#!/usr/bin/env python3
"""Particle generator for Superpowers & Mutants.

Draws the particle atlas ``packs/SuperpowersRP/textures/sp/particles.png`` (original pixel art,
deterministic) and writes one ``packs/SuperpowersRP/particles/<name>.json`` per effect of the
docs/ARCHITECTURE.md "Particles" table (format_version 1.10.0).

    python3 tools/gen_particles.py              # write atlas + every particle JSON
    python3 tools/gen_particles.py --check      # validate the files on disk (no writing)
    python3 tools/gen_particles.py --preview D  # also write an 4x upscaled atlas preview to D
    python3 tools/gen_particles.py --long-axis x  # if lookat_direction turns out to align the X axis

``--check`` validates every particle file: JSON, identifier/contract match, materials, facing
modes, that every Molang expression parses (a small Molang evaluator is included), that every
``variable.*`` read is either a contract input (``fx.molang``: color -> variable.color.r/g/b,
dir -> variable.dir.x/y/z, numbers -> variable.<name>), an engine built-in, a curve or a variable
assigned in the same file, that every contract input is actually used, that every UV rectangle
(including expression-driven variants and flipbook frames) lies inside the texture, which must
exist with the declared size, and it samples every effect with its inputs absent (all 0) and
present to make sure sizes/colours stay finite and the effect stays visible (sane defaults) and
that particle counts stay modest. Finally it cross-checks every ``sp:*`` particle id spawned
by the behaviour-pack scripts.

Atlas cell map (256x256 px, coordinates x, y, w, h in pixels):

  y=0   16px row  glow (0,0,16,16)  core dot (16,0)  spark star (32,0)  ember (48,0,8,8)
                  chunks 4x 8x8 (64,0) (72,0) (64,8) (72,8)  droplet (96,0,8,8)  bubble (112,0)
                  mote (128,0,8,8)  hex cell (144,0)  ash flake (160,0,8,8)  foam (176,0)
  y=16  16px row  smoke frames 0-3 (0..48)  flame frames 0-3 (64..112)  sparkle frames 0-3
                  (128..176)  dust grains 4x 8x8 (192,200,208,216)
  y=32  32px row  ring (0)  thick dusty ring (32)  vapour ring (64)  target ring (96)
                  big glow (128)  flash starburst (160)  crack A (192)  crack B (224)
  y=64  32px row  big fire frames 0-3 (0..96)  big smoke frames 0-3 (128..224)
  y=96  tall row  lightning bolts 4x 16x32 (0..48)  vertical strips 8x32: beam (64) beam core (72)
                  streak (80)  psi wave frames 4x 16x32 (96..144)  silhouettes 16x32: standing
                  (160) running (176)  swirl 32x32 (192)
  y=128 strips    horizontal (transposed) copies: beam (0,128,32,8) core (0,136) streak (0,144)
                  psi wave frames 32x16 (32,64,96,128 at y=128)

Long direction-aligned quads (beam, beam_core, psi_link, wind_streak) use the
``lookat_direction`` facing mode. ``LOOKAT_DIRECTION_LONG_AXIS`` selects which billboard axis
runs along the direction: 'y' (default: like ``lookat_y`` keeps the quad's Y axis on world up,
``lookat_direction`` keeps it on the direction) -> size = [half width, half length] and vertical
texture strips; 'x' -> size = [half length, half width] and the horizontal strips. Both strip
orientations are always present in the atlas, so flipping the constant only rewrites the JSON.
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
PDIR = os.path.join(RP, 'particles')
TEX = 'textures/sp/particles'
TEX_PATH = os.path.join(RP, TEX + '.png')
TW = TH = 256

LOOKAT_DIRECTION_LONG_AXIS = 'y'

# ====================================================================== contract
# id -> (inputs, file name). Inputs exactly as in docs/ARCHITECTURE.md.
CONTRACT = {
    'sp:beam': ['dir', 'len', 'width', 'color'],
    'sp:beam_core': ['dir', 'len', 'width', 'color'],
    'sp:glow': ['color', 'size'],
    'sp:spark': ['color'],
    'sp:ember': [],
    'sp:smoke': [],
    'sp:melt': [],
    'sp:dust': ['color'],
    'sp:dust_fall': ['color'],
    'sp:debris_chunks': ['color', 'size'],
    'sp:shockwave': ['radius', 'color'],
    'sp:shockwave_air': ['radius', 'color'],
    'sp:sonic_boom': ['dir'],
    'sp:wind_streak': ['dir', 'len'],
    'sp:cloud_puff': [],
    'sp:lightning': ['color'],
    'sp:afterimage': ['color'],
    'sp:water_splash': [],
    'sp:psi_aura': ['color'],
    'sp:psi_link': ['dir', 'len', 'color'],
    'sp:psi_shield': ['radius'],
    'sp:reflect': [],
    'sp:meteor_trail': ['size'],
    'sp:meteor_marker': ['radius'],
    'sp:explosion_flash': ['size'],
    'sp:fireball': ['size'],
    'sp:charge_aura': ['color'],
    'sp:crack': ['size'],
    'sp:power_gain': ['color'],
    'sp:power_purge': [],
    'sp:inject': ['color'],
    'sp:time_motes': [],
    'sp:levitate': ['color'],
}

# effects that may be spawned every tick: keep them to a handful of quads
PER_TICK = {'sp:beam', 'sp:beam_core', 'sp:glow', 'sp:lightning', 'sp:wind_streak', 'sp:psi_link',
            'sp:dust_fall', 'sp:charge_aura', 'sp:psi_aura', 'sp:levitate', 'sp:meteor_trail',
            'sp:ember', 'sp:smoke', 'sp:afterimage', 'sp:cloud_puff', 'sp:crack', 'sp:time_motes',
            'sp:meteor_marker'}

# ====================================================================== atlas cells
CELLS = {
    'glow': (0, 0, 16, 16), 'dot': (16, 0, 16, 16), 'star': (32, 0, 16, 16), 'ember': (48, 0, 8, 8),
    'chunk0': (64, 0, 8, 8), 'chunk1': (72, 0, 8, 8), 'chunk2': (64, 8, 8, 8), 'chunk3': (72, 8, 8, 8),
    'drop': (96, 0, 8, 8), 'bubble': (112, 0, 16, 16), 'mote': (128, 0, 8, 8), 'hex': (144, 0, 16, 16),
    'ash': (160, 0, 8, 8), 'foam': (176, 0, 16, 16),
    'ring': (0, 32, 32, 32), 'ring_thick': (32, 32, 32, 32), 'ring_vapour': (64, 32, 32, 32),
    'ring_target': (96, 32, 32, 32), 'glow_big': (128, 32, 32, 32), 'flash': (160, 32, 32, 32),
    'crack0': (192, 32, 32, 32), 'crack1': (224, 32, 32, 32),
    'sil_stand': (160, 96, 16, 32), 'sil_run': (176, 96, 16, 32), 'swirl': (192, 96, 32, 32),
}
for _i in range(4):
    CELLS[f'smoke{_i}'] = (_i * 16, 16, 16, 16)
    CELLS[f'flame{_i}'] = (64 + _i * 16, 16, 16, 16)
    CELLS[f'sparkle{_i}'] = (128 + _i * 16, 16, 16, 16)
    CELLS[f'grain{_i}'] = (192 + _i * 8, 16, 8, 8)
    CELLS[f'fire_big{_i}'] = (_i * 32, 64, 32, 32)
    CELLS[f'smoke_big{_i}'] = (128 + _i * 32, 64, 32, 32)
    CELLS[f'bolt{_i}'] = (_i * 16, 96, 16, 32)
    CELLS[f'psi_v{_i}'] = (96 + _i * 16, 96, 16, 32)
    CELLS[f'psi_h{_i}'] = (32 + _i * 32, 128, 32, 16)
CELLS.update({'beam_v': (64, 96, 8, 32), 'core_v': (72, 96, 8, 32), 'streak_v': (80, 96, 8, 32),
              'beam_h': (0, 128, 32, 8), 'core_h': (0, 136, 32, 8), 'streak_h': (0, 144, 32, 8)})


# ====================================================================== atlas painting
def grid(w, h):
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    return xs + 0.5 - w / 2.0, ys + 0.5 - h / 2.0


def quant(a, n=8):
    return np.round(np.clip(a, 0.0, 1.0) * n) / n


def additive(intensity, levels=8):
    """Premultiplied white sprite for particles_add (transparent pixels are black)."""
    a = quant(intensity, levels)
    out = np.zeros(a.shape + (4,))
    out[..., 0] = out[..., 1] = out[..., 2] = a
    out[..., 3] = a
    return out


def straight(alpha, shade, levels=8):
    """Straight-alpha greyscale (or RGB) sprite for particles_blend / particles_alpha."""
    a = quant(alpha, levels)
    out = np.zeros(a.shape + (4,))
    shade = np.asarray(shade, dtype=np.float64)
    if shade.ndim == a.ndim:
        shade = np.repeat(shade[..., None], 3, axis=-1)
    out[..., :3] = np.clip(shade, 0, 1)
    out[..., 3] = a
    out[a <= 0] = 0
    return out


def ascii_sprite(rows, palette):
    """palette: char -> (shade or (r,g,b), alpha)."""
    h, w = len(rows), len(rows[0])
    out = np.zeros((h, w, 4))
    for y, row in enumerate(rows):
        assert len(row) == w, rows
        for x, ch in enumerate(row):
            if ch in palette:
                s, a = palette[ch]
                rgb = (s, s, s) if isinstance(s, (int, float)) else s
                out[y, x, :3] = rgb
                out[y, x, 3] = a
    return out


def value_noise(shape, cells, rng):
    """Smooth periodic-ish value noise in [0,1]."""
    h, w = shape
    g = rng.random((cells + 1, cells + 1))
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    fx, fy = xs / w * cells, ys / h * cells
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - x0, fy - y0
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    a, b = g[y0, x0], g[y0, x0 + 1]
    c, d = g[y0 + 1, x0], g[y0 + 1, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def paint_glow(n):
    x, y = grid(n, n)
    r = np.sqrt(x * x + y * y) / (n / 2.0)
    i = 0.8 * np.clip(1 - r, 0, 1) ** 1.35 + 0.5 * np.clip(1 - r / 0.32, 0, 1)
    return additive(np.clip(i, 0, 1), 12)


def paint_dot():
    x, y = grid(16, 16)
    r = np.sqrt(x * x + y * y)
    i = np.where(r < 2.3, 1.0, np.where(r < 3.7, 0.6, np.where(r < 5.2, 0.22, 0.0)))
    return additive(i)


def paint_star():
    x, y = grid(16, 16)
    ax, ay = np.abs(x), np.abs(y)
    arm = np.maximum((ay < 1) * np.clip(1 - ax / 7.6, 0, 1) ** 1.1, (ax < 1) * np.clip(1 - ay / 7.6, 0, 1) ** 1.1)
    diag = ((np.abs(ax - ay) < 0.6) & (ax < 3.6)) * 0.45
    core = ((ax < 1.6) & (ay < 1.6)) * 1.0
    return additive(np.maximum.reduce([arm, diag, core]))


def paint_ember():
    x, y = grid(8, 8)
    r = np.sqrt(x * x + y * y)
    i = np.where(r < 1.0, 1.0, np.where(r < 1.6, 0.62, np.where(r < 2.2, 0.25, 0.0)))
    return additive(i)


CHUNKS = [
    ["........", ".#####..", ".#ooo##.", ".#o###x.", ".#####x.", ".####xx.", "..#xxx..", "........"],
    ["........", "..####..", ".#oo###.", ".#o####.", ".#####x.", "..##xxx.", "...xx...", "........"],
    ["........", "........", ".####...", ".#oo##x.", ".#o###x.", ".###xxx.", "..xxx...", "........"],
    ["........", "...##...", "..#o##..", ".#oo###.", ".######x", "..####x.", "...xx...", "........"],
]


def paint_chunk(i, rng):
    spr = ascii_sprite(CHUNKS[i], {'#': (0.8, 1), 'o': (1.0, 1), 'x': (0.56, 1)})
    # a few darker speckles inside for a rocky look
    for _ in range(2):
        yy, xx = rng.integers(2, 6), rng.integers(2, 6)
        if spr[yy, xx, 3] > 0 and spr[yy, xx, 0] == 0.8:
            spr[yy, xx, :3] = 0.68
    return spr


DROP = ["...##...", "...##...", "..####..", ".##o###.", ".#o####.", ".######.", ".####xx.", "..xxxx.."]
ASH = ["........", "........", "...##...", "..###x..", "...#xx..", "....x...", "........", "........"]
GRAINS = [
    ["........", "........", "...##...", "..###x..", "..#xx...", "...x....", "........", "........"],
    ["........", "........", "..##....", "..##x...", "...xx...", "........", "........", "........"],
    ["........", "...#....", "..###...", ".####x..", "..#xxx..", "...x....", "........", "........"],
    ["........", "........", "........", "...##...", "...#x...", "........", "........", "........"],
]


def paint_bubble():
    x, y = grid(16, 16)
    r = np.sqrt(x * x + y * y)
    a = np.where((r > 5.2) & (r < 6.4), 0.95, np.where(r <= 5.2, 0.16, 0.0))
    hl = ((np.abs(x + 2.5) < 1.1) & (np.abs(y + 2.5) < 1.1)) | ((np.abs(x + 0.5) < 0.6) & (np.abs(y + 3.5) < 0.6))
    a = np.where(hl, 1.0, a)
    return straight(a, np.ones_like(a))


def paint_mote():
    x, y = grid(8, 8)
    ax, ay = np.abs(x), np.abs(y)
    i = np.where((ax < 1) & (ay < 1), 1.0, 0.0)
    i = np.maximum(i, np.where(((ax < 1) & (ay < 2)) | ((ay < 1) & (ax < 2)), 0.55, 0))
    i = np.maximum(i, np.where((ax < 2) & (ay < 2), 0.28, 0))
    i = np.maximum(i, np.where(((ax < 1) & (ay < 3)) | ((ay < 1) & (ax < 3)), 0.14, 0))
    return additive(i)


def paint_hex():
    x, y = grid(16, 16)
    ax, ay = np.abs(x), np.abs(y)
    d = np.maximum(ay, ax * 0.866 + ay * 0.5)
    i = np.where((d > 5.6) & (d < 6.8), 1.0, np.where(d <= 5.6, 0.18, 0.0))
    i = np.where((d > 3.0) & (d < 3.8) & (y < -0.5) & (x < 0.5), np.maximum(i, 0.45), i)
    return additive(i)


def paint_foam(rng):
    x, y = grid(16, 16)
    a = np.zeros_like(x)
    sh = np.zeros_like(x)
    for cx, cy, rr in [(-2.5, 1.0, 3.6), (2.5, 1.5, 3.0), (0.5, -2.5, 3.2), (-3.5, -2.5, 2.0), (4.0, -2.0, 1.8)]:
        d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
        inside = d < rr
        a = np.where(inside, np.maximum(a, np.where(d > rr - 1.0, 0.95, 0.7)), a)
        sh = np.where(inside, np.maximum(sh, np.where((x - cx) + (y - cy) < -rr * 0.6, 1.0, 0.86)), sh)
    return straight(a, sh)


def cloud(n, frame, rng, big=False):
    """Lumpy cloud: union of soft circles that grows and breaks up with the frame index."""
    x, y = grid(n, n)
    s = n / 16.0
    dens = np.zeros_like(x)
    blobs = [(-2.0, 1.0, 3.6), (2.2, 0.8, 3.4), (0.0, -1.8, 3.8), (-3.0, -2.2, 2.4), (3.2, -2.4, 2.3),
             (0.6, 3.0, 2.6), (-4.2, 1.8, 2.0), (4.4, 2.2, 1.9)]
    grow = [0.78, 0.92, 1.04, 1.12][frame]
    for cx, cy, rr in blobs:
        cx, cy, rr = cx * s * grow, cy * s * grow, rr * s * grow
        d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / rr
        dens = np.maximum(dens, np.clip(1 - d, 0, 1))
    nz = value_noise((n, n), 4 if not big else 6, rng)
    a = np.clip(dens * 2.6, 0, 1) * [1.0, 0.92, 0.8, 0.62][frame]
    holes = nz < [0.0, 0.18, 0.3, 0.45][frame]
    a = np.where(holes & (dens < 0.75), a * 0.35, a)
    light = 0.78 + 0.22 * np.clip(-(x + y) / n * 1.6 + 0.4, 0, 1)
    return straight(a, light)


FLAME_RAMP = [(0.0, (0.55, 0.08, 0.03)), (0.25, (0.85, 0.2, 0.04)), (0.5, (1.0, 0.48, 0.08)),
              (0.72, (1.0, 0.78, 0.22)), (0.9, (1.0, 0.96, 0.7))]


def ramp(h):
    out = np.zeros(h.shape + (3,))
    for t, c in FLAME_RAMP:
        m = h >= t
        out[m] = c
    return out


def paint_flame(frame, rng):
    x, y = grid(16, 16)
    scale = [1.0, 0.9, 0.74, 0.55][frame]
    heat = np.zeros_like(x)
    jit = rng.uniform(-0.8, 0.8, 5)
    for k, (cy, rr) in enumerate([(3.0, 4.6), (0.5, 3.8), (-2.2, 2.9), (-4.6, 1.9), (-6.4, 1.0)]):
        cx = jit[k] * (k / 4.0) * 1.5
        d = np.sqrt((x - cx * scale) ** 2 + (y - cy * scale - (1 - scale) * 4) ** 2) / (rr * scale)
        heat = np.maximum(heat, np.clip(1 - d, 0, 1) * (1.0 - 0.1 * k))
    heat = heat * [1.0, 0.95, 0.85, 0.72][frame]
    a = np.where(heat > 0.04, 1.0, 0.0)
    return straight(a, ramp(np.clip(heat * 1.25, 0, 1)), levels=1)


def paint_sparkle(frame):
    x, y = grid(16, 16)
    ax, ay = np.abs(x), np.abs(y)
    arm_len = [1.5, 3.5, 6.5, 2.5][frame]
    peak = [0.8, 1.0, 1.0, 0.65][frame]
    arm = np.maximum((ay < 1) * np.clip(1 - (ax - 1) / arm_len, 0, 1), (ax < 1) * np.clip(1 - (ay - 1) / arm_len, 0, 1))
    core = ((ax < 1) & (ay < 1)) * 1.0
    diag = ((np.abs(ax - ay) < 0.6) & (ax < 2.6)) * (0.45 if frame == 2 else 0.0)
    halo = ((ax < 2) & (ay < 2)) * (0.3 if frame in (1, 2) else 0.15)
    return additive(np.maximum.reduce([arm * peak, core * peak, diag, halo]))


def paint_ring(kind, rng):
    x, y = grid(32, 32)
    r = np.sqrt(x * x + y * y)
    th = np.arctan2(y, x)
    if kind == 'ring':
        a = np.where((r > 13.2) & (r < 15.4), 1.0, 0.0)
        a = np.maximum(a, np.where(r <= 13.2, np.clip((r - 7.0) / 6.2, 0, 1) ** 1.6 * 0.65, 0))
        return straight(a, np.where(r > 13.2, 1.0, 0.9))
    if kind == 'ring_thick':
        nz = value_noise((32, 32), 6, rng)
        band = np.where((r > 10.0) & (r < 15.4), 1.0, 0.0) * (0.55 + 0.45 * nz)
        inner = np.where(r <= 10.0, np.clip((r - 5.0) / 5.0, 0, 1) ** 1.5 * 0.45, 0)
        edge = np.where((r > 14.0) & (r < 15.4), 1.0, 0.0)
        return straight(np.maximum.reduce([band, inner, edge * 0.95]), 0.82 + 0.18 * nz)
    if kind == 'ring_vapour':
        ang = 0.55 + 0.45 * (0.5 + 0.5 * np.sin(th * 7 + 1.3) * np.cos(th * 3 - 0.4))
        prof = np.exp(-((r - 12.4) ** 2) / (2 * 1.9 ** 2))
        a = np.where(r < 15.6, prof * ang * 1.25, 0)
        return straight(np.clip(a, 0, 1), 0.86 + 0.14 * np.clip(-(x + y) / 30 + 0.5, 0, 1))
    if kind == 'ring_target':
        outer = np.where((r > 13.9) & (r < 15.3), 1.0, 0.0)
        halo = np.where((r > 12.6) & (r <= 13.9), 0.28, 0.0)
        dash = np.where((r > 10.0) & (r < 11.0) & (np.sin(th * 8) > 0), 0.6, 0.0)
        ticks = np.where(((np.abs(x) < 1) | (np.abs(y) < 1)) & (r > 11.4) & (r < 14.0), 0.85, 0.0)
        return additive(np.maximum.reduce([outer, halo, dash, ticks]))
    raise ValueError(kind)


def paint_flash():
    x, y = grid(32, 32)
    r = np.sqrt(x * x + y * y)
    th = np.arctan2(y, x)
    rays = np.zeros_like(r)
    for k in range(8):
        a0 = k * math.pi / 4 + 0.2
        dth = np.angle(np.exp(1j * (th - a0)))
        length = 15.5 if k % 2 == 0 else 10.5
        rays = np.maximum(rays, np.exp(-((dth * r) ** 2) / (2 * 1.1 ** 2)) * np.clip(1 - r / length, 0, 1))
    core = np.clip(1 - r / 16, 0, 1) ** 2.2 + 0.6 * np.clip(1 - r / 5, 0, 1)
    return additive(np.clip(np.maximum(rays, core), 0, 1), 10)


def paint_crack(seed):
    rng = random.Random(seed)
    alpha = np.zeros((32, 32))
    shade = np.ones((32, 32))
    pix = {}

    def mark(px, py, val):
        if 0 <= px < 32 and 0 <= py < 32:
            pix[(px, py)] = min(pix.get((px, py), 9), val)

    def branch(x, y, ang, length, depth):
        for _ in range(length):
            ang += rng.uniform(-0.5, 0.5)
            x += math.cos(ang)
            y += math.sin(ang)
            mark(int(round(x)), int(round(y)), depth)
            if depth == 0 and rng.random() < 0.22:
                mark(int(round(x + rng.choice((-1, 1)))), int(round(y)), 1)
            if depth < 2 and rng.random() < 0.12:
                branch(x, y, ang + rng.choice((-1, 1)) * rng.uniform(0.6, 1.1), length // 2, depth + 1)

    n = rng.randint(5, 6)
    for k in range(n):
        branch(15.5, 15.5, k * 2 * math.pi / n + rng.uniform(-0.3, 0.3), rng.randint(10, 14), 0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            mark(15 + dx, 15 + dy, 0)
            mark(16 + dx, 16 + dy, 0)
    for (px, py), depth in pix.items():
        alpha[py, px] = 1.0
        shade[py, px] = (0.1, 0.2, 0.3)[min(depth, 2)]
    # lighter rim on the lower-right of the main cracks (chipped edge)
    for (px, py), depth in list(pix.items()):
        if depth == 0:
            for qx, qy in ((px + 1, py), (px, py + 1)):
                if 0 <= qx < 32 and 0 <= qy < 32 and alpha[qy, qx] == 0:
                    alpha[qy, qx] = 0.75
                    shade[qy, qx] = 0.55
    return straight(alpha, shade, levels=4)


def paint_big_fire(frame, rng):
    x, y = grid(32, 32)
    grow = [0.7, 0.86, 1.0, 1.08][frame]
    heat = np.zeros_like(x)
    blobs = [(0, 3, 9), (-6, 5, 6), (6, 4, 6.5), (-3, -4, 7), (4, -5, 6), (0, -10, 4.5), (-8, -3, 4), (8, -2, 4.2)]
    for cx, cy, rr in blobs:
        d = np.sqrt((x - cx * grow) ** 2 + (y - cy * grow) ** 2) / (rr * grow)
        heat = np.maximum(heat, np.clip(1 - d, 0, 1))
    nz = value_noise((32, 32), 5, rng)
    heat = heat * (0.86 + 0.28 * nz) * [1.15, 1.0, 0.82, 0.6][frame]
    a = np.where(heat > 0.06, 1.0, 0.0)
    if frame == 3:
        a = np.where(nz < 0.35, 0.0, a)
    col = ramp(np.clip(heat, 0, 1))
    if frame >= 2:  # cooling: soot at the outer edge
        soot = (heat < 0.22)[..., None]
        col = np.where(soot, np.array([0.3, 0.12, 0.08]), col)
    return straight(a, col, levels=1)


BOLT_SEEDS = [11, 23, 37, 51]


def paint_bolt(i):
    rng = random.Random(BOLT_SEEDS[i])
    inten = np.zeros((32, 16))

    def put(px, py, v):
        if 0 <= px < 16 and 0 <= py < 32:
            inten[py, px] = max(inten[py, px], v)

    def path(x, y, y_end, wid, val, allow_branch):
        while y < y_end:
            step = rng.randint(2, 4)
            nx = min(13, max(2, x + rng.choice((-3, -2, -1, 1, 2, 3))))
            for k in range(step + 1):
                px = int(round(x + (nx - x) * k / step))
                py = y + k
                put(px, py, val)
                if wid > 1:
                    put(px + 1, py, val)
                for hx in (-1, 1, 2 if wid > 1 else 1):
                    put(px + hx, py, val * 0.35)
            if allow_branch and rng.random() < 0.3:
                path(nx, y + step, min(y_end, y + step + rng.randint(5, 8)), 1, val * 0.75, False)
            x, y = nx, y + step

    path(rng.randint(6, 9), 0, 32, 2, 1.0, True)
    return additive(inten)


def strip_profile(kind):
    if kind == 'beam':
        prof = np.array([0.12, 0.38, 0.78, 1.0, 1.0, 0.78, 0.38, 0.12])
        v = np.arange(32)
        lon = 0.93 + 0.07 * np.cos(2 * math.pi * v / 16.0)
        return additive(np.outer(lon, prof), 16)
    if kind == 'core':
        prof = np.array([0.0, 0.06, 0.48, 1.0, 1.0, 0.48, 0.06, 0.0])
        return additive(np.outer(np.ones(32), prof), 16)
    if kind == 'streak':
        prof = np.array([0.0, 0.15, 0.55, 1.0, 1.0, 0.55, 0.15, 0.0])
        lon = np.sin(math.pi * (np.arange(32) + 0.5) / 32) ** 0.7
        return straight(np.outer(lon, prof), np.ones((32, 8)))
    raise ValueError(kind)


def paint_psi(frame):
    x = np.arange(16) + 0.5
    v = np.arange(32) + 0.5
    ph = frame / 4.0
    out = np.zeros((32, 16))
    for j, vv in enumerate(v):
        s = 4.2 * math.sin(2 * math.pi * (vv / 16.0 + ph))
        g1 = np.exp(-((x - 8 - s) ** 2) / (2 * 0.75 ** 2))
        g2 = np.exp(-((x - 8 + s) ** 2) / (2 * 0.75 ** 2)) * 0.8
        core = np.exp(-((x - 8) ** 2) / (2 * 1.6 ** 2)) * 0.3
        out[j] = np.maximum.reduce([g1, g2, core])
    return additive(out)


def paint_silhouette(run):
    parts = [(4, 0, 8, 8), (4, 8, 8, 12)]
    if run:
        parts += [(0, 7, 4, 9), (12, 9, 4, 11), (4, 20, 4, 9), (8, 21, 4, 11)]
    else:
        parts += [(0, 8, 4, 12), (12, 8, 4, 12), (4, 20, 4, 12), (8, 20, 4, 12)]
    a = np.zeros((32, 16))
    s = np.zeros((32, 16))
    for px, py, pw, ph in parts:
        for yy in range(py, py + ph):
            for xx in range(px, px + pw):
                rim = xx in (px, px + pw - 1) or yy in (py, py + ph - 1)
                a[yy, xx] = max(a[yy, xx], 1.0 if rim else 0.55)
                s[yy, xx] = max(s[yy, xx], 1.0 if rim else 0.82)
    # face hint: eyes darker gap
    for xx in (6, 9):
        a[4, xx] = 0.3
    return straight(a, s)


def paint_swirl():
    x, y = grid(32, 32)
    r = np.sqrt(x * x + y * y)
    th = np.arctan2(y, x)
    s = th + r * 0.38
    arms = ((np.cos(3 * s) + 1) / 2) ** 2.2 * np.clip(1 - r / 15.5, 0, 1) ** 0.6 * np.clip((r - 1.5) / 3, 0, 1)
    core = np.clip(1 - r / 4.5, 0, 1) * 0.8
    return additive(np.clip(np.maximum(arms * 1.3, core), 0, 1))


def build_atlas():
    rng = np.random.default_rng(1729)
    img = np.zeros((TH, TW, 4))

    def blit(name, spr):
        x, y, w, h = CELLS[name]
        assert spr.shape == (h, w, 4), (name, spr.shape, (h, w))
        img[y:y + h, x:x + w] = spr

    blit('glow', paint_glow(16))
    blit('glow_big', paint_glow(32))
    blit('dot', paint_dot())
    blit('star', paint_star())
    blit('ember', paint_ember())
    for i in range(4):
        blit(f'chunk{i}', paint_chunk(i, rng))
        blit(f'grain{i}', ascii_sprite(GRAINS[i], {'#': (0.92, 1), 'x': (0.66, 1)}))
        blit(f'smoke{i}', cloud(16, i, rng))
        blit(f'smoke_big{i}', cloud(32, i, rng, big=True))
        blit(f'flame{i}', paint_flame(i, rng))
        blit(f'fire_big{i}', paint_big_fire(i, rng))
        blit(f'sparkle{i}', paint_sparkle(i))
        blit(f'bolt{i}', paint_bolt(i))
        psi = paint_psi(i)
        blit(f'psi_v{i}', psi)
        blit(f'psi_h{i}', np.transpose(psi, (1, 0, 2)))
    blit('drop', ascii_sprite(DROP, {'#': (0.86, 1), 'o': (1.0, 1), 'x': (0.62, 1)}))
    blit('bubble', paint_bubble())
    blit('mote', paint_mote())
    blit('hex', paint_hex())
    blit('ash', ascii_sprite(ASH, {'#': (0.42, 1), 'x': (0.3, 1)}))
    blit('foam', paint_foam(rng))
    for k in ('ring', 'ring_thick', 'ring_vapour', 'ring_target'):
        blit(k, paint_ring(k, rng))
    blit('flash', paint_flash())
    blit('crack0', paint_crack(7))
    blit('crack1', paint_crack(19))
    blit('sil_stand', paint_silhouette(False))
    blit('sil_run', paint_silhouette(True))
    blit('swirl', paint_swirl())
    for kind in ('beam', 'core', 'streak'):
        spr = strip_profile(kind)
        blit(f'{kind}_v', spr)
        blit(f'{kind}_h', np.transpose(spr, (1, 0, 2)))
    return Image.fromarray(np.round(np.clip(img, 0, 1) * 255).astype(np.uint8), 'RGBA')


# ====================================================================== particle JSON helpers
def n(v):
    """JSON value for a Molang field: constants stay numbers, expressions stay strings."""
    if isinstance(v, str):
        return v
    v = round(float(v), 4)
    return int(v) if v == int(v) else v


T_EXPR = 'variable.t = math.clamp(variable.particle_age / math.max(variable.particle_lifetime, 0.001), 0, 1);'
R1, R2, R3, R4 = (f'variable.particle_random_{i}' for i in range(1, 5))


def col_init(default):
    r, g, b = default
    return ('variable.hc = (variable.color.r + variable.color.g + variable.color.b) > 0.004;'
            f'variable.tr = variable.hc ? variable.color.r : {n(r)};'
            f'variable.tg = variable.hc ? variable.color.g : {n(g)};'
            f'variable.tb = variable.hc ? variable.color.b : {n(b)};')


def dir_init(default=(0, 1, 0)):
    dx, dy, dz = default
    return ('variable.dl = math.sqrt(variable.dir.x * variable.dir.x + variable.dir.y * variable.dir.y + variable.dir.z * variable.dir.z);'
            f'variable.ax = variable.dl > 0.0001 ? variable.dir.x / variable.dl : {n(dx)};'
            f'variable.ay = variable.dl > 0.0001 ? variable.dir.y / variable.dl : {n(dy)};'
            f'variable.az = variable.dl > 0.0001 ? variable.dir.z / variable.dl : {n(dz)};')


def num_init(var, src, default, lo=None, hi=None):
    e = f'(variable.{src} > 0 ? variable.{src} : {n(default)})'
    if lo is not None:
        e = f'math.clamp({e}, {n(lo)}, {n(hi)})'
    return f'variable.{var} = {e};'


def idx(count, r=R4):
    return f'math.min(math.floor({r} * {count}), {count - 1})'


def uv_static(cell):
    x, y, w, h = CELLS[cell]
    return {'texture_width': TW, 'texture_height': TH, 'uv': [x, y], 'uv_size': [w, h]}


def uv_expr(xe, ye, w, h):
    return {'texture_width': TW, 'texture_height': TH, 'uv': [xe, ye], 'uv_size': [w, h]}


def uv_flip(cell0, frames, step=None):
    x, y, w, h = CELLS[cell0]
    return {'texture_width': TW, 'texture_height': TH,
            'flipbook': {'base_UV': [x, y], 'size_UV': [w, h], 'step_UV': list(step or [w, 0]),
                         'max_frame': frames, 'stretch_to_lifetime': True, 'loop': False}}


def frame_x(cell0, frames, t='variable.t'):
    x = CELLS[cell0][0]
    w = CELLS[cell0][2]
    return f'{x} + math.min(math.floor({t} * {frames}), {frames - 1}) * {w}'


def strip(kind):
    """UV + size helper for lookat_direction quads along the direction."""
    return CELLS[f'{kind}_{"v" if LOOKAT_DIRECTION_LONG_AXIS == "y" else "h"}']


def along(half_width, half_length):
    return [half_width, half_length] if LOOKAT_DIRECTION_LONG_AXIS == 'y' else [half_length, half_width]


def instant(count, active=0.05):
    return {'minecraft:emitter_rate_instant': {'num_particles': count},
            'minecraft:emitter_lifetime_once': {'active_time': active}}


def tint(r, g, b, a):
    return {'minecraft:particle_appearance_tinting': {'color': [n(r), n(g), n(b), n(a)]}}


def billboard(size, mode, uv, direction=None):
    bb = {'size': [n(size[0]), n(size[1])], 'facing_camera_mode': mode}
    if direction is not None:
        bb['direction'] = {'mode': 'custom', 'custom_direction': [n(d) for d in direction]}
    bb['uv'] = uv
    return {'minecraft:particle_appearance_billboard': bb}


def init(creation=None, per_render=T_EXPR, per_update=None):
    out = {}
    if creation:
        out['minecraft:emitter_initialization'] = {'creation_expression': creation}
    pi = {}
    if per_update:
        pi['per_update_expression'] = per_update
    if per_render:
        pi['per_render_expression'] = per_render
    if pi:
        out['minecraft:particle_initialization'] = pi
    return out


def life(expr):
    return {'minecraft:particle_lifetime_expression': {'max_lifetime': n(expr)}}


def dynamic(acc=(0, 0, 0), drag=0, rot_drag=None):
    d = {'linear_acceleration': [n(a) for a in acc], 'linear_drag_coefficient': n(drag)}
    if rot_drag is not None:
        d['rotation_drag_coefficient'] = n(rot_drag)
    return {'minecraft:particle_motion_dynamic': d}


def collision(radius, restitution=0.2, drag=4, expire=False):
    c = {'collision_radius': radius, 'coefficient_of_restitution': restitution, 'collision_drag': drag}
    if expire:
        c['expire_on_contact'] = True
    return {'minecraft:particle_motion_collision': c}


def spin(rotation, rate=0):
    return {'minecraft:particle_initial_spin': {'rotation': n(rotation), 'rotation_rate': n(rate)}}


def speed(v):
    return {'minecraft:particle_initial_speed': n(v)}


def point(offset=(0, 0, 0), direction=None):
    s = {'offset': [n(o) for o in offset]}
    if direction is not None:
        s['direction'] = direction if isinstance(direction, str) else [n(d) for d in direction]
    return {'minecraft:emitter_shape_point': s}


def sphere(radius, direction='outwards', surface=False, offset=(0, 0, 0)):
    s = {'offset': [n(o) for o in offset], 'radius': n(radius), 'surface_only': surface}
    s['direction'] = direction if isinstance(direction, str) else [n(d) for d in direction]
    return {'minecraft:emitter_shape_sphere': s}


def box(half, direction='outwards', offset=(0, 0, 0)):
    s = {'offset': [n(o) for o in offset], 'half_dimensions': [n(h) for h in half], 'surface_only': False}
    s['direction'] = direction if isinstance(direction, str) else [n(d) for d in direction]
    return {'minecraft:emitter_shape_box': s}


def merge(*parts):
    out = {}
    for p in parts:
        out.update(p)
    return out


FADE = '(1 - variable.t)'
ENV = 'math.sin(variable.t * 180)'  # 0 -> 1 -> 0 envelope


def effect(pid, material, components, lighting=False, curves=None):
    comps = dict(components)
    if lighting:
        comps['minecraft:particle_appearance_lighting'] = {}
    pe = {'description': {'identifier': pid,
                          'basic_render_parameters': {'material': material, 'texture': TEX}}}
    if curves:
        pe['curves'] = curves
    pe['components'] = comps
    return {'format_version': '1.10.0', 'particle_effect': pe}


# ====================================================================== effects
def effects():
    E = {}
    DIR = ['variable.ax', 'variable.ay', 'variable.az']

    # ---------------------------------------------------------------- beams
    for pid, kind, wmul, white in (('sp:beam', 'beam', 1.0, 0.0), ('sp:beam_core', 'core', 0.4, 0.75)):
        x, y, w, h = strip(kind)
        f = '(1 - variable.t * 0.6)'
        mix = lambda c: f'(variable.{c} + (1 - variable.{c}) * {n(white)})' if white else f'variable.{c}'
        E[pid] = effect(pid, 'particles_add', merge(
            init(col_init((1.0, 0.28, 0.08)) + dir_init() +
                 num_init('bl', 'len', 2) + num_init('bw', 'width', 0.1)),
            instant(1), point(), speed(0), life(0.1),
            billboard(along('variable.bw' if wmul == 1 else f'variable.bw * {n(wmul)}', 'variable.bl * 0.5'), 'lookat_direction',
                      uv_expr(x, y, w, h), DIR),
            tint(f'{mix("tr")} * {f}', f'{mix("tg")} * {f}', f'{mix("tb")} * {f}', f),
        ))

    # ---------------------------------------------------------------- glow
    E['sp:glow'] = effect('sp:glow', 'particles_add', merge(
        init(col_init((1.0, 0.45, 0.15)) + num_init('gs', 'size', 0.4)),
        instant(1), point(), speed(0), life(0.15),
        billboard(['variable.gs * (1 + variable.t * 0.25)', 'variable.gs * (1 + variable.t * 0.25)'], 'lookat_xyz',
                  uv_static('glow')),
        tint(f'variable.tr * {FADE}', f'variable.tg * {FADE}', f'variable.tb * {FADE}', FADE),
    ))

    # ---------------------------------------------------------------- sparks
    white_to = lambda c, k: f'(1 + (variable.{c} - 1) * math.min(variable.t * {k}, 1))'
    fade2 = '(1 - variable.t * variable.t)'
    E['sp:spark'] = effect('sp:spark', 'particles_add', merge(
        init(col_init((1.0, 0.7, 0.3))),
        instant(10), sphere(0.05), speed('math.random(3, 7)'), life('math.random(0.4, 0.7)'),
        dynamic((0, -14, 0), 2), collision(0.04, 0.4, 3),
        billboard(['0.07 * (1 - variable.t * 0.6)', '0.07 * (1 - variable.t * 0.6)'], 'lookat_xyz', uv_static('star')),
        tint(f'{white_to("tr", 2.5)} * {fade2}', f'{white_to("tg", 2.5)} * {fade2}', f'{white_to("tb", 2.5)} * {fade2}', fade2),
    ))

    # ---------------------------------------------------------------- embers
    flick = f'(0.75 + 0.25 * math.sin(variable.particle_age * 1500 + {R2} * 360))'
    E['sp:ember'] = effect('sp:ember', 'particles_add', merge(
        instant(3), init(),
        box((0.3, 0.15, 0.3), ['math.random(-0.3, 0.3)', 1, 'math.random(-0.3, 0.3)']),
        speed('math.random(0.4, 0.9)'), life('math.random(0.85, 1.15)'),
        dynamic([f'math.sin(variable.particle_age * 360 + {R2} * 360) * 0.8', 0.3,
                 f'math.cos(variable.particle_age * 300 + {R3} * 360) * 0.8'], 1.2),
        billboard(['0.065 * (1 - variable.t * 0.6)', '0.065 * (1 - variable.t * 0.6)'], 'lookat_xyz', uv_static('ember')),
        tint(f'{FADE} * {flick}', f'math.lerp(0.9, 0.25, variable.t) * {FADE} * {flick}',
             f'math.lerp(0.4, 0.04, variable.t) * {FADE} * {flick}', FADE),
    ))

    # ---------------------------------------------------------------- smoke
    smoke_a = '0.85 * math.pow(1 - variable.t, 1.2) * math.min(variable.t * 6, 1)'
    E['sp:smoke'] = effect('sp:smoke', 'particles_blend', merge(
        instant(2), init(),
        sphere(0.2, ['math.random(-0.2, 0.2)', 1, 'math.random(-0.2, 0.2)']),
        speed('math.random(0.5, 0.9)'), life('math.random(1.3, 1.7)'),
        dynamic((0, 0.3, 0), 0.8), spin('math.random(0, 360)', 'math.random(-40, 40)'),
        billboard(['0.25 + variable.t * 0.45', '0.25 + variable.t * 0.45'], 'lookat_xyz', uv_flip('smoke0', 4)),
        tint(0.22, 0.21, 0.2, smoke_a),
    ), lighting=True)

    # ---------------------------------------------------------------- molten droplets
    E['sp:melt'] = effect('sp:melt', 'particles_add', merge(
        instant(4), init(),
        sphere(0.4, ['math.random(-0.2, 0.2)', -1, 'math.random(-0.2, 0.2)']),
        speed('math.random(0.2, 0.8)'), life('math.random(0.8, 1.3)'),
        dynamic((0, -9, 0), 0.4), collision(0.04, 0, 10),
        billboard(['0.075 * (1 - variable.t * 0.4)', '0.075 * (1 - variable.t * 0.4)'], 'lookat_xyz', uv_static('drop')),
        tint('1 - math.pow(variable.t, 3)', 'math.lerp(0.85, 0.3, variable.t) * (1 - math.pow(variable.t, 3))',
             'math.lerp(0.4, 0.05, variable.t) * (1 - math.pow(variable.t, 3))', '1 - math.pow(variable.t, 3)'),
    ))

    # ---------------------------------------------------------------- dust
    shrink_end = lambda start: f'(variable.t < {n(start)} ? 1 : (1 - variable.t) / {n(1 - start)})'
    grain_uv = uv_expr(f'192 + {idx(4)} * 8', 16, 8, 8)
    k = f'(0.75 + {R3} * 0.35)'
    E['sp:dust'] = effect('sp:dust', 'particles_alpha', merge(
        init(col_init((0.6, 0.55, 0.5))),
        instant(14), sphere(0.35), speed('math.random(1, 3)'), life('math.random(0.6, 1.2)'),
        dynamic((0, -7, 0), 2.5), collision(0.04, 0.2, 5),
        billboard([f'(0.045 + {R2} * 0.05) * {shrink_end(0.7)}'] * 2, 'lookat_xyz', grain_uv),
        tint(f'variable.tr * {k}', f'variable.tg * {k}', f'variable.tb * {k}', 1),
    ), lighting=True)
    E['sp:dust_fall'] = effect('sp:dust_fall', 'particles_alpha', merge(
        init(col_init((0.6, 0.55, 0.5))),
        instant(2), box((0.25, 0.1, 0.25), [0, -1, 0]), speed('math.random(0, 0.3)'),
        life('math.random(0.5, 0.9)'), dynamic((0, -5, 0), 1), collision(0.03, 0, 5, expire=True),
        billboard([f'(0.03 + {R2} * 0.025) * {shrink_end(0.7)}'] * 2, 'lookat_xyz', grain_uv),
        tint(f'variable.tr * {k}', f'variable.tg * {k}', f'variable.tb * {k}', 1),
    ), lighting=True)

    # ---------------------------------------------------------------- rock chunks
    cs_inline = 'math.clamp(variable.size > 0 ? variable.size : 1, 0.3, 3)'
    E['sp:debris_chunks'] = effect('sp:debris_chunks', 'particles_alpha', merge(
        init(col_init((0.55, 0.5, 0.45)) + num_init('cs', 'size', 1, 0.3, 3)),
        instant(f'math.clamp(12 + {cs_inline} * 4, 12, 24)'),
        sphere(f'0.25 * {cs_inline}', ['math.random(-1, 1)', 'math.random(0.4, 1.4)', 'math.random(-1, 1)']),
        speed(f'math.random(2.5, 5.5) * math.sqrt({cs_inline})'), life('math.random(1.0, 1.8)'),
        dynamic((0, -14, 0), 1, 1.0), collision(0.06, 0.3, 6),
        spin('math.random(0, 360)', 'math.random(-540, 540)'),
        billboard([f'(0.05 + {R2} * 0.07) * variable.cs * {shrink_end(0.8)}'] * 2, 'lookat_xyz',
                  uv_expr(f'64 + math.mod({idx(4)}, 2) * 8', f'math.floor({idx(4)} / 2) * 8', 8, 8)),
        tint(f'variable.tr * (0.7 + {R3} * 0.4)', f'variable.tg * (0.7 + {R3} * 0.4)', f'variable.tb * (0.7 + {R3} * 0.4)', 1),
    ), lighting=True)

    # ---------------------------------------------------------------- shockwaves
    grow3 = '(1 - math.pow(1 - variable.t, 3))'
    E['sp:shockwave'] = effect('sp:shockwave', 'particles_blend', merge(
        init(col_init((0.9, 0.9, 0.9)) + num_init('sr', 'radius', 3, 0.2, 64)),
        instant(1), point(), speed(0), life(0.45), spin('math.random(0, 360)'),
        billboard([f'variable.sr * {grow3} + 0.1'] * 2, 'emitter_transform_xz', uv_static('ring_thick')),
        tint('variable.tr', 'variable.tg', 'variable.tb', 'variable.shock_alpha'),
    ), curves={'variable.shock_alpha': {
        'type': 'linear', 'input': 'variable.particle_age / variable.particle_lifetime', 'horizontal_range': 1,
        'nodes': [0.95, 0.85, 0.6, 0.3, 0.0]}})
    E['sp:shockwave_air'] = effect('sp:shockwave_air', 'particles_blend', merge(
        init(col_init((0.92, 0.92, 0.95)) + num_init('sr', 'radius', 2, 0.2, 64)),
        instant(1), point(), speed(0), life(0.35),
        billboard([f'variable.sr * {grow3} + 0.05'] * 2, 'lookat_xyz', uv_static('ring')),
        tint('variable.tr', 'variable.tg', 'variable.tb', '0.8 * math.pow(1 - variable.t, 1.3)'),
    ))
    E['sp:sonic_boom'] = effect('sp:sonic_boom', 'particles_blend', merge(
        init(dir_init((0, 0, 1))),
        instant(2), point(), speed(0), life(0.5), spin('math.random(0, 360)', 'math.random(-60, 60)'),
        billboard([f'(0.3 + 2.2 * (1 - math.pow(1 - variable.t, 2.5))) * (0.6 + {R1} * 0.4)'] * 2,
                  'direction_z', uv_static('ring_vapour'), DIR),
        tint(0.95, 0.97, 1.0, '0.9 * math.pow(1 - variable.t, 1.6)'),
    ))

    # ---------------------------------------------------------------- wind streaks
    x, y, w, h = strip('streak')
    E['sp:wind_streak'] = effect('sp:wind_streak', 'particles_blend', merge(
        init(dir_init() + num_init('wl', 'len', 2, 0.1, 16)),
        instant('math.random_integer(4, 6)'), sphere(0.7, 'outwards'), speed(0),
        life('math.random(0.15, 0.25)'),
        billboard(along(0.018, f'variable.wl * 0.5 * (0.5 + {R2} * 0.5)'), 'lookat_direction',
                  uv_expr(x, y, w, h), DIR),
        tint(1, 1, 1, '0.6 * (1 - variable.t) * math.min(variable.t * 8, 1)'),
    ))

    # ---------------------------------------------------------------- vapour puff
    E['sp:cloud_puff'] = effect('sp:cloud_puff', 'particles_blend', merge(
        instant(5), init(), sphere(0.3), speed('math.random(0.2, 0.6)'), life('math.random(0.8, 1.2)'),
        dynamic((0, 0.15, 0), 1.5), spin('math.random(0, 360)', 'math.random(-30, 30)'),
        billboard([f'(0.25 + {R2} * 0.15) * (1 + variable.t * 1.2)'] * 2, 'lookat_xyz', uv_flip('smoke0', 4)),
        tint(1, 1, 1, '0.7 * math.pow(1 - variable.t, 1.3)'),
    ), lighting=True)

    # ---------------------------------------------------------------- lightning
    flicker = f'(math.mod(math.floor(variable.particle_age * 40 + {R2} * 4), 2) < 1 ? 1 : 0.35)'
    hot = lambda c: f'(variable.{c} + (1 - variable.{c}) * 0.35)'
    E['sp:lightning'] = effect('sp:lightning', 'particles_add', merge(
        init(col_init((1.0, 0.9, 0.45))),
        instant('math.random_integer(2, 3)'), sphere(0.3), speed(0), life('math.random(0.12, 0.22)'),
        spin('math.random(0, 360)'),
        billboard([f'0.35 * (0.8 + {R3} * 0.4)', f'0.7 * (0.8 + {R3} * 0.4)'], 'lookat_xyz',
                  uv_expr(f'math.mod(math.floor({R1} * 4 + variable.particle_age * 30), 4) * 16', 96, 16, 32)),
        tint(f'{hot("tr")} * {flicker}', f'{hot("tg")} * {flicker}', f'{hot("tb")} * {flicker}', flicker),
    ))

    # ---------------------------------------------------------------- afterimage
    E['sp:afterimage'] = effect('sp:afterimage', 'particles_blend', merge(
        init(col_init((1.0, 0.86, 0.2))),
        instant(1), point((0, 0.94, 0)), speed(0), life(0.4),
        billboard(['0.47 * (1 + variable.t * 0.08)', '0.94 * (1 + variable.t * 0.08)'], 'rotate_y',
                  uv_expr(f'160 + ({R1} < 0.5 ? 0 : 16)', 96, 16, 32)),
        tint('variable.tr * 0.85 + 0.15', 'variable.tg * 0.85 + 0.15', 'variable.tb * 0.85 + 0.15', '0.6 * (1 - variable.t)'),
    ))

    # ---------------------------------------------------------------- water
    foam = f'({R1} < 0.3)'
    E['sp:water_splash'] = effect('sp:water_splash', 'particles_blend', merge(
        instant(16), init(),
        sphere(0.3, ['math.random(-1, 1)', 'math.random(1.2, 2.2)', 'math.random(-1, 1)']),
        speed(f'{foam} ? math.random(0.5, 1.2) : math.random(2.5, 5)'),
        life(f'{foam} ? math.random(0.6, 1.0) : math.random(0.5, 0.9)'),
        dynamic([0, f'{foam} ? -1.5 : -14', 0], f'{foam} ? 3 : 0.5'), collision(0.05, 0, 1, expire=True),
        billboard([f'{foam} ? (0.12 + {R2} * 0.1) * (1 + variable.t) : 0.05 + {R2} * 0.03'] * 2, 'lookat_xyz',
                  uv_expr(f'{foam} ? 176 : 96', 0, f'{foam} ? 16 : 8', f'{foam} ? 16 : 8')),
        tint(f'{foam} ? 1 : 0.6', f'{foam} ? 1 : 0.8', 1, f'{foam} ? 0.8 * (1 - variable.t) : 0.85'),
    ), lighting=True)

    # ---------------------------------------------------------------- psionic
    E['sp:psi_aura'] = effect('sp:psi_aura', 'particles_add', merge(
        init(col_init((0.78, 0.36, 1.0))),
        instant(7), point(), life('math.random(0.5, 0.7)'),
        {'minecraft:particle_motion_parametric': {'relative_position': [
            f'({R1} < 0.14 ? 0 : 1) * (0.55 + {R4} * 0.35) * math.cos({R1} * 360 + variable.particle_age * (200 + {R2} * 160) * ({R3} < 0.5 ? 1 : -1))',
            f'({R1} < 0.14 ? 0 : 1) * (({R2} - 0.5) * 1.4 + variable.particle_age * 0.4)',
            f'({R1} < 0.14 ? 0 : 1) * (0.55 + {R4} * 0.35) * math.sin({R1} * 360 + variable.particle_age * (200 + {R2} * 160) * ({R3} < 0.5 ? 1 : -1))']}},
        spin('math.random(0, 360)', f'{R1} < 0.14 ? 540 : 0'),
        billboard([f'{R1} < 0.14 ? 0.45 : 0.06 * (1 + 0.3 * math.sin(variable.particle_age * 900))'] * 2, 'lookat_xyz',
                  uv_expr(f'{R1} < 0.14 ? 192 : 128', f'{R1} < 0.14 ? 96 : 0', f'{R1} < 0.14 ? 32 : 8', f'{R1} < 0.14 ? 32 : 8')),
        tint(f'variable.tr * {ENV}', f'variable.tg * {ENV}', f'variable.tb * {ENV}', f'{ENV} * ({R1} < 0.14 ? 0.5 : 1)'),
    ))
    x, y, w, h = CELLS['psi_v0' if LOOKAT_DIRECTION_LONG_AXIS == 'y' else 'psi_h0']  # frames step along x by w
    E['sp:psi_link'] = effect('sp:psi_link', 'particles_add', merge(
        init(col_init((0.78, 0.36, 1.0)) + dir_init() + num_init('pl', 'len', 3, 0.1, 64)),
        instant(1), point(), speed(0), life(0.1),
        billboard(along(0.16, 'variable.pl * 0.5'), 'lookat_direction',
                  uv_expr(f'{x} + {idx(4, R1)} * {w}', y, w, h), DIR),
        tint('variable.tr * 0.85', 'variable.tg * 0.85', 'variable.tb * 0.85', '0.75 * (1 - variable.t * 0.5)'),
    ))
    hexsel = f'({R1} < 0.4)'
    E['sp:psi_shield'] = effect('sp:psi_shield', 'particles_add', merge(
        init(num_init('sr', 'radius', 3, 0.5, 32)),
        instant('math.clamp(math.pow(math.clamp(variable.radius > 0 ? variable.radius : 3, 0.5, 32), 2) * 1.6, 8, 36)'),
        sphere('math.clamp(variable.radius > 0 ? variable.radius : 3, 0.5, 32)', 'outwards', surface=True),
        speed('math.random(0, 0.15)'), life('math.random(0.5, 0.8)'),
        billboard([f'{hexsel} ? 0.22 : 0.09'] * 2, 'lookat_xyz',
                  uv_expr(f'{hexsel} ? 144 : {frame_x("sparkle0", 4)}', f'{hexsel} ? 0 : 16', 16, 16)),
        tint(f'({hexsel} ? 0.6 : 0.85) * {ENV}', f'({hexsel} ? 0.45 : 0.6) * {ENV}', ENV, ENV),
    ))
    flashsel = f'({R1} < 0.17)'
    E['sp:reflect'] = effect('sp:reflect', 'particles_add', merge(
        instant(12), init(), sphere(0.1), speed(f'{flashsel} ? 0 : math.random(3, 6)'),
        life(f'{flashsel} ? 0.18 : math.random(0.25, 0.45)'), dynamic((0, 0, 0), 4),
        billboard([f'{flashsel} ? 0.9 * (1 + variable.t * 0.5) : 0.08 * (1 - variable.t * 0.5)'] * 2, 'lookat_xyz',
                  uv_expr(f'{flashsel} ? 128 : 32', f'{flashsel} ? 32 : 0', f'{flashsel} ? 32 : 16', f'{flashsel} ? 32 : 16')),
        tint(f'({flashsel} ? 1 : 0.85) * math.pow(1 - variable.t, 2)', f'({flashsel} ? 0.85 : 0.5) * math.pow(1 - variable.t, 2)',
             'math.pow(1 - variable.t, 2)', 'math.pow(1 - variable.t, 2)'),
    ))

    # ---------------------------------------------------------------- meteor
    firesel = f'({R1} < 0.55)'
    E['sp:meteor_trail'] = effect('sp:meteor_trail', 'particles_blend', merge(
        init(num_init('ms', 'size', 1, 0.2, 6)),
        instant(3), sphere('0.25 * math.clamp(variable.size > 0 ? variable.size : 1, 0.2, 6)'),
        speed('math.random(0.1, 0.4)'), life(f'{firesel} ? math.random(0.4, 0.7) : math.random(1.0, 1.6)'),
        dynamic([0, f'{firesel} ? 0.2 : 0.6', 0], 0.6), spin('math.random(0, 360)', 'math.random(-60, 60)'),
        billboard([f'{firesel} ? (0.35 + {R2} * 0.15) * variable.ms * (1 - variable.t * 0.5) : (0.4 + {R2} * 0.2) * variable.ms * (1 + variable.t * 1.2)'] * 2,
                  'lookat_xyz', {'texture_width': TW, 'texture_height': TH, 'flipbook': {
                      'base_UV': [f'{firesel} ? 64 : 0', 16], 'size_UV': [16, 16], 'step_UV': [16, 0],
                      'max_frame': 4, 'stretch_to_lifetime': True, 'loop': False}}),
        tint(f'{firesel} ? 1 : 0.25', f'{firesel} ? 1 : 0.23', f'{firesel} ? 1 : 0.22',
             f'{firesel} ? 0.95 * (1 - variable.t * variable.t) : 0.7 * (1 - variable.t) * math.min(variable.t * 5, 1)'),
    ))
    E['sp:meteor_marker'] = effect('sp:meteor_marker', 'particles_add', merge(
        init(num_init('mr', 'radius', 3, 0.3, 64)),
        instant(1), point(), speed(0), life(0.55), spin(0, 45),
        billboard(['variable.mr * (1 + 0.04 * math.sin(variable.particle_age * 720))'] * 2, 'emitter_transform_xz',
                  uv_static('ring_target')),
        tint('variable.pulse', '0.15 * variable.pulse', '0.08 * variable.pulse', 'variable.pulse'),
    ), curves={'variable.pulse': {
        'type': 'catmull_rom', 'input': 'variable.particle_age / variable.particle_lifetime', 'horizontal_range': 1,
        'nodes': [0.0, 0.0, 1.0, 0.7, 1.0, 0.0, 0.0]}})
    E['sp:explosion_flash'] = effect('sp:explosion_flash', 'particles_add', merge(
        init(num_init('fs', 'size', 3, 0.2, 32)),
        instant(1), point(), speed(0), life(0.2), spin('math.random(0, 360)'),
        billboard(['variable.fs * (0.8 + variable.t * 0.6)'] * 2, 'lookat_xyz', uv_static('flash')),
        tint('math.pow(1 - variable.t, 2)', '0.95 * math.pow(1 - variable.t, 2)', '0.8 * math.pow(1 - variable.t, 2)',
             'math.pow(1 - variable.t, 2)'),
    ))
    fb = f'({R1} < 0.6)'
    fs_inline = 'math.clamp(variable.size > 0 ? variable.size : 2, 0.3, 8)'
    E['sp:fireball'] = effect('sp:fireball', 'particles_blend', merge(
        init(num_init('bs', 'size', 2, 0.3, 8)),
        instant(30), sphere(f'0.6 * {fs_inline}', ['math.random(-1, 1)', 'math.random(0.3, 1.5)', 'math.random(-1, 1)']),
        speed(f'({fb} ? math.random(1.5, 4) : math.random(1, 2.5)) * math.sqrt({fs_inline})'),
        life(f'{fb} ? math.random(0.7, 1.3) : math.random(2.0, 3.0)'),
        dynamic([0, f'{fb} ? 1.5 : 2.0', 0], f'{fb} ? 2.5 : 1.2'), spin('math.random(0, 360)', 'math.random(-30, 30)'),
        billboard([f'{fb} ? (0.4 + {R3} * 0.3) * variable.bs * (0.6 + variable.t * 0.8) : (0.5 + {R3} * 0.3) * variable.bs * (0.8 + variable.t * 1.4)'] * 2,
                  'lookat_xyz', {'texture_width': TW, 'texture_height': TH, 'flipbook': {
                      'base_UV': [f'{fb} ? 0 : 128', 64], 'size_UV': [32, 32], 'step_UV': [32, 0],
                      'max_frame': 4, 'stretch_to_lifetime': True, 'loop': False}}),
        tint(f'{fb} ? 1 : 0.2', f'{fb} ? 1 : 0.19', f'{fb} ? 1 : 0.18',
             f'{fb} ? 1 - variable.t * variable.t : 0.8 * (1 - variable.t) * math.min(variable.t * 4, 1)'),
    ))

    # ---------------------------------------------------------------- charge / power fx
    E['sp:charge_aura'] = effect('sp:charge_aura', 'particles_add', merge(
        init(col_init((1.0, 0.8, 0.4))),
        instant(6), sphere(1.3, 'inwards', surface=True), speed(2.4), life(0.5),
        billboard(['0.05 + variable.t * 0.03'] * 2, 'lookat_xyz', uv_static('mote')),
        tint(f'variable.tr * {ENV}', f'variable.tg * {ENV}', f'variable.tb * {ENV}', ENV),
    ))
    E['sp:crack'] = effect('sp:crack', 'particles_blend', merge(
        init(num_init('ks', 'size', 1.5, 0.2, 16)),
        instant(1), point(), speed(0), life(2.0), spin('math.random(0, 360)'),
        billboard(['variable.ks * (0.55 + 0.45 * math.min(variable.t * 10, 1))'] * 2, 'emitter_transform_xz',
                  uv_expr(f'{R1} < 0.5 ? 192 : 224', 32, 32, 32)),
        tint(1, 1, 1, '(variable.t < 0.6 ? 1 : (1 - variable.t) / 0.4)'),
    ), lighting=True)
    birth = '(variable.emitter_age - variable.particle_age)'
    ang = f'({birth} * 400 + ({R1} < 0.5 ? 0 : 180) + variable.particle_age * 120)'
    rad = f'(0.75 - {birth} * 0.12)'
    gain = lambda c: f'(variable.{c} + (1 - variable.{c}) * 0.3) * {ENV}'
    E['sp:power_gain'] = effect('sp:power_gain', 'particles_add', merge(
        init(col_init((0.55, 1.0, 0.45))),
        {'minecraft:emitter_rate_steady': {'spawn_rate': 18, 'max_particles': 40},
         'minecraft:emitter_lifetime_once': {'active_time': 1.4}},
        point(), life('math.random(0.5, 0.8)'),
        {'minecraft:particle_motion_parametric': {'relative_position': [
            f'{rad} * math.cos({ang})', f'{birth} * 1.25 + variable.particle_age * 0.4', f'{rad} * math.sin({ang})']}},
        billboard([0.12, 0.12], 'lookat_xyz', uv_expr(frame_x('sparkle0', 4), 16, 16, 16)),
        tint(gain('tr'), gain('tg'), gain('tb'), ENV),
    ))
    smk = f'({R1} < 0.5)'
    E['sp:power_purge'] = effect('sp:power_purge', 'particles_blend', merge(
        instant(20), init(), sphere(0.5, ['math.random(-1, 1)', 'math.random(-0.2, 1)', 'math.random(-1, 1)'], offset=(0, 1, 0)),
        speed(f'{smk} ? math.random(0.3, 0.7) : math.random(0.3, 0.8)'),
        life(f'{smk} ? math.random(1.2, 1.8) : math.random(1.5, 2.5)'),
        dynamic([f'{smk} ? 0 : math.sin(variable.particle_age * 200 + {R2} * 360) * 1.5',
                 f'{smk} ? 0.5 : -1.2', f'{smk} ? 0 : math.cos(variable.particle_age * 170 + {R3} * 360) * 1.5'],
                f'{smk} ? 1 : 1.5'),
        spin('math.random(0, 360)', 'math.random(-180, 180)'),
        billboard([f'{smk} ? (0.3 + {R2} * 0.2) * (1 + variable.t) : 0.05'] * 2, 'lookat_xyz',
                  uv_expr(f'{smk} ? {frame_x("smoke0", 4)} : 160', f'{smk} ? 16 : 0', f'{smk} ? 16 : 8', f'{smk} ? 16 : 8')),
        tint(f'{smk} ? 0.45 : 0.3', f'{smk} ? 0.45 : 0.3', f'{smk} ? 0.46 : 0.3',
             f'{smk} ? 0.8 * (1 - variable.t) : 1 - math.pow(variable.t, 4)'),
    ), lighting=True)
    pal = lambda c: f'(variable.{c} + (1 - variable.{c}) * 0.4)'
    E['sp:inject'] = effect('sp:inject', 'particles_blend', merge(
        init(col_init((0.45, 1.0, 0.5))),
        instant(8), sphere(0.12, ['math.random(-1, 1)', 'math.random(0, 1.5)', 'math.random(-1, 1)']),
        speed('math.random(0.4, 1.2)'), life('math.random(0.35, 0.7)'), dynamic((0, 0.8, 0), 2.5),
        billboard([f'(0.05 + {R2} * 0.04) * (variable.t > 0.85 ? 1.4 : 1)'] * 2, 'lookat_xyz', uv_static('bubble')),
        tint(pal('tr'), pal('tg'), pal('tb'), 0.85),
    ))
    twinkle = f'{ENV} * (0.7 + 0.3 * math.sin(variable.particle_age * 400 + {R2} * 360))'
    E['sp:time_motes'] = effect('sp:time_motes', 'particles_add', merge(
        instant(6), init(), sphere(2.5, 'outwards'), speed('math.random(0.05, 0.2)'), life('math.random(1.5, 2.5)'),
        dynamic((0, 0, 0), 0.2),
        billboard([f'0.045 + {R3} * 0.03'] * 2, 'lookat_xyz', uv_static('mote')),
        tint(f'0.55 * {twinkle}', f'0.75 * {twinkle}', twinkle, twinkle),
    ))
    lev = '(math.min(variable.t * 5, 1) * (1 - variable.t))'
    E['sp:levitate'] = effect('sp:levitate', 'particles_add', merge(
        init(col_init((0.78, 0.36, 1.0))),
        instant(4),
        {'minecraft:emitter_shape_disc': {'offset': [0, 0.05, 0], 'radius': 0.45, 'plane_normal': [0, 1, 0],
                                          'surface_only': False, 'direction': [0, 1, 0]}},
        speed('math.random(0.6, 1.3)'), life('math.random(0.6, 1.0)'), dynamic((0, 0, 0), 0.5),
        billboard(['0.055 * (1 - variable.t * 0.5)'] * 2, 'lookat_xyz', uv_static('mote')),
        tint(f'variable.tr * {lev}', f'variable.tg * {lev}', f'variable.tb * {lev}', lev),
    ))
    return E


# ====================================================================== Molang evaluator (check)
class MolangError(Exception):
    pass


TOKEN_RE = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)|([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)|('[^']*')|(\?\?|&&|\|\||==|!=|<=|>=|->|[-+*/()?:;,<>!=\[\]{}]))")


def tokenize(src):
    pos, out = 0, []
    src = src.rstrip()
    while pos < len(src):
        m = TOKEN_RE.match(src, pos)
        if not m or m.end() == pos:
            raise MolangError(f'bad token at {pos}: {src[pos:pos + 20]!r}')
        num, ident, s, op = m.groups()
        if num is not None:
            out.append(('num', float(num)))
        elif ident is not None:
            out.append(('id', ident.lower()))
        elif s is not None:
            out.append(('str', s[1:-1]))
        else:
            out.append(('op', op))
        pos = m.end()
        while pos < len(src) and src[pos].isspace():
            pos += 1
    return out


def _alias(name):
    for short, full in (('v.', 'variable.'), ('q.', 'query.'), ('t.', 'temp.'), ('c.', 'context.')):
        if name.startswith(short):
            return full + name[len(short):]
    return name


MATH = {
    'math.sin': lambda a: math.sin(math.radians(a)), 'math.cos': lambda a: math.cos(math.radians(a)),
    'math.floor': math.floor, 'math.ceil': math.ceil, 'math.round': lambda a: math.floor(a + 0.5),
    'math.trunc': math.trunc, 'math.abs': abs, 'math.sqrt': lambda a: math.sqrt(a) if a >= 0 else float('nan'),
    'math.pow': lambda a, b: float('nan') if (a < 0 and b != int(b)) else a ** b,
    'math.exp': math.exp, 'math.ln': lambda a: math.log(a) if a > 0 else float('nan'),
    'math.clamp': lambda v, lo, hi: max(lo, min(hi, v)), 'math.min': min, 'math.max': max,
    'math.mod': lambda a, b: math.fmod(a, b) if b else 0.0, 'math.lerp': lambda a, b, t: a + (b - a) * t,
    'math.hermite_blend': lambda t: 3 * t * t - 2 * t * t * t, 'math.atan2': lambda y, x: math.degrees(math.atan2(y, x)),
}


class Molang:
    """Tiny Molang subset parser/evaluator used to sanity check particle expressions."""

    def __init__(self, src):
        self.src = src
        self.toks = tokenize(src)
        self.i = 0
        self.reads, self.writes = set(), set()
        self.prog = self.statements()

    def peek(self, k=0):
        return self.toks[self.i + k] if self.i + k < len(self.toks) else ('eof', None)

    def take(self, kind=None, val=None):
        t = self.peek()
        if (kind and t[0] != kind) or (val is not None and t[1] != val):
            raise MolangError(f'expected {val or kind} got {t} in {self.src!r}')
        self.i += 1
        return t

    def statements(self):
        stmts = []
        while self.peek()[0] != 'eof':
            if self.peek() == ('id', 'return'):
                self.take()
                stmts.append(('return', self.expr()))
            elif self.peek()[0] == 'id' and self.peek(1) == ('op', '='):
                name = _alias(self.take()[1])
                if not name.startswith(('variable.', 'temp.')):
                    raise MolangError(f'cannot assign {name}')
                self.take('op', '=')
                self.writes.add(name)
                stmts.append(('set', name, self.expr()))
            else:
                stmts.append(('expr', self.expr()))
            if self.peek() == ('op', ';'):
                self.take()
            elif self.peek()[0] != 'eof':
                raise MolangError(f'expected ; got {self.peek()} in {self.src!r}')
        if len(stmts) > 1 and not self.src.strip().endswith(';'):
            raise MolangError(f'multi-statement expression must end with ; : {self.src!r}')
        return stmts

    def expr(self):
        cond = self.binary(0)
        if self.peek() == ('op', '?'):
            self.take()
            a = self.expr()
            if self.peek() == ('op', ':'):
                self.take()
                b = self.expr()
                return ('tern', cond, a, b)
            return ('tern', cond, a, ('num', 0.0))
        if self.peek() == ('op', '??'):
            self.take()
            return ('coal', cond, self.expr())
        return cond

    LEVELS = [('||',), ('&&',), ('==', '!='), ('<', '<=', '>', '>='), ('+', '-'), ('*', '/')]

    def binary(self, lvl):
        if lvl == len(self.LEVELS):
            return self.unary()
        left = self.binary(lvl + 1)
        while self.peek()[0] == 'op' and self.peek()[1] in self.LEVELS[lvl]:
            op = self.take()[1]
            left = ('bin', op, left, self.binary(lvl + 1))
        return left

    def unary(self):
        if self.peek() == ('op', '-'):
            self.take()
            return ('neg', self.unary())
        if self.peek() == ('op', '!'):
            self.take()
            return ('not', self.unary())
        return self.primary()

    def primary(self):
        t = self.take()
        if t[0] == 'num':
            return ('num', t[1])
        if t == ('op', '('):
            e = self.expr()
            self.take('op', ')')
            return e
        if t[0] == 'id':
            name = _alias(t[1])
            if self.peek() == ('op', '('):
                self.take()
                args = []
                if self.peek() != ('op', ')'):
                    args.append(self.expr())
                    while self.peek() == ('op', ','):
                        self.take()
                        args.append(self.expr())
                self.take('op', ')')
                if name.startswith('math.') and name not in MATH and name not in ('math.random', 'math.random_integer', 'math.die_roll', 'math.die_roll_integer', 'math.pi'):
                    raise MolangError(f'unknown function {name}')
                return ('call', name, args)
            if name == 'math.pi':
                return ('num', math.pi)
            if name.startswith('variable.'):
                self.reads.add(name)
            elif name.startswith('query.'):
                raise MolangError(f'query in particle expression (no actor): {name}')
            elif name not in ('true', 'false'):
                raise MolangError(f'unknown identifier {name} in {self.src!r}')
            return ('var', name)
        raise MolangError(f'unexpected {t} in {self.src!r}')

    def run(self, env, rng):
        res = 0.0
        for st in self.prog:
            if st[0] == 'set':
                env[st[1]] = ev(st[2], env, rng)
            elif st[0] == 'return':
                return ev(st[1], env, rng)
            else:
                res = ev(st[1], env, rng)
        return res


def ev(node, env, rng):
    k = node[0]
    if k == 'num':
        return node[1]
    if k == 'var':
        if node[1] == 'true':
            return 1.0
        if node[1] == 'false':
            return 0.0
        return float(env.get(node[1], 0.0))
    if k == 'neg':
        return -ev(node[1], env, rng)
    if k == 'not':
        return 0.0 if ev(node[1], env, rng) else 1.0
    if k == 'tern':
        return ev(node[2], env, rng) if ev(node[1], env, rng) else ev(node[3], env, rng)
    if k == 'coal':
        return ev(node[1], env, rng)
    if k == 'bin':
        op, a = node[1], ev(node[2], env, rng)
        if op == '&&':
            return 1.0 if (a and ev(node[3], env, rng)) else 0.0
        if op == '||':
            return 1.0 if (a or ev(node[3], env, rng)) else 0.0
        b = ev(node[3], env, rng)
        if op == '+':
            return a + b
        if op == '-':
            return a - b
        if op == '*':
            return a * b
        if op == '/':
            return a / b if b else 0.0
        return 1.0 if {'==': a == b, '!=': a != b, '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b}[op] else 0.0
    if k == 'call':
        name, args = node[1], [ev(a, env, rng) for a in node[2]]
        if name == 'math.random':
            return rng.uniform(args[0], args[1])
        if name == 'math.random_integer':
            return float(rng.randint(int(args[0]), int(args[1])))
        return float(MATH[name](*args))
    raise MolangError(f'bad node {node}')


BUILTINS = {'variable.particle_age', 'variable.particle_lifetime', 'variable.emitter_age', 'variable.emitter_lifetime'}
BUILTINS |= {f'variable.particle_random_{i}' for i in range(1, 5)} | {f'variable.emitter_random_{i}' for i in range(1, 5)}
INPUT_VARS = {'color': {'variable.color.r', 'variable.color.g', 'variable.color.b'},
              'dir': {'variable.dir.x', 'variable.dir.y', 'variable.dir.z'}}
TYPICAL = {'dir': (0.6, 0.0, 0.8), 'color': (0.2, 0.5, 1.0), 'len': 12.0, 'width': 0.08, 'size': 1.5, 'radius': 4.0}
MATERIALS = {'particles_alpha', 'particles_blend', 'particles_add'}
FACING = {'rotate_xyz', 'rotate_y', 'lookat_xyz', 'lookat_y', 'lookat_direction', 'direction_x', 'direction_y',
          'direction_z', 'emitter_transform_xy', 'emitter_transform_xz', 'emitter_transform_yz'}
# keys whose string values are not Molang
NON_MOLANG_KEYS = {'identifier', 'material', 'texture', 'facing_camera_mode', 'mode', 'type', 'format_version'}


def collect_exprs(obj, path=''):
    """Yield (path, string) for every Molang string in a particle component tree."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in NON_MOLANG_KEYS:
                continue
            if k == 'direction' and isinstance(v, str):
                continue  # outwards / inwards
            if k == 'plane_normal' and isinstance(v, str):
                continue
            yield from collect_exprs(v, f'{path}/{k}')
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from collect_exprs(v, f'{path}[{i}]')
    elif isinstance(obj, str):
        yield path, obj


