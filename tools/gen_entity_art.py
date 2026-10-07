#!/usr/bin/env python3
"""Entity art generator and validator for Superpowers & Mutants.

Generates (deterministically, original pixel art in a vanilla-like style):
  packs/SuperpowersRP/textures/entity/rogue_mutant_<0..3>.png  64x64 Rogue Mutant skins
  packs/SuperpowersRP/textures/entity/meteor.png               64x64 molten meteor rock
  packs/SuperpowersRP/textures/entity/debris_grass.png         16x16 grass-side chunk
  packs/SuperpowersRP/textures/entity/debris_magma.png         16x16 magma chunk (static)

Materials: the mutant base layer and the meteor use `entity_emissive_alpha`, where the alpha
channel is the emissive mask: alpha 255 = normally lit, alpha 0 (with a non-black colour) =
fully glowing; fully transparent black pixels are discarded. The mutant's outer layers (hat,
jacket, sleeves, pants) are rendered with `entity_alphatest`, so there alpha is transparency.

Usage:
  python3 tools/gen_entity_art.py                 regenerate the textures
  python3 tools/gen_entity_art.py --check [--vanilla <vanilla resource pack dir>]
                                                  validate the entity/animation/fog assets
"""
import json
import math
import os
import random
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, 'packs', 'SuperpowersBP')
RP = os.path.join(ROOT, 'packs', 'SuperpowersRP')
TEX = os.path.join(RP, 'textures', 'entity')


# =============================================================================== helpers
def clamp8(v):
    return max(0, min(255, int(round(v))))


def mul(c, f):
    return tuple(clamp8(x * f) for x in c[:3])


def mix(a, b, t):
    return tuple(clamp8(a[i] + (b[i] - a[i]) * t) for i in range(3))


