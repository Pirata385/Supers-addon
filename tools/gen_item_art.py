#!/usr/bin/env python3
"""Pixel-art generator for Superpowers & Mutants: item, block, UI, glyph-font and pack-icon textures.

Every PNG is drawn from code (no external assets) and regenerated deterministically:

    python3 tools/gen_item_art.py                 # (re)write every PNG + atlas json files
    python3 tools/gen_item_art.py --check         # verify every texture referenced by the packs exists
    python3 tools/gen_item_art.py --preview DIR   # also write upscaled contact sheets for review

Style: vanilla Minecraft - 16x16 items with dark 1 px outlines, small palettes, light from the
top-left. UI icons are 32x32 pixel art upscaled 2x (64x64), pack icons 64x64 upscaled 4x.
"""
import argparse
import json
import math
import os
import random
import re
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BP = os.path.join(ROOT, 'packs', 'SuperpowersBP')
RP = os.path.join(ROOT, 'packs', 'SuperpowersRP')

POWERS = ['strength', 'flight', 'heat_vision', 'speedster', 'esper']


# =================================================================== colour helpers
def C(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3)) + (a[3],)


WHITE = C('#ffffff')
BLACK = C('#000000')


def lighter(c, t):
    return mix(c, WHITE, t)


def darker(c, t):
    return mix(c, BLACK, t)


def with_alpha(c, a):
    return c[:3] + (int(a),)