class Ctx:
    def __init__(self, comps, curves):
        self.cache = {}
        self.comps = comps
        self.curves = curves

    def m(self, src):
        if src not in self.cache:
            self.cache[src] = Molang(src)
        return self.cache[src]

    def val(self, v, env, rng):
        if isinstance(v, bool):
            return 1.0 if v else 0.0
        if isinstance(v, (int, float)):
            return float(v)
        return self.m(v).run(env, rng)


def eval_curve(ctx, c, env, rng):
    x = ctx.val(c['input'], env, rng)
    rngx = ctx.val(c.get('horizontal_range', 1), env, rng) or 1.0
    nodes = c['nodes']
    if c['type'] == 'catmull_rom':
        nodes = nodes[1:-1]
    u = max(0.0, min(1.0, x / rngx)) * (len(nodes) - 1)
    i = min(int(u), len(nodes) - 2)
    f = u - i
    return nodes[i] + (nodes[i + 1] - nodes[i]) * f


def check(write_report=True):
    errors, warnings = [], []
    rows = []

    def err(m):
        errors.append(m)

    if not os.path.exists(TEX_PATH):
        err(f'atlas missing: {TEX_PATH}')
        atlas_size = (TW, TH)
    else:
        atlas_size = Image.open(TEX_PATH).size
    found = {}
    for fn in sorted(os.listdir(PDIR)):
        if not fn.endswith('.json'):
            continue
        p = os.path.join(PDIR, fn)
        try:
            d = json.load(open(p))
        except Exception as e:  # noqa: BLE001
            err(f'{fn}: invalid JSON: {e}')
            continue
        try:
            pe = d['particle_effect']
            desc = pe['description']
            pid = desc['identifier']
        except Exception:  # noqa: BLE001
            err(f'{fn}: missing particle_effect/description/identifier')
            continue
        if d.get('format_version') != '1.10.0':
            err(f'{fn}: format_version must be 1.10.0')
        if pid in found:
            err(f'{fn}: duplicate identifier {pid} (also {found[pid]})')
        found[pid] = fn
        if pid not in CONTRACT:
            warnings.append(f'{fn}: {pid} is not in the contract table')
        if fn != pid.split(':', 1)[1] + '.json':
            err(f'{fn}: file name should be {pid.split(":", 1)[1]}.json')
        brp = desc.get('basic_render_parameters', {})
        if brp.get('material') not in MATERIALS:
            err(f'{pid}: material {brp.get("material")} not one of {sorted(MATERIALS)}')
        tex = brp.get('texture', '')
        tex_file = next((os.path.join(RP, tex + e) for e in ('.png', '.tga') if os.path.exists(os.path.join(RP, tex + e))), None)
        if not tex_file:
            err(f'{pid}: texture {tex} does not exist in the RP')
            tsize = (TW, TH)
        else:
            tsize = Image.open(tex_file).size
        comps = pe.get('components', {})
        curves = pe.get('curves', {})
        ctx = Ctx(comps, curves)
        # -------- static: parse every expression, collect reads/writes
        reads, writes = set(), set(curves.keys())
        for cname, c in curves.items():
            if not cname.startswith('variable.'):
                err(f'{pid}: curve name {cname} must start with variable.')
            for k in ('input', 'horizontal_range'):
                if isinstance(c.get(k), str):
                    try:
                        m = ctx.m(c[k])
                        reads |= m.reads
                    except MolangError as e:
                        err(f'{pid}: curve {cname}.{k}: {e}')
            if c.get('type') not in ('linear', 'catmull_rom'):
                err(f'{pid}: curve {cname} type {c.get("type")} unsupported by the checker')
            if c.get('type') == 'catmull_rom' and len(c.get('nodes', [])) < 4:
                err(f'{pid}: catmull_rom curve {cname} needs >= 4 nodes')
        for path, src in collect_exprs(comps):
            try:
                m = ctx.m(src)
            except MolangError as e:
                err(f'{pid}: {path}: {e}')
                continue
            reads |= m.reads
            writes |= m.writes
        inputs = CONTRACT.get(pid, [])
        allowed = set(BUILTINS) | writes
        for inp in inputs:
            allowed |= INPUT_VARS.get(inp, {f'variable.{inp}'})
        for r in sorted(reads - allowed):
            err(f'{pid}: reads undefined variable {r}')
        for inp in inputs:
            if not (INPUT_VARS.get(inp, {f'variable.{inp}'}) & reads):
                err(f'{pid}: contract input "{inp}" is never used')
        for cname in curves:
            if cname not in reads:
                warnings.append(f'{pid}: curve {cname} unused')
        bb = comps.get('minecraft:particle_appearance_billboard')
        if not bb:
            err(f'{pid}: no billboard')
            continue
        mode = bb.get('facing_camera_mode')
        if mode not in FACING:
            err(f'{pid}: unknown facing_camera_mode {mode}')
        if mode in ('lookat_direction', 'direction_x', 'direction_y', 'direction_z') and 'direction' not in bb:
            warnings.append(f'{pid}: {mode} without explicit direction (derives from velocity)')
        uv = bb.get('uv', {})
        if (uv.get('texture_width'), uv.get('texture_height')) != tuple(tsize):
            err(f'{pid}: uv texture size {uv.get("texture_width")}x{uv.get("texture_height")} != {tsize}')
        if not any(k.startswith('minecraft:emitter_lifetime') for k in comps):
            err(f'{pid}: emitter lifetime component missing')
        if not any(k.startswith('minecraft:emitter_rate') for k in comps):
            err(f'{pid}: emitter rate component missing')
        if not any(k.startswith('minecraft:emitter_shape') for k in comps):
            err(f'{pid}: emitter shape component missing')
        if 'minecraft:particle_motion_collision' in comps and 'minecraft:particle_motion_dynamic' not in comps:
            err(f'{pid}: collision needs particle_motion_dynamic')
        # -------- dynamic sampling (inputs absent / typical)
        rng = random.Random(hash(pid) & 0xffff)
        stats = {}
        for scen in ('absent', 'typical'):
            vis, maxcount = 0.0, 0
            uv_bad = None
            for s in range(160):
                env = {}
                if scen == 'typical':
                    for inp in inputs:
                        v = TYPICAL[inp]
                        if inp == 'color':
                            env.update({'variable.color.r': v[0], 'variable.color.g': v[1], 'variable.color.b': v[2]})
                        elif inp == 'dir':
                            env.update({'variable.dir.x': v[0], 'variable.dir.y': v[1], 'variable.dir.z': v[2]})
                        else:
                            env[f'variable.{inp}'] = v
                for i in range(1, 5):
                    env[f'variable.emitter_random_{i}'] = rng.random()
                    env[f'variable.particle_random_{i}'] = rng.random()
                env['variable.emitter_age'] = 0.0
                env['variable.emitter_lifetime'] = 1.0
                try:
                    ei = comps.get('minecraft:emitter_initialization', {})
                    if 'creation_expression' in ei:
                        ctx.val(ei['creation_expression'], env, rng)
                    rate = comps.get('minecraft:emitter_rate_instant')
                    if rate:
                        cnt = ctx.val(rate['num_particles'], env, rng)
                    else:
                        st = comps['minecraft:emitter_rate_steady']
                        lt = comps.get('minecraft:emitter_lifetime_once', {}).get('active_time', 1)
                        cnt = min(ctx.val(st['max_particles'], env, rng), ctx.val(st['spawn_rate'], env, rng) * ctx.val(lt, env, rng))
                    maxcount = max(maxcount, cnt)
                    if not (1 <= cnt <= 40):
                        err(f'{pid} [{scen}]: particle count {cnt} outside 1..40')
                    for key in ('minecraft:emitter_shape_sphere', 'minecraft:emitter_shape_disc'):
                        if key in comps:
                            rad = ctx.val(comps[key]['radius'], env, rng)
                            if not (0 <= rad < 64):
                                err(f'{pid} [{scen}]: shape radius {rad}')
                    if 'minecraft:particle_initial_speed' in comps:
                        sp = ctx.val(comps['minecraft:particle_initial_speed'], env, rng)
                        if not math.isfinite(sp) or abs(sp) > 40:
                            err(f'{pid} [{scen}]: initial speed {sp}')
                    lifev = ctx.val(comps['minecraft:particle_lifetime_expression']['max_lifetime'], env, rng)
                    if not (0 < lifev <= 6):
                        err(f'{pid} [{scen}]: lifetime {lifev}')
                    env['variable.particle_lifetime'] = lifev
                    env['variable.particle_age'] = lifev * (s % 20) / 19.0
                    env['variable.emitter_age'] = env['variable.particle_age'] + rng.uniform(0, 1.4)
                    pi = comps.get('minecraft:particle_initialization', {})
                    for k in ('per_update_expression', 'per_render_expression'):
                        if k in pi:
                            ctx.val(pi[k], env, rng)
                    for cname, c in curves.items():
                        env[cname] = eval_curve(ctx, c, env, rng)
                    for key in ('minecraft:particle_motion_dynamic',):
                        if key in comps:
                            for a in comps[key].get('linear_acceleration', []):
                                if not math.isfinite(ctx.val(a, env, rng)):
                                    err(f'{pid} [{scen}]: acceleration not finite')
                    if 'minecraft:particle_motion_parametric' in comps:
                        for a in comps['minecraft:particle_motion_parametric'].get('relative_position', []):
                            vv = ctx.val(a, env, rng)
                            if not math.isfinite(vv) or abs(vv) > 16:
                                err(f'{pid} [{scen}]: parametric position {vv}')
                    sz = [ctx.val(v, env, rng) for v in bb['size']]
                    if not all(math.isfinite(v) and 0 <= v <= 40 for v in sz):
                        err(f'{pid} [{scen}]: billboard size {sz}')
                    if 'direction' in bb and bb['direction'].get('mode') == 'custom':
                        dv = [ctx.val(v, env, rng) for v in bb['direction']['custom_direction']]
                        if not all(math.isfinite(v) for v in dv) or math.sqrt(sum(v * v for v in dv)) < 1e-3:
                            err(f'{pid} [{scen}]: degenerate custom direction {dv}')
                    # UV rectangles
                    rects = []
                    if 'flipbook' in uv:
                        fbk = uv['flipbook']
                        bx, by = (ctx.val(v, env, rng) for v in fbk['base_UV'])
                        w, h = (ctx.val(v, env, rng) for v in fbk['size_UV'])
                        sx, sy = (ctx.val(v, env, rng) for v in fbk.get('step_UV', [0, 0]))
                        for f in range(int(ctx.val(fbk['max_frame'], env, rng))):
                            rects.append((bx + sx * f, by + sy * f, w, h))
                    else:
                        x, y = (ctx.val(v, env, rng) for v in uv['uv'])
                        w, h = (ctx.val(v, env, rng) for v in uv['uv_size'])
                        rects.append((x, y, w, h))
                    for (x, y, w, h) in rects:
                        if not (0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= uv['texture_width'] and y + h <= uv['texture_height']):
                            uv_bad = (x, y, w, h)
                        if any(abs(v - round(v)) > 1e-6 for v in (x, y, w, h)):
                            uv_bad = ('fractional', x, y, w, h)
                    col = [ctx.val(v, env, rng) for v in comps['minecraft:particle_appearance_tinting']['color']]
                    if not all(math.isfinite(v) and -0.01 <= v <= 2 for v in col) or col[3] > 1.01:
                        err(f'{pid} [{scen}]: tint {col}')
                    vis = max(vis, min(sz) * (col[0] + col[1] + col[2]) * col[3])
                except MolangError as e:
                    err(f'{pid} [{scen}]: {e}')
                    break
                except (KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError) as e:
                    err(f'{pid} [{scen}]: evaluation failed: {e!r}')
                    break
            if uv_bad:
                err(f'{pid} [{scen}]: UV rect outside texture {tsize}: {uv_bad}')
            if vis < 0.01:
                err(f'{pid} [{scen}]: effect is invisible (size*colour*alpha max {vis:.4f}) - bad default?')
            stats[scen] = maxcount
        if pid in PER_TICK and stats.get('typical', 0) > 8:
            err(f'{pid}: per-tick effect spawns {stats["typical"]} quads (keep <= 8)')
        rows.append((pid, brp.get('material'), mode, stats.get('typical'), ', '.join(inputs) or '-'))
    for pid in CONTRACT:
        if pid not in found:
            err(f'missing particle file for contract id {pid}')

    # -------- scripts: every spawned sp:* particle id must exist
    script_text = ''
    for dp, _, fns in os.walk(os.path.join(BP, 'scripts')):
        for f in fns:
            if f.endswith('.js'):
                script_text += open(os.path.join(dp, f), encoding='utf-8').read() + '\n'
    called = set(re.findall(r"(?:particle|particleFor|line|ring|spawnParticle)\(\s*[^'\"()]*?['\"](sp:[a-z0-9_]+)['\"]", script_text))
    called |= set(re.findall(r"spawnParticle\(\s*['\"](sp:[a-z0-9_]+)['\"]", script_text))
    missing = sorted(p for p in called if p not in found)
    for p in missing:
        err(f'script spawns undefined particle {p}')
    # literals that look like particle ids but are not passed directly (e.g. stored in constants)
    known_other = set()
    for sub in ('items', 'blocks', 'entities'):
        for dp, _, fns in os.walk(os.path.join(BP, sub)):
            for f in fns:
                if f.endswith('.json'):
                    try:
                        dd = json.load(open(os.path.join(dp, f)))
                        for v in dd.values():
                            if isinstance(v, dict) and 'description' in v:
                                known_other.add(v['description'].get('identifier'))
                    except Exception:  # noqa: BLE001
                        pass
    literal = set(re.findall(r"['\"](sp:[a-z0-9_]+)['\"]", script_text))
    unclassified = sorted(p for p in literal if p not in found and p not in known_other and p.split(':')[1] in
                          {c.split(':')[1] for c in CONTRACT} | {'meteor_crash'})
    if write_report:
        print(f'{"id":22} {"material":16} {"facing":22} {"count":>5}  inputs')
        for r in rows:
            print(f'{r[0]:22} {r[1]:16} {r[2]:22} {round(r[3] or 0, 1):>5}  {r[4]}')
        print(f'\nscript particle ids spawned: {len(called)} -> {", ".join(sorted(called))}')
        print(f'missing particle ids: {", ".join(missing) or "none"}')
        if unclassified:
            print(f'note: sp:* literals similar to particle names not defined as particles: {", ".join(unclassified)}')
        for w in warnings:
            print('WARN', w)
        for e in errors:
            print('ERROR', e)
        print(f'\ncheck_particles: {len(found)} particle files, {len(errors)} error(s), {len(warnings)} warning(s)')
    return errors


