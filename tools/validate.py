#!/usr/bin/env python3
"""Static validation of the Superpowers & Mutants packs.

Checks that every JSON file parses, and that every identifier referenced from scripts or
JSON (particles, sounds, animations, fogs, entities, items, blocks, structures, textures,
language keys, UI icons) actually exists in the packs (or in vanilla, where allowed).

Usage: python3 tools/validate.py [--vanilla-terrain path/to/vanilla/terrain_texture.json]
Exit status 1 on any error.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, 'packs', 'SuperpowersBP')
RP = os.path.join(ROOT, 'packs', 'SuperpowersRP')

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def load_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        err(f'JSON parse error {os.path.relpath(path, ROOT)}: {e}')
        return None


def walk(base, ext):
    for d, _, files in os.walk(base):
        for fn in files:
            if fn.endswith(ext):
                yield os.path.join(d, fn)


def texture_exists(rel):
    for ext in ('.png', '.tga', '.jpg'):
        if os.path.exists(os.path.join(RP, rel + ext)):
            return True
    return False


VANILLA_HINT_PREFIXES = ('textures/blocks/', 'textures/items/', 'textures/entity/', 'textures/particle/', 'textures/ui/', 'textures/misc/')


def main():
    vanilla_terrain = set()
    for i, a in enumerate(sys.argv):
        if a == '--vanilla-terrain' and i + 1 < len(sys.argv):
            raw = open(sys.argv[i + 1], encoding='utf-8-sig').read()
            raw = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
            data = json.loads(raw)
            for v in data.get('texture_data', {}).values():
                t = v.get('textures')
                items = t if isinstance(t, list) else [t]
                for it in items:
                    if isinstance(it, str):
                        vanilla_terrain.add(it)
                    elif isinstance(it, dict) and 'path' in it:
                        vanilla_terrain.add(it['path'])

    # ---------------------------------------------------------------- parse everything
    for base in (BP, RP):
        for p in walk(base, '.json'):
            load_json(p)

    # ---------------------------------------------------------------- collect definitions
    particles = set()
    for p in walk(os.path.join(RP, 'particles'), '.json'):
        d = load_json(p)
        if d:
            try:
                particles.add(d['particle_effect']['description']['identifier'])
            except Exception:  # noqa: BLE001
                err(f'particle without identifier: {p}')
    sounds = set()
    sd = load_json(os.path.join(RP, 'sounds', 'sound_definitions.json')) if os.path.exists(os.path.join(RP, 'sounds', 'sound_definitions.json')) else None
    if sd:
        defs = sd.get('sound_definitions', sd)
        for sid, v in defs.items():
            if sid == 'format_version':
                continue
            sounds.add(sid)
            for s in v.get('sounds', []):
                name = s if isinstance(s, str) else s.get('name')
                if name and name.startswith('sounds/sp') and not any(os.path.exists(os.path.join(RP, name + e)) for e in ('.ogg', '.wav', '.fsb')):
                    err(f'sound file missing for {sid}: {name}')
    else:
        err('sounds/sound_definitions.json missing')
    animations = set()
    for p in list(walk(os.path.join(RP, 'animations'), '.json')):
        d = load_json(p)
        if d:
            animations.update(d.get('animations', {}).keys())
    anim_controllers = set()
    for p in walk(os.path.join(RP, 'animation_controllers'), '.json'):
        d = load_json(p)
        if d:
            anim_controllers.update(d.get('animation_controllers', {}).keys())
    geometries = set()
    for p in walk(os.path.join(RP, 'models'), '.json'):
        d = load_json(p)
        if not d:
            continue
        for g in d.get('minecraft:geometry', []):
            geometries.add(g.get('description', {}).get('identifier'))
        for k in d:
            if k.startswith('geometry.'):
                geometries.add(k.split(':')[0])
    render_controllers = set()
    for p in walk(os.path.join(RP, 'render_controllers'), '.json'):
        d = load_json(p)
        if d:
            render_controllers.update(d.get('render_controllers', {}).keys())
    fogs = set()
    for p in walk(os.path.join(RP, 'fogs'), '.json'):
        d = load_json(p)
        if d:
            fogs.add(d.get('minecraft:fog_settings', {}).get('description', {}).get('identifier'))
    bp_entities = {}
    for p in walk(os.path.join(BP, 'entities'), '.json'):
        d = load_json(p)
        if d:
            ident = d.get('minecraft:entity', {}).get('description', {}).get('identifier')
            bp_entities[ident] = d
    rp_entities = {}
    for p in walk(os.path.join(RP, 'entity'), '.json'):
        d = load_json(p)
        if d:
            ident = d.get('minecraft:client_entity', {}).get('description', {}).get('identifier')
            rp_entities[ident] = d
    items = {}
    for p in walk(os.path.join(BP, 'items'), '.json'):
        d = load_json(p)
        if d:
            items[d.get('minecraft:item', {}).get('description', {}).get('identifier')] = d
    blocks = {}
    for p in walk(os.path.join(BP, 'blocks'), '.json'):
        d = load_json(p)
        if d:
            blocks[d.get('minecraft:block', {}).get('description', {}).get('identifier')] = d
    structures = set()
    for p in walk(os.path.join(BP, 'structures'), '.mcstructure'):
        rel = os.path.relpath(p, os.path.join(BP, 'structures'))
        ns, name = rel.split(os.sep, 1) if os.sep in rel else ('mystructure', rel)
        structures.add(f'{ns}:{name[:-len(".mcstructure")]}')
    item_tex = load_json(os.path.join(RP, 'textures', 'item_texture.json')) or {}
    item_tex_keys = set(item_tex.get('texture_data', {}).keys())
    for k, v in item_tex.get('texture_data', {}).items():
        t = v.get('textures')
        for path in (t if isinstance(t, list) else [t]):
            if isinstance(path, str) and not texture_exists(path):
                err(f'item_texture {k}: missing file {path}')
    terrain = load_json(os.path.join(RP, 'textures', 'terrain_texture.json')) or {}
    terrain_keys = set(terrain.get('texture_data', {}).keys())
    for k, v in terrain.get('texture_data', {}).items():
        t = v.get('textures')
        for path in (t if isinstance(t, list) else [t]):
            if isinstance(path, dict):
                path = path.get('path')
            if isinstance(path, str) and not texture_exists(path):
                err(f'terrain_texture {k}: missing file {path}')
    lang = {}
    lp = os.path.join(RP, 'texts', 'en_US.lang')
    if os.path.exists(lp):
        for line in open(lp, encoding='utf-8'):
            line = line.split('##')[0].strip()
            if '=' in line:
                k, v = line.split('=', 1)
                lang[k.strip()] = v.strip()
    else:
        err('RP texts/en_US.lang missing')

    # ---------------------------------------------------------------- script references
    script_text = ''
    for p in walk(os.path.join(BP, 'scripts'), '.js'):
        script_text += open(p, encoding='utf-8').read() + '\n'
    used_particles = set(re.findall(r"['\"](sp:[a-z0-9_]+)['\"]", script_text))
    # only those passed to particle helpers
    particle_calls = set(re.findall(r"(?:particle|particleFor|line|ring|spawnParticle)\([^'\"]*?['\"](sp:[a-z0-9_]+)['\"]", script_text))
    for pid in sorted(particle_calls):
        if pid not in particles:
            err(f'script uses undefined particle {pid}')
    sound_ids = set(re.findall(r"['\"](sp\.[a-z0-9_.]+)['\"]", script_text))
    for sid in sorted(sound_ids):
        if sid not in sounds:
            err(f'script uses undefined sound {sid}')
    for vs in re.findall(r"(?:sound|soundTo|playSound)\([^)]*?['\"]((?:random|mob|block|ambient|dig|step)\.[a-z0-9_.]+)['\"]", script_text):
        warn(f'script uses vanilla sound {vs} (ok if it exists in vanilla)')
    for aid in sorted(set(re.findall(r"['\"](animation\.sp\.[a-z0-9_.]+)['\"]", script_text))):
        if aid not in animations:
            err(f'script uses undefined animation {aid}')
    for fid in sorted(set(re.findall(r"fogPush\([^,]+,\s*['\"]([a-z0-9_:]+)['\"]", script_text))):
        if fid not in fogs:
            err(f'script uses undefined fog {fid}')
    for ident in ('sp:debris', 'sp:meteor', 'sp:rogue_mutant'):
        if ident not in bp_entities:
            err(f'BP entity missing: {ident}')
        if ident not in rp_entities:
            err(f'RP client entity missing: {ident}')
    script_items = set(re.findall(r"['\"](sp:(?:syringe_[a-z_]+|suppressor_serum|mutagen_crystal|mutant_codex|emblem_[a-z_]+))['\"]", script_text))
    cfg = open(os.path.join(BP, 'scripts', 'config.js')).read()
    for power in re.findall(r"emblem: 'sp:emblem_([a-z_]+)'", cfg):
        script_items.add(f'sp:emblem_{power}')
        script_items.add(f'sp:syringe_{power}')
    for iid in sorted(script_items):
        if iid not in items:
            err(f'item referenced but not defined: {iid}')
    for bid in ('sp:meteorite', 'sp:mutagen_tank'):
        if bid not in blocks:
            err(f'block missing: {bid}')
    for sid in sorted(set(re.findall(r"id: '(sp:[a-z_]+)'", open(os.path.join(BP, 'scripts', 'ui', 'codex.js')).read()))):
        if sid.startswith('sp:mutagen_lab') or sid.startswith('sp:meteor_crash'):
            if sid not in structures:
                err(f'structure missing: {sid}')
    # codex icons
    for icon in sorted(set(re.findall(r"['\"`](textures/[a-z0-9_/]+)['\"`]", script_text))):
        if not texture_exists(icon) and not icon.endswith('/'):
            err(f'texture referenced from scripts missing: {icon}')
    for icon in sorted(set(re.findall(r"UI \+ '([a-z0-9_]+)'", script_text))):
        if not texture_exists('textures/sp/ui/' + icon):
            err(f'codex UI icon missing: textures/sp/ui/{icon}')
    for p in POWER_IDS(cfg):
        if not texture_exists(f'textures/sp/ui/power_{p}'):
            err(f'codex UI icon missing: textures/sp/ui/power_{p}')

    # ---------------------------------------------------------------- items & blocks
    for iid, d in items.items():
        comps = d.get('minecraft:item', {}).get('components', {})
        icon = comps.get('minecraft:icon')
        key = icon if isinstance(icon, str) else (icon or {}).get('textures', {}).get('default') if isinstance(icon, dict) else None
        if not key:
            err(f'item {iid} has no minecraft:icon')
        elif key not in item_tex_keys:
            err(f'item {iid} icon key {key} not in item_texture.json')
        dn = comps.get('minecraft:display_name', {}).get('value')
        lang_key = dn if dn else f'item.{iid}.name'
        if '.' in lang_key and lang_key not in lang and not lang_key.startswith('§'):
            err(f'item {iid}: display name key {lang_key} missing in en_US.lang')
    blocks_json = load_json(os.path.join(RP, 'blocks.json')) or {}
    for bid, d in blocks.items():
        comps = d.get('minecraft:block', {}).get('components', {})
        mats = comps.get('minecraft:material_instances', {})
        for m in mats.values():
            tex = m.get('texture') if isinstance(m, dict) else None
            if tex and tex not in terrain_keys:
                err(f'block {bid} material texture {tex} not in terrain_texture.json')
        if f'tile.{bid}.name' not in lang:
            dn = comps.get('minecraft:display_name')
            if not dn:
                err(f'block {bid}: lang key tile.{bid}.name missing')
    for eid in bp_entities:
        if eid and eid.startswith('sp:') and f'entity.{eid}.name' not in lang:
            err(f'lang missing entity.{eid}.name')

    # ---------------------------------------------------------------- client entities
    for eid, d in rp_entities.items():
        desc = d.get('minecraft:client_entity', {}).get('description', {})
        for k, path in desc.get('textures', {}).items():
            if texture_exists(path):
                continue
            if path in vanilla_terrain or (not vanilla_terrain and path.startswith(VANILLA_HINT_PREFIXES)):
                continue
            err(f'{eid}: texture {k} -> {path} not found (pack or vanilla)')
        for k, g in desc.get('geometry', {}).items():
            if g not in geometries and not g.startswith('geometry.humanoid') and g not in ('geometry.zombie',):
                err(f'{eid}: geometry {g} not defined')
        for k, a in desc.get('animations', {}).items():
            if a.startswith('animation.sp.') and a not in animations:
                err(f'{eid}: animation {a} not defined')
            if a.startswith('controller.animation.sp') and a not in anim_controllers:
                err(f'{eid}: controller {a} not defined')
        for rc in desc.get('render_controllers', []):
            name = rc if isinstance(rc, str) else list(rc.keys())[0]
            if name.startswith('controller.render.sp') and name not in render_controllers:
                err(f'{eid}: render controller {name} not defined')

    # ---------------------------------------------------------------- manifests
    bpm = load_json(os.path.join(BP, 'manifest.json'))
    rpm = load_json(os.path.join(RP, 'manifest.json'))
    if bpm and rpm:
        if not any(dep.get('uuid') == rpm['header']['uuid'] for dep in bpm.get('dependencies', [])):
            err('BP manifest does not depend on the RP')
        mods = {dep.get('module_name'): dep.get('version') for dep in bpm.get('dependencies', []) if 'module_name' in dep}
        if mods.get('@minecraft/server') != '2.5.0' or mods.get('@minecraft/server-ui') != '2.0.0':
            err(f'unexpected script module versions {mods}')
    for pack in (BP, RP):
        if not os.path.exists(os.path.join(pack, 'pack_icon.png')):
            err(f'pack_icon.png missing in {os.path.basename(pack)}')

    for w in warnings:
        print('WARN ', w)
    for e in errors:
        print('ERROR', e)
    print(f'validate: {len(errors)} error(s), {len(warnings)} warning(s); particles={len(particles)} sounds={len(sounds)} '
          f'animations={len(animations)} items={len(items)} blocks={len(blocks)} entities={len(bp_entities)} structures={len(structures)}')
    return 1 if errors else 0


def POWER_IDS(cfg):
    m = re.search(r"POWER_IDS = \[([^\]]+)\]", cfg)
    return re.findall(r"'([a-z_]+)'", m.group(1)) if m else []


if __name__ == '__main__':
    sys.exit(main())