# =================================================================== canvas
class Canvas:
    """Tiny RGBA pixel canvas (y down)."""

    def __init__(self, w, h=None):
        self.w = w
        self.h = h or w
        self.a = np.zeros((self.h, self.w, 4), np.uint8)

    def copy(self):
        c = Canvas(self.w, self.h)
        c.a = self.a.copy()
        return c

    def inb(self, x, y):
        return 0 <= x < self.w and 0 <= y < self.h

    def px(self, x, y, c):
        if c is not None and self.inb(x, y):
            self.a[y, x] = c

    def get(self, x, y):
        return tuple(int(v) for v in self.a[y, x])

    def on(self, x, y):
        return self.inb(x, y) and self.a[y, x, 3] > 0

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.px(x, y, c)

    def fill_fn(self, fn):
        for y in range(self.h):
            for x in range(self.w):
                c = fn(x, y)
                if c is not None:
                    self.px(x, y, c)

    def disc(self, cx, cy, r, c):
        self.fill_fn(lambda x, y: c if (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r else None)

    def poly(self, pts, c):
        self.fill_fn(lambda x, y: c if point_in_poly(x + .5, y + .5, pts) else None)

    def line(self, x0, y0, x1, y1, c, w=1):
        x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        while True:
            for oy in range(w):
                for ox in range(w):
                    self.px(x0 + ox, y0 + oy, c)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def chars(self, rows, pal, ox=0, oy=0):
        for j, row in enumerate(rows):
            for i, ch in enumerate(row):
                if ch in pal and pal[ch] is not None:
                    self.px(ox + i, oy + j, pal[ch])

    def blit(self, other, ox, oy):
        for y in range(other.h):
            for x in range(other.w):
                if other.a[y, x, 3] > 0:
                    self.px(ox + x, oy + y, tuple(int(v) for v in other.a[y, x]))

    def mask(self):
        return self.a[:, :, 3] > 0

    def outline(self, c, diag=False, mask=None):
        """Add a 1 px outline around opaque pixels (on transparent pixels only)."""
        m = self.mask() if mask is None else mask
        out = np.zeros_like(m)
        nb = [(-1, 0), (1, 0), (0, -1), (0, 1)]
        if diag:
            nb += [(-1, -1), (1, -1), (-1, 1), (1, 1)]
        for dx, dy in nb:
            sh = np.zeros_like(m)
            ys = slice(max(0, dy), self.h + min(0, dy))
            yd = slice(max(0, -dy), self.h + min(0, -dy))
            xs = slice(max(0, dx), self.w + min(0, dx))
            xd = slice(max(0, -dx), self.w + min(0, -dx))
            sh[yd, xd] = m[ys, xs]
            out |= sh
        out &= ~self.mask()
        self.a[out] = c
        return self

    def bevel(self, light, dark, mask=None, inset=False):
        """Lighten top/left edge pixels and darken bottom/right edge pixels of a region."""
        m = self.mask() if mask is None else mask
        res = self.a.copy()
        for y in range(self.h):
            for x in range(self.w):
                if not m[y, x]:
                    continue
                up = y == 0 or not m[y - 1, x]
                left = x == 0 or not m[y, x - 1]
                down = y == self.h - 1 or not m[y + 1, x]
                right = x == self.w - 1 or not m[y, x + 1]
                if (up or left) and not (down or right):
                    res[y, x] = light if not inset else dark
                elif (down or right) and not (up or left):
                    res[y, x] = dark if not inset else light
        self.a = res
        return self

    def recolor(self, src, dst):
        m = np.all(self.a == np.array(src, np.uint8), axis=2)
        self.a[m] = dst
        return self

    def shifted(self, dx, dy):
        c = Canvas(self.w, self.h)
        c.blit(self, dx, dy)
        return c

    def scaled(self, n):
        c = Canvas(self.w * n, self.h * n)
        c.a = np.repeat(np.repeat(self.a, n, axis=0), n, axis=1)
        return c

    def image(self):
        return Image.fromarray(self.a, 'RGBA')

    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.image().save(path, format='PNG', optimize=True)


def point_in_poly(px, py, pts):
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def from_rows(rows, pal):
    w = max(len(r) for r in rows)
    cv = Canvas(w, len(rows))
    cv.chars(rows, pal)
    return cv


# =================================================================== palettes
OUTLINE = C('#1b1e29')
GLASS_L = C('#f2fbff')
GLASS_M = C('#bfe0ee')
GLASS_D = C('#86a8bd')
GLASS_E = C('#d9eef6')       # empty barrel interior
METAL_L = C('#f1f1f5')
METAL_M = C('#b6b7c4')
METAL_D = C('#787a8c')
RUBBER = C('#3a3a46')
NEEDLE_L = C('#f6f6fa')
NEEDLE_D = C('#8a8fa1')
GOLD_L = C('#fff3b0')
GOLD_M = C('#f0bf35')
GOLD_D = C('#a8700f')
GOLD_O = C('#3d2606')

# (light, base, dark) per liquid / power colour
LIQ = {
    'strength': (C('#ffd59a'), C('#ff961c'), C('#bd5405')),
    'flight': (C('#d4f4ff'), C('#5cc6ff'), C('#2273c0')),
    'heat_vision': (C('#ffae96'), C('#ff3a1c'), C('#9e1209')),
    'speedster': (C('#fff8b4'), C('#ffd51a'), C('#bb8c05')),
    'esper': (C('#f2ceff'), C('#bf5bff'), C('#7020be')),
    'suppressor': (C('#c9cad4'), C('#7d7f8e'), C('#4a4b59')),
    'mutagen': (C('#d8ffc2'), C('#5ce84a'), C('#23962f')),
    'magenta': (C('#ffc2f1'), C('#ff3fd2'), C('#a81688')),
}
# outline / deep tone per power (emblem discs, glyph outlines)
DEEP = {
    'strength': C('#4a1e00'),
    'flight': C('#0b2d52'),
    'heat_vision': C('#420604'),
    'speedster': C('#4a3500'),
    'esper': C('#2c0a4f'),
}


# =================================================================== items
def syringe(liquid=None, unstable=False):
    """16x16 diagonal syringe: needle bottom-left, plunger top-right.

    s = x - y runs along the syringe (needle -> plunger), t = x + y - 15 across it
    (negative = top-left side, lit)."""
    cv = Canvas(16)

    def shade3(t, l, m, d):
        return l if t < 0 else (m if t == 0 else d)

    fill_top = 2  # last liquid slice (s)
    for y in range(16):
        for x in range(16):
            s, t = x - y, x + y - 15
            col = None
            if -8 <= s <= -6 and abs(t) <= 1:                      # needle hub
                col = shade3(t, METAL_L, METAL_M, METAL_D)
            elif -5 <= s <= 5 and abs(t) <= 3:                     # glass barrel
                if abs(t) == 3:
                    col = GLASS_L if t < 0 else GLASS_D
                elif s == -5:
                    col = GLASS_M
                elif liquid and s <= fill_top:
                    if unstable:
                        pal = LIQ['magenta'] if ((s + 2 * t + 40) // 3) % 2 == 0 else LIQ['mutagen']
                    else:
                        pal = LIQ[liquid]
                    col = pal[0] if t == -2 else (pal[2] if t == 2 else pal[1])
                elif liquid and s == fill_top + 1:
                    col = RUBBER
                elif liquid and t == 0:
                    col = METAL_M                                     # plunger rod inside
                else:
                    col = GLASS_E if t <= 0 else GLASS_M
            elif 6 <= s <= 7 and abs(t) <= 5:                      # finger flange
                col = METAL_L if t < -1 else (METAL_M if t <= 1 else METAL_D)
            elif 8 <= s <= 10 and abs(t) <= 1:                     # plunger rod
                col = shade3(t, METAL_L, METAL_M, METAL_D)
            elif 11 <= s <= 12 and abs(t) <= 2:                    # thumb rest
                col = METAL_L if t < 0 else (METAL_M if t == 0 else METAL_D)
            if col:
                cv.px(x, y, col)
    cv.outline(OUTLINE)
    # glass glints on the lit wall
    for s in (-2, 0):
        t = -3
        cv.px((s + t + 15) // 2, (t - s + 15) // 2, WHITE)
    # needle (thin, no outline)
    for x, y in [(1, 14), (2, 13), (3, 12)]:
        cv.px(x, y, NEEDLE_L)
    for x, y in [(2, 14), (3, 13)]:
        cv.px(x, y, NEEDLE_D)
    cv.px(1, 14, WHITE)
    return cv


CRYSTAL_PAL = {
    'o': C('#0c3a17'), 'd': C('#1d8433'), 'm': C('#3ccf46'), 'l': C('#8bff6a'), 'w': C('#eaffdd'),
}


def mutagen_crystal():
    """Cluster of three faceted shards (lit face, ridge highlight, shaded faces)."""
    rows = [
        '................',
        '.......oo.......',
        '......owmo......',
        '......owmdo.....',
        '.....olwmdo.....',
        '.oo..olwmdo.....',
        '.owo.olwmdo..oo.',
        '.olwoolwmdo.omo.',
        '..olwolwmdoomdo.',
        '..olwolwmdoomdo.',
        '..olwolwmdoomdo.',
        '...olwolwmdomdo.',
        '...olwolwmdmdo..',
        '....oolwmdodo...',
        '.....oooooooo...',
        '................',
    ]
    return from_rows(rows, CRYSTAL_PAL)


def mutant_codex():
    cv = Canvas(16)
    cov_l, cov_m, cov_d = C('#4a3a78'), C('#33285a'), C('#1f1838')
    page_l, page_d = C('#f4ecd2'), C('#c9bd98')
    spine_l, spine_d = C('#5b2d2d'), C('#3a1a1a')
    o = C('#120d1f')
    # pages (right + bottom edge)
    cv.rect(4, 2, 14, 14, page_l)
    for y in range(3, 14, 2):
        cv.px(14, y, page_d)
    for x in range(5, 14, 2):
        cv.px(x, 14, page_d)
    # cover
    cv.rect(2, 1, 13, 13, cov_m)
    cv.rect(3, 1, 13, 1, cov_l)
    cv.rect(13, 2, 13, 13, cov_d)
    cv.rect(3, 13, 13, 13, cov_d)
    # spine
    cv.rect(1, 1, 2, 14, spine_d)
    cv.rect(1, 1, 1, 14, spine_l)
    for y in (3, 11):
        cv.px(1, y, GOLD_M)
        cv.px(2, y, GOLD_D)
    # gold corners
    for (x, y) in [(12, 2), (12, 12)]:
        cv.px(x, y, GOLD_M)
    cv.outline(o)
    # DNA helix on the cover (glowing)
    g1, g2, rung = C('#a8ff7a'), C('#46e04a'), C('#2a8a3a')
    cx = 7.5
    for i, y in enumerate(range(3, 12)):
        ph = i * (2 * math.pi / 8.0)
        xa = int(round(cx + 2.5 * math.sin(ph)))
        xb = int(round(cx - 2.5 * math.sin(ph)))
        if i % 2 == 1 and abs(xa - xb) > 1:
            for x in range(min(xa, xb) + 1, max(xa, xb)):
                cv.px(x, y, rung)
        front_a = math.cos(ph) >= 0
        cv.px(xb, y, g2 if front_a else g1)
        cv.px(xa, y, g1 if front_a else g2)
    return cv


# ------------------------------------------------------------------- symbols
# Emblem symbols (~11 px). Palette keys: o outline, w light, m base, d dark, k core, y hot
SYM10 = {
    'strength': [
        '..oo.oo.oo.',
        '.owwowwowwo',
        '.owmowmowmo',
        'oowmowmowmo',
        'owoooooomdo',
        'owwwwwwomdo',
        'ommmmmmomdo',
        'oooooooodo.',
        '.ommmmmmdo.',
        '..ommmmdo..',
        '...ooooo...',
    ],
    'flight': None,      # procedural (see glyph_wing(mini=True))
    'heat_vision': [
        '.ooooo.....',
        'owwwwwo....',
        'owmkmwoo...',
        'omkykmyyyyy',
        'owmkmwoo...',
        'owwwwwo....',
        '.ooooo.....',
    ],
    'speedster': [
        '.....oooo.',
        '....owwo..',
        '...owwo...',
        '..owwooo..',
        '.owwwwwwo.',
        '.oooowwo..',
        '...owwo...',
        '..owwo....',
        '..owo.....',
        '..oo......',
    ],
    'esper': [
        '.....w.....',
        '...oo.oo...',
        '..owwowwo..',
        'mowmwowmwom',
        'mowwmowwmom',
        'momwwowmdom',
        '..ommommo..',
        '...oooooo..',
    ],
}

# 16x16 glyph / UI symbols. Same palette keys plus y (hot core) / r (rim)
SYM16 = {
    'strength': [
        '.oo.oo.oo.oo.',
        'owwowwowwowwo',
        'owmowmowmowmo',
        'ommommommommo',
        'ommommommommo',
        'oooooooooommo',
        'owwwwwwwwomdo',
        'ommmmmmmmomdo',
        'oddddddddomdo',
        '.ooooooooommo',
        '.ommmmmmmmmmo',
        '.ommmmmmmmmdo',
        '..ommmmmmmdo.',
        '..ommmmmmmdo.',
        '..oddddddddo.',
        '..ooooooooo..',
    ],
    'flight': None,      # procedural (see glyph_wing)
    'heat_vision': [
        '......y......',
        '..y...y...y..',
        '...y.....y...',
        '....ooooo....',
        '..oowwwwwoo..',
        '.owwwmmmwwwo.',
        'owwwmkkkmwwwo',
        'owwmkyyykmwwo',
        'owwwmkkkmwwwo',
        '.owwwmmmwwwo.',
        '..oowwwwwoo..',
        '....ooooo....',
        '...y.....y...',
        '..y...y...y..',
        '......y......',
        '.............',
    ],
    'speedster': None,   # polygon (see glyph_bolt)
    'esper': None,       # procedural spiral (see glyph_swirl)
}


def sym_palette(power):
    l, m, d = LIQ[power]
    return {'o': DEEP[power], 'w': l, 'm': m, 'd': d, 'k': d, 'y': C('#fff4c2')}


def sym_canvas(power, size):
    if size == 10:
        if power == 'flight':
            return glyph_wing(mini=True)
        rows = SYM10[power]
        pal = sym_palette(power)
        if power == 'heat_vision':
            pal = dict(pal, w=WHITE, m=LIQ[power][1], k=LIQ[power][2], y=C('#ffd36a'))
        if power == 'esper':
            pal = dict(pal, m=LIQ[power][1])
        return from_rows(rows, pal)
    if power == 'flight':
        return glyph_wing()
    if power == 'speedster':
        return glyph_bolt()
    if power == 'esper':
        return glyph_swirl()
    pal = sym_palette(power)
    if power == 'heat_vision':
        pal = dict(pal, w=WHITE, m=LIQ[power][1], k=LIQ[power][2], y=C('#ffd36a'))
    return from_rows(SYM16[power], pal)


def _capsule(cv, ax, ay, bx, by, r, cols, taper=True):
    """Filled (optionally tapering) capsule from a to b; cols = (lit side, middle, shaded side)."""
    vx, vy = bx - ax, by - ay
    for y in range(cv.h):
        for x in range(cv.w):
            wx, wy = x + .5 - ax, y + .5 - ay
            t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
            dist = math.hypot(x + .5 - (ax + vx * t), y + .5 - (ay + vy * t))
            if dist <= (r * (1 - 0.35 * t) if taper else r):
                side = wx * vy - wy * vx
                cv.px(x, y, cols[0] if side < -0.5 else (cols[1] if side < 0.8 else cols[2]))


def glyph_wing(mini=False):
    """Angel wing: arched arm on top, feathers hanging down, longest at the wrist."""
    l, m, d = LIQ['flight']
    o = DEEP['flight']
    if mini:   # 11x11 emblem symbol
        size, r, ar = 11, 1.45, 1.1
        feathers = [(2.0, 2.6, 1.4, 10.0), (4.6, 2.6, 4.4, 9.0), (7.3, 3.0, 7.6, 7.6)]
        arm_pts = [(1.0, 2.8), (3.5, 1.6), (6.5, 1.5), (9.8, 2.8)]
    else:      # 16x16 glyph / UI symbol
        size, r, ar = 16, 1.9, 1.45
        feathers = [(2.6, 3.0, 1.6, 14.3), (5.9, 3.0, 5.4, 13.2), (9.2, 3.4, 9.3, 11.2), (12.4, 4.0, 13.0, 8.8)]
        arm_pts = [(1.0, 3.8), (4.0, 2.2), (8.0, 1.8), (12.0, 2.8), (15.0, 4.8)]
    cv = Canvas(size)
    for (ax, ay, bx, by) in reversed(feathers):
        f = Canvas(size)
        _capsule(f, ax, ay, bx, by, r, (l, m, m))
        f.outline(o)
        cv.blit(f, 0, 0)
    arm = Canvas(size)
    for (ax, ay), (bx, by) in zip(arm_pts, arm_pts[1:]):
        _capsule(arm, ax, ay, bx, by, ar, (WHITE, l, l), taper=False)
    arm.outline(o)
    cv.blit(arm, 0, 0)
    return cv


def glyph_bolt():
    l, m, d = LIQ['speedster']
    cv = Canvas(12, 16)
    pts = [(7.0, 0.0), (11.5, 0.0), (8.2, 5.6), (11.6, 5.6), (2.5, 16.0), (4.6, 8.4), (1.0, 8.4)]
    inner = Canvas(12, 16)
    inner.poly(pts, m)
    # light on the upper-left half, dark on the right
    for y in range(16):
        for x in range(12):
            if inner.on(x, y):
                cv.px(x, y, l if x + y * 0.35 < 7.2 else m)
    cv.bevel(l, d)
    # outline needs room: draw on a slightly larger canvas then crop
    big = Canvas(14, 18)
    big.blit(cv, 1, 1)
    big.outline(DEEP['speedster'])
    out = Canvas(13, 16)
    out.blit(big, 0, -1)   # crop back to the 16 px cell (tips touch the cell edges)
    return out


def glyph_swirl():
    l, m, d = LIQ['esper']
    cv = Canvas(16, 16)
    cx, cy = 7.5, 7.8
    pts = []
    th = 0.0
    while th < 3.4 * math.pi:
        r = 0.6 + 0.95 * th
        pts.append((cx + r * math.cos(th), cy + r * math.sin(th) * 0.95, th))
        th += 0.05
    for (x, y, th) in pts:
        k = th / (3.4 * math.pi)
        col = l if k < 0.35 else (m if k < 0.75 else d)
        for ox in (0, 1):
            for oy in (0, 1):
                xx, yy = int(math.floor(x - 0.5)) + ox, int(math.floor(y - 0.5)) + oy
                if 1 <= xx <= 14 and 1 <= yy <= 14 and not cv.on(xx, yy):
                    cv.px(xx, yy, col)
    cv.px(7, 7, WHITE)
    cv.px(8, 7, l)
    cv.outline(DEEP['esper'])
    return cv


def medallion(size, power, rim=(GOLD_L, GOLD_M, GOLD_D), outline_col=GOLD_O, rim_w=1.0):
    cv = Canvas(size)
    c = size / 2.0
    R = size / 2.0 - 0.02
    l, m, d = LIQ[power]
    base = darker(d, 0.35)
    for y in range(size):
        for x in range(size):
            dx, dy = x + .5 - c, y + .5 - c
            dist = math.hypot(dx, dy)
            if dist > R:
                continue
            lit = (-dx - dy) / (dist * math.sqrt(2)) if dist > 0 else 0
            if dist > R - 1:
                cv.px(x, y, outline_col)
            elif dist > R - 1 - rim_w:
                cv.px(x, y, rim[0] if lit > 0.35 else (rim[2] if lit < -0.35 else rim[1]))
            elif dist > R - 2 - rim_w:
                cv.px(x, y, darker(base, 0.45))
            else:
                k = (dx + dy) / (2 * c)  # -0.7 .. 0.7
                cv.px(x, y, mix(mix(base, d, 0.55), base, 0.5 + k))
    return cv


def emblem(power):
    cv = medallion(16, power)
    sym = sym_canvas(power, 10)
    ox = (16 - sym.w + 1) // 2
    oy = (16 - sym.h + 1) // 2
    cv.blit(sym, ox, oy)
    return cv


# =================================================================== glyph font
def glyph_hourglass():
    frame_l, frame_d = C('#e0c08a'), C('#8a6230')
    glass = C('#cfeaf5')
    sand = C('#ffd560')
    o = C('#2a1d10')
    cv = Canvas(12, 16)
    cv.rect(0, 0, 11, 1, frame_l)
    cv.rect(0, 14, 11, 15, frame_l)
    cv.rect(0, 1, 11, 1, frame_d)
    cv.rect(0, 15, 11, 15, frame_d)
    bulb = [(1.5, 2), (10.5, 2), (6.6, 8), (10.5, 14), (1.5, 14), (5.4, 8)]
    inner = Canvas(12, 16)
    inner.poly(bulb, glass)
    inner.outline(o)
    for y in range(2, 14):
        for x in range(12):
            if inner.on(x, y):
                cv.px(x, y, inner.get(x, y))
    # sand: small pile on top, falling stream, heap below
    for y in range(4, 6):
        for x in range(12):
            if inner.get(x, y) == glass:
                cv.px(x, y, sand)
    cv.px(5, 8, sand)
    cv.px(6, 9, sand)
    cv.px(5, 10, sand)
    for y in range(11, 14):
        for x in range(12):
            if inner.get(x, y) == glass and abs(x - 5.5) <= (y - 9.5) * 1.6:
                cv.px(x, y, sand)
    return cv


def glyph_check():
    g_l, g_m, g_d = C('#b4ff8c'), C('#4ee03c'), C('#1f8f2a')
    cv = Canvas(15, 16)
    pts = [(1, 8.5), (4, 6), (6.2, 9), (12, 2), (14.8, 4.5), (6.2, 14.5)]
    cv.poly(pts, g_m)
    cv.bevel(g_l, g_d)
    cv.outline(C('#0b3a12'))
    # spark
    s = C('#f4ffe6')
    for (x, y) in [(2, 1), (2, 2), (2, 3), (1, 2), (3, 2)]:
        cv.px(x, y, s)
    return cv


def glyph_star():
    y_l, y_m, y_d = C('#fffbe0'), C('#ffe14a'), C('#d39a0a')
    cv = Canvas(16, 16)
    pts = []
    for i in range(16):
        ang = -math.pi / 2 + i * math.pi / 8
        # long rays on the axes, shorter diagonal rays, narrow valleys between them
        r = 2.6 if i % 2 == 1 else (7.9 if i % 4 == 0 else 5.2)
        pts.append((7.5 + r * math.cos(ang), 7.8 + r * math.sin(ang)))
    cv.poly(pts, y_m)
    cv.bevel(y_l, y_d)
    cv.disc(7.5, 7.8, 1.8, WHITE)
    return cv


def glyph_bar(kind):
    cv = Canvas(6, 16)
    if kind == 'full':
        cv.rect(0, 3, 5, 12, WHITE)
    elif kind == 'empty':
        cv.rect(0, 3, 5, 3, WHITE)
        cv.rect(0, 12, 5, 12, WHITE)
        cv.rect(0, 3, 0, 12, WHITE)
        cv.rect(5, 3, 5, 12, WHITE)
    else:
        cv.rect(0, 3, 5, 3, WHITE)
        cv.rect(0, 12, 5, 12, WHITE)
        cv.rect(5, 3, 5, 12, WHITE)
        cv.rect(0, 3, 2, 12, WHITE)
    return cv


def glyph_arrow():
    cv = Canvas(7, 16)
    for i in range(5):
        cv.rect(i, 3 + i, i, 12 - i, WHITE)
    return cv


FLAME_ROWS = [
    '.....o.......',
    '....oyo......',
    '....oyyo.....',
    '...oyyyo..o..',
    '...oyyyyo.oo.',
    '..oyyyyyoowo.',
    '..oyywyyyowyo',
    '.oyywwwyyyyyo',
    '.oyywwwwyyymo',
    'oyywwwwwwyymo',
    'oyywwwwwwyymo',
    'omyywwwwyymmo',
    'ommyywwyymmdo',
    '.ommmyyymmdo.',
    '..oddmmmddo..',
    '...ooooooo...',
]


def glyph_flame():
    pal = {'o': C('#4a1004'), 'w': C('#fff6c8'), 'y': C('#ffb12e'), 'm': C('#ff6a12'), 'd': C('#c2280a')}
    return from_rows(FLAME_ROWS, pal)


SKULL_ROWS = [
    '...ooooooo...',
    '.oowwwwwwwoo.',
    'owwwwwwwwwwmo',
    'owwwwwwwwwwmo',
    'owwwwwwwwwmmo',
    'owoooowoooomo',
    'owogeowogeomo',
    'owoeeowoeeomo',
    'owwoowmwoowmo',
    '.owwwwowwwmo.',
    '..omwmmmwmo..',
    '..owowowowo..',
    '..omomomomo..',
    '...ooooooo...',
    '.............',
    '.............',
]


def glyph_skull():
    pal = {'o': C('#14240f'), 'w': C('#c9d9b4'), 'm': C('#8fa57a'), 'g': C('#eaffd0'), 'e': C('#4cff45')}
    return from_rows(SKULL_ROWS, pal)


LOCK_ROWS = [
    '...oooooo...',
    '..ommmmmmo..',
    '.ommoooommo.',
    '.omo....omo.',
    '.omo....omo.',
    '.omo....omo.',
    'oooooooooooo',
    'owwwwwwwwwwo',
    'owyyyyyyyydo',
    'owyyyooyyydo',
    'owyyyooyyydo',
    'owyyyyoyyydo',
    'owyyyyoyyydo',
    'owyyyyyyyydo',
    'oddddddddddo',
    'oooooooooooo',
]


def glyph_lock():
    pal = {'o': C('#2a1d10'), 'm': C('#c4c6d2'), 'w': GOLD_L, 'y': GOLD_M, 'd': GOLD_D}
    return from_rows(LOCK_ROWS, pal)


def glyph_syringe():
    s = syringe('mutagen')
    return s.shifted(-1, 0)


def glyph_font():
    cells = [
        sym_canvas('strength', 16), sym_canvas('flight', 16), sym_canvas('heat_vision', 16),
        glyph_bolt(), glyph_swirl(), glyph_hourglass(), glyph_check(), glyph_star(),
        glyph_bar('full'), glyph_bar('empty'), glyph_bar('half'), glyph_arrow(),
        glyph_flame(), glyph_syringe(), glyph_skull(), glyph_lock(),
    ]
    page = Canvas(256)
    for i, g in enumerate(cells):
        assert g.w <= 16 and g.h <= 16, (i, g.w, g.h)
        cx, cy = (i % 16) * 16, (i // 16) * 16
        # left-aligned (Bedrock sizes a glyph by its rightmost opaque column), vertically centred
        cols = np.nonzero(g.mask().any(axis=0))[0]
        ox = -int(cols[0]) if len(cols) else 0
        oy = (16 - g.h) // 2
        page.blit(g, cx + ox, cy + oy)
    return page, cells


# =================================================================== blocks
def meteorite_texture():
    rng = random.Random(4242)
    cv = Canvas(16)
    base = [C('#1d1a19'), C('#2a2624'), C('#36302d'), C('#433b37'), C('#524842')]
    # value noise
    grid = [[rng.random() for _ in range(5)] for _ in range(5)]

    def vn(x, y):
        gx, gy = x / 4.0, y / 4.0
        x0, y0 = int(gx), int(gy)
        fx, fy = gx - x0, gy - y0
        a = grid[y0 % 4][x0 % 4]
        b = grid[y0 % 4][(x0 + 1) % 4]
        c = grid[(y0 + 1) % 4][x0 % 4]
        d = grid[(y0 + 1) % 4][(x0 + 1) % 4]
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

    for y in range(16):
        for x in range(16):
            v = vn(x, y) * 0.7 + rng.random() * 0.3
            idx = min(4, int(v * 5))
            cv.px(x, y, base[idx])
    # pits (scorched craters)
    for (px_, py_) in [(3, 3), (12, 5), (6, 12), (13, 13)]:
        cv.px(px_, py_, C('#100e0d'))
        cv.px(px_ + 1, py_, base[3])
        cv.px(px_, py_ - 1, base[0])
    # glowing veins (tile-able random walks)
    vein_hi, vein, vein_d = C('#c8ff9a'), C('#5cf04a'), C('#1f7a2c')
    walks = [((0, 9), [(1, 0), (1, -1), (1, 0), (1, 0), (1, -1), (0, -1), (1, -1), (1, 0), (1, 0)]),
             ((15, 11), [(-1, 0), (-1, 1), (-1, 0), (-1, 1), (0, 1)]),
             ((9, 4), [(0, -1), (1, -1), (0, -1)]),
             ((4, 14), [(1, 0), (1, 1)])]
    vein_px = set()
    for (sx, sy), steps in walks:
        x, y = sx, sy
        vein_px.add((x, y))
        for dx, dy in steps:
            x, y = (x + dx) % 16, (y + dy) % 16
            vein_px.add((x, y))
    for (x, y) in vein_px:
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            n = ((x + dx) % 16, (y + dy) % 16)
            if n not in vein_px:
                cv.px(n[0], n[1], vein_d)
    for i, (x, y) in enumerate(sorted(vein_px)):
        cv.px(x, y, vein_hi if i % 4 == 0 else vein)
    # crystal nubs
    for (x, y) in [(10, 9), (2, 6)]:
        cv.px(x, y, vein_hi)
        cv.px(x + 1, y, vein)
        cv.px(x, y + 1, vein)
        cv.px(x + 1, y + 1, vein_d)
    return cv


TANK_METAL = (C('#d7dbe3'), C('#9ea4b3'), C('#666c7c'), C('#2e313b'))


def tank_side():
    l, m, d, o = TANK_METAL
    cv = Canvas(16)
    # glass + fluid preview (rows 3..12)
    fl, fm, fd = C('#a6ff8a'), C('#47d63e'), C('#23862c')
    for y in range(3, 13):
        for x in range(16):
            if x in (0, 15):
                cv.px(x, y, d)
            elif x in (1, 14):
                cv.px(x, y, with_alpha(GLASS_M, 200))
            elif y == 3:
                cv.px(x, y, with_alpha(GLASS_L, 160))
            else:
                cv.px(x, y, fl if y == 4 else (fd if (x * 7 + y * 3) % 11 == 0 else fm))
    for (x, y) in [(4, 10), (5, 7), (10, 11), (11, 6), (8, 9)]:
        cv.px(x, y, fl)
    # caps (rows 0..2 and 13..15)
    for y0 in (0, 13):
        cv.rect(0, y0, 15, y0 + 2, m)
        cv.rect(0, y0, 15, y0, l if y0 == 0 else m)
        cv.rect(0, y0 + 2, 15, y0 + 2, d)
        for x in (1, 5, 10, 14):
            cv.px(x, y0 + 1, l)
            cv.px(x + 0, y0 + 2, o if y0 == 13 else d)
    # hazard stripe on the bottom band
    for x in range(16):
        if (x // 2) % 2 == 0:
            cv.px(x, 14, C('#f2c230'))
        else:
            cv.px(x, 14, C('#2a2a30'))
    return cv


def tank_top():
    l, m, d, o = TANK_METAL
    cv = Canvas(16)
    cv.rect(0, 0, 15, 15, m)
    cv.rect(0, 0, 15, 0, l)
    cv.rect(0, 0, 0, 15, l)
    cv.rect(15, 0, 15, 15, d)
    cv.rect(0, 15, 15, 15, d)
    for (x, y) in [(2, 2), (13, 2), (2, 13), (13, 13)]:
        cv.px(x, y, l)
        cv.px(x + 1, y + 1, d)
    # hatch with glowing port
    cv.disc(8, 8, 4.6, d)
    cv.disc(8, 8, 3.6, C('#3a3f4c'))
    cv.disc(8, 8, 2.6, C('#47d63e'))
    cv.disc(7.4, 7.4, 1.2, C('#c8ff9a'))
    cv.rect(7, 2, 8, 3, d)
    cv.rect(7, 12, 8, 13, d)
    return cv


def tank_glass():
    cv = Canvas(16)
    edge = with_alpha(C('#dff4ff'), 150)
    pane = with_alpha(C('#bfe6f5'), 40)
    streak = with_alpha(C('#ffffff'), 140)
    cv.rect(0, 0, 15, 15, pane)
    for x in (1, 14):
        cv.rect(x, 0, x, 15, edge)
    for i in range(5):
        cv.px(3 + i, 11 - i * 2, streak)
        cv.px(3 + i, 12 - i * 2, streak)
    for i in range(3):
        cv.px(10 + i, 9 - i * 2, with_alpha(WHITE, 90))
    return cv


def tank_fluid():
    rng = random.Random(77)
    cv = Canvas(16)
    fl, fm, fd = C('#9cff7e', 225), C('#47d63e', 215), C('#2f9e35', 215)
    for y in range(16):
        for x in range(16):
            v = math.sin(x * 0.8 + y * 0.45) * 0.3 + math.sin(y * 0.9 - x * 0.3) * 0.2 + rng.random() * 0.3
            cv.px(x, y, fd if v < -0.2 else (fm if v < 0.38 else fl))
    for (x, y) in [(4, 11), (5, 8), (10, 13), (11, 9), (7, 6), (12, 5), (3, 4), (8, 2), (13, 12)]:
        cv.px(x, y, C('#eaffdd', 240))
        cv.px(x + 1, y + 1, C('#b8ff9e', 230))
    return cv


# =================================================================== UI icons (32x32 art, saved 2x)
def ui_power(power):
    cv = medallion(32, power, rim_w=2.0)
    sym = sym_canvas(power, 16)
    cv.blit(sym, (32 - sym.w) // 2, (32 - sym.h) // 2)
    return cv


def ui_bolt_burst():
    cv = Canvas(32)
    # burst
    pts = []
    for i in range(24):
        ang = -math.pi / 2 + i * math.pi / 12
        r = 15 if i % 2 == 0 else 9.5
        pts.append((16 + r * math.cos(ang), 16 + r * math.sin(ang)))
    cv.poly(pts, C('#ff7a1c'))
    inner = Canvas(32)
    pts2 = [(16 + 8.5 * math.cos(-math.pi / 2 + i * math.pi / 12) * (1 if i % 2 == 0 else 0.75),
             16 + 8.5 * math.sin(-math.pi / 2 + i * math.pi / 12) * (1 if i % 2 == 0 else 0.75)) for i in range(24)]
    inner.poly(pts2, C('#ffb83a'))
    cv.blit(inner, 0, 0)
    cv.outline(C('#4a1a00'))
    bolt = glyph_bolt().scaled(2)
    cv.blit(bolt, (32 - bolt.w) // 2, 0)
    return cv


def ui_from16(sprite):
    cv = Canvas(32)
    big = sprite.scaled(2)
    cv.blit(big, (32 - big.w) // 2, (32 - big.h) // 2)
    return cv


def ui_blueprint():
    cv = Canvas(32)
    paper, paper_d, grid, ink = C('#2f6fc4'), C('#1f4f94'), C('#4d8ad6'), C('#e8f4ff')
    o = C('#0d1f3d')
    cv.rect(3, 4, 28, 27, paper)
    for x in range(3, 29, 4):
        cv.rect(x, 4, x, 27, grid)
    for y in range(4, 28, 4):
        cv.rect(3, y, 28, y, grid)
    cv.rect(3, 27, 28, 27, paper_d)
    cv.rect(28, 4, 28, 27, paper_d)
    # building drawing
    for (x0, y0, x1, y1) in [(7, 14, 24, 23), (10, 9, 21, 14)]:
        cv.rect(x0, y0, x1, y0, ink)
        cv.rect(x0, y1, x1, y1, ink)
        cv.rect(x0, y0, x0, y1, ink)
        cv.rect(x1, y0, x1, y1, ink)
    cv.rect(14, 18, 17, 23, ink)
    for x in (9, 20):
        cv.rect(x, 17, x + 2, 19, ink)
    # dome
    for x in range(12, 20):
        cv.px(x, 8 - (1 if 13 <= x <= 18 else 0) - (1 if 14 <= x <= 17 else 0), ink)
    cv.outline(o)
    # rolled corner
    cv.px(28, 4, o)
    cv.px(27, 4, C('#9cc4f0'))
    cv.px(28, 5, C('#9cc4f0'))
    return cv


def ui_book_guide():
    cv = Canvas(32)
    page, page_d, cover = C('#f6efd8'), C('#cdbf96'), C('#8a3b1f')
    o = C('#2a140a')
    cv.rect(2, 8, 29, 26, cover)
    # two pages (slight curve)
    for x in range(3, 16):
        top = 7 + (1 if x < 6 else 0)
        cv.rect(x, top, x, 24, page)
    for x in range(16, 29):
        top = 7 + (1 if x > 25 else 0)
        cv.rect(x, top, x, 24, page)
    cv.rect(15, 7, 16, 25, page_d)
    for y in range(11, 23, 3):
        cv.rect(5, y, 13, y, page_d)
    cv.outline(o)
    # big question mark on the right page
    q = [
        '.oooo.',
        'oyyyyo',
        'oyooyo',
        'ooo.yo',
        '..oyyo',
        '..oyo.',
        '..ooo.',
        '..oyo.',
        '..ooo.',
    ]
    qc = from_rows(q, {'o': C('#1f4a8a'), 'y': C('#3f8cff')})
    cv.blit(qc.scaled(1), 19, 10)
    return cv


def ui_gear():
    cv = Canvas(32)
    m, l, d = C('#b9bcc8'), C('#eceef4'), C('#6c7080')
    o = C('#1f2129')
    cx = cy = 16
    for y in range(32):
        for x in range(32):
            dx, dy = x + .5 - cx, y + .5 - cy
            r = math.hypot(dx, dy)
            a = math.atan2(dy, dx)
            tooth = (math.cos(a * 8) > 0.35)
            rr = 13 if tooth else 10.5
            if 4.2 < r <= rr:
                cv.px(x, y, m)
    cv.bevel(l, d)
    cv.outline(o)
    # inner ring shading
    for y in range(32):
        for x in range(32):
            r = math.hypot(x + .5 - 16, y + .5 - 16)
            if 4.2 < r <= 5.3:
                cv.px(x, y, d)
    return cv


def ui_mypowers():
    cv = Canvas(32)
    skin, skin_d, hair, shirt, shirt_d = C('#c99a74'), C('#a8785a'), C('#4a3020'), C('#3fa9c9'), C('#2a7c98')
    eye_w, eye = C('#ffffff'), C('#3a2a7a')
    o = C('#1a1410')
    # aura
    for y in range(32):
        for x in range(32):
            r = math.hypot(x + .5 - 16, y + .5 - 15)
            if 12.5 < r <= 14.5 and (y < 26):
                cv.px(x, y, C('#7cff5a') if (x + y) % 3 else C('#d8ffc2'))
    # body
    cv.rect(7, 23, 24, 31, shirt)
    cv.rect(7, 29, 24, 31, shirt_d)
    # head
    cv.rect(10, 7, 21, 20, skin)
    cv.rect(10, 7, 21, 10, hair)
    cv.rect(10, 11, 10, 13, hair)
    cv.rect(21, 11, 21, 13, hair)
    cv.rect(10, 19, 21, 20, skin_d)
    cv.rect(12, 14, 13, 15, eye_w)
    cv.rect(13, 14, 13, 15, eye)
    cv.rect(18, 14, 19, 15, eye_w)
    cv.rect(18, 14, 18, 15, eye)
    cv.rect(14, 17, 17, 17, C('#7a4a36'))
    cv.rect(13, 21, 18, 22, skin_d)
    body_mask = cv.mask() & ~(np.all(cv.a[:, :, :3] == np.array(C('#7cff5a')[:3]), axis=2) |
                              np.all(cv.a[:, :, :3] == np.array(C('#d8ffc2')[:3]), axis=2))
    cv.outline(o, mask=body_mask)
    # star badge
    star = glyph_star()
    cv.blit(star, 19, 0)
    return cv


def ui_remove():
    cv = Canvas(32)
    r_l, r_m, r_d = C('#ff8a7a'), C('#e8281c'), C('#8e0f0a')
    for y in range(32):
        for x in range(32):
            u, v = x + .5 - 16, y + .5 - 16
            if (abs(u - v) <= 3.2 or abs(u + v) <= 3.2) and abs(u) <= 11.5 and abs(v) <= 11.5:
                cv.px(x, y, r_m)
    cv.bevel(r_l, r_d)
    cv.outline(C('#3a0604'))
    return cv


def ui_back():
    cv = Canvas(32)
    m, l, d = C('#e9ebf2'), C('#ffffff'), C('#9a9eb0')
    pts = [(3, 16), (15, 4), (15, 11), (28, 11), (28, 21), (15, 21), (15, 28)]
    cv.poly(pts, m)
    cv.bevel(l, d)
    cv.outline(C('#22252f'))
    return cv


def ui_lab():
    cv = Canvas(32)
    wall, wall_l, wall_d = C('#b9bec9'), C('#dfe3ea'), C('#7e8492')
    roof = C('#5d6372')
    win, win_l = C('#47d63e'), C('#c8ff9a')
    o = C('#1d2028')
    cv.rect(3, 13, 28, 29, wall)
    cv.rect(3, 13, 28, 13, wall_l)
    cv.rect(3, 28, 28, 29, wall_d)
    cv.rect(1, 11, 30, 12, roof)
    # tank on the roof
    cv.rect(18, 3, 25, 10, C('#9ea4b3'))
    cv.rect(19, 4, 24, 9, C('#47d63e'))
    cv.rect(19, 4, 20, 9, C('#9cff7e'))
    cv.rect(18, 3, 25, 3, C('#d7dbe3'))
    # chimney
    cv.rect(6, 5, 9, 10, wall_d)
    cv.rect(6, 5, 9, 5, wall)
    # windows
    for x0 in (6, 13, 20):
        cv.rect(x0, 16, x0 + 4, 20, win)
        cv.px(x0, 16, win_l)
        cv.px(x0 + 1, 16, win_l)
        cv.px(x0, 17, win_l)
    # door + hazard stripe
    cv.rect(13, 23, 17, 29, C('#3a3f4c'))
    for x in range(3, 29):
        if x < 13 or x > 17:
            cv.px(x, 26, C('#f2c230') if (x // 2) % 2 == 0 else C('#2a2a30'))
    cv.outline(o)
    # smoke
    for (x, y, c) in [(7, 2, C('#cfd3dc')), (8, 1, C('#e8ebf0')), (9, 2, C('#cfd3dc')), (10, 0, C('#e8ebf0'))]:
        cv.px(x, y, c)
    return cv


def ui_crater():
    """A chunk of terrain with an impact crater and a glowing meteorite (oblique view)."""
    cv = Canvas(32)
    grass_l, grass, grass_d = C('#7cc94f'), C('#5fae3c'), C('#3f7f27')
    dirt, dirt_d = C('#8a6242'), C('#6b4a31')
    pit_far, pit, pit_deep = C('#9a7a5a'), C('#5f412b'), C('#2e2016')
    o = C('#1a120c')
    cx, cy, rx, ry = 16.0, 18.0, 14.5, 8.0

    def ell(x, y, ex, ey, ccx=cx, ccy=cy):
        return ((x + .5 - ccx) / ex) ** 2 + ((y + .5 - ccy) / ey) ** 2

    # extruded dirt side (terrain block seen from the front)
    for y in range(32):
        for x in range(32):
            for dz in range(0, 6):
                if ell(x, y - dz, rx, ry) <= 1 and y >= cy:
                    cv.px(x, y, dirt if (x + y) % 5 else dirt_d)
    # grass top
    for y in range(32):
        for x in range(32):
            if ell(x, y, rx, ry) <= 1:
                cv.px(x, y, grass_l if ell(x, y, rx, ry) > 0.72 and y < cy else grass)
    # raised rim + bowl
    for y in range(32):
        for x in range(32):
            e = ell(x, y, 10.5, 5.6, ccy=cy + 0.5)
            if e <= 1:
                cv.px(x, y, pit_far if y < cy - 1 else pit)
            elif e <= 1.35:
                cv.px(x, y, dirt_d if y > cy else grass_d)
            if ell(x, y, 7.0, 3.6, ccy=cy + 1.5) <= 1:
                cv.px(x, y, pit_deep)
    # meteorite chunk with glowing veins
    cv.disc(16, 18.2, 3.6, C('#2a2624'))
    cv.disc(15.2, 17.4, 2.0, C('#433b37'))
    for (x, y) in [(13, 18), (14, 19), (17, 16), (18, 19), (16, 20)]:
        cv.px(x, y, C('#5cf04a'))
    cv.px(15, 16, C('#c8ff9a'))
    cv.outline(o)
    # smoke + sparks
    for (x, y, c) in [(13, 9, C('#a9a9b0')), (14, 8, C('#c4c4ca')), (13, 7, C('#a9a9b0')), (14, 5, C('#c4c4ca')),
                      (18, 10, C('#a9a9b0')), (19, 8, C('#c4c4ca')), (18, 6, C('#a9a9b0')), (19, 4, C('#d8d8de')),
                      (16, 12, C('#7cff5a')), (21, 12, C('#7cff5a')), (11, 12, C('#7cff5a')), (16, 3, C('#d8d8de'))]:
        cv.px(x, y, c)
    return cv


def ui_mutant():
    cv = Canvas(32)
    skin, skin_l, skin_d = C('#7f9a6a'), C('#a4bf8c'), C('#566b46')
    o = C('#141c10')
    eye, eye_l = C('#c45cff'), C('#f2ceff')
    cv.rect(6, 5, 25, 27, skin)
    cv.rect(6, 5, 25, 6, skin_l)
    cv.rect(6, 26, 25, 27, skin_d)
    cv.rect(24, 7, 25, 27, skin_d)
    # brow ridge
    cv.rect(8, 11, 23, 12, skin_d)
    # glowing eyes
    for x0 in (9, 18):
        cv.rect(x0, 13, x0 + 4, 15, C('#1a0a2a'))
        cv.rect(x0 + 1, 13, x0 + 3, 14, eye)
        cv.px(x0 + 1, 13, eye_l)
    # mouth with teeth
    cv.rect(10, 21, 21, 24, C('#2a1010'))
    for x in range(10, 22, 2):
        cv.px(x, 21, C('#f0ead0'))
        cv.px(x + 1, 24, C('#f0ead0'))
    # scar + stitches
    for i in range(7):
        cv.px(19 + i // 2, 5 + i, C('#5a2a2a'))
    for (x, y) in [(18, 7), (21, 7), (19, 9), (22, 9)]:
        cv.px(x, y, C('#e0d8c0'))
    # vein glow
    for (x, y) in [(7, 17), (8, 18), (8, 19), (7, 20)]:
        cv.px(x, y, C('#5cf04a'))
    cv.outline(o)
    return cv


def ui_icons():
    icons = {}
    for p in POWERS:
        icons[f'power_{p}'] = ui_power(p)
    icons['cat_powers'] = ui_bolt_burst()
    icons['cat_items'] = ui_from16(syringe('mutagen'))
    icons['cat_structures'] = ui_blueprint()
    icons['cat_mobs'] = ui_from16(glyph_skull())
    icons['cat_guide'] = ui_book_guide()
    icons['cat_settings'] = ui_gear()
    icons['cat_mypowers'] = ui_mypowers()
    icons['remove'] = ui_remove()
    icons['back'] = ui_back()
    icons['lab'] = ui_lab()
    icons['crater'] = ui_crater()
    icons['mutant'] = ui_mutant()
    return {k: v.scaled(2) for k, v in icons.items()}


# =================================================================== pack icon (64x64 art, saved 4x)
def pack_icon():
    S = 64
    cv = Canvas(S)
    c = S / 2.0
    bg_in, bg_out = C('#3a1f63'), C('#0c0a1c')
    ray = C('#4a2a7a')
    for y in range(S):
        for x in range(S):
            dx, dy = x + .5 - c, y + .5 - c
            r = math.hypot(dx, dy) / (c * 1.414)
            a = math.atan2(dy, dx)
            col = mix(bg_in, bg_out, r * 1.2)
            if math.cos(a * 12) > 0.55 and r > 0.2:
                col = mix(col, ray, 0.6 * (1 - r))
            cv.px(x, y, col)
    # five-power ring
    order = POWERS
    for y in range(S):
        for x in range(S):
            dx, dy = x + .5 - c, y + .5 - c
            r = math.hypot(dx, dy)
            if 23.5 < r <= 29.5:
                a = (math.degrees(math.atan2(dy, dx)) + 90 + 360) % 360
                seg = int(a // 72)
                within = a - seg * 72
                l, m, d = LIQ[order[seg]]
                if within < 3 or within > 69:
                    col = C('#14101f')
                elif r > 28.5:
                    col = d
                elif r < 24.5:
                    col = l
                else:
                    col = m
                cv.px(x, y, col)
            elif 29.5 < r <= 31.0 or 22.5 < r <= 23.5:
                cv.px(x, y, C('#14101f'))
            elif r <= 22.5:
                k = r / 22.5
                cv.px(x, y, mix(C('#1c3a22'), C('#0b1410'), k))
    # mutagen glow inside the ring
    for y in range(S):
        for x in range(S):
            r = math.hypot(x + .5 - c, y + .5 - c)
            if r <= 22.5:
                k = max(0.0, 1 - r / 20.0)
                cv.px(x, y, mix(cv.get(x, y), C('#2f8f3a'), 0.55 * k))
    # DNA double helix (green), vertical: back strand, rungs, front strand
    g_front, g_front_hi, g_back, rung = C('#7dff5c'), C('#e2ffd2'), C('#2b9a35'), C('#58c94a')
    strands = []
    for y in range(9, 56):
        ph = (y - 9) * (2 * math.pi / 22.0)
        xa = c + 10.0 * math.sin(ph)
        xb = c - 10.0 * math.sin(ph)
        a_front = math.cos(ph) >= 0
        strands.append((y, xa, xb, a_front))
    for (y, xa, xb, a_front) in strands:
        if y % 3 == 0:
            lo, hi = sorted((xa, xb))
            for x in range(int(round(lo)) + 2, int(round(hi)) - 1):
                cv.px(x, y, rung)
    for front in (False, True):
        for (y, xa, xb, a_front) in strands:
            for xx, is_a in ((xa, True), (xb, False)):
                if (is_a == a_front) != front:
                    continue
                x0 = int(round(xx)) - 1
                for dx in range(3):
                    cv.px(x0 + dx, y, (g_front_hi if dx == 0 else g_front) if front else g_back)
    # lightning bolt (bold, centred)
    bolt = Canvas(S)
    pts = [(36, 6), (48, 6), (37.5, 26), (47, 26), (24, 58), (29.5, 34), (19, 34)]
    bolt.poly(pts, C('#ffd51a'))
    hl = Canvas(S)
    hl.poly([(37, 9), (44, 9), (34.5, 28), (41, 28), (30, 46), (32.5, 31.5), (23, 31.5)], C('#fff8b4'))
    bolt.blit(hl, 0, 0)
    bolt.outline(C('#1a1204'))
    bolt.outline(C('#1a1204'))
    halo = bolt.copy()
    halo.outline(C('#fff3a0'))
    for y in range(S):
        for x in range(S):
            if halo.get(x, y) == C('#fff3a0'):
                cv.px(x, y, mix(cv.get(x, y), C('#fff3a0'), 0.45))
    cv.blit(bolt, 0, 0)
    return cv.scaled(4)


# =================================================================== outputs
def build_items():
    items = {}
    for p in POWERS:
        items[f'syringe_{p}'] = syringe(p)
    items['syringe_unstable'] = syringe('mutagen', unstable=True)
    items['suppressor_serum'] = syringe('suppressor')
    items['syringe_empty'] = syringe(None)
    items['mutagen_crystal'] = mutagen_crystal()
    items['mutant_codex'] = mutant_codex()
    for p in POWERS:
        items[f'emblem_{p}'] = emblem(p)
    return items


def build_blocks():
    return {
        'meteorite': meteorite_texture(),
        'mutagen_tank_side': tank_side(),
        'mutagen_tank_top': tank_top(),
        'mutagen_tank_glass': tank_glass(),
        'mutagen_tank_fluid': tank_fluid(),
    }


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, indent=2)
        f.write('\n')


def generate(preview_dir=None):
    items = build_items()
    blocks = build_blocks()
    ui = ui_icons()
    font, glyph_cells = glyph_font()
    icon = pack_icon()

    for name, cv in items.items():
        assert cv.w == 16 and cv.h == 16, name
        cv.save(os.path.join(RP, 'textures', 'items', f'sp_{name}.png'))
    for name, cv in blocks.items():
        assert cv.w == 16 and cv.h == 16, name
        cv.save(os.path.join(RP, 'textures', 'blocks', f'sp_{name}.png'))
    for name, cv in ui.items():
        assert cv.w == 64 and cv.h == 64, name
        cv.save(os.path.join(RP, 'textures', 'sp', 'ui', f'{name}.png'))
    font.save(os.path.join(RP, 'font', 'glyph_E7.png'))
    icon.save(os.path.join(RP, 'pack_icon.png'))
    icon.save(os.path.join(BP, 'pack_icon.png'))

    write_json(os.path.join(RP, 'textures', 'item_texture.json'), {
        'resource_pack_name': 'superpowers_and_mutants',
        'texture_name': 'atlas.items',
        'texture_data': {f'sp_{n}': {'textures': f'textures/items/sp_{n}'} for n in items},
    })
    write_json(os.path.join(RP, 'textures', 'terrain_texture.json'), {
        'resource_pack_name': 'superpowers_and_mutants',
        'texture_name': 'atlas.terrain',
        'padding': 8,
        'num_mip_levels': 4,
        'texture_data': {f'sp_{n}': {'textures': f'textures/blocks/sp_{n}'} for n in blocks},
    })
    n = len(items) + len(blocks) + len(ui) + 3
    print(f'wrote {n} textures + item_texture.json + terrain_texture.json')

    if preview_dir:
        os.makedirs(preview_dir, exist_ok=True)

        def sheet(sprites, scale, cols, name, bg=(54, 57, 66, 255)):
            sp = list(sprites.items())
            w = max(s.w for _, s in sp) * scale
            h = max(s.h for _, s in sp) * scale
            rows_n = (len(sp) + cols - 1) // cols
            img = Image.new('RGBA', (cols * (w + 8) + 8, rows_n * (h + 8) + 8), bg)
            for i, (_, s) in enumerate(sp):
                im = s.scaled(scale).image()
                img.alpha_composite(im, (8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + 8)))
            img.save(os.path.join(preview_dir, name))

        sheet(items, 12, 5, 'items.png')
        sheet(blocks, 12, 5, 'blocks.png')
        sheet(ui, 2, 5, 'ui.png')
        sheet({str(i): g for i, g in enumerate(glyph_cells)}, 10, 8, 'glyphs.png')
        sheet({'icon': icon}, 1, 1, 'pack_icon.png')
        print(f'previews in {preview_dir}')


# =================================================================== reference check
def strip_comments(text):
    return re.sub(r'(?m)^\s*//.*$', '', text)


def check():
    """Verify that every texture referenced by item/block JSON, the atlases and the geometry exists."""
    problems = []

    def load(path):
        with open(path, encoding='utf-8') as f:
            return json.loads(strip_comments(f.read()))

    def tex_exists(rel):
        return any(os.path.exists(os.path.join(RP, rel + ext)) for ext in ('.png', '.tga'))

    item_atlas = load(os.path.join(RP, 'textures', 'item_texture.json'))['texture_data']
    terrain_atlas = load(os.path.join(RP, 'textures', 'terrain_texture.json'))['texture_data']
    for atlas_name, atlas in (('item_texture', item_atlas), ('terrain_texture', terrain_atlas)):
        for key, entry in atlas.items():
            texs = entry['textures']
            for t in (texs if isinstance(texs, list) else [texs]):
                path = t['path'] if isinstance(t, dict) else t
                if not tex_exists(path):
                    problems.append(f'{atlas_name}.json: {key} -> {path} missing')

    item_ids = set()
    for fn in sorted(os.listdir(os.path.join(BP, 'items'))):
        if not fn.endswith('.json'):
            continue
        d = load(os.path.join(BP, 'items', fn))['minecraft:item']
        item_ids.add(d['description']['identifier'])
        icon = d['components'].get('minecraft:icon')
        if icon is None:
            problems.append(f'items/{fn}: no minecraft:icon')
            continue
        key = icon if isinstance(icon, str) else icon.get('textures', {}).get('default', icon.get('texture'))
        if key not in item_atlas:
            problems.append(f'items/{fn}: icon {key} not in item_texture.json')

    geo_ids = set()
    mdir = os.path.join(RP, 'models', 'blocks')
    if os.path.isdir(mdir):
        for fn in os.listdir(mdir):
            if fn.endswith('.json'):
                for g in load(os.path.join(mdir, fn)).get('minecraft:geometry', []):
                    geo_ids.add(g['description']['identifier'])
    blocks_json = load(os.path.join(RP, 'blocks.json'))
    block_ids = set()
    for fn in sorted(os.listdir(os.path.join(BP, 'blocks'))):
        if not fn.endswith('.json'):
            continue
        d = load(os.path.join(BP, 'blocks', fn))['minecraft:block']
        bid = d['description']['identifier']
        block_ids.add(bid)
        comps = d['components']
        for inst, mi in comps.get('minecraft:material_instances', {}).items():
            if 'texture' in mi and mi['texture'] not in terrain_atlas:
                problems.append(f'blocks/{fn}: material {inst} texture {mi["texture"]} not in terrain_texture.json')
        geo = comps.get('minecraft:geometry')
        gid = geo if isinstance(geo, str) else (geo or {}).get('identifier')
        if gid and not gid.startswith('minecraft:') and gid not in geo_ids:
            problems.append(f'blocks/{fn}: geometry {gid} not found in RP models/blocks')
        loot = comps.get('minecraft:loot')
        if loot and not os.path.exists(os.path.join(BP, loot)):
            problems.append(f'blocks/{fn}: loot table {loot} missing')
        if bid not in blocks_json:
            problems.append(f'RP blocks.json: no entry (sound) for {bid}')

    # recipes: every sp: id must exist
    known = item_ids | block_ids
    for fn in sorted(os.listdir(os.path.join(BP, 'recipes'))):
        text = open(os.path.join(BP, 'recipes', fn), encoding='utf-8').read()
        for ref in re.findall(r'"(sp:[a-z0-9_]+)"', text):
            if ref not in known and not ref.startswith('sp:' + fn[:-5]):
                problems.append(f'recipes/{fn}: unknown item {ref}')

    # language keys for every item / block
    lang = {}
    for line in open(os.path.join(RP, 'texts', 'en_US.lang'), encoding='utf-8'):
        line = line.split('\t#')[0].rstrip('\n')
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            lang[k] = v
    for iid in item_ids:
        if f'item.{iid}.name' not in lang:
            problems.append(f'en_US.lang: missing item.{iid}.name')
    for bid in block_ids:
        if f'tile.{bid}.name' not in lang:
            problems.append(f'en_US.lang: missing tile.{bid}.name')

    # UI icons + font + pack icons
    for name in ([f'power_{p}' for p in POWERS] + ['cat_powers', 'cat_items', 'cat_structures', 'cat_mobs', 'cat_guide',
                                                   'cat_settings', 'cat_mypowers', 'remove', 'back', 'lab', 'crater', 'mutant']):
        if not tex_exists(f'textures/sp/ui/{name}'):
            problems.append(f'textures/sp/ui/{name}.png missing')
    for rel, size in (('font/glyph_E7.png', (256, 256)), ('pack_icon.png', (256, 256))):
        p = os.path.join(RP, rel)
        if not os.path.exists(p) or Image.open(p).size != size:
            problems.append(f'RP {rel} missing or not {size}')
    if not os.path.exists(os.path.join(BP, 'pack_icon.png')):
        problems.append('BP pack_icon.png missing')

    # texture paths used by scripts (ActionForm button icons) in the folders generated here
    sdir = os.path.join(BP, 'scripts')
    for dirpath, _, files in os.walk(sdir):
        for fn in files:
            if not fn.endswith('.js'):
                continue
            text = open(os.path.join(dirpath, fn), encoding='utf-8').read()
            consts = dict(re.findall(r"const (\w+) = '(textures/[^']*)'", text))
            refs = re.findall(r"[`'](textures/[A-Za-z0-9_/${}.]*)[`']", text)
            refs += [consts[c] + n for c, n in re.findall(r"\b(\w+) \+ '([a-z0-9_]+)'", text) if c in consts]
            refs += [consts[c] + n for c, n in re.findall(r"\b(\w+) \+ `([a-z0-9_${}.]+)`", text) if c in consts]
            for ref in refs:
                if not ref.startswith(('textures/items/', 'textures/blocks/', 'textures/sp/ui/')) or ref.endswith('/'):
                    continue
                expanded = [ref]
                if '${' in ref:
                    expanded = [re.sub(r'\$\{[^}]*\}', p_, ref) for p_ in POWERS]
                for e in expanded:
                    if not tex_exists(e):
                        problems.append(f'scripts/{os.path.relpath(os.path.join(dirpath, fn), sdir)}: {e} missing')

    for p in problems:
        print('CHECK FAIL:', p)
    print(f'check: {len(problems)} problem(s)')
    return 1 if problems else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='only verify texture references')
    ap.add_argument('--preview', default=None, help='write upscaled contact sheets to this directory')
    args = ap.parse_args()
    if args.check:
        return check()
    generate(args.preview)
    return check()


if __name__ == '__main__':
    sys.exit(main())