class Canvas:
    """Tiny RGBA pixel canvas (list based, no numpy needed for 64x64 art)."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = [[(0, 0, 0, 0)] * w for _ in range(h)]

    def set(self, x, y, rgb, a=255):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = (rgb[0], rgb[1], rgb[2], a)

    def get(self, x, y):
        return self.px[y][x]

    def save(self, path):
        from PIL import Image
        im = Image.new('RGBA', (self.w, self.h))
        im.putdata([p for row in self.px for p in row])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im.save(path)


def box_faces(u0, v0, w, h, d):
    """Bedrock box-UV layout of a cube: face -> (x, y, width, height) in texture pixels."""
    return {
        'top': (u0 + d, v0, w, d),
        'bottom': (u0 + d + w, v0, w, d),
        'right': (u0, v0 + d, d, h),
        'front': (u0 + d, v0 + d, w, h),
        'left': (u0 + d + w, v0 + d, d, h),
        'back': (u0 + 2 * d + w, v0 + d, w, h),
    }


def paint_box(cv, u0, v0, w, h, d, painter):
    for face, (fx, fy, fw, fh) in box_faces(u0, v0, w, h, d).items():
        for y in range(fh):
            for x in range(fw):
                r = painter(face, x, y, fw, fh)
                if r is None:
                    continue
                if len(r) == 3:
                    cv.set(fx + x, fy + y, r)
                else:
                    cv.set(fx + x, fy + y, r[:3], r[3])


# ============================================================================ rogue mutant
VARIANTS = [
    {   # 0 Brute - strength: grey-green bulging skin, dark veins, orange eyes
        'skin': (122, 142, 98), 'vein': (74, 92, 56), 'hair': (44, 38, 32), 'hair_cov': 0.55,
        'eye': (255, 168, 52), 'eye_core': (255, 236, 168), 'shard': (255, 146, 38), 'shard_hi': (255, 226, 150),
        'shirt': (92, 102, 114), 'pants': (62, 70, 82), 'mark': 'veins',
    },
    {   # 1 Scorcher - heat vision: reddish scorched skin with glowing cracks, red eyes
        'skin': (176, 112, 88), 'vein': (112, 54, 40), 'hair': (30, 24, 22), 'hair_cov': 0.3,
        'eye': (255, 64, 24), 'eye_core': (255, 206, 132), 'shard': (255, 88, 34), 'shard_hi': (255, 204, 120),
        'shirt': (106, 86, 80), 'pants': (72, 62, 60), 'mark': 'cracks',
    },
    {   # 2 Blur - speedster: pale skin, glowing yellow lightning veins, bleached spiky hair
        'skin': (204, 190, 164), 'vein': (156, 140, 112), 'hair': (232, 214, 130), 'hair_cov': 0.95,
        'eye': (255, 226, 70), 'eye_core': (255, 252, 214), 'shard': (255, 220, 64), 'shard_hi': (255, 250, 204),
        'shirt': (84, 104, 122), 'pants': (56, 68, 88), 'mark': 'lightning',
    },
    {   # 3 Psion - esper: bald lavender skull with bulging violet veins, violet eyes
        'skin': (184, 166, 202), 'vein': (112, 70, 152), 'hair': None, 'hair_cov': 0.0,
        'eye': (206, 100, 255), 'eye_core': (246, 214, 255), 'shard': (192, 92, 255), 'shard_hi': (240, 204, 255),
        'shirt': (94, 88, 116), 'pants': (64, 60, 84), 'mark': 'psi',
    },
]

COAT = (224, 226, 220)
COAT_SHADE = (196, 200, 194)
STAINS = [(120, 176, 72), (112, 36, 30), (74, 72, 70)]
SHOE = (42, 36, 32)
MOUTH = (48, 22, 22)
TOOTH = (214, 204, 174)


def mutant_skin(idx):
    v = VARIANTS[idx]
    rnd = random.Random(9100 + idx * 77)
    cv = Canvas(64, 64)
    skin, vein = v['skin'], v['vein']
    dark = mul(skin, 0.78)

    def noisy(c, amt=0.07):
        return mul(c, 1.0 + (rnd.random() - 0.5) * 2 * amt)

    def shaded(c, y, fh, amt=0.07):
        # vertical light gradient + noise, vanilla style
        return mul(noisy(c, amt), 1.04 - 0.14 * (y / max(1, fh - 1)))

    glow_line = {'cracks': (255, 112, 36), 'lightning': (255, 228, 92)}.get(v['mark'])

    # pre-computed meandering marks for arms (per face column walk)
    def walk_marks(n, h):
        cols = set()
        for _ in range(n):
            x = rnd.randrange(4)
            y = rnd.randrange(2, 5)
            while y < h - 3:
                cols.add((x, y))
                y += 1
                if rnd.random() < 0.25:
                    x = max(0, min(3, x + rnd.choice((-1, 1))))
                if rnd.random() < 0.15:
                    break
        return cols

    # ------------------------------------------------------------------ head (0,0) 8x8x8
    hair = v['hair']
    # hair grows in 2x2 clumps (patchy, balding mutants) instead of per-pixel noise
    clumps = {f: [rnd.random() < v['hair_cov'] for _ in range(16)] for f in ('top', 'front', 'right', 'left', 'back')}
    hair_rows = {f: [clumps[f][(y // 2) * 4 + x // 2] or rnd.random() < v['hair_cov'] * 0.3 for y in range(8) for x in range(8)]
                 for f in clumps}
    skull_veins = set()
    if v['mark'] in ('psi', 'veins'):
        for _ in range(3 if v['mark'] == 'psi' else 1):
            x, y = rnd.randrange(1, 7), rnd.randrange(0, 3)
            for _ in range(rnd.randrange(4, 7)):
                skull_veins.add((x, y))
                if rnd.random() < 0.6:
                    y = min(7, y + 1)
                else:
                    x = max(0, min(7, x + rnd.choice((-1, 1))))
    vein = mix(skin, vein, 0.7)  # veins read as raised, not as painted lines

    def head(face, x, y, fw, fh):
        if face == 'bottom':
            return noisy(dark)
        if face == 'top':
            if hair and hair_rows['top'][y * 8 + x]:
                return noisy(hair, 0.12)
            if (x, y) in skull_veins:
                return noisy(vein)
            return noisy(skin)
        if face == 'front':
            if hair and (y == 0 or (y == 1 and hair_rows['front'][x])):
                return noisy(hair, 0.12)
            if y == 4 and x in (1, 2, 5, 6):  # glowing eyes (alpha 0 = emissive)
                core = x in (2, 5)
                return (*(v['eye_core'] if core else v['eye']), 0)
            if y == 3 and x in (1, 2, 5, 6):
                return noisy(mul(skin, 0.62))  # heavy brow ridge
            if y == 5 and x in (3, 4):
                return noisy(mul(skin, 0.7))
            if y == 6:
                return {1: noisy(dark), 2: TOOTH, 3: MOUTH, 4: TOOTH, 5: MOUTH, 6: noisy(dark)}.get(x, noisy(skin))
            if y == 7:
                return noisy(dark)
            if v['mark'] == 'psi' and y <= 2 and (x, y + 3) in skull_veins:
                return noisy(vein)
            if v['mark'] == 'cracks' and (x, y) in ((6, 5), (7, 5), (6, 6)):
                return (*glow_line, 0)
            if v['mark'] == 'lightning' and (x, y) in ((0, 5), (1, 6), (0, 7)):
                return (*glow_line, 0)
            if v['mark'] == 'veins' and (x, y) in ((5, 1), (5, 2), (6, 2)):
                return noisy(vein)
            return shaded(skin, y, fh, 0.05)
        # sides and back
        if hair and (y <= (2 if face != 'back' else 5)) and hair_rows[face][y * 8 + x]:
            return noisy(hair, 0.12)
        if face in ('right', 'left') and y in (3, 4) and x in (3, 4):
            return noisy(mul(skin, 0.72))  # ear
        if (x, y) in skull_veins:
            return noisy(vein)
        if v['mark'] == 'psi' and face in ('right', 'left') and (x, y) == (5, 2):
            return (*v['eye'], 0)  # glowing temple node
        return shaded(skin, y, fh)

    paint_box(cv, 0, 0, 8, 8, 8, head)

    # ------------------------------------------------------------------ body (16,16) 8x12x4 - scrubs
    holes = {('front', rnd.randrange(1, 7), rnd.randrange(4, 10)), ('back', rnd.randrange(1, 7), rnd.randrange(2, 10))}
    for _ in range(3):
        f, x, y = rnd.choice(('front', 'back', 'left', 'right')), rnd.randrange(4), rnd.randrange(3, 11)
        holes.add((f, x, y))
    shirt = v['shirt']

    def body(face, x, y, fw, fh):
        if face == 'front' and ((y == 0 and 2 <= x <= 5) or (y == 1 and 3 <= x <= 4)):
            return noisy(skin)  # V-neck
        if (face, x, y) in holes:
            return noisy(dark)
        if face == 'bottom':
            return noisy(mul(shirt, 0.8))
        if face in ('front', 'back', 'left', 'right') and y == fh - 1:
            return noisy(mul(shirt, 0.82))
        if rnd.random() < 0.04:
            return noisy(rnd.choice(STAINS[:2]))
        return shaded(shirt, y, fh)

    paint_box(cv, 16, 16, 8, 12, 4, body)

    # ------------------------------------------------------------------ arms (bare, mutated)
    def arm_painter(bulky):
        marks = {f: walk_marks(3 if bulky else 2, 12) for f in ('front', 'back', 'left', 'right')}

        def p(face, x, y, fw, fh):
            if face == 'top':
                return noisy(skin)
            if face == 'bottom':
                return noisy(mul(skin, 0.7))  # palm / fist
            if y >= 9:  # hand
                if y == 9 and face == 'front':
                    return noisy(mul(skin, 0.68))  # knuckles
                if y == 11 and face == 'front' and x in (0, 2):
                    return (196, 188, 160)  # claw-like nails
                return noisy(mul(skin, 0.86))
            if (x, y) in marks[face]:
                if glow_line:
                    return (*glow_line, 0)
                return noisy(vein)
            return shaded(skin, y, fh)
        return p

    paint_box(cv, 40, 16, 4, 12, 4, arm_painter(True))   # right arm (bulky)
    paint_box(cv, 32, 48, 4, 12, 4, arm_painter(False))  # left arm

    # ------------------------------------------------------------------ legs (scrub pants + shoes)
    def leg_painter(seed):
        r2 = random.Random(seed)
        hole = (r2.choice(('front', 'right', 'left')), r2.randrange(4), r2.randrange(3, 8))
        pants = v['pants']

        def p(face, x, y, fw, fh):
            if face == 'bottom':
                return noisy(mul(SHOE, 0.8))
            if face == 'top':
                return noisy(pants)
            if y >= 10:
                return noisy(SHOE if y == 10 else mul(SHOE, 1.3))
            if (face, x, y) == hole:
                return noisy(skin)
            if y in (4, 5) and face == 'front':
                return noisy(mul(pants, 0.85))  # worn knees
            return shaded(pants, y, fh)
        return p

    paint_box(cv, 0, 16, 4, 12, 4, leg_painter(idx * 13 + 1))
    paint_box(cv, 16, 48, 4, 12, 4, leg_painter(idx * 13 + 2))

    # ------------------------------------------------------------------ jacket overlay: torn lab coat
    tear = {f: [rnd.choice((0, 0, 1, 1, 2, 3)) for _ in range(8)] for f in ('front', 'back', 'left', 'right')}
    coat_holes = set()
    for _ in range(4):
        f = rnd.choice(('back', 'back', 'left', 'right', 'front'))
        cx, cy = rnd.randrange(1, 7 if f in ('front', 'back') else 3), rnd.randrange(2, 9)
        coat_holes.add((f, cx, cy))
        if rnd.random() < 0.6:
            coat_holes.add((f, cx + 1, cy))
        if rnd.random() < 0.5:
            coat_holes.add((f, cx, cy + 1))
    stains = {}
    for _ in range(6):
        f = rnd.choice(('front', 'back', 'left', 'right'))
        col = rnd.choice(STAINS)
        cx, cy = rnd.randrange(8), rnd.randrange(3, 11)
        for dx, dy in ((0, 0), (1, 0), (0, 1), (-1, 1)):
            if rnd.random() < 0.75:
                stains[(f, cx + dx, cy + dy)] = col
    accent = v['eye']

    def jacket(face, x, y, fw, fh):
        if face == 'bottom':
            return None
        if face == 'top':
            return noisy(COAT, 0.05)
        if y >= fh - tear[face][x % 8]:
            return None  # ragged hem
        if (face, x, y) in coat_holes:
            return None
        if face == 'front':
            if 3 <= x <= 4 and y >= 2:
                return None  # coat hangs open
            if y <= 2 and x in (2, 5):
                return noisy(COAT_SHADE, 0.04)  # lapels
            if x == 1 and y in (3, 4):
                return accent if y == 3 else (236, 236, 236)  # ID badge with the variant stripe
            if x in (5, 6) and y == 6:
                return noisy(COAT_SHADE, 0.04)  # pocket edge
        if (face, x, y) in stains:
            return noisy(stains[(face, x, y)], 0.1)
        if x == 0 or x == fw - 1:
            return noisy(COAT_SHADE, 0.04)
        return shaded(COAT, y, fh, 0.04)

    paint_box(cv, 16, 32, 8, 12, 4, jacket)

    # ------------------------------------------------------------------ sleeves: torn off at uneven heights
    def sleeve_painter(lo, hi):
        cut = {f: [rnd.randrange(lo, hi + 1) for _ in range(4)] for f in ('front', 'back', 'left', 'right')}

        def p(face, x, y, fw, fh):
            if face == 'top':
                return noisy(COAT, 0.05)
            if face == 'bottom':
                return None
            if y >= cut[face][x]:
                return None
            if y == cut[face][x] - 1:
                return noisy(COAT_SHADE, 0.05)  # frayed edge
            return shaded(COAT, y, fh, 0.04)
        return p

    paint_box(cv, 40, 32, 4, 12, 4, sleeve_painter(2, 4))   # right: ripped by the swollen arm
    paint_box(cv, 48, 48, 4, 12, 4, sleeve_painter(4, 8))   # left

    # ------------------------------------------------------------------ pants overlay: shredded flaps
    def pants_painter(seed):
        r2 = random.Random(seed)
        flaps = {(f, x) for f in ('front', 'back', 'left', 'right') for x in range(4) if r2.random() < 0.3}
        col = mul(v['pants'], 0.85)

        def p(face, x, y, fw, fh):
            if face in ('top', 'bottom'):
                return None
            if (face, x) in flaps and 6 <= y <= 9:
                return noisy(col)
            return None
        return p

    paint_box(cv, 0, 32, 4, 12, 4, pants_painter(idx * 31 + 5))
    paint_box(cv, 0, 48, 4, 12, 4, pants_painter(idx * 31 + 6))

    # ------------------------------------------------------------------ hat overlay: spiky hair for the Blur
    if v['mark'] == 'lightning':
        def hat(face, x, y, fw, fh):
            if face == 'top':
                return noisy(hair, 0.12) if rnd.random() < 0.55 else None
            if face == 'bottom':
                return None
            if face == 'back' and y <= 3 and rnd.random() < 0.6:
                return noisy(hair, 0.12)
            if face in ('right', 'left') and y <= 1 and rnd.random() < 0.6:
                return noisy(hair, 0.12)
            if face == 'front' and y == 0 and rnd.random() < 0.5:
                return noisy(hair, 0.12)
            return None
        paint_box(cv, 32, 0, 8, 8, 8, hat)

    # ------------------------------------------------------------------ glowing crystal shards
    def shard(face, x, y, fw, fh):
        if face == 'bottom':
            return mul(v['shard'], 0.5)
        if face == 'top':
            return (*v['shard_hi'], 0)
        t = y / max(1, fh - 1)
        c = mix(v['shard_hi'], v['shard'], t)
        if x == 0:
            c = mul(c, 0.82)
        return (*c, 0)

    paint_box(cv, 56, 16, 2, 4, 2, shard)
    paint_box(cv, 56, 24, 2, 3, 2, shard)
    paint_box(cv, 56, 32, 2, 3, 2, shard)
    return cv


# ================================================================================== meteor
def meteor():
    rnd = random.Random(4242)
    W = 64
    pts = []
    while len(pts) < 30:  # well separated cell centres (no sliver cells / blobs of glow)
        c = (rnd.uniform(0, W), rnd.uniform(0, W))
        if all(min(abs(c[0] - q[0]), W - abs(c[0] - q[0])) ** 2 + min(abs(c[1] - q[1]), W - abs(c[1] - q[1])) ** 2 > 81 for q in pts):
            pts.append(c)
    crust = [(52, 44, 40), (44, 37, 34), (62, 52, 46), (34, 29, 27)]
    cv = Canvas(W, W)
    for y in range(W):
        for x in range(W):
            ds = []
            for px, py in pts:
                dx = min(abs(x + 0.5 - px), W - abs(x + 0.5 - px))
                dy = min(abs(y + 0.5 - py), W - abs(y + 0.5 - py))
                ds.append(math.hypot(dx, dy))
            ds.sort()
            edge = ds[1] - ds[0] + (rnd.random() - 0.5) * 0.5
            if edge < 0.55:
                cv.set(x, y, (255, 214, 104), 0)           # white-hot crack core
            elif edge < 1.25:
                cv.set(x, y, (255, 120 + rnd.randrange(20), 30), 0)  # glowing crack
            elif edge < 2.4:
                t = (edge - 1.25) / 1.15
                cv.set(x, y, mix((120, 46, 22), crust[0], t))  # heated rim (lit)
            else:
                c = crust[rnd.randrange(len(crust))] if rnd.random() < 0.35 else crust[0]
                c = mul(c, 1.0 + (rnd.random() - 0.5) * 0.16 - min(0.18, (edge - 2.4) * 0.03))
                if rnd.random() < 0.012:
                    cv.set(x, y, (255, 150, 52), 0)        # ember speck
                else:
                    cv.set(x, y, c)
    return cv


# =========================================================================== debris chunks
def debris_grass():
    rnd = random.Random(77)
    dirt = [(134, 96, 67), (121, 85, 58), (150, 108, 74), (96, 67, 46), (109, 77, 52)]
    green = [(89, 148, 52), (106, 170, 62), (78, 128, 44), (98, 160, 56)]
    cv = Canvas(16, 16)
    drip = [rnd.choice((3, 3, 4, 4, 5, 6)) for _ in range(16)]
    for y in range(16):
        for x in range(16):
            if y < drip[x]:
                c = green[rnd.randrange(len(green))]
                if y == drip[x] - 1:
                    c = mul(c, 0.85)
            else:
                c = dirt[rnd.randrange(len(dirt))] if rnd.random() < 0.5 else dirt[0]
            cv.set(x, y, c)
    return cv


def debris_magma():
    rnd = random.Random(31)
    cv = Canvas(16, 16)
    pts = [(rnd.uniform(0, 16), rnd.uniform(0, 16)) for _ in range(7)]
    for y in range(16):
        for x in range(16):
            ds = sorted(math.hypot(min(abs(x + 0.5 - px), 16 - abs(x + 0.5 - px)), min(abs(y + 0.5 - py), 16 - abs(y + 0.5 - py))) for px, py in pts)
            edge = ds[1] - ds[0]
            if edge < 0.7:
                c = (88, 26, 12)
            elif ds[0] < 1.6:
                c = (255, 168, 58) if ds[0] < 0.9 else (232, 110, 30)
            else:
                c = (150, 56, 22) if rnd.random() < 0.5 else (126, 44, 18)
            cv.set(x, y, mul(c, 1.0 + (rnd.random() - 0.5) * 0.1))
    return cv


def generate():
    for i in range(4):
        mutant_skin(i).save(os.path.join(TEX, f'rogue_mutant_{i}.png'))
    meteor().save(os.path.join(TEX, 'meteor.png'))
    debris_grass().save(os.path.join(TEX, 'debris_grass.png'))
    debris_magma().save(os.path.join(TEX, 'debris_magma.png'))
    print('entity art written to', os.path.relpath(TEX, ROOT))


# =============================================================================== validator
HUMANOID_BONES = {'root', 'waist', 'body', 'head', 'hat', 'cape', 'leftarm', 'rightarm', 'leftsleeve',
                  'rightsleeve', 'leftitem', 'rightitem', 'leftleg', 'rightleg', 'leftpants', 'rightpants', 'jacket'}
# vanilla animations used by the client entities (verified against the vanilla RP when --vanilla is given)
VANILLA_ANIMS = {'animation.humanoid.base_pose', 'animation.humanoid.look_at_target.default', 'animation.humanoid.move',
                 'animation.humanoid.bob', 'animation.humanoid.attack.rotations'}
PLAYER_LOOPS = ['flight.hover', 'flight.cruise', 'flight.carry', 'strength.charge', 'strength.lift', 'strength.dash',
                'heat.beam', 'speed.run', 'esper.channel']
PLAYER_ONESHOTS = ['strength.leap', 'strength.throw', 'strength.clap', 'speed.blitz', 'esper.cast', 'esper.barrier', 'inject']
OWN_ENTITIES = {'sp:debris': 'debris', 'sp:meteor': 'meteor', 'sp:rogue_mutant': 'rogue_mutant'}


def pixels(im):
    """Flat list of RGBA tuples (Pillow 11+ deprecates getdata)."""
    f = getattr(im, 'get_flattened_data', None)
    return list(f() if f else im.getdata())


def load_json_c(path):
    raw = open(path, encoding='utf-8-sig').read()
    raw = re.sub(r'^\s*//.*$', '', raw, flags=re.M)
    return json.loads(raw)


def check(vanilla):
    errors, warns = [], []
    E, Wn = errors.append, warns.append

    def jload(path):
        try:
            return load_json_c(path)
        except Exception as e:  # noqa: BLE001
            E(f'JSON error {os.path.relpath(path, ROOT)}: {e}')
            return None

    def tex_file(rel):
        for ext in ('.png', '.tga'):
            p = os.path.join(RP, rel + ext)
            if os.path.exists(p):
                return p
        return None

    # ---------------------------------------------------------------- vanilla reference data
    vanilla_tex, vanilla_anims = set(), set()
    if vanilla:
        tt = os.path.join(vanilla, 'textures', 'terrain_texture.json')
        if os.path.exists(tt):
            for v in load_json_c(tt).get('texture_data', {}).values():
                t = v.get('textures')
                for it in (t if isinstance(t, list) else [t]):
                    if isinstance(it, str):
                        vanilla_tex.add(it)
                    elif isinstance(it, dict) and 'path' in it:
                        vanilla_tex.add(it['path'])
        for d, _, files in os.walk(os.path.join(vanilla, 'animations')):
            for fn in files:
                try:
                    vanilla_anims.update(load_json_c(os.path.join(d, fn)).get('animations', {}).keys())
                except Exception:  # noqa: BLE001
                    pass
        for a in sorted(VANILLA_ANIMS):
            if vanilla_anims and a not in vanilla_anims:
                E(f'vanilla animation {a} not found in {vanilla}')

    # ---------------------------------------------------------------- geometry
    geos = {}
    gdir = os.path.join(RP, 'models', 'entity')
    for fn in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        d = jload(os.path.join(gdir, fn))
        if not d:
            continue
        for g in d.get('minecraft:geometry', []):
            desc = g['description']
            gid, tw, th = desc['identifier'], desc.get('texture_width', 64), desc.get('texture_height', 64)
            bones = {}
            for b in g.get('bones', []):
                bones[b['name'].lower()] = b
            for b in g.get('bones', []):
                if b.get('parent') and b['parent'].lower() not in bones:
                    E(f'{gid}: bone {b["name"]} has unknown parent {b["parent"]}')
                for c in b.get('cubes', []):
                    uv = c.get('uv')
                    sx, sy, sz = (math.floor(v) for v in c['size'])
                    if isinstance(uv, list):
                        u, v = uv
                        if u < 0 or v < 0 or u + 2 * (sz + sx) > tw or v + sz + sy > th:
                            E(f'{gid}: bone {b["name"]} box UV {uv} size {c["size"]} outside {tw}x{th}')
                    elif isinstance(uv, dict):
                        for face, fu in uv.items():
                            (u, v), (su, sv) = fu['uv'], fu['uv_size']
                            if min(u, u + su) < 0 or max(u, u + su) > tw or min(v, v + sv) < 0 or max(v, v + sv) > th:
                                E(f'{gid}: bone {b["name"]} face {face} UV outside {tw}x{th}')
            geos[gid] = {'tw': tw, 'th': th, 'bones': bones}

    # ---------------------------------------------------------------- animations / controllers
    anims = {}
    for fn in sorted(os.listdir(os.path.join(RP, 'animations'))):
        d = jload(os.path.join(RP, 'animations', fn))
        if d:
            for k, v in d.get('animations', {}).items():
                if k in anims:
                    E(f'duplicate animation {k}')
                anims[k] = (fn, v)
    ctrls = {}
    for fn in sorted(os.listdir(os.path.join(RP, 'animation_controllers'))):
        d = jload(os.path.join(RP, 'animation_controllers', fn))
        if d:
            ctrls.update(d.get('animation_controllers', {}))
    rcs = {}
    for fn in sorted(os.listdir(os.path.join(RP, 'render_controllers'))):
        d = jload(os.path.join(RP, 'render_controllers', fn))
        if d:
            rcs.update(d.get('render_controllers', {}))

    for k, (fn, a) in anims.items():
        for bone, chans in a.get('bones', {}).items():
            for ch, val in chans.items():
                if ch not in ('rotation', 'position', 'scale', 'relative_to'):
                    E(f'{k}: bone {bone} unknown channel {ch}')
                frames = val.values() if isinstance(val, dict) and ch != 'relative_to' else [val]
                for fr in frames:
                    if ch in ('rotation', 'position') and not (isinstance(fr, list) and len(fr) == 3):
                        E(f'{k}: bone {bone} {ch} must be a 3-vector')
                if isinstance(val, dict) and ch != 'relative_to':
                    times = [float(t) for t in val]
                    if a.get('animation_length') and max(times) > a['animation_length'] + 1e-6:
                        E(f'{k}: keyframe after animation_length')

    # ---------------------------------------------------------------- player animations
    doc = open(os.path.join(ROOT, 'docs', 'ARCHITECTURE.md'), encoding='utf-8').read()
    sec = doc.split('### Player animations', 1)[-1].split('###', 1)[0]
    required = set(re.findall(r'`(animation\.sp\.[a-z_.]+)`', sec))
    required.update(f'animation.sp.{n}' for n in PLAYER_LOOPS + PLAYER_ONESHOTS)
    required.add('animation.sp.reset')
    scripts = ''
    for d, _, files in os.walk(os.path.join(BP, 'scripts')):
        for fn in files:
            if fn.endswith('.js'):
                scripts += open(os.path.join(d, fn), encoding='utf-8').read()
    used = set(re.findall(r"['\"](animation\.sp\.[a-z0-9_.]+)['\"]", scripts))
    for a in sorted(required | used):
        if a not in anims:
            E(f'animation {a} missing (required by docs or used by scripts)')
    for k, (fn, a) in anims.items():
        if fn != 'sp_player.animation.json':
            continue
        for bone in a.get('bones', {}):
            if bone.lower() not in HUMANOID_BONES:
                E(f'{k}: bone {bone} not in geometry.humanoid.custom')
        name = k[len('animation.sp.'):]
        if name in PLAYER_LOOPS and a.get('loop') is not True:
            E(f'{k}: pose must loop')
        if name in PLAYER_ONESHOTS:
            ln = a.get('animation_length', 0)
            if a.get('loop') is not False or not 0.3 <= ln <= 0.8:
                E(f'{k}: one-shot must have loop false and a 0.3-0.8 s length (got {a.get("loop")}, {ln})')
        if name == 'reset' and (a.get('loop') is not False or abs(a.get('animation_length', 0) - 0.05) > 1e-6):
            E(f'{k}: must be a 0.05 s one-shot')
        if name != 'reset' and 'is_first_person' not in json.dumps(a):
            E(f'{k}: not neutralised in first person')

    # ---------------------------------------------------------------- client entities
    cfg = open(os.path.join(BP, 'scripts', 'config.js'), encoding='utf-8').read()
    m = re.search(r'DEBRIS_TEXTURES = \[([^\]]+)\]', cfg)
    debris_order = re.findall(r"'([a-z_]+)'", m.group(1)) if m else []
    for eid, short in OWN_ENTITIES.items():
        p = os.path.join(RP, 'entity', f'{short}.entity.json')
        if not os.path.exists(p):
            E(f'client entity missing: {p}')
            continue
        d = jload(p)
        if not d:
            continue
        desc = d['minecraft:client_entity']['description']
        if desc.get('identifier') != eid:
            E(f'{p}: identifier {desc.get("identifier")} != {eid}')
        geo_ids = list(desc.get('geometry', {}).values())
        geo = None
        for g in geo_ids:
            if g not in geos:
                E(f'{eid}: geometry {g} not defined')
            else:
                geo = geos[g]
        for key, path in desc.get('textures', {}).items():
            f = tex_file(path)
            if f:
                if geo and path.startswith('textures/entity/'):
                    from PIL import Image
                    size = Image.open(f).size
                    if size != (geo['tw'], geo['th']):
                        E(f'{eid}: texture {path} is {size}, geometry expects {geo["tw"]}x{geo["th"]}')
            elif path.startswith('textures/blocks/') and (not vanilla_tex or path in vanilla_tex):
                if not vanilla_tex:
                    Wn(f'{eid}: {path} assumed vanilla (pass --vanilla to verify)')
            else:
                E(f'{eid}: texture {key} -> {path} not found in pack or vanilla')
        amap = desc.get('animations', {})
        for key, aid in amap.items():
            if aid.startswith('controller.'):
                if aid not in ctrls:
                    E(f'{eid}: controller {aid} not defined')
                    continue
                for sname, st in ctrls[aid].get('states', {}).items():
                    for an in st.get('animations', []):
                        an = an if isinstance(an, str) else list(an)[0]
                        if an not in amap:
                            E(f'{eid}: controller {aid} state {sname} plays unknown key {an}')
                    for tr in st.get('transitions', []):
                        for target in tr:
                            if target not in ctrls[aid]['states']:
                                E(f'{eid}: controller {aid} transition to unknown state {target}')
                if ctrls[aid].get('initial_state', 'default') not in ctrls[aid]['states']:
                    E(f'{aid}: initial_state missing')
            elif aid in anims:
                if geo:
                    for bone in anims[aid][1].get('bones', {}):
                        if bone.lower() not in geo['bones']:
                            E(f'{eid}: animation {aid} bone {bone} not in geometry')
            elif aid in VANILLA_ANIMS:
                if geo:
                    for b in ('head', 'body', 'leftarm', 'rightarm', 'leftleg', 'rightleg', 'waist'):
                        if b not in geo['bones']:
                            E(f'{eid}: vanilla humanoid animation {aid} needs bone {b}')
            else:
                E(f'{eid}: animation {aid} not defined')
        for entry in desc.get('scripts', {}).get('animate', []):
            key = entry if isinstance(entry, str) else list(entry)[0]
            if key not in amap:
                E(f'{eid}: animate entry {key} not in animations')
        for rc in desc.get('render_controllers', []):
            name = rc if isinstance(rc, str) else list(rc)[0]
            r = rcs.get(name)
            if not r:
                E(f'{eid}: render controller {name} missing')
                continue
            arrays = r.get('arrays', {}).get('textures', {})
            for arr, items in arrays.items():
                for it in items:
                    if it.split('.', 1)[1] not in desc.get('textures', {}):
                        E(f'{name}: {arr} references unknown {it}')
            for t in r.get('textures', []):
                base = t.split('[', 1)[0]
                if base.startswith('Texture.') and base[8:] not in desc.get('textures', {}):
                    E(f'{name}: unknown texture {t}')
                if base.startswith('Array.') and base not in arrays:
                    E(f'{name}: unknown array {t}')
            for mm in r.get('materials', []):
                for bone, mat in mm.items():
                    if mat.split('.', 1)[1] not in desc.get('materials', {}):
                        E(f'{name}: unknown material {mat}')
                    if bone != '*' and geo and bone.lower() not in geo['bones']:
                        E(f'{name}: material bone {bone} not in geometry')
            if eid == 'sp:debris':
                keys = list(desc['textures'].keys())
                if keys != debris_order:
                    E(f'debris texture keys {keys} != config DEBRIS_TEXTURES {debris_order}')
                arr = [x.split('.', 1)[1] for x in arrays.get('Array.skins', [])]
                if arr != debris_order:
                    E('debris Array.skins order differs from DEBRIS_TEXTURES')
                if r.get('textures') != ["Array.skins[query.property('sp:tex')]"]:
                    E('debris render controller must select Array.skins[query.property(\'sp:tex\')]')
            if eid == 'sp:rogue_mutant' and r.get('textures') != ['Array.skins[query.variant]']:
                E('rogue mutant render controller must select by query.variant')
        if eid in ('sp:debris', 'sp:meteor') and desc.get('scripts', {}).get('scale') != "query.property('sp:size')":
            E(f'{eid}: scripts.scale must be query.property(\'sp:size\')')

    # ---------------------------------------------------------------- texture content rules
    from PIL import Image
    for i in range(4):
        p = os.path.join(TEX, f'rogue_mutant_{i}.png')
        if not os.path.exists(p):
            E(f'missing {p}')
            continue
        im = Image.open(p).convert('RGBA')
        glow = sum(1 for px in pixels(im) if px[3] == 0 and px[:3] != (0, 0, 0))
        if glow < 8:
            E(f'{p}: no emissive (alpha 0, coloured) pixels')
        eyes = [im.getpixel((8 + x, 12)) for x in (1, 2, 5, 6)]
        if any(e[3] != 0 for e in eyes):
            E(f'{p}: eye pixels are not emissive')
        # overlay layers (alphatest) must be binary alpha
        for (u, v, w, h) in ((32, 0, 32, 16), (16, 32, 24, 16), (40, 32, 16, 16), (48, 48, 16, 16), (0, 32, 16, 16), (0, 48, 16, 16)):
            for y in range(v, v + h):
                for x in range(u, u + w):
                    a = im.getpixel((x, y))[3]
                    if a not in (0, 255):
                        E(f'{p}: overlay pixel ({x},{y}) has partial alpha {a}')
                        break
    p = os.path.join(TEX, 'meteor.png')
    if os.path.exists(p):
        im = Image.open(p).convert('RGBA')
        if any(px == (0, 0, 0, 0) for px in pixels(im)):
            E('meteor.png has fully transparent pixels (would be discarded)')
        if sum(1 for px in pixels(im) if px[3] == 0) < 200:
            E('meteor.png has too few glowing pixels')

    # ---------------------------------------------------------------- behavior side
    bpd = {}
    for short in ('debris', 'meteor', 'rogue_mutant'):
        d = jload(os.path.join(BP, 'entities', f'{short}.json'))
        if d:
            bpd[short] = d['minecraft:entity']
    if 'debris' in bpd:
        props = bpd['debris']['description'].get('properties', {})
        if props.get('sp:tex', {}).get('range') != [0, 31] or not props.get('sp:tex', {}).get('client_sync'):
            E('debris sp:tex must be int [0,31] client_sync')
        if props.get('sp:size', {}).get('range') != [0.25, 4.0] or not props.get('sp:size', {}).get('client_sync'):
            E('debris sp:size must be float [0.25,4] client_sync')
        if len(debris_order) > 32:
            E('more debris textures than sp:tex range')
    if 'meteor' in bpd:
        props = bpd['meteor']['description'].get('properties', {})
        if props.get('sp:size', {}).get('range') != [0.5, 6.0] or not props.get('sp:size', {}).get('client_sync'):
            E('meteor sp:size must be float [0.5,6] client_sync')
    if 'rogue_mutant' in bpd:
        e = bpd['rogue_mutant']
        values = sorted(g.get('minecraft:variant', {}).get('value', -1) for g in e.get('component_groups', {}).values())
        if values != [0, 1, 2, 3]:
            E(f'rogue mutant variant groups {values} != [0,1,2,3]')
        if 'minecraft:burns_in_daylight' in e['components']:
            E('rogue mutant must not burn in daylight')
        table = e['components'].get('minecraft:loot', {}).get('table')
        if not table or not os.path.exists(os.path.join(BP, table)):
            E(f'rogue mutant loot table {table} missing')
        else:
            items = set()
            for d2, _, files in os.walk(os.path.join(BP, 'items')):
                for fn in files:
                    it = jload(os.path.join(d2, fn))
                    if it:
                        items.add(it['minecraft:item']['description']['identifier'])
            for pool in jload(os.path.join(BP, table)).get('pools', []):
                for en in pool.get('entries', []):
                    if en.get('name', '').startswith('sp:') and en['name'] not in items:
                        E(f'loot table item {en["name"]} not defined')
        sr = jload(os.path.join(BP, 'spawn_rules', 'rogue_mutant.json'))
        if sr and sr['minecraft:spawn_rules']['description']['identifier'] != 'sp:rogue_mutant':
            E('spawn rule identifier mismatch')

    # ---------------------------------------------------------------- fog
    fog = jload(os.path.join(RP, 'fogs', 'sp_time_dilation.json'))
    if fog:
        fs = fog.get('minecraft:fog_settings', {})
        if fs.get('description', {}).get('identifier') != 'sp:time_dilation':
            E('fog identifier must be sp:time_dilation')
        for medium in ('air', 'water'):
            m2 = fs.get('distance', {}).get(medium, {})
            if not all(k in m2 for k in ('fog_start', 'fog_end', 'fog_color', 'render_distance_type')):
                E(f'fog distance.{medium} incomplete')

    for w in warns:
        print('WARN ', w)
    for e in errors:
        print('ERROR', e)
    print(f'gen_entity_art --check: {len(errors)} error(s), {len(warns)} warning(s); geometries={len(geos)} '
          f'animations={len(anims)} controllers={len(ctrls)} render_controllers={len(rcs)}')
    return 1 if errors else 0


if __name__ == '__main__':
    if '--check' in sys.argv:
        van = None
        if '--vanilla' in sys.argv:
            van = sys.argv[sys.argv.index('--vanilla') + 1]
        sys.exit(check(van))
    generate()