def main():
    global LOOKAT_DIRECTION_LONG_AXIS
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='validate the files on disk only')
    ap.add_argument('--preview', default=None, help='write an upscaled atlas preview into this directory')
    ap.add_argument('--long-axis', choices=('x', 'y'), default=None,
                    help='billboard axis that lookat_direction aligns with the direction (default: %s)' % LOOKAT_DIRECTION_LONG_AXIS)
    args = ap.parse_args()
    if args.long_axis:
        LOOKAT_DIRECTION_LONG_AXIS = args.long_axis
    if not args.check:
        os.makedirs(os.path.dirname(TEX_PATH), exist_ok=True)
        os.makedirs(PDIR, exist_ok=True)
        atlas = build_atlas()
        atlas.save(TEX_PATH, optimize=True)
        E = effects()
        assert set(E) == set(CONTRACT), set(E) ^ set(CONTRACT)
        for pid, d in E.items():
            with open(os.path.join(PDIR, pid.split(':', 1)[1] + '.json'), 'w') as f:
                json.dump(d, f, indent=2)
                f.write('\n')
        print(f'wrote {TEX_PATH} and {len(E)} particle files')
        if args.preview:
            os.makedirs(args.preview, exist_ok=True)
            bg = Image.new('RGBA', atlas.size, (40, 44, 52, 255))
            # checker background so additive black-keyed sprites and alpha sprites are both visible
            for yy in range(0, TH, 8):
                for xx in range(0, TW, 8):
                    if (xx // 8 + yy // 8) % 2:
                        bg.paste((52, 56, 66, 255), (xx, yy, xx + 8, yy + 8))
            bg.alpha_composite(atlas)
            bg.resize((TW * 4, TH * 4), Image.NEAREST).save(os.path.join(args.preview, 'particles_preview.png'))
    errors = check()
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
