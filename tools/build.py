#!/usr/bin/env python3
"""Package the add-on for installation.

Creates in dist/:
  Superpowers_and_Mutants.mcaddon   (both packs; double-click to import into Minecraft)
  Superpowers_and_Mutants_BP.mcpack
  Superpowers_and_Mutants_RP.mcpack
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = {
    'BP': os.path.join(ROOT, 'packs', 'SuperpowersBP'),
    'RP': os.path.join(ROOT, 'packs', 'SuperpowersRP'),
}
DIST = os.path.join(ROOT, 'dist')
SKIP_SUFFIXES = ('.DS_Store', '.pyc', 'Thumbs.db')


def add_pack(z, src, prefix):
    n = 0
    for d, dirs, files in os.walk(src):
        dirs.sort()
        for fn in sorted(files):
            if fn.endswith(SKIP_SUFFIXES):
                continue
            full = os.path.join(d, fn)
            rel = os.path.relpath(full, src).replace(os.sep, '/')
            info = zipfile.ZipInfo(f'{prefix}{rel}', date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, open(full, 'rb').read())
            n += 1
    return n


def main():
    os.makedirs(DIST, exist_ok=True)
    addon = os.path.join(DIST, 'Superpowers_and_Mutants.mcaddon')
    with zipfile.ZipFile(addon, 'w') as z:
        nb = add_pack(z, PACKS['BP'], 'Superpowers_and_Mutants_BP/')
        nr = add_pack(z, PACKS['RP'], 'Superpowers_and_Mutants_RP/')
    for key, src in PACKS.items():
        with zipfile.ZipFile(os.path.join(DIST, f'Superpowers_and_Mutants_{key}.mcpack'), 'w') as z:
            add_pack(z, src, '')
    size = os.path.getsize(addon)
    print(f'built {os.path.relpath(addon, ROOT)} ({size / 1024:.0f} KiB, {nb} BP files, {nr} RP files)')


if __name__ == '__main__':
    main()
