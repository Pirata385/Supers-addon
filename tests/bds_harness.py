#!/usr/bin/env python3
"""Run the add-on on a Bedrock Dedicated Server and collect content-log / script output.

Usage:
  python3 tests/bds_harness.py --bds /path/to/bedrock-server-dir [--test-pack tests/sp_test_bp]
                               [--timeout 240] [--keep]

The harness copies the BDS install into a scratch directory, installs the add-on packs
(and optionally the GameTest-based test pack), creates a flat test world with the
"Beta APIs" experiment enabled (needed only by the test pack's simulated players),
boots the server and streams its console until the test pack prints `[SPTEST] DONE`
or the timeout expires. Exit status is non-zero when errors are found.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import nbt  # noqa: E402

BP = os.environ.get('SP_BP_DIR') or os.path.join(ROOT, 'packs', 'SuperpowersBP')
RP = os.environ.get('SP_RP_DIR') or os.path.join(ROOT, 'packs', 'SuperpowersRP')


def manifest(path):
    with open(os.path.join(path, 'manifest.json')) as f:
        m = json.load(f)
    return {'pack_id': m['header']['uuid'], 'version': m['header']['version']}


def set_props(server_dir, props):
    p = os.path.join(server_dir, 'server.properties')
    lines = open(p).read().splitlines()
    seen = set()
    out = []
    for line in lines:
        k = line.split('=', 1)[0].strip()
        if k in props:
            out.append(f'{k}={props[k]}')
            seen.add(k)
        else:
            out.append(line)
    for k, v in props.items():
        if k not in seen:
            out.append(f'{k}={v}')
    os.unlink(p)
    open(p, 'w').write('\n'.join(out) + '\n')


class Server:
    def __init__(self, server_dir):
        self.dir = server_dir
        self.lines = []
        self.proc = None
        self.lock = threading.Lock()

    def start(self):
        env = dict(os.environ, LD_LIBRARY_PATH='.')
        shim = os.path.join(HERE, 'shim', 'noipv6.so')
        if os.path.exists(shim) and os.environ.get('SP_NO_SHIM') != '1':
            env['LD_PRELOAD'] = shim
        self.proc = subprocess.Popen(['./bedrock_server'], cwd=self.dir, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
                                     text=True, bufsize=1)
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.proc.stdout:
            line = line.rstrip('\n')
            with self.lock:
                self.lines.append(line)
            print(line, flush=True)

    def send(self, cmd):
        self.proc.stdin.write(cmd + '\n')
        self.proc.stdin.flush()

    def wait_for(self, pattern, timeout):
        rx = re.compile(pattern)
        end = time.time() + timeout
        idx = 0
        while time.time() < end:
            with self.lock:
                cur = self.lines[idx:]
                idx = len(self.lines)
            for l in cur:
                if rx.search(l):
                    return l
            if self.proc.poll() is not None:
                return None
            time.sleep(0.2)
        return None

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.send('stop')
                self.proc.wait(timeout=30)
            except Exception:
                self.proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bds', required=True)
    ap.add_argument('--work', default=os.path.join(HERE, '.bds'))
    ap.add_argument('--test-pack', default=None)
    ap.add_argument('--timeout', type=int, default=240)
    ap.add_argument('--keep', action='store_true', help='keep the previous world')
    ap.add_argument('--commands', default='', help='semicolon separated console commands after start')
    ap.add_argument('--port', type=int, default=19232, help='IPv4 port (IPv6 uses port+1)')
    ap.add_argument('--wait', type=int, default=15, help='seconds to run when no test pack is given')
    ap.add_argument('--test-api', default=None,
                    help="@minecraft/server beta version for the test pack (default: auto from the BDS version, e.g. 2.6.0-beta for 1.26.3)")
    ap.add_argument('--suites', default='', help='comma separated GameTest suites to run (default: all)')
    ap.add_argument('--stub-powers-except', default=None,
                    help="replace every power module except these comma-separated ids (or 'none') with a stub in the server copy")
    args = ap.parse_args()

    work = os.path.abspath(args.work)
    srv = os.path.join(work, os.path.basename(os.path.abspath(args.bds)))
    if not os.path.exists(os.path.join(srv, 'bedrock_server')):
        os.makedirs(work, exist_ok=True)
        # hardlink the (large, read-only) install, then give the copy private config files
        if subprocess.call(['cp', '-al', os.path.abspath(args.bds), srv]) != 0:
            shutil.copytree(args.bds, srv, symlinks=True)
        for name in os.listdir(srv):
            fp = os.path.join(srv, name)
            if os.path.isfile(fp) and name != 'bedrock_server' and not name.endswith('.so'):
                data = open(fp, 'rb').read()
                os.unlink(fp)
                open(fp, 'wb').write(data)

    level = 'sp_test'
    world = os.path.join(srv, 'worlds', level)
    if not args.keep and os.path.exists(world):
        shutil.rmtree(world)

    # Install packs (fresh copies every run)
    packs = [('behavior_packs', BP, 'sp_bp'), ('resource_packs', RP, 'sp_rp')]
    if args.test_pack:
        packs.append(('behavior_packs', os.path.abspath(args.test_pack), 'sp_test_bp'))
    for kind, src, name in packs:
        dst = os.path.join(srv, kind, name)
        if os.path.exists(dst):
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
    if args.stub_powers_except:
        pdir = os.path.join(srv, 'behavior_packs', 'sp_bp', 'scripts', 'powers')
        for fn in os.listdir(pdir):
            pid = fn[:-3]
            keep = [x.strip() for x in args.stub_powers_except.split(',')]
            if fn.endswith('.js') and pid not in keep:
                open(os.path.join(pdir, fn), 'w').write(
                    "import { definePower } from '../core/powers.js';\ndefinePower('%s', {});\n" % pid)
    if args.test_pack:
        api = args.test_api
        if not api:
            # The newest vanilla_1.26.x behavior pack shipped with the server tells its version.
            vers = [d for d in os.listdir(os.path.join(srv, 'behavior_packs')) if d.startswith('vanilla_1.26.')]
            minor = max((int(d.split('.')[-1]) for d in vers), default=0)
            api = {0: '2.6.0-beta', 10: '2.7.0-beta', 20: '2.8.0-beta', 30: '2.9.0-beta',
                   40: '2.10.0-beta', 50: '2.11.0-beta'}.get(minor, '2.6.0-beta')
        ui_api = {'2.6.0-beta': '2.1.0-beta', '2.7.0-beta': '2.1.0-beta', '2.8.0-beta': '2.1.0-beta',
                  '2.9.0-beta': '2.2.0-beta', '2.10.0-beta': '2.2.0-beta', '2.11.0-beta': '2.3.0-beta'}.get(api, '2.1.0-beta')
        # Simulated players created by the GameTest module can only be wrapped by script
        # contexts that load that module. In the private server copy ONLY, switch the add-on
        # to the matching beta API + GameTest so it can see the simulated players; the shipped
        # manifest keeps the stable 2.5.0 / 2.0.0 versions.
        bpm_path = os.path.join(srv, 'behavior_packs', 'sp_bp', 'manifest.json')
        bpm = json.load(open(bpm_path))
        deps = [d for d in bpm['dependencies'] if d.get('module_name') not in ('@minecraft/server', '@minecraft/server-ui', '@minecraft/server-gametest')]
        deps += [{'module_name': '@minecraft/server', 'version': api},
                 {'module_name': '@minecraft/server-ui', 'version': ui_api},
                 {'module_name': '@minecraft/server-gametest', 'version': '1.0.0-beta'}]
        bpm['dependencies'] = deps
        json.dump(bpm, open(bpm_path, 'w'), indent=2)
        # keep a tiny import so the module is actually loaded in the add-on context
        main_js = os.path.join(srv, 'behavior_packs', 'sp_bp', 'scripts', 'main.js')
        src = open(main_js).read()
        if '@minecraft/server-gametest' not in src:
            open(main_js, 'w').write("import '@minecraft/server-gametest';\n" + src)
        mp = os.path.join(srv, 'behavior_packs', 'sp_test_bp', 'manifest.json')
        m = json.load(open(mp))
        for dep in m['dependencies']:
            if dep.get('module_name') == '@minecraft/server':
                dep['version'] = api
        json.dump(m, open(mp, 'w'), indent=2)
        print(f'[HARNESS] test mode: add-on + test pack use @minecraft/server {api}, server-ui {ui_api}')
    if args.test_pack and args.suites:
        suites = [x.strip() for x in args.suites.split(',') if x.strip()]
        open(os.path.join(srv, 'behavior_packs', 'sp_test_bp', 'scripts', 'suite.js'), 'w').write(
            'export const SUITES = %s;\n' % json.dumps(suites))

    set_props(srv, {
        'level-name': level, 'level-type': 'FLAT', 'gamemode': 'creative', 'allow-cheats': 'true',
        'online-mode': 'false', 'content-log-console-output-enabled': 'true', 'content-log-level': 'info',
        'content-log-file-enabled': 'false', 'view-distance': '10', 'tick-distance': '4',
        'server-port': str(args.port), 'server-portv6': str(args.port + 1), 'enable-lan-visibility': 'false',
        'difficulty': 'normal', 'allow-list': 'false',
    })

    # First boot creates the world (and level.dat); then enable experiments + packs.
    if not os.path.exists(os.path.join(world, 'level.dat')):
        s = Server(srv)
        s.start()
        ok = s.wait_for(r'Server started', 120)
        s.stop()
        if not ok:
            print('[HARNESS] server failed to start')
            return 2
    ver, name, root = nbt.read_level_dat(os.path.join(world, 'level.dat'))
    comp = root[1]
    exp = comp.get('experiments', (nbt.TAG_COMPOUND, {}))[1]
    if args.test_pack:
        exp['gametest'] = nbt.byte(1)
        exp['experiments_ever_used'] = nbt.byte(1)
        exp['saved_with_toggled_experiments'] = nbt.byte(1)
    comp['experiments'] = (nbt.TAG_COMPOUND, exp)
    comp['commandsEnabled'] = nbt.byte(1)
    comp['cheatsEnabled'] = nbt.byte(1)
    comp['doDaylightCycle'] = nbt.byte(0)
    comp['domobspawning'] = nbt.byte(0)
    comp['doweathercycle'] = nbt.byte(0)
    nbt.write_level_dat(os.path.join(world, 'level.dat'), ver, name, root)

    bps = [manifest(BP)] + ([manifest(args.test_pack)] if args.test_pack else [])
    json.dump(bps, open(os.path.join(world, 'world_behavior_packs.json'), 'w'), indent=2)
    json.dump([manifest(RP)], open(os.path.join(world, 'world_resource_packs.json'), 'w'), indent=2)

    s = Server(srv)
    s.start()
    if not s.wait_for(r'Server started', 120):
        print('[HARNESS] server failed to start with packs')
        s.stop()
        return 2
    for c in [c.strip() for c in args.commands.split(';') if c.strip()]:
        s.send(c)
    if args.test_pack:
        s.wait_for(r'\[SPTEST\] DONE', args.timeout)
    else:
        time.sleep(args.wait)
    s.stop()

    errors = [l for l in s.lines if re.search(r'\[(Scripting|Json|Item|Blocks|Entity|Recipes|Texture|Molang|Particle|FeatureRegistration|Structure|Commands|Animation|Actor|Geometry|Sound)\]\[(error|warning)\]|ERROR|Unhandled|\[SPTEST\] FAIL', l, re.I)]
    print('\n========== HARNESS SUMMARY ==========')
    for l in errors:
        print(l)
    fails = [l for l in s.lines if '[SPTEST] FAIL' in l]
    passes = [l for l in s.lines if '[SPTEST] PASS' in l]
    print(f'passes={len(passes)} fails={len(fails)} log_issues={len(errors)}')
    return 1 if (errors or fails) else 0


if __name__ == '__main__':
    sys.exit(main())
