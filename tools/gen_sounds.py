#!/usr/bin/env python3
"""Procedural sound generator for Superpowers & Mutants (resource pack sounds).

Every sound is synthesised deterministically with numpy (filtered noise, layered sines, FM,
pitch sweeps, envelopes, distortion, feedback-delay reverb) and written as mono 44.1 kHz
OGG Vorbis via soundfile. The script also writes the matching
`packs/SuperpowersRP/sounds/sound_definitions.json` and `packs/SuperpowersRP/sounds.json`.

Usage:
  python3 tools/gen_sounds.py                 # regenerate every .ogg + both JSON files
  python3 tools/gen_sounds.py --only sp.flight.boom,sp.ui.click
  python3 tools/gen_sounds.py --preview DIR   # also write .wav + spectrogram .png previews
  python3 tools/gen_sounds.py --check         # validate contract ids, files and script usage

The same seed is derived from every file name, so the audio content is reproducible; the Ogg
stream serial number is also fixed after encoding so regenerated files are byte-identical.
"""
import argparse
import json
import os
import re
import sys
import zlib

import numpy as np

try:
    import soundfile as sf
except ImportError:  # --check without soundfile still validates JSON / references
    sf = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RP = os.path.join(ROOT, 'packs', 'SuperpowersRP')
BP_SCRIPTS = os.path.join(ROOT, 'packs', 'SuperpowersBP', 'scripts')
SOUND_DIR = os.path.join(RP, 'sounds')
DEFS_PATH = os.path.join(SOUND_DIR, 'sound_definitions.json')
ENTITY_SOUNDS_PATH = os.path.join(RP, 'sounds.json')
ARCH = os.path.join(ROOT, 'docs', 'ARCHITECTURE.md')

SR = 44100
TAU = 2.0 * np.pi
PEAK = 0.89          # -1 dBFS
VORBIS_COMPRESSION = 0.55   # libsndfile: vorbis quality = 1 - level  (≈ q0.45)
SIZE_BUDGET = 6 * 1024 * 1024


# --------------------------------------------------------------------------------------------
# DSP primitives
# --------------------------------------------------------------------------------------------

def N(d):
    return max(0, int(round(d * SR)))


def T(n):
    return np.arange(n) / SR


def fit(x, n):
    if len(x) >= n:
        return x[:n]
    return np.concatenate([x, np.zeros(n - len(x))])


def norm(x, p=1.0):
    m = float(np.max(np.abs(x))) if len(x) else 0.0
    return x * (p / m) if m > 1e-12 else x


def rms(x):
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.0


def white(n, rng):
    return rng.standard_normal(n)


def _fft_len(n):
    return 1 << int(np.ceil(np.log2(n + 8192)))


def spec(x, gain):
    """Zero-phase filter: multiply the spectrum by gain(f)."""
    n = len(x)
    m = _fft_len(n)
    X = np.fft.rfft(x, m)
    f = np.fft.rfftfreq(m, 1.0 / SR)
    return np.fft.irfft(X * gain(f), m)[:n]


def g_lp(fc, order=2):
    return lambda f: 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))


def g_hp(fc, order=2):
    return lambda f: 1.0 / np.sqrt(1.0 + (fc / np.maximum(f, 1.0)) ** (2 * order))


def g_bp(fc, q):
    return lambda f: 1.0 / np.sqrt(1.0 + q * q * (f / fc - fc / np.maximum(f, 1.0)) ** 2)


def lp(x, fc, order=2):
    return spec(x, g_lp(fc, order))


def hp(x, fc, order=2):
    return spec(x, g_hp(fc, order))


def bp(x, fc, q=1.0):
    return spec(x, g_bp(fc, q))


def colored(n, rng, slope):
    """slope 0 = white, -1 = pink, -2 = brown (power spectrum ~ f^slope)."""
    x = white(n, rng)
    y = spec(x, lambda f: np.maximum(f, 20.0) ** (slope / 2.0))
    return y / (np.std(y) + 1e-12)


def conv(x, h):
    n = len(x)
    m = 1 << int(np.ceil(np.log2(n + len(h))))
    return np.fft.irfft(np.fft.rfft(x, m) * np.fft.rfft(h, m), m)[:n]


def stft_filter(x, gain_fn, win=1024, hop=256):
    """Time-varying zero-phase filter: gain_fn(f[1,bins], t[frames,1]) -> gains."""
    n = len(x)
    pad = win
    xp = np.concatenate([np.zeros(pad), x, np.zeros(pad + win)])
    frames = 1 + (len(xp) - win) // hop
    w = np.hanning(win + 1)[:-1]
    idx = np.arange(win)[None, :] + hop * np.arange(frames)[:, None]
    X = np.fft.rfft(xp[idx] * w, axis=1)
    f = np.fft.rfftfreq(win, 1.0 / SR)[None, :]
    tc = ((hop * np.arange(frames) + win / 2 - pad) / SR)[:, None]
    Y = np.fft.irfft(X * gain_fn(f, tc), n=win, axis=1) * w
    out = np.zeros(len(xp))
    ws = np.zeros(len(xp))
    w2 = w * w
    for i in range(frames):
        s = i * hop
        out[s:s + win] += Y[i]
        ws[s:s + win] += w2
    out = out / np.maximum(ws, 1e-6)
    return out[pad:pad + n]


def tv(x, shape, fc, q=1.0, order=2, win=1024, hop=256):
    """Time-varying lp/hp/bp filter; fc / q are scalars or per-sample arrays."""
    n = len(x)
    tt = T(n)
    fca = np.broadcast_to(np.asarray(fc, float), (n,))
    qa = np.broadcast_to(np.asarray(q, float), (n,))

    def g(f, tc):
        c = np.interp(tc, tt, fca)
        f = np.maximum(f, 1.0)
        if shape == 'lp':
            return 1.0 / np.sqrt(1.0 + (f / c) ** (2 * order))
        if shape == 'hp':
            return 1.0 / np.sqrt(1.0 + (c / f) ** (2 * order))
        qq = np.interp(tc, tt, qa)
        return 1.0 / np.sqrt(1.0 + qq * qq * (f / c - c / f) ** 2)

    return stft_filter(x, g, win, hop)


def curve(n, pts, log=False):
    """Piecewise linear (or log-linear) curve through (time, value) points."""
    ts = [p[0] for p in pts]
    vs = [p[1] for p in pts]
    if log:
        return np.exp(np.interp(T(n), ts, np.log(vs)))
    return np.interp(T(n), ts, vs)


def env_exp(n, attack, decay, hold=0.0, start=0.0):
    t = T(n) - start
    a = np.clip(t / attack, 0.0, 1.0) if attack > 0 else (t >= 0).astype(float)
    d = np.exp(-np.maximum(0.0, t - attack - hold) / decay)
    return a * d * (t >= 0)


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def drop(f0, f1, tau, n, start=0.0):
    """Exponential pitch drop f0 -> f1 (kick-drum style)."""
    t = np.maximum(0.0, T(n) - start)
    return f1 + (f0 - f1) * np.exp(-t / tau)


def sweep(f0, f1, n, dur=None, start=0.0):
    """Exponential glide f0 -> f1 over dur seconds (then holds)."""
    dur = dur or n / SR
    x = np.clip((T(n) - start) / dur, 0.0, 1.0)
    return f0 * (f1 / f0) ** x


def phase(freq, n):
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    return np.cumsum(f) / SR


def sine(freq, n, ph0=0.0):
    return np.sin(TAU * (phase(freq, n) + ph0))


def saw(freq, n, ph0=0.0):
    """PolyBLEP band-limited sawtooth."""
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    p = (np.cumsum(f) / SR + ph0) % 1.0
    dt = np.clip(f / SR, 1e-9, 0.45)
    y = 2.0 * p - 1.0
    m = p < dt
    tt = p[m] / dt[m]
    y[m] -= tt + tt - tt * tt - 1.0
    m = p > 1.0 - dt
    tt = (p[m] - 1.0) / dt[m]
    y[m] -= tt * tt + tt + tt + 1.0
    return y


def square(freq, n, ph0=0.0):
    return 0.5 * (saw(freq, n, ph0) - saw(freq, n, ph0 + 0.5))


def tri(freq, n, ph0=0.0):
    p = (phase(freq, n) + ph0) % 1.0
    return 4.0 * np.abs(p - 0.5) - 1.0


def midi(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def drive(x, k):
    x = norm(x)
    return np.tanh(k * x) / np.tanh(k)


def smooth_noise(n, rng, hz):
    """Slow random modulation in [-1, 1]."""
    y = lp(white(n + N(1.0), rng), hz, order=2)[N(0.5):N(0.5) + n]
    return norm(y)


def comb(x, D, g, damp=0.35):
    """Feedback comb with a one-zero lowpass in the loop (block-vectorised)."""
    n = len(x)
    nb = -(-n // D)
    xb = np.zeros(nb * D)
    xb[:n] = x
    xb = xb.reshape(nb, D)
    y = np.empty_like(xb)
    prev = np.zeros(D)
    carry = 0.0
    for k in range(nb):
        sh = np.empty(D)
        sh[0] = carry
        sh[1:] = prev[:-1]
        fb = (1.0 - damp) * prev + damp * sh
        carry = prev[-1]
        prev = xb[k] + g * fb
        y[k] = prev
    return y.reshape(-1)[:n]


def allpass(x, D, g=0.5):
    n = len(x)
    nb = -(-n // D)
    xb = np.zeros(nb * D)
    xb[:n] = x
    xb = xb.reshape(nb, D)
    y = np.empty_like(xb)
    px = np.zeros(D)
    py = np.zeros(D)
    for k in range(nb):
        yk = -g * xb[k] + px + g * py
        px = xb[k]
        py = yk
        y[k] = yk
    return y.reshape(-1)[:n]


_COMBS = (1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116)
_APS = (556, 441, 341, 225)


def reverb(x, rt=1.5, mix=0.25, damp=0.35, predelay=0.012, tail=None, bright=7000):
    """Schroeder/Freeverb-style reverb from decaying feedback delays. Appends the tail."""
    tail = rt * 0.9 if tail is None else tail
    x = fade_end(x, 0.03)
    xp = np.concatenate([x, np.zeros(N(tail))])
    wet = np.zeros(len(xp))
    for D in _COMBS:
        g = 10.0 ** (-3.0 * D / (rt * SR))
        wet += comb(xp, D, g, damp)
    for D in _APS:
        wet = allpass(wet, D, 0.5)
    wet = lp(hp(wet, 80), bright)
    wet = fit(np.concatenate([np.zeros(N(predelay)), wet]), len(xp))
    dry = fit(x, len(wet))
    e_d = np.sum(x * x)
    e_w = np.sum(wet * wet)
    if e_w > 1e-12:
        wet *= np.sqrt(e_d / e_w)
    return dry * (1.0 - mix * 0.5) + wet * mix


def grains(n, rng, rate, dur=(0.003, 0.02), amp_pow=1.5, decay_frac=0.3):
    """Cloud of short decaying noise bursts (rock crumble, debris, gravel)."""
    t = T(n)
    r = rate(t) if callable(rate) else np.full(n, float(rate))
    r = np.maximum(r, 0.0)
    rmax = float(r.max()) if n else 0.0
    out = np.zeros(n)
    if rmax <= 0:
        return out
    k = rng.poisson(rmax * n / SR)
    pos = np.sort(rng.integers(0, n, k))
    pos = pos[rng.random(k) < r[pos] / rmax]
    for p in pos:
        L = max(8, N(rng.uniform(*dur)))
        g = rng.standard_normal(L) * np.exp(-np.arange(L) / (L * decay_frac)) * (rng.random() ** amp_pow)
        e = min(n, p + L)
        out[p:e] += g[:e - p]
    return out


def crackle(n, rng, rate, amp_pow=3.0, ker_ms=1.5):
    """Sparse random impulses with tiny noisy decays (sizzle, electric arcs, fire)."""
    r = rate(T(n)) if callable(rate) else np.full(n, float(rate))
    mask = rng.random(n) < np.maximum(r, 0.0) / SR
    x = np.zeros(n)
    k = int(mask.sum())
    x[mask] = (rng.random(k) ** amp_pow) * rng.choice([-1.0, 1.0], k)
    L = max(4, N(ker_ms / 1000.0))
    ker = rng.standard_normal(L) * np.exp(-np.arange(L) / (L * 0.25))
    return conv(x, ker)


def pings(n, rng, rate, freqs, dur=(0.05, 0.2), amp_pow=1.0):
    """Random short sine pings (sparkle)."""
    r = rate(T(n)) if callable(rate) else np.full(n, float(rate))
    rmax = float(r.max())
    out = np.zeros(n)
    if rmax <= 0:
        return out
    k = rng.poisson(rmax * n / SR)
    pos = np.sort(rng.integers(0, n, k))
    pos = pos[rng.random(k) < r[pos] / rmax]
    for p in pos:
        d = rng.uniform(*dur)
        L = N(d * 3)
        f = freqs[rng.integers(0, len(freqs))] * 2 ** (rng.uniform(-8, 8) / 1200)
        tt = np.arange(L) / SR
        g = np.sin(TAU * f * tt) * np.exp(-tt / d) * np.minimum(1.0, tt / 0.002) * (rng.random() ** amp_pow)
        g += 0.25 * np.sin(TAU * f * 2.76 * tt) * np.exp(-tt / (d * 0.4)) * np.minimum(1.0, tt / 0.002)
        e = min(n, p + L)
        out[p:e] += g[:e - p]
    return out


def bubbles(n, rng, rate, f_range=(300, 1200), dur=(0.012, 0.04)):
    """Liquid bubbles: short sine chirps rising in pitch."""
    r = rate(T(n)) if callable(rate) else np.full(n, float(rate))
    rmax = float(r.max())
    out = np.zeros(n)
    if rmax <= 0:
        return out
    k = rng.poisson(rmax * n / SR)
    pos = np.sort(rng.integers(0, n, k))
    pos = pos[rng.random(k) < r[pos] / rmax]
    for p in pos:
        d = rng.uniform(*dur)
        L = N(d * 4)
        tt = np.arange(L) / SR
        f0 = np.exp(rng.uniform(np.log(f_range[0]), np.log(f_range[1])))
        f = f0 * (1.0 + 2.5 * tt / (d * 4))
        g = np.sin(TAU * np.cumsum(f) / SR) * np.exp(-tt / d) * np.minimum(1.0, tt / 0.001)
        g *= 0.3 + 0.7 * rng.random()
        e = min(n, p + L)
        out[p:e] += g[:e - p]
    return out


def nwave(dur):
    """N-shaped pressure wave (sonic boom): jump up, linear ramp down, jump back."""
    L = max(4, N(dur))
    return np.linspace(1.0, -1.0, L)


# formant tables: (centre Hz, bandwidth Hz, gain dB)
VOWELS = {
    'a': ((800, 90, 0), (1150, 110, -4), (2900, 140, -20), (3900, 160, -30)),
    'o': ((450, 70, 0), (800, 90, -9), (2830, 120, -22), (3800, 140, -32)),
    'u': ((325, 60, 0), (700, 70, -14), (2530, 150, -32)),
    'e': ((400, 70, 0), (1700, 100, -12), (2600, 130, -20), (3200, 150, -28)),
    'ae': ((660, 90, 0), (1700, 110, -8), (2400, 130, -18)),
}


def formant_gain(f, vowel, shift=1.0):
    g = np.zeros_like(f, dtype=float) + 0.004
    for fc, bw, db in VOWELS[vowel]:
        fc *= shift
        bw *= shift
        ff = np.maximum(f, 1.0)
        g = g + 10 ** (db / 20.0) / np.sqrt(1.0 + ((ff * ff - fc * fc) / (ff * bw)) ** 2)
    return g


def formant(x, v0, v1=None, morph=None, shift=1.0):
    """Formant filter, optionally morphing from vowel v0 to v1 with per-sample morph curve."""
    n = len(x)
    if v1 is None:
        return spec(x, lambda f: formant_gain(f, v0, shift))
    tt = T(n)
    m = np.broadcast_to(np.asarray(morph, float), (n,))
    sh = np.broadcast_to(np.asarray(shift, float), (n,))

    def g(f, tc):
        a = np.interp(tc, tt, m)
        s = np.interp(tc, tt, sh)
        return (1 - a) * formant_gain(f * 1.0 / s, v0) + a * formant_gain(f * 1.0 / s, v1)

    return stft_filter(x, g)


class Buf:
    def __init__(self, dur):
        self.x = np.zeros(max(1, N(dur)))

    @property
    def n(self):
        return len(self.x)

    def add(self, sig, at=0.0, gain=1.0):
        i = N(at)
        L = min(len(sig), len(self.x) - i)
        if L > 0:
            self.x[i:i + L] += gain * sig[:L]
        return self

    def out(self, fade=0.12):
        """Buffer with its end faded out (layers still sounding at the end must not click)."""
        return fade_end(self.x, fade)


def fade_end(x, dur=0.04):
    x = np.array(x, float)
    L = min(len(x) // 2, max(2, N(dur)))
    x[-L:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, L))
    return x


def chirp_tone(n, f, harmonics=((1, 1.0),), detune_cents=(0,), ph_rng=None):
    out = np.zeros(n)
    for c in detune_cents:
        ph0 = ph_rng.random() if ph_rng is not None else 0.0
        fr = f * 2 ** (c / 1200.0)
        for h, a in harmonics:
            out += a * sine(fr * h, n, ph0 * h)
    return out / max(1, len(detune_cents))


def body_thud(n, rng, f0=95, f1=38, tau=0.07, decay=0.3, noise_fc=700, noise_decay=0.08, noise_gain=0.8):
    s = sine(drop(f0, f1, tau, n), n) * env_exp(n, 0.0015, decay)
    s += noise_gain * norm(lp(colored(n, rng, -1), noise_fc)) * env_exp(n, 0.0008, noise_decay)
    return s


def crack(n, rng, decay=0.006, fc=2500, gain=1.0):
    return gain * norm(hp(white(n, rng), fc)) * env_exp(n, 0.0003, decay)


def whoosh_noise(n, rng, fc, q, env, slope=-1):
    return norm(tv(colored(n, rng, slope), 'bp', fc, q)) * env


def rumble(n, rng, fc=140, roll_hz=3.0, depth=0.5):
    r = norm(lp(colored(n, rng, -2), fc, order=3))
    return r * (1.0 - depth + depth * (0.5 + 0.5 * smooth_noise(n, rng, roll_hz)))


# --------------------------------------------------------------------------------------------
# finishing
# --------------------------------------------------------------------------------------------

def raised_fade(L, rising=True):
    w = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, L))
    return w if rising else w[::-1]


def finish(x, fin=0.002, fout=0.03, loop=False, hpf=28.0, max_dur=None):
    x = np.asarray(x, float)
    x = hp(x, hpf, order=2)
    if max_dur:
        x = x[:N(max_dur)]
    if not loop:
        # trim leading / trailing silence below -60 dB of the peak
        pk = np.max(np.abs(x))
        idx = np.nonzero(np.abs(x) > pk * 0.001)[0]
        if len(idx):
            x = x[max(0, idx[0] - N(0.002)):min(len(x), idx[-1] + N(0.02))]
    Li = max(2, N(fin))
    Lo = max(2, min(N(fout), len(x) // 2))
    x = x.copy()
    x[:Li] *= raised_fade(Li, True)
    x[-Lo:] *= raised_fade(Lo, False)
    x = norm(x, PEAK)
    return x.astype(np.float32)


# --------------------------------------------------------------------------------------------
# sound recipes  (each returns a float array; finishing is applied afterwards)
# --------------------------------------------------------------------------------------------

def J(rng, a, b):
    return float(rng.uniform(a, b))


# ---- power / syringe ------------------------------------------------------------------------

def r_power_gain(rng, v):
    d = 2.6
    b = Buf(d)
    n = b.n
    t = T(n)
    chord = (60, 64, 67, 71, 74, 79)  # Cmaj9 spread
    for i, m in enumerate(chord):
        st = 0.07 * i
        f_end, f_start = midi(m), midi(m - 5)
        g = f_start + (f_end - f_start) * smoothstep((t - st) / 0.85)
        g = g * (1.0 + 0.0035 * np.sin(TAU * 5.2 * t + i))
        tone = chirp_tone(n, g, ((1, 1.0), (2, 0.28), (3, 0.1), (4, 0.05)), (-7, 0, 7), rng)
        e = curve(n, [(0, 0), (st, 0), (st + 0.45, 0.55), (0.95, 1.0), (1.5, 0.75), (d, 0)])
        trem = 1.0 + 0.3 * np.sin(TAU * (6.0 + 0.8 * i) * t + rng.random() * TAU)
        b.add(tone * e * trem, gain=0.16 if m < 72 else 0.11)
    # airy riser
    fc = curve(n, [(0, 700), (0.95, 7000), (d, 5000)], log=True)
    b.add(whoosh_noise(n, rng, fc, 1.4, curve(n, [(0, 0), (0.85, 0.5), (1.05, 0.15), (2.2, 0)])), gain=0.2)
    # sparkles converging into the bloom
    sp_rate = lambda tt: np.interp(tt, [0, 0.3, 0.95, 1.4, d], [4, 12, 45, 18, 0])
    sp_f = [midi(m + 24) for m in chord] + [midi(m + 36) for m in chord[:3]]
    b.add(norm(pings(n, rng, sp_rate, sp_f, (0.04, 0.18))), gain=0.32)
    # bloom
    b.add(sine(drop(130, 65, 0.15, n), n) * env_exp(n, 0.01, 0.35), at=0.95, gain=0.35)
    b.add(chirp_tone(n, midi(84), ((1, 1), (2.76, 0.4), (5.4, 0.15))) * env_exp(n, 0.002, 0.5), at=0.95, gain=0.18)
    return reverb(b.out(), rt=2.2, mix=0.35, bright=9000)


def r_power_lose(rng, v):
    d = 2.0
    n = N(d)
    t = T(n)
    out = np.zeros(n)
    for m in (69, 70, 75, 76, 63):
        f = midi(m) * 2 ** (-(J(rng, 12, 17) / 12.0) * smoothstep(t / d) ** 0.8)
        f = f * (1 + 0.006 * np.sin(TAU * J(rng, 4, 7) * t))
        out += saw(f, n, rng.random()) + 0.5 * sine(f * 0.5, n)
    out = tv(out, 'lp', curve(n, [(0, 3200), (d, 260)], log=True), order=2)
    e = curve(n, [(0, 0), (0.45, 1.0), (1.1, 0.7), (d, 0)])
    out = norm(out) * e
    wash = whoosh_noise(n, rng, curve(n, [(0, 3000), (d, 250)], log=True), 1.2, e * 0.6)
    x = out + 0.35 * wash
    return reverb(drive(x, 1.4), rt=1.8, mix=0.3)


def r_power_purge(rng, v):
    d = 2.8
    b = Buf(d)
    n = b.n
    t = T(n)
    # reversed swell intro (sucked in)
    pre = N(0.55)
    sw = norm(hp(white(pre, rng), 1500)) * (np.linspace(0, 1, pre) ** 3)
    b.add(sw, gain=0.45)
    # hit
    b.add(body_thud(n, rng, 120, 40, 0.06, 0.45, 600, 0.12), at=0.55, gain=0.9)
    # dissonant cluster falling two octaves
    m_n = n - N(0.55)
    tt = T(m_n)
    cl = np.zeros(m_n)
    for m in (57, 58, 63, 64, 69, 70):
        f = midi(m) * 2 ** (-(J(rng, 20, 26) / 12.0) * smoothstep(tt / (d - 0.55)) ** 0.7)
        cl += saw(f * (1 + 0.01 * np.sin(TAU * J(rng, 3, 8) * tt)), m_n, rng.random())
    cl = tv(cl, 'lp', curve(m_n, [(0, 5000), (d - 0.55, 180)], log=True))
    e = curve(m_n, [(0, 0.2), (0.08, 1.0), (0.9, 0.6), (d - 0.55, 0)])
    b.add(drive(cl, 2.2) * e, at=0.55, gain=0.55)
    wash = whoosh_noise(m_n, rng, curve(m_n, [(0, 7000), (d - 0.55, 200)], log=True), 0.8, e)
    b.add(wash, at=0.55, gain=0.4)
    return reverb(b.out(), rt=2.0, mix=0.3)


def r_syringe_inject(rng, v):
    d = 1.25
    b = Buf(d)
    n = b.n
    # mechanical double click
    for i, at in enumerate((0.0, 0.028)):
        k = N(0.05)
        tt = T(k)
        c = norm(hp(white(k, rng), 3000)) * np.exp(-tt / 0.0012)
        c += 0.6 * np.sin(TAU * (3200 + 900 * i) * tt) * np.exp(-tt / 0.012)
        b.add(c, at=at, gain=0.7 - 0.25 * i)
    # pneumatic hiss
    hs_n = N(0.7)
    hs = norm(bp(hp(white(hs_n, rng), 2500), 5500, 0.7))
    hs_env = env_exp(hs_n, 0.004, 0.09) * 0.8 + env_exp(hs_n, 0.02, 0.28) * 0.25
    hs *= hs_env * (1 + 0.15 * smooth_noise(hs_n, rng, 40))
    b.add(hs, at=0.05, gain=0.9)
    # liquid gurgle (plunger pushing fluid)
    g_n = N(0.85)
    rate = lambda tt: np.interp(tt, [0, 0.1, 0.5, 0.85], [5, 40, 28, 0])
    gu = bubbles(g_n, rng, rate, (350, 1300), (0.01, 0.035))
    slosh = norm(lp(colored(g_n, rng, -1), 500)) * (0.5 + 0.5 * smooth_noise(g_n, rng, 8))
    gu = norm(gu) + 0.25 * slosh * curve(g_n, [(0, 0), (0.15, 1), (0.85, 0)])
    b.add(gu * curve(g_n, [(0, 0), (0.08, 1), (0.6, 0.7), (0.85, 0)]), at=0.32, gain=0.55)
    return reverb(b.out(), rt=0.5, mix=0.12)


# ---- UI ---------------------------------------------------------------------------------------

def r_ui_open(rng, v):
    d = 0.85
    b = Buf(d)
    n = b.n
    # page flips: quick paper flaps
    at = 0.0
    for i in range(5):
        k = N(0.03)
        fl = norm(bp(white(k, rng), J(rng, 2500, 4200), 1.2)) * env_exp(k, 0.001, 0.007)
        b.add(fl, at=at, gain=0.35 * (1 - 0.12 * i))
        at += 0.018 + 0.008 * i
    # whoosh
    w_n = N(0.35)
    b.add(whoosh_noise(w_n, rng, curve(w_n, [(0, 900), (0.15, 3000), (0.35, 1500)], log=True), 1.6,
                       curve(w_n, [(0, 0), (0.12, 1), (0.35, 0)])), gain=0.35)
    # chime
    for i, (m, a) in enumerate(((88, 0.35), (95, 0.28))):
        k = N(0.6)
        f = midi(m)
        ch = chirp_tone(k, f, ((1, 1.0), (2.0, 0.25), (2.76, 0.18), (5.4, 0.06))) * env_exp(k, 0.002, 0.18)
        b.add(ch, at=0.11 + 0.07 * i, gain=a)
    return reverb(b.out(), rt=0.8, mix=0.2, bright=10000)


def r_ui_click(rng, v):
    n = N(0.07)
    tt = T(n)
    f = 1700 if v == 0 else 2100
    x = np.sin(TAU * f * tt) * env_exp(n, 0.0015, 0.012)
    x += 0.5 * norm(lp(white(n, rng), 4500)) * env_exp(n, 0.0004, 0.003)
    x += 0.3 * np.sin(TAU * f * 0.5 * tt) * env_exp(n, 0.0015, 0.02)
    return x


def r_ui_select(rng, v):
    n = N(0.17)
    f = sweep(1250, 1760, n, 0.03)
    x = 0.8 * sine(f, n) + 0.25 * tri(f * 2, n) + 0.12 * sine(f * 3, n)
    return x * env_exp(n, 0.003, 0.05, hold=0.015)


def r_ui_deny(rng, v):
    d = 0.36
    b = Buf(d)
    for at, f0 in ((0.0, 116.0), (0.15, 104.0)):
        k = N(0.14)
        f = f0 * (1 - 0.04 * T(k) / 0.14)
        s = square(f, k) + 0.6 * square(f * 1.012, k) + 0.4 * saw(f * 0.5, k)
        s = lp(s, 1100)
        s *= curve(k, [(0, 0), (0.006, 1), (0.1, 0.8), (0.14, 0)])
        b.add(s, at=at, gain=1.0)
    return b.out()


# ---- generic impacts / debris / whoosh --------------------------------------------------------

def r_impact_heavy(rng, v):
    d = 1.9
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, J(rng, 82, 100), J(rng, 33, 40), 0.07, 0.34, J(rng, 600, 850), 0.09), gain=1.0)
    b.add(crack(n, rng, 0.007, 2200), gain=0.45)
    cr = grains(n, rng, lambda tt: 300 * np.exp(-tt / 0.32) * (tt > 0.02), (0.003, 0.022))
    cr = norm(bp(cr, J(rng, 1200, 1900), 0.6) + 0.6 * lp(cr, 500))
    b.add(cr * curve(n, [(0, 0), (0.025, 1), (1.0, 0.2), (d, 0)]), gain=0.4)
    # pebbles bouncing afterwards
    pb = grains(n, rng, lambda tt: np.interp(tt, [0, 0.25, 0.8, d], [0, 30, 6, 0]), (0.002, 0.008), 2.0)
    b.add(norm(hp(pb, 1800)), gain=0.12)
    return reverb(drive(b.out(), 1.9), rt=1.4, mix=0.18)


def r_impact_light(rng, v):
    d = 0.6
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, J(rng, 150, 190), J(rng, 80, 100), 0.03, 0.08, 1800, 0.05, 0.9), gain=1.0)
    b.add(crack(n, rng, 0.004, 3000), gain=0.35)
    cr = grains(n, rng, lambda tt: 160 * np.exp(-tt / 0.12) * (tt > 0.01), (0.002, 0.012))
    b.add(norm(bp(cr, J(rng, 2000, 3200), 0.7)), gain=0.3)
    return reverb(drive(b.out(), 1.4), rt=0.7, mix=0.12)


def r_debris_rip(rng, v):
    d = 1.25
    b = Buf(d)
    n = b.n
    t = T(n)
    snap_t = J(rng, 0.55, 0.7)
    # grinding: rough modulated noise sweeping up (tear)
    grind = colored(n, rng, -1)
    rough = np.abs(smooth_noise(n, rng, J(rng, 35, 55))) ** 1.5
    grind = tv(grind, 'bp', curve(n, [(0, 320), (snap_t, 950), (d, 500)], log=True), 1.3) * (0.35 + rough)
    e = curve(n, [(0, 0), (0.12, 0.8), (snap_t, 1.0), (snap_t + 0.05, 0.5), (d, 0)])
    b.add(norm(grind) * e, gain=0.7)
    cr = grains(n, rng, lambda tt: np.interp(tt, [0, 0.1, snap_t, snap_t + 0.3, d], [40, 260, 380, 120, 0]), (0.002, 0.015))
    b.add(norm(bp(cr, 1900, 0.6)), gain=0.35)
    low = norm(lp(colored(n, rng, -2), 110)) * e
    b.add(low, gain=0.5)
    # snap
    b.add(body_thud(n, rng, 140, 60, 0.04, 0.12, 2400, 0.03), at=snap_t, gain=0.7)
    b.add(crack(n, rng, 0.005, 2000), at=snap_t, gain=0.5)
    return reverb(drive(b.out(), 1.6), rt=0.9, mix=0.12)


def r_debris_place(rng, v):
    d = 0.35
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, J(rng, 120, 145), J(rng, 65, 80), 0.03, 0.07, 1500, 0.04, 0.9), gain=1.0)
    gr = grains(n, rng, lambda tt: 200 * np.exp(-tt / 0.05), (0.002, 0.008))
    b.add(norm(bp(gr, 2600, 0.8)), gain=0.25)
    return b.out()


def r_whoosh(rng, v):
    d = J(rng, 0.5, 0.6)
    n = N(d)
    pk = J(rng, 0.2, 0.26)
    fc = curve(n, [(0, 380), (pk, J(rng, 1500, 2100)), (d, 520)], log=True)
    e = curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 1.5
    return whoosh_noise(n, rng, fc, 1.6, e)


# ---- strength ---------------------------------------------------------------------------------

def r_strength_punch(rng, v):
    d = 0.45
    b = Buf(d)
    n = b.n
    thump = sine(drop(J(rng, 115, 135), J(rng, 48, 56), 0.035, n), n) * env_exp(n, 0.001, 0.11)
    b.add(thump, gain=1.0)
    body = norm(lp(colored(n, rng, -1), J(rng, 800, 1100))) * env_exp(n, 0.0007, 0.045)
    b.add(body, gain=0.7)
    slap = norm(bp(white(n, rng), J(rng, 1100, 1500), 1.2)) * env_exp(n, 0.0005, 0.025)
    b.add(slap, gain=0.45)
    b.add(crack(n, rng, 0.004, 2800), gain=0.55)
    return reverb(drive(b.out(), 2.4), rt=0.45, mix=0.1)


def r_strength_charge(rng, v):
    d = 1.3
    n = N(d)
    t = T(n)
    f = curve(n, [(0, 34), (d, 68)], log=True)
    sub = sine(f, n) + 0.5 * saw(f, n) * 0.3 + 0.35 * sine(f * 2.01, n)
    noise = tv(colored(n, rng, -2), 'lp', curve(n, [(0, 120), (d, 650)], log=True), order=2)
    trem_rate = curve(n, [(0, 6), (d, 17)])
    trem = 0.65 + 0.35 * np.sin(TAU * np.cumsum(trem_rate) / SR)
    gr = grains(n, rng, lambda tt: 20 + 80 * tt / d, (0.002, 0.01))
    x = norm(sub) * 0.8 + norm(noise) * 0.7 * trem + 0.15 * norm(bp(gr, 1200, 0.7))
    x = drive(x, 2.2)
    e = curve(n, [(0, 0), (0.25, 0.85), (d - 0.3, 1.0), (d, 0)])
    return x * e


def r_strength_leap(rng, v):
    d = 1.1
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, 90, 42, 0.05, 0.22, 800, 0.08), gain=1.0)
    w = whoosh_noise(n, rng, curve(n, [(0, 250), (0.25, 1500), (d, 700)], log=True), 1.1,
                     curve(n, [(0, 0), (0.08, 1), (0.35, 0.7), (d, 0)]))
    b.add(w, gain=0.8)
    cr = grains(n, rng, lambda tt: 220 * np.exp(-tt / 0.15), (0.002, 0.015))
    b.add(norm(bp(cr, 1600, 0.6)), gain=0.25)
    return reverb(drive(b.out(), 1.6), rt=1.0, mix=0.15)


def r_strength_land(rng, v):
    d = 3.0
    b = Buf(d)
    n = b.n
    sub = sine(drop(J(rng, 70, 80), J(rng, 26, 30), 0.18, n), n) * env_exp(n, 0.002, 0.6)
    b.add(drive(sub, 2.5), gain=1.0)
    body = norm(tv(colored(n, rng, -2), 'lp', curve(n, [(0, 900), (0.6, 150), (d, 90)], log=True)))
    b.add(body * env_exp(n, 0.001, 0.45), gain=0.85)
    b.add(crack(n, rng, 0.012, 1800), gain=0.5)
    cr = grains(n, rng, lambda tt: 380 * np.exp(-tt / 0.5) * (tt > 0.02), (0.003, 0.03))
    cr = norm(bp(cr, 1100, 0.5) + 0.8 * lp(cr, 400))
    b.add(cr * curve(n, [(0, 0), (0.03, 1), (1.6, 0.25), (d, 0)]), gain=0.4)
    b.add(rumble(n, rng, 120, 3.0) * env_exp(n, 0.05, 0.9), gain=0.5)
    return reverb(drive(b.out(), 1.8), rt=2.4, mix=0.25)


def r_strength_throw(rng, v):
    d = 0.8
    b = Buf(d)
    n = b.n
    pk = J(rng, 0.18, 0.24)
    w = whoosh_noise(n, rng, curve(n, [(0, 220), (pk, J(rng, 850, 1100)), (d, 300)], log=True), 1.2,
                     curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 1.3, slope=-1.5)
    b.add(w, gain=1.0)
    b.add(sine(curve(n, [(0, 55), (pk, 95), (d, 45)], log=True), n) * curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 2, gain=0.35)
    b.add(body_thud(n, rng, 110, 55, 0.03, 0.08, 700, 0.04, 0.6), gain=0.4)
    return reverb(b.out(), rt=0.8, mix=0.12)


def r_strength_dash(rng, v):
    d = 1.2
    n = N(d)
    t = T(n)
    turb = 0.7 + 0.3 * smooth_noise(n, rng, 28)
    roar = tv(colored(n, rng, -1), 'lp', curve(n, [(0, 900), (0.15, 3500), (d, 1200)], log=True)) * turb
    reso = tv(white(n, rng), 'bp', curve(n, [(0, 400), (0.2, 1400), (d, 600)], log=True), 3.0)
    f = curve(n, [(0, 40), (0.15, 55), (d, 38)], log=True)
    sub = drive(saw(f, n) + sine(f, n), 2.0)
    x = norm(roar) + 0.4 * norm(reso) + 0.45 * sub
    e = curve(n, [(0, 0), (0.04, 1), (0.45, 0.85), (d, 0)])
    return reverb(drive(x * e, 1.5), rt=1.0, mix=0.12)


def r_strength_clap(rng, v):
    d = 3.6
    b = Buf(d)
    n = b.n
    # razor-sharp transient: broadband crack + hand slap resonances + N-wave
    b.add(norm(hp(white(n, rng), 1200)) * env_exp(n, 0.0001, 0.0035), gain=1.0)
    for fc, dec, g in ((1250, 0.03, 0.5), (2600, 0.02, 0.35), (520, 0.05, 0.4)):
        b.add(norm(bp(white(n, rng), fc, 3.0)) * env_exp(n, 0.0002, dec), gain=g)
    b.add(nwave(0.004), gain=0.9)
    b.add(sine(drop(160, 40, 0.05, n), n) * env_exp(n, 0.0005, 0.25), gain=0.6)
    # thunder: crackle cluster then long rolling rumble
    cr = crackle(n, rng, lambda tt: np.interp(tt, [0, 0.03, 0.35, 0.8], [0, 900, 120, 0]), 2.0, 3.0)
    b.add(norm(bp(cr, 1800, 0.5)) * curve(n, [(0, 0), (0.03, 1), (0.8, 0)]), gain=0.5)
    rr = rumble(n, rng, 160, 2.5, 0.6)
    b.add(rr * curve(n, [(0, 0), (0.08, 0.9), (0.5, 1.0), (d, 0)]) ** 1.2, gain=0.8)
    b.add(norm(lp(colored(n, rng, -1), 900)) * curve(n, [(0, 0), (0.05, 1), (1.2, 0.2), (d, 0)]), gain=0.25)
    x = np.tanh(3.2 * norm(b.out())) / np.tanh(3.2)   # limit the transient so the tail stays loud
    return reverb(x, rt=2.8, mix=0.3, bright=6000)


# ---- flight -----------------------------------------------------------------------------------

def r_flight_takeoff(rng, v):
    d = 1.2
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, 85, 45, 0.04, 0.15, 700, 0.06), gain=0.6)
    fc = curve(n, [(0, 250), (0.7, 2600), (d, 3200)], log=True)
    e = curve(n, [(0, 0), (0.12, 1), (0.5, 0.8), (d, 0)])
    b.add(whoosh_noise(n, rng, fc, 1.8, e), gain=1.0)
    whistle = sine(curve(n, [(0, 320), (d, 1100)], log=True), n) * e * 0.12
    b.add(whistle, gain=1.0)
    return reverb(b.out(), rt=1.0, mix=0.15)


def r_flight_land(rng, v):
    d = 0.7
    b = Buf(d)
    n = b.n
    pre = N(0.12)
    b.add(whoosh_noise(pre, rng, curve(pre, [(0, 1500), (0.12, 600)], log=True), 1.2,
                       curve(pre, [(0, 0), (0.12, 1)])), gain=0.4)
    b.add(body_thud(n, rng, 100, 45, 0.04, 0.16, 900, 0.06), at=0.1, gain=1.0)
    gr = grains(n, rng, lambda tt: 150 * np.exp(-tt / 0.15), (0.002, 0.012))
    b.add(norm(bp(gr, 2000, 0.6)), at=0.1, gain=0.25)
    return reverb(drive(b.out(), 1.4), rt=0.8, mix=0.12)


def r_flight_wind(rng, v):
    d = 1.6
    n = N(d)
    src = colored(n, rng, -1)
    centre = 750 * 2 ** (0.8 * smooth_noise(n, rng, 1.2))
    body = tv(src, 'bp', centre, 1.1)
    hiss = hp(white(n, rng), 3500) * 0.12
    howl = tv(white(n, rng), 'bp', centre * J(rng, 1.8, 2.4), 6.0) * 0.6
    gust = 0.65 + 0.35 * smooth_noise(n, rng, J(rng, 0.8, 1.6))
    x = (norm(body) + 0.5 * norm(howl) + norm(hiss) * 0.3) * gust
    L = N(0.32)
    x[:L] *= raised_fade(L, True)
    x[-L:] *= raised_fade(L, False)
    return x


def r_flight_boom(rng, v):
    d = 2.6
    b = Buf(d)
    n = b.n
    gap = J(rng, 0.09, 0.14)
    nw = lp(fit(nwave(J(rng, 0.008, 0.012)), N(0.05)), 9000)
    b.add(nw, at=0.005, gain=1.0)
    b.add(nw, at=0.005 + gap, gain=0.85)
    b.add(sine(drop(70, 35, 0.06, n), n) * env_exp(n, 0.001, 0.25), gain=0.55)
    b.add(sine(drop(70, 35, 0.06, n), n) * env_exp(n, 0.001, 0.25), at=gap, gain=0.45)
    b.add(norm(hp(white(n, rng), 1500)) * env_exp(n, 0.0002, 0.012), gain=0.35)
    b.add(rumble(n, rng, 140, 2.0, 0.5) * curve(n, [(0, 0), (0.06, 1), (0.6, 0.6), (d, 0)]), gain=0.7)
    x = np.tanh(1.8 * norm(b.out())) / np.tanh(1.8)
    return reverb(x, rt=2.6, mix=0.3, bright=6000)


def r_flight_grab(rng, v):
    d = 0.4
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, 120, 70, 0.03, 0.08, 1100, 0.05, 0.8), gain=1.0)
    k = N(0.15)
    b.add(whoosh_noise(k, rng, curve(k, [(0, 2500), (0.15, 900)], log=True), 1.2, curve(k, [(0, 0), (0.03, 1), (0.15, 0)])), gain=0.4)
    cloth = norm(bp(white(n, rng), 1800, 0.8)) * env_exp(n, 0.002, 0.04)
    b.add(cloth, at=0.01, gain=0.35)
    return b.out()


def r_flight_throw(rng, v):
    d = 0.7
    n = N(d)
    pk = 0.16
    w = whoosh_noise(n, rng, curve(n, [(0, 350), (pk, 2000), (d, 600)], log=True), 1.5,
                     curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 1.4)
    tone = sine(curve(n, [(0, 200), (pk, 420), (d, 260)], log=True), n) * curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 2
    return reverb(w + 0.15 * tone, rt=0.9, mix=0.15)


# ---- heat vision ------------------------------------------------------------------------------

def _hum(n, rng, f=98.0):
    s = saw(f, n, rng.random()) + 0.7 * saw(f * 1.006, n, rng.random()) + 0.4 * square(f * 2.002, n)
    s = bp(s, 720, 1.2) + 0.6 * bp(s, 1850, 2.0) + 0.5 * lp(s, 260)
    return norm(s) * (1.0 + 0.18 * np.sin(TAU * 50.0 * T(n)))


def _sizzle(n, rng, rate=2200):
    c = crackle(n, rng, rate, 2.5, 1.0)
    c = hp(c, 2600) + 0.4 * bp(c, 5200, 1.2)
    return norm(c)


def r_heat_start(rng, v):
    d = 0.7
    b = Buf(d)
    n = b.n
    # ignition zap: FM chirp up
    k = N(0.22)
    tt = T(k)
    fc = sweep(220, 2600, k, 0.18)
    mod = np.sin(TAU * phase(fc * 1.5, k)) * 3.0
    zap = np.sin(TAU * phase(fc, k) + mod) * env_exp(k, 0.002, 0.08)
    b.add(zap, gain=0.45)
    b.add(_sizzle(n, rng, 4000) * env_exp(n, 0.001, 0.12), gain=0.35)
    # fwoom
    fw = whoosh_noise(n, rng, curve(n, [(0, 300), (0.25, 3500), (d, 1500)], log=True), 0.9,
                      curve(n, [(0, 0), (0.06, 1), (0.25, 0.6), (d, 0)]))
    b.add(fw, gain=0.6)
    # hum fading in (bridges into the loop)
    hm = _hum(n, rng) * curve(n, [(0, 0), (0.15, 0.2), (0.4, 0.6), (d, 0)])
    b.add(hm, gain=0.5)
    return reverb(b.out(), rt=0.6, mix=0.1)


def r_heat_loop(rng, v):
    d = 0.72
    n = N(d)
    hm = _hum(n, rng, 98.0 if v == 0 else 101.0)
    sz = _sizzle(n, rng, 2400) * (0.7 + 0.3 * smooth_noise(n, rng, 12))
    roar = norm(bp(colored(n, rng, -1), 1300, 0.8)) * 0.25
    x = hm * 0.75 + sz * 0.45 + roar
    L = N(0.12)
    x[:L] *= raised_fade(L, True)
    x[-L:] *= raised_fade(L, False)
    return x


def r_heat_stop(rng, v):
    d = 1.1
    b = Buf(d)
    n = b.n
    hs = tv(white(n, rng), 'hp', curve(n, [(0, 6500), (d, 1800)], log=True)) * env_exp(n, 0.005, 0.3)
    b.add(norm(hs), gain=0.6)
    k = N(0.35)
    f = sweep(98, 35, k)
    pd = (saw(f, k) + 0.5 * saw(f * 1.006, k)) * curve(k, [(0, 1), (0.35, 0)]) ** 2
    b.add(lp(pd, 900), gain=0.5)
    # cooling ticks
    for _ in range(4):
        at = J(rng, 0.25, 0.95)
        kk = N(0.06)
        tt = T(kk)
        tk = np.sin(TAU * J(rng, 2800, 5200) * tt) * np.exp(-tt / 0.008) + 0.4 * norm(hp(white(kk, rng), 4000)) * np.exp(-tt / 0.001)
        b.add(tk, at=at, gain=J(rng, 0.08, 0.18))
    return reverb(b.out(), rt=0.6, mix=0.1)


def r_heat_sizzle(rng, v):
    d = 0.65
    n = N(d)
    e = curve(n, [(0, 0), (0.012, 1), (0.25, 0.5), (d, 0)])
    sz = _sizzle(n, rng, J(rng, 2500, 4500)) * e
    steam = norm(bp(white(n, rng), J(rng, 3500, 6000), 0.6)) * e * 0.35
    pop = norm(lp(white(N(0.03), rng), 1500)) * env_exp(N(0.03), 0.0005, 0.006)
    x = sz + steam
    x[:len(pop)] += 0.5 * pop
    return x


def r_heat_burst(rng, v):
    d = 1.6
    b = Buf(d)
    n = b.n
    blast = tv(colored(n, rng, -1), 'lp', curve(n, [(0, 9000), (0.3, 1500), (d, 500)], log=True))
    b.add(norm(blast) * env_exp(n, 0.002, 0.22), gain=0.9)
    b.add(sine(drop(85, 40, 0.06, n), n) * env_exp(n, 0.002, 0.25), gain=0.7)
    turb = 0.6 + 0.4 * smooth_noise(n, rng, 18)
    fire = norm(lp(colored(n, rng, -2), 600)) * turb * curve(n, [(0, 0), (0.05, 1), (d, 0)]) ** 1.5
    b.add(fire, gain=0.6)
    b.add(_sizzle(n, rng, 3000) * curve(n, [(0, 0), (0.05, 1), (d, 0)]) ** 2, gain=0.35)
    b.add(crack(n, rng, 0.005, 3000), gain=0.4)
    return reverb(drive(b.out(), 1.7), rt=1.4, mix=0.18)


def r_heat_overheat(rng, v):
    d = 1.8
    b = Buf(d)
    n = b.n
    burst = norm(bp(white(n, rng), 2600, 0.8)) * env_exp(n, 0.003, 0.08)
    b.add(burst, gain=0.7)
    sput = 0.75 + 0.25 * np.sign(smooth_noise(n, rng, 14)) * curve(n, [(0, 0), (1.0, 0), (d, 1)])
    hiss = tv(white(n, rng), 'bp', curve(n, [(0, 5500), (d, 2500)], log=True), 0.9)
    b.add(norm(hiss) * curve(n, [(0, 0), (0.02, 1), (0.6, 0.7), (d, 0)]) * sput, gain=0.8)
    wh = sine(curve(n, [(0, 2300), (d, 1700)], log=True) * (1 + 0.004 * np.sin(TAU * 7 * T(n))), n)
    b.add(wh * curve(n, [(0, 0), (0.1, 1), (1.2, 0.5), (d, 0)]), gain=0.09)
    b.add(_sizzle(n, rng, 1500) * curve(n, [(0, 1), (d, 0)]), gain=0.2)
    return reverb(b.out(), rt=0.9, mix=0.12)


def r_heat_focus(rng, v):
    n = N(0.2)
    f = sweep(600, 1250, n, 0.07)
    x = sine(f, n) + 0.3 * sine(2 * f, n) + 0.15 * tri(f * 0.5, n)
    return x * env_exp(n, 0.004, 0.05, hold=0.03)


# ---- speedster --------------------------------------------------------------------------------

def _arc(n, rng, density=1.0):
    """Electric arc: noise chopped by a jittery discharge pulse train + tonal buzz + crackle."""
    pf = J(rng, 140, 360) * (1 + 0.3 * smooth_noise(n, rng, 40))
    pulse = lp((saw(pf, n) > 0.15).astype(float), 6000)
    buzz = norm(hp(white(n, rng), 1600) * pulse)
    tone = norm(bp(square(pf, n), 1400, 0.8))
    c = norm(hp(crackle(n, rng, 7000 * density, 1.5, 0.6), 2000))
    gate = lp((smooth_noise(n, rng, 45) > -0.35).astype(float), 300)
    return drive((0.6 * buzz + 0.35 * tone + 0.7 * c) * gate, 2.0)


def r_speed_start(rng, v):
    d = 0.95
    b = Buf(d)
    n = b.n
    f = sweep(180, 2600, n, 0.8)
    whine = np.sin(TAU * phase(f, n) + 1.2 * np.sin(TAU * phase(f * 0.5, n)))
    b.add(whine * curve(n, [(0, 0), (0.1, 0.4), (0.8, 1.0), (0.85, 0.3), (d, 0)]), gain=0.35)
    b.add(_arc(n, rng, 1.0) * curve(n, [(0, 0.1), (0.8, 1.0), (d, 0)]), gain=0.4)
    b.add(crack(n, rng, 0.006, 2000), at=0.8, gain=0.7)
    b.add(body_thud(n, rng, 160, 70, 0.03, 0.08, 2000, 0.03, 0.6), at=0.8, gain=0.5)
    return reverb(b.out(), rt=0.7, mix=0.12)


def r_speed_stop(rng, v):
    d = 0.9
    b = Buf(d)
    n = b.n
    f = sweep(1800, 70, n, 0.75)
    pd = saw(f, n) + 0.5 * saw(f * 1.01, n)
    pd = tv(pd, 'lp', curve(n, [(0, 5000), (d, 400)], log=True))
    b.add(norm(pd) * curve(n, [(0, 0), (0.02, 1), (0.75, 0.3), (d, 0)]), gain=0.5)
    b.add(_arc(n, rng, 0.5) * curve(n, [(0, 1), (0.4, 0.2), (d, 0)]), gain=0.3)
    b.add(crack(n, rng, 0.003, 3000), at=0.78, gain=0.25)
    return reverb(b.out(), rt=0.7, mix=0.12)


def r_speed_zap(rng, v):
    d = 0.38
    b = Buf(d)
    n = b.n
    at = 0.0
    for i in range(int(rng.integers(3, 6))):
        k = N(J(rng, 0.04, 0.1))
        z = _arc(k, rng, 1.6) * env_exp(k, 0.001, k / SR * 0.35)
        b.add(z, at=at, gain=J(rng, 0.6, 1.0) * (1 - 0.12 * i))
        at += J(rng, 0.03, 0.07)
    b.add(crack(n, rng, 0.003, 2500), gain=0.6)
    return reverb(b.out(), rt=0.4, mix=0.1)


def r_speed_boom(rng, v):
    d = 2.0
    b = Buf(d)
    n = b.n
    nw = lp(fit(nwave(0.009), N(0.05)), 10000)
    b.add(nw, at=0.003, gain=1.0)
    b.add(sine(drop(80, 38, 0.05, n), n) * env_exp(n, 0.001, 0.2), gain=0.5)
    b.add(_arc(n, rng, 1.2) * env_exp(n, 0.002, 0.25), gain=0.35)
    b.add(rumble(n, rng, 160, 2.5) * curve(n, [(0, 0), (0.05, 1), (d, 0)]) ** 1.3, gain=0.65)
    x = np.tanh(1.8 * norm(b.out())) / np.tanh(1.8)
    return reverb(x, rt=2.0, mix=0.25)


def r_speed_gear(rng, v):
    d = 0.55
    b = Buf(d)
    n = b.n
    k = N(0.04)
    clunk = body_thud(k, rng, 300, 160, 0.01, 0.015, 3000, 0.008, 0.8)
    b.add(clunk, gain=0.7)
    f = curve(n, [(0, 280), (0.4, 950), (d, 1000)], log=True)
    teeth = curve(n, [(0, 60), (0.4, 190), (d, 200)], log=True)
    whir = (saw(f, n) * 0.6 + sine(f * 2, n) * 0.3) * (0.55 + 0.45 * np.sin(TAU * phase(teeth, n)))
    whir = lp(whir, 4000)
    b.add(whir * curve(n, [(0, 0), (0.04, 0.7), (0.35, 1.0), (d, 0)]), at=0.02, gain=0.5)
    b.add(_arc(n, rng, 0.6) * curve(n, [(0, 0), (0.3, 0.5), (d, 0)]), gain=0.15)
    return b.out()


def r_speed_dodge(rng, v):
    d = 0.32
    n = N(d)
    pk = J(rng, 0.08, 0.11)
    fc = curve(n, [(0, 2400), (pk, 4200), (d, 600)], log=True)
    e = curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 1.6
    w = whoosh_noise(n, rng, fc, 2.0, e)
    c = crack(n, rng, 0.003, 3500)
    x = w + 0.0
    x[N(pk):] += 0.35 * c[:n - N(pk)]
    return x


def r_speed_slow_in(rng, v):
    d = 2.0
    n = N(d)
    f = sweep(220, 38, n, 1.4)
    tone = np.zeros(n)
    for c, a in ((-9, 0.8), (0, 1.0), (7, 0.7), (1200, 0.25), (702, 0.35)):
        ff = f * 2 ** (c / 1200.0)
        tone += a * (sine(ff, n) + 0.3 * saw(ff, n, rng.random()))
    tone = tv(tone, 'lp', curve(n, [(0, 2400), (d, 200)], log=True))
    e = curve(n, [(0, 0), (0.08, 1.0), (1.2, 0.6), (d, 0)])
    sw = whoosh_noise(n, rng, curve(n, [(0, 2500), (d, 150)], log=True), 1.0, curve(n, [(0, 0), (0.05, 1), (1.0, 0)]))
    thud = sine(drop(90, 35, 0.15, n), n) * env_exp(n, 0.005, 0.5)
    x = norm(tone) * e + 0.4 * sw + 0.5 * thud
    return reverb(x, rt=2.6, mix=0.4, bright=4000)


def r_speed_slow_out(rng, v):
    d = 1.15
    n = N(d)
    f = sweep(40, 230, n, 1.1)
    tone = np.zeros(n)
    for c, a in ((-9, 0.8), (0, 1.0), (7, 0.7), (1200, 0.25)):
        ff = f * 2 ** (c / 1200.0)
        tone += a * (sine(ff, n) + 0.3 * saw(ff, n, rng.random()))
    tone = tv(tone, 'lp', curve(n, [(0, 250), (d, 3000)], log=True))
    sw = whoosh_noise(n, rng, curve(n, [(0, 150), (d, 3500)], log=True), 1.0, curve(n, [(0, 0), (d, 1)]) ** 2)
    x = norm(tone) * curve(n, [(0, 0.05), (d, 1)]) ** 1.6 + 0.5 * sw
    x = reverb(x[::-1], rt=1.1, mix=0.35, tail=0.45)[::-1]   # reverse reverb → swell
    k = N(0.25)
    end = np.zeros(len(x))
    pop = sine(drop(200, 90, 0.03, k), k) * env_exp(k, 0.001, 0.05)
    end[-k:] += pop * 0.6
    return x + end * np.max(np.abs(x))


def r_speed_blitz(rng, v):
    d = 2.2
    b = Buf(d)
    n = b.n
    b.add(norm(hp(white(n, rng), 1000)) * env_exp(n, 0.0001, 0.006), gain=1.0)
    b.add(nwave(0.006), gain=0.8)
    cr = crackle(n, rng, lambda tt: np.interp(tt, [0, 0.01, 0.12, 0.35], [0, 6000, 1500, 0]), 2.0, 1.5)
    b.add(norm(hp(cr, 1500)), gain=0.5)
    b.add(_arc(n, rng, 1.5) * env_exp(n, 0.001, 0.12), gain=0.35)
    b.add(sine(drop(120, 35, 0.06, n), n) * env_exp(n, 0.001, 0.35), gain=0.7)
    b.add(rumble(n, rng, 180, 3.5, 0.6) * curve(n, [(0, 0), (0.05, 1), (d, 0)]) ** 1.2, gain=0.8)
    x = np.tanh(2.2 * norm(b.out())) / np.tanh(2.2)
    return reverb(x, rt=2.2, mix=0.28)


# ---- esper --------------------------------------------------------------------------------------

def _ethereal(n, rng, base=220.0, wob=4.0, partials=(1.0, 1.5, 2.0, 3.0)):
    t = T(n)
    out = np.zeros(n)
    for i, p in enumerate(partials):
        for c in (-6, 6):
            f = base * p * 2 ** (c / 1200.0) * (1 + 0.006 * np.sin(TAU * 5.0 * t + i))
            out += sine(f, n, rng.random()) / (1 + i * 0.8)
    trem = 0.7 + 0.3 * np.sin(TAU * wob * t + rng.random() * TAU)
    return norm(out) * trem


def r_esper_grab(rng, v):
    d = 0.9
    n = N(d)
    bend = curve(n, [(0, 0.94), (0.35, 1.0), (d, 1.02)])
    t = T(n)
    tone = np.zeros(n)
    for m, a in ((57, 1.0), (64, 0.7), (69, 0.6), (76, 0.3)):
        for c in (-8, 0, 8):
            f = midi(m) * bend * 2 ** (c / 1200.0) * (1 + 0.008 * np.sin(TAU * 6.0 * t))
            tone += a * sine(f, n, rng.random())
    e = curve(n, [(0, 0), (0.33, 1.0), (d, 0)]) ** 1.3
    breath = whoosh_noise(n, rng, curve(n, [(0, 600), (0.33, 2200), (d, 1200)], log=True), 2.0, e)
    x = norm(tone) * e + 0.3 * breath
    return reverb(x, rt=1.4, mix=0.3, bright=8000)


def r_esper_hold(rng, v):
    d = 1.3
    n = N(d)
    x = _ethereal(n, rng, 220.0 if v == 0 else 207.65, J(rng, 3.2, 4.5))
    air = norm(bp(colored(n, rng, -1), 1800, 1.5)) * 0.12
    x = x + air
    L = N(0.25)
    x[:L] *= raised_fade(L, True)
    x[-L:] *= raised_fade(L, False)
    return x


def r_esper_launch(rng, v):
    d = 0.8
    n = N(d)
    pk = 0.18
    w = whoosh_noise(n, rng, curve(n, [(0, 300), (pk, 1800), (d, 3200)], log=True), 1.4,
                     curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 1.2)
    f = curve(n, [(0, 300), (d, 1500)], log=True)
    tone = (sine(f, n) + 0.5 * sine(f * 1.5, n) + 0.3 * sine(f * 2.01, n)) * curve(n, [(0, 0), (pk, 1), (d, 0)]) ** 1.5
    return reverb(w + 0.35 * norm(tone), rt=1.1, mix=0.25)


def r_esper_drop(rng, v):
    d = 0.6
    b = Buf(d)
    n = b.n
    b.add(body_thud(n, rng, 110, 60, 0.04, 0.12, 700, 0.05, 0.6), gain=1.0)
    f = curve(n, [(0, 620), (d, 300)], log=True)
    b.add((sine(f, n) + 0.4 * sine(f * 1.5, n)) * env_exp(n, 0.01, 0.15), gain=0.2)
    return reverb(b.out(), rt=0.9, mix=0.2)


def r_esper_levitate(rng, v):
    d = 2.2
    n = N(d)
    t = T(n)
    rise = 2 ** ((7.0 / 12.0) * smoothstep(t / 1.8))
    src = np.zeros(n)
    for m in (57, 61, 64, 69):
        for c in (-10, 0, 10):
            f = midi(m) * rise * 2 ** (c / 1200.0) * (1 + 0.007 * np.sin(TAU * J(rng, 4.5, 6.0) * t + rng.random() * TAU))
            src += saw(f, n, rng.random())
    choir = formant(src, 'o', 'a', curve(n, [(0, 0), (d, 1)]))
    choir = lp(choir, 5000)
    e = curve(n, [(0, 0), (0.6, 0.8), (1.6, 1.0), (d, 0)])
    sp = pings(n, rng, lambda tt: 6 + 14 * tt / d, [midi(m) for m in (93, 97, 100, 105)], (0.05, 0.2))
    x = norm(choir) * e + 0.15 * norm(sp)
    return reverb(x, rt=2.4, mix=0.4, bright=8000)


def r_esper_slam(rng, v):
    d = 2.5
    b = Buf(d)
    n = b.n
    k = N(0.3)
    f = sweep(500, 60, k, 0.28)
    dive = (sine(f, k) + 0.5 * sine(f * 1.5, k)) * curve(k, [(0, 0), (0.05, 1), (0.3, 0.6)])
    b.add(dive, gain=0.35)
    b.add(whoosh_noise(k, rng, curve(k, [(0, 3000), (0.3, 300)], log=True), 1.2, curve(k, [(0, 0), (0.3, 1)])), gain=0.5)
    b.add(body_thud(n, rng, 80, 30, 0.08, 0.5, 600, 0.15), at=0.28, gain=1.0)
    b.add(crack(n, rng, 0.006, 2000), at=0.28, gain=0.4)
    b.add(_ethereal(n, rng, 110.0, 6.0) * env_exp(n, 0.005, 0.4), at=0.28, gain=0.3)
    cr = grains(n, rng, lambda tt: 250 * np.exp(-tt / 0.3), (0.003, 0.02))
    b.add(norm(bp(cr, 1400, 0.6)), at=0.3, gain=0.3)
    return reverb(drive(b.out(), 1.8), rt=1.8, mix=0.25)


def r_esper_barrier_up(rng, v):
    d = 1.4
    b = Buf(d)
    n = b.n
    t = T(n)
    sw = whoosh_noise(n, rng, curve(n, [(0, 300), (0.3, 3000), (d, 2000)], log=True), 1.5,
                      curve(n, [(0, 0), (0.25, 1), (0.6, 0.2), (d, 0)]))
    b.add(sw, gain=0.45)
    f = curve(n, [(0, 70), (0.3, 110), (d, 110)], log=True)
    hum = sine(f, n) + 0.6 * sine(f * 2.003, n) + 0.3 * saw(f * 3.0, n) * 0.5
    b.add(norm(hum) * curve(n, [(0, 0), (0.3, 1), (1.0, 0.7), (d, 0)]), gain=0.45)
    shimmer = np.zeros(n)
    for f0 in (2093, 2637, 3136, 4186):
        shimmer += sine(f0 * (1 + 0.003 * np.sin(TAU * 7 * t + f0)), n, rng.random())
    flick = 0.5 + 0.5 * smooth_noise(n, rng, 25)
    b.add(norm(shimmer) * flick * curve(n, [(0, 0), (0.3, 1), (d, 0)]), gain=0.18)
    b.add(norm(pings(n, rng, 25, [2093, 2637, 3136, 4186, 5274], (0.03, 0.1))) * curve(n, [(0, 0), (0.25, 1), (d, 0)]), gain=0.15)
    return reverb(b.out(), rt=1.4, mix=0.3, bright=10000)


def r_esper_barrier_down(rng, v):
    d = 1.1
    n = N(d)
    t = T(n)
    shimmer = np.zeros(n)
    for f0 in (4186, 3136, 2637, 2093):
        f = f0 * curve(n, [(0, 1.0), (d, 0.6)], log=True) * (1 + 0.003 * np.sin(TAU * 7 * t + f0))
        shimmer += sine(f, n, rng.random())
    flick = 0.5 + 0.5 * smooth_noise(n, rng, 30)
    f = curve(n, [(0, 110), (d, 55)], log=True)
    hum = norm(sine(f, n) + 0.5 * sine(f * 2.003, n))
    e = curve(n, [(0, 1), (d, 0)]) ** 1.5
    sp = norm(pings(n, rng, lambda tt: 30 * (1 - tt / d), [2093, 2637, 3136, 4186], (0.03, 0.1)))
    x = norm(shimmer) * flick * e * 0.5 + hum * e * 0.5 + sp * 0.3 * e
    return reverb(x, rt=1.3, mix=0.3, bright=10000)


def r_esper_reflect(rng, v):
    d = 0.7
    b = Buf(d)
    n = b.n
    t = T(n)
    base = J(rng, 1900, 2300)
    ping = np.zeros(n)
    for r_, a, dec in ((1.0, 1.0, 0.25), (1.62, 0.6, 0.18), (2.53, 0.4, 0.12), (3.9, 0.2, 0.08)):
        ping += a * np.sin(TAU * base * r_ * t) * np.exp(-t / dec)
    b.add(ping * np.minimum(1, t / 0.0008), gain=0.5)
    f = curve(n, [(0, J(rng, 3500, 4200)), (0.35, J(rng, 1500, 1900))], log=True)
    ric = sine(f, n) * curve(n, [(0, 0), (0.01, 1), (0.4, 0)]) ** 1.2
    b.add(ric, at=0.02, gain=0.35)
    b.add(crack(n, rng, 0.002, 4000), gain=0.4)
    return reverb(b.out(), rt=1.0, mix=0.22, bright=12000)


def r_esper_meteor_call(rng, v):
    d = 3.4
    b = Buf(d)
    n = b.n
    t = T(n)
    drone = np.zeros(n)
    for m, a in ((33, 1.0), (34, 0.7), (40, 0.6), (45, 0.4), (46, 0.3)):
        f = midi(m) * (1 + 0.004 * np.sin(TAU * J(rng, 0.2, 0.5) * t))
        drone += a * saw(f, n, rng.random())
    drone = tv(drone, 'lp', curve(n, [(0, 150), (1.6, 900), (d, 300)], log=True))
    b.add(norm(drone) * curve(n, [(0, 0), (1.2, 1.0), (2.6, 0.8), (d, 0)]), gain=0.6)
    rr = rumble(n, rng, 110, 1.5, 0.7)
    b.add(rr * curve(n, [(0, 0), (0.8, 0.4), (1.8, 1.0), (d, 0)]), gain=0.55)
    whine = sine(curve(n, [(0, 1400), (d, 1900)], log=True) * (1 + 0.01 * np.sin(TAU * 5 * t)), n)
    b.add(whine * curve(n, [(0, 0), (1.5, 1), (d, 0)]), gain=0.04)
    return reverb(b.out(), rt=2.8, mix=0.35, bright=5000)


def r_esper_meteor_fall(rng, v):
    d = 3.2
    n = N(d)
    t = T(n)
    e = curve(n, [(0, 0.05), (1.5, 0.35), (2.8, 0.9), (3.1, 1.0), (d, 0.0)]) ** 1.2
    turb = 0.7 + 0.3 * smooth_noise(n, rng, 22)
    roar = tv(colored(n, rng, -1), 'lp', curve(n, [(0, 300), (d, 3500)], log=True)) * turb
    whistle = tv(white(n, rng), 'bp', curve(n, [(0, 180), (d, 950)], log=True), 4.0)
    tone = sine(curve(n, [(0, 120), (d, 520)], log=True), n) * 0.5
    fire = crackle(n, rng, lambda tt: 300 + 2500 * tt / d, 2.5, 1.5)
    sub = sine(curve(n, [(0, 30), (d, 55)], log=True), n)
    x = norm(roar) + 0.45 * norm(whistle) + 0.12 * tone + 0.25 * norm(hp(fire, 1500)) + 0.5 * sub
    x = drive(x * e, 1.6)
    return x


def r_esper_meteor_impact(rng, v):
    d = 5.0
    b = Buf(d)
    n = b.n
    b.add(norm(hp(white(n, rng), 800)) * env_exp(n, 0.0002, 0.012), gain=0.9)
    sub = sine(drop(55, 20, 0.25, n), n) * env_exp(n, 0.003, 1.1)
    b.add(drive(sub, 3.0), gain=1.0)
    blast = tv(colored(n, rng, -1), 'lp', curve(n, [(0, 8000), (0.4, 900), (2.0, 200), (d, 120)], log=True))
    b.add(norm(blast) * env_exp(n, 0.002, 0.6), gain=0.9)
    cr = grains(n, rng, lambda tt: 500 * np.exp(-tt / 0.9) * (tt > 0.05), (0.003, 0.035))
    b.add(norm(bp(cr, 1100, 0.5) + 0.6 * lp(cr, 400)) * curve(n, [(0, 0), (0.05, 1), (2.5, 0.2), (d, 0)]), gain=0.45)
    fire = crackle(n, rng, lambda tt: 2000 * np.exp(-tt / 1.2), 2.5, 1.5)
    b.add(norm(hp(fire, 1500)) * curve(n, [(0, 0), (0.1, 1), (d, 0)]), gain=0.2)
    b.add(rumble(n, rng, 90, 1.8, 0.6) * curve(n, [(0, 0), (0.15, 1), (1.5, 0.7), (d, 0)]) ** 1.3, gain=0.7)
    x = np.tanh(2.6 * norm(b.out())) / np.tanh(2.6)
    return reverb(x, rt=3.6, mix=0.35, bright=5000)


# ---- rogue mutant -----------------------------------------------------------------------------

def _voice(n, rng, f, fry=28.0, fry_depth=0.6, jitter=0.04):
    """Glottal-ish source: saw with pitch jitter and vocal-fry AM."""
    f = f * (1.0 + jitter * smooth_noise(n, rng, 9))
    src = saw(f, n, rng.random()) + 0.5 * saw(f * 1.004, n, rng.random())
    fry_rate = fry * (1 + 0.25 * smooth_noise(n, rng, 5))
    am = 1.0 - fry_depth * (0.5 + 0.5 * np.sin(TAU * phase(fry_rate, n))) ** 3
    return src * am


def r_mutant_ambient(rng, v):
    d = J(rng, 1.4, 1.8)
    n = N(d)
    if v == 2:   # wet snort / breath
        br = colored(n, rng, -1)
        e = curve(n, [(0, 0), (0.25, 1), (0.5, 0.3), (0.7, 0), (0.85, 0.9), (1.2, 0)])
        br = formant(br, 'u', shift=0.8) * e
        gr = _voice(n, rng, 70, 22, 0.8) * curve(n, [(0, 0), (0.8, 0), (0.9, 0.5), (1.2, 0)])
        x = norm(br) + 0.4 * norm(formant(gr, 'o', shift=0.75))
        return drive(x, 2.5)
    f = curve(n, [(0, J(rng, 70, 80)), (d * 0.4, J(rng, 88, 100)), (d, J(rng, 62, 70))], log=True)
    vo = _voice(n, rng, f, J(rng, 24, 34), 0.7)
    vo = formant(vo, 'o' if v == 0 else 'a', 'u', curve(n, [(0, 0), (d, 1)]), shift=0.78)
    breath = formant(colored(n, rng, -1), 'a', shift=0.8)
    e = curve(n, [(0, 0), (0.2, 0.9), (d * 0.6, 1.0), (d, 0)])
    x = (norm(vo) + 0.35 * norm(breath)) * e
    x = drive(x, 3.0)
    return reverb(x, rt=0.6, mix=0.12)


def r_mutant_hurt(rng, v):
    d = 0.55
    n = N(d)
    f0 = J(rng, 150, 180)
    f = curve(n, [(0, f0), (0.08, f0 * 1.35), (d, f0 * 0.75)], log=True)
    vo = _voice(n, rng, f, 40, 0.5, 0.06)
    vo = formant(vo, 'ae' if v != 1 else 'a', shift=0.85)
    snarl = formant(hp(white(n, rng), 800), 'ae', shift=0.9)
    e = curve(n, [(0, 0), (0.015, 1.0), (0.2, 0.8), (d, 0)])
    x = (norm(vo) + 0.3 * norm(snarl)) * e
    return reverb(drive(x, 3.5), rt=0.5, mix=0.1)


def r_mutant_death(rng, v):
    d = 2.6
    b = Buf(d)
    n = b.n
    k = N(1.8)
    f = curve(k, [(0, 150), (0.25, 165), (1.8, 48)], log=True)
    vo = _voice(k, rng, f, curve(k, [(0, 30), (1.8, 14)]), curve(k, [(0, 0.4), (1.8, 0.9)]), 0.05)
    vo = formant(vo, 'a', 'u', curve(k, [(0, 0), (1.8, 1)]), shift=curve(k, [(0, 0.85), (1.8, 0.7)]))
    e = curve(k, [(0, 0), (0.03, 1.0), (0.9, 0.85), (1.8, 0)])
    b.add(drive(norm(vo) * e, 3.0), gain=0.85)
    gur = bubbles(k, rng, lambda tt: np.interp(tt, [0, 0.9, 1.5, 1.8], [0, 0, 25, 0]), (120, 400), (0.02, 0.05))
    b.add(norm(gur), gain=0.2)
    b.add(body_thud(n, rng, 90, 40, 0.06, 0.25, 600, 0.1), at=1.75, gain=0.8)
    gr = grains(n, rng, lambda tt: 150 * np.exp(-tt / 0.2), (0.002, 0.012))
    b.add(norm(bp(gr, 1600, 0.6)), at=1.76, gain=0.2)
    return reverb(b.out(), rt=1.2, mix=0.15)


def r_mutant_power(rng, v):
    d = 1.4
    b = Buf(d)
    n = b.n
    t = T(n)
    f = curve(n, [(0, 70), (1.1, 140), (d, 120)], log=True)
    vo = formant(_voice(n, rng, f, 30, 0.6), 'o', 'a', curve(n, [(0, 0), (1.1, 1)]), shift=0.8)
    b.add(drive(norm(vo) * curve(n, [(0, 0), (0.3, 0.7), (1.1, 1.0), (d, 0)]), 3.0), gain=0.6)
    fw = sweep(110, 1100, n, 1.1)
    whine = np.sin(TAU * phase(fw, n) + 2.0 * np.sin(TAU * phase(fw * 0.5, n)))
    b.add(whine * curve(n, [(0, 0), (1.05, 1.0), (1.15, 0.2), (d, 0)]), gain=0.25)
    cr = crackle(n, rng, lambda tt: 200 + 3000 * (tt / d) ** 2, 2.5, 1.0)
    b.add(norm(hp(cr, 2000)) * curve(n, [(0, 0), (1.1, 1), (d, 0)]), gain=0.3)
    b.add(body_thud(n, rng, 120, 50, 0.05, 0.2, 1200, 0.06), at=1.1, gain=0.7)
    b.add(crack(n, rng, 0.006, 2500), at=1.1, gain=0.4)
    return reverb(b.out(), rt=1.0, mix=0.15)


# --------------------------------------------------------------------------------------------
# sound table
# --------------------------------------------------------------------------------------------
# id: (category, volume, min_distance, max_distance, recipe, variations, loop)
# variations: number of files; files are sounds/sp/<group>/<name>[N].ogg

SOUNDS = {
    'sp.power.gain':        ('player', 1.0, 4, 32, r_power_gain, 1, False),
    'sp.power.lose':        ('player', 1.0, 4, 32, r_power_lose, 1, False),
    'sp.power.purge':       ('player', 1.0, 4, 32, r_power_purge, 1, False),
    'sp.syringe.inject':    ('player', 0.9, 2, 16, r_syringe_inject, 1, False),
    'sp.ui.open':           ('ui', 0.7, None, None, r_ui_open, 1, False),
    'sp.ui.click':          ('ui', 0.5, None, None, r_ui_click, 2, False),
    'sp.ui.select':         ('ui', 0.55, None, None, r_ui_select, 1, False),
    'sp.ui.deny':           ('ui', 0.6, None, None, r_ui_deny, 1, False),
    'sp.impact.heavy':      ('player', 1.0, 8, 64, r_impact_heavy, 3, False),
    'sp.impact.light':      ('player', 0.85, 4, 32, r_impact_light, 3, False),
    'sp.debris.rip':        ('player', 1.0, 6, 48, r_debris_rip, 2, False),
    'sp.debris.place':      ('block', 0.8, 2, 16, r_debris_place, 2, False),
    'sp.whoosh':            ('player', 0.8, 2, 24, r_whoosh, 2, False),
    'sp.strength.punch':    ('player', 1.0, 4, 32, r_strength_punch, 3, False),
    'sp.strength.charge':   ('player', 0.9, 4, 32, r_strength_charge, 1, True),
    'sp.strength.leap':     ('player', 1.0, 6, 48, r_strength_leap, 2, False),
    'sp.strength.land':     ('player', 1.0, 12, 96, r_strength_land, 2, False),
    'sp.strength.throw':    ('player', 1.0, 4, 32, r_strength_throw, 2, False),
    'sp.strength.dash':     ('player', 1.0, 8, 64, r_strength_dash, 1, False),
    'sp.strength.clap':     ('player', 1.0, 16, 128, r_strength_clap, 1, False),
    'sp.flight.takeoff':    ('player', 1.0, 4, 32, r_flight_takeoff, 1, False),
    'sp.flight.land':       ('player', 1.0, 4, 32, r_flight_land, 1, False),
    'sp.flight.wind':       ('player', 0.6, 2, 24, r_flight_wind, 3, True),
    'sp.flight.boom':       ('player', 1.0, 16, 128, r_flight_boom, 2, False),
    'sp.flight.grab':       ('player', 0.9, 2, 24, r_flight_grab, 1, False),
    'sp.flight.throw':      ('player', 1.0, 4, 32, r_flight_throw, 1, False),
    'sp.heat.start':        ('player', 0.9, 4, 32, r_heat_start, 1, False),
    'sp.heat.loop':         ('player', 0.7, 4, 32, r_heat_loop, 2, True),
    'sp.heat.stop':         ('player', 0.8, 4, 32, r_heat_stop, 1, False),
    'sp.heat.sizzle':       ('player', 0.7, 2, 24, r_heat_sizzle, 3, False),
    'sp.heat.burst':        ('player', 1.0, 8, 64, r_heat_burst, 2, False),
    'sp.heat.overheat':     ('player', 0.9, 4, 32, r_heat_overheat, 1, False),
    'sp.heat.focus':        ('player', 0.5, 2, 16, r_heat_focus, 1, False),
    'sp.speed.start':       ('player', 0.9, 4, 32, r_speed_start, 1, False),
    'sp.speed.stop':        ('player', 0.8, 4, 32, r_speed_stop, 1, False),
    'sp.speed.zap':         ('player', 0.8, 4, 32, r_speed_zap, 3, False),
    'sp.speed.boom':        ('player', 1.0, 12, 96, r_speed_boom, 1, False),
    'sp.speed.gear':        ('player', 0.7, 2, 24, r_speed_gear, 1, False),
    'sp.speed.dodge':       ('player', 0.8, 2, 24, r_speed_dodge, 2, False),
    'sp.speed.slow_in':     ('player', 1.0, 4, 48, r_speed_slow_in, 1, False),
    'sp.speed.slow_out':    ('player', 1.0, 4, 48, r_speed_slow_out, 1, False),
    'sp.speed.blitz':       ('player', 1.0, 12, 96, r_speed_blitz, 1, False),
    'sp.esper.grab':        ('player', 0.9, 4, 32, r_esper_grab, 1, False),
    'sp.esper.hold':        ('player', 0.6, 2, 24, r_esper_hold, 2, True),
    'sp.esper.launch':      ('player', 1.0, 4, 32, r_esper_launch, 1, False),
    'sp.esper.drop':        ('player', 0.8, 2, 24, r_esper_drop, 1, False),
    'sp.esper.levitate':    ('player', 0.8, 4, 32, r_esper_levitate, 1, False),
    'sp.esper.slam':        ('player', 1.0, 8, 64, r_esper_slam, 1, False),
    'sp.esper.barrier_up':  ('player', 0.9, 4, 32, r_esper_barrier_up, 1, False),
    'sp.esper.barrier_down': ('player', 0.8, 4, 32, r_esper_barrier_down, 1, False),
    'sp.esper.reflect':     ('player', 0.9, 4, 32, r_esper_reflect, 2, False),
    'sp.esper.meteor_call': ('weather', 1.0, 16, 96, r_esper_meteor_call, 1, False),
    'sp.esper.meteor_fall': ('player', 1.0, 16, 128, r_esper_meteor_fall, 1, False),
    'sp.esper.meteor_impact': ('player', 1.0, 24, 128, r_esper_meteor_impact, 1, False),
    'sp.mutant.ambient':    ('hostile', 1.0, 2, 24, r_mutant_ambient, 3, False),
    'sp.mutant.hurt':       ('hostile', 1.0, 2, 24, r_mutant_hurt, 3, False),
    'sp.mutant.death':      ('hostile', 1.0, 4, 32, r_mutant_death, 1, False),
    'sp.mutant.power':      ('hostile', 1.0, 4, 48, r_mutant_power, 1, False),
}

# entity sound events (RP sounds.json)
ENTITY_SOUNDS = {
    'sp:rogue_mutant': {
        'volume': 1.0,
        'pitch': [0.85, 1.05],
        'events': {
            'ambient': 'sp.mutant.ambient',
            'hurt': 'sp.mutant.hurt',
            'death': 'sp.mutant.death',
            'step': {'sound': 'mob.zombie.step', 'volume': 0.3, 'pitch': 0.8},
        },
    },
}


def files_for(sid):
    parts = sid.split('.')[1:]
    if len(parts) == 1:
        group, name = 'misc', parts[0]
    else:
        group, name = parts[0], '_'.join(parts[1:])
    count = SOUNDS[sid][5]
    if count == 1:
        return [f'sounds/sp/{group}/{name}']
    return [f'sounds/sp/{group}/{name}{i + 1}' for i in range(count)]


LOUD_REF = -15.0   # dB: files louder than this get their table volume scaled down
LOUD_REF_CATEGORY = {'hostile': -11.0}   # mobs must read clearly over the world


def loudness(x):
    """Crude short-term loudness: max 300 ms RMS (dB) after a perceptual-ish weighting."""
    y = spec(np.asarray(x, float), lambda f: g_hp(150, 1)(f) * (1.0 + 0.6 * g_bp(3000, 0.7)(f)))
    w = N(0.3)
    if len(y) <= w:
        return 10 * np.log10(np.mean(y * y) + 1e-12)
    cs = np.concatenate([[0.0], np.cumsum(y * y)])
    return float(10 * np.log10(np.max(cs[w:] - cs[:-w]) / w + 1e-12))


def file_volume(name, base, category):
    """Table volume, scaled down for files that are louder than the reference (loudness matching)."""
    path = os.path.join(RP, name + '.ogg')
    if sf is None or not os.path.exists(path):
        return base
    x, _sr = sf.read(path)
    ref = LOUD_REF_CATEGORY.get(category, LOUD_REF)
    gain = min(1.0, 10 ** ((ref - loudness(x)) / 20.0))
    return round(max(0.1, base * gain), 2)


def build_definitions():
    defs = {}
    for sid, (cat, vol, mind, maxd, _r, _c, _loop) in SOUNDS.items():
        d = {'category': cat}
        if mind is not None:
            d['min_distance'] = float(mind)
        if maxd is not None:
            d['max_distance'] = float(maxd)
        d['sounds'] = [{'name': name, 'volume': file_volume(name, vol, cat), 'pitch': 1.0,
                        'load_on_low_memory': True, 'stream': False}
                       for name in files_for(sid)]
        defs[sid] = d
    return {'format_version': '1.20.20', 'sound_definitions': defs}


def build_entity_sounds():
    return {'entity_sounds': {'entities': ENTITY_SOUNDS}}


# --------------------------------------------------------------------------------------------
# OGG writing (fixed stream serial → byte-identical regeneration)
# --------------------------------------------------------------------------------------------

def _crc_table():
    tab = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if (r & 0x80000000) else (r << 1)
        tab.append(r & 0xFFFFFFFF)
    return tab


_CRC = _crc_table()


def _ogg_crc(data):
    crc = 0
    tab = _CRC
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ tab[((crc >> 24) & 0xFF) ^ b]
    return crc


def fix_ogg_serial(path, serial):
    data = bytearray(open(path, 'rb').read())
    pos = 0
    while pos + 27 <= len(data):
        if data[pos:pos + 4] != b'OggS':
            raise ValueError(f'{path}: bad ogg page at {pos}')
        nseg = data[pos + 26]
        body = sum(data[pos + 27:pos + 27 + nseg])
        end = pos + 27 + nseg + body
        data[pos + 14:pos + 18] = serial.to_bytes(4, 'little')
        data[pos + 22:pos + 26] = b'\0\0\0\0'
        crc = _ogg_crc(bytes(data[pos:end]))
        data[pos + 22:pos + 26] = crc.to_bytes(4, 'little')
        pos = end
    with open(path, 'wb') as f:
        f.write(bytes(data))


def write_ogg(path, x):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for _ in range(3):
        sf.write(path, x, SR, format='OGG', subtype='VORBIS', compression_level=VORBIS_COMPRESSION)
        pk = float(np.max(np.abs(sf.read(path)[0])))
        if pk <= 0.98:   # lossy coding can overshoot sharp transients: re-encode a bit lower
            break
        x = (x * (0.95 / pk)).astype(np.float32)
    fix_ogg_serial(path, zlib.crc32(os.path.basename(path).encode()) & 0x7FFFFFFF)


def preview(prev_dir, rel, x):
    os.makedirs(prev_dir, exist_ok=True)
    base = os.path.join(prev_dir, rel.replace('sounds/sp/', '').replace('/', '_'))
    sf.write(base + '.wav', x, SR, subtype='PCM_16')
    try:
        from PIL import Image
    except ImportError:
        return
    win, hop = 1024, 256
    if len(x) < win:
        x = fit(x, win)
    frames = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(frames)[:, None]
    S = np.abs(np.fft.rfft(x[idx] * np.hanning(win), axis=1))
    S = 20 * np.log10(S + 1e-6)
    S = np.clip((S - S.max() + 80) / 80, 0, 1)
    # log frequency axis 30 Hz .. 20 kHz, 256 rows
    f = np.fft.rfftfreq(win, 1 / SR)
    rows = np.exp(np.linspace(np.log(30), np.log(20000), 256))
    img = np.stack([np.interp(rows, f, S[i]) for i in range(frames)], axis=1)[::-1]
    # waveform strip
    wav = np.zeros((64, frames))
    for i in range(frames):
        a = np.max(np.abs(x[i * hop:i * hop + hop])) if i * hop < len(x) else 0
        h = int(a * 31)
        wav[32 - h:33 + h, i] = 1
    im = np.vstack([img, np.zeros((4, frames)), wav])
    Image.fromarray((im * 255).astype(np.uint8)).save(base + '.png')


def generate(only=None, prev_dir=None):
    if sf is None:
        sys.exit('soundfile is required to generate sounds')
    wanted = set(only) if only else None
    produced = set()
    total = 0
    for sid, (cat, vol, mind, maxd, recipe, count, loop) in SOUNDS.items():
        rels = files_for(sid)
        produced.update(rels)
        if wanted and sid not in wanted:
            continue
        for i, rel in enumerate(rels):
            rng = np.random.default_rng(zlib.crc32(rel.encode()))
            raw = recipe(rng, i)
            if loop:
                x = finish(raw, fin=0.001, fout=0.001, loop=True)
            else:
                x = finish(raw)
            path = os.path.join(RP, rel + '.ogg')
            write_ogg(path, x)
            sz = os.path.getsize(path)
            total += sz
            print(f'  {rel:42s} {len(x) / SR:5.2f}s  {sz / 1024:6.1f} KB')
            if prev_dir:
                preview(prev_dir, rel, x)
    # drop stale files in our directory
    if not wanted:
        sp_dir = os.path.join(SOUND_DIR, 'sp')
        for dp, _dn, fns in os.walk(sp_dir):
            for fn in fns:
                rel = os.path.relpath(os.path.join(dp, fn), RP).replace(os.sep, '/')
                if fn.endswith('.ogg') and rel[:-4] not in produced:
                    os.remove(os.path.join(dp, fn))
                    print(f'  removed stale {rel}')
    with open(DEFS_PATH, 'w') as f:
        json.dump(build_definitions(), f, indent=2)
        f.write('\n')
    with open(ENTITY_SOUNDS_PATH, 'w') as f:
        json.dump(build_entity_sounds(), f, indent=2)
        f.write('\n')
    print(f'wrote {DEFS_PATH} ({len(SOUNDS)} ids) and {ENTITY_SOUNDS_PATH}')


# --------------------------------------------------------------------------------------------
# --check
# --------------------------------------------------------------------------------------------

def contract_ids():
    text = open(ARCH, encoding='utf-8').read()
    m = re.search(r'^### Sounds.*?$(.*?)^###', text, re.S | re.M)
    if not m:
        return set()
    return set(re.findall(r'`(sp\.[a-z0-9_.]+)`', m.group(1)))


def script_sound_ids():
    """{sound id: [file:line, ...]} for ids passed to fx.sound / fx.soundTo / playSound."""
    used = {}
    dynamic = []
    call = re.compile(r'\b(?:sound|soundTo|playSound)\s*\(')
    lit = re.compile(r"""['"`]((?:sp|random|mob|block|ambient|dig|step|note|fire|damage|game|use|armor|bucket|liquid|item|beacon|conduit|portal|ui)\.[A-Za-z0-9_.]+)['"`]""")
    for dp, _dn, fns in os.walk(BP_SCRIPTS):
        for fn in fns:
            if not fn.endswith('.js'):
                continue
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, ROOT)
            src = open(p, encoding='utf-8').read()
            for mm in call.finditer(src):
                seg = src[mm.end():mm.end() + 240]
                depth = 1
                for j, ch in enumerate(seg):
                    depth += ch == '('
                    depth -= ch == ')'
                    if depth == 0:
                        seg = seg[:j]
                        break
                line = src.count('\n', 0, mm.start()) + 1
                ids = lit.findall(seg)
                for sid in ids:
                    used.setdefault(sid, []).append(f'{rel}:{line}')
                if not ids and re.search(r"`sp\.[^`]*\$\{", seg):
                    dynamic.append(f'{rel}:{line}')
            # any other 'sp.x.y' string literal (e.g. passed through a variable)
            for mm in re.finditer(r"""['"](sp\.[a-z0-9_]+(?:\.[a-z0-9_]+)*)['"]""", src):
                used.setdefault(mm.group(1), []).append(f'{rel}:{src.count(chr(10), 0, mm.start()) + 1}')
    return used, dynamic


def check():
    errors = []
    warns = []
    if not os.path.exists(DEFS_PATH):
        print('ERROR: sound_definitions.json missing')
        return 1
    data = json.load(open(DEFS_PATH))
    if data.get('format_version') != '1.20.20':
        errors.append('sound_definitions.json format_version must be 1.20.20')
    defs = data.get('sound_definitions', {})
    contract = contract_ids()
    if not contract:
        errors.append('could not read sound ids from docs/ARCHITECTURE.md')
    for sid in sorted(contract - set(defs)):
        errors.append(f'contract sound id not defined: {sid}')
    for sid in sorted(set(defs) - contract):
        warns.append(f'defined but not in contract: {sid}')
    referenced = set()
    total = 0
    for sid, d in defs.items():
        if d.get('category') not in ('ambient', 'block', 'bottle', 'bucket', 'hostile', 'music', 'neutral',
                                     'player', 'record', 'ui', 'weather'):
            errors.append(f'{sid}: bad category {d.get("category")}')
        if not d.get('sounds'):
            errors.append(f'{sid}: no sounds')
        for s in d.get('sounds', []):
            name = s['name'] if isinstance(s, dict) else s
            if name.endswith('.ogg'):
                errors.append(f'{sid}: name must not include the extension: {name}')
            path = os.path.join(RP, name + '.ogg')
            referenced.add(os.path.normpath(path))
            if not os.path.exists(path):
                errors.append(f'{sid}: missing file {name}.ogg')
                continue
            total += os.path.getsize(path)
            if sf is not None:
                info = sf.info(path)
                if info.channels != 1:
                    errors.append(f'{name}.ogg: must be mono (has {info.channels} channels)')
                if info.samplerate not in (44100, 22050):
                    errors.append(f'{name}.ogg: sample rate {info.samplerate}')
                if info.format != 'OGG' or info.subtype != 'VORBIS':
                    errors.append(f'{name}.ogg: not OGG/Vorbis ({info.format}/{info.subtype})')
                if info.duration > 8:
                    warns.append(f'{name}.ogg: long sound ({info.duration:.1f}s)')
                if np.max(np.abs(sf.read(path)[0])) > 1.0:
                    warns.append(f'{name}.ogg: decoded audio clips (peak > 0 dBFS)')
    # orphans
    for dp, _dn, fns in os.walk(os.path.join(SOUND_DIR, 'sp')):
        for fn in fns:
            p = os.path.normpath(os.path.join(dp, fn))
            if p not in referenced:
                warns.append(f'unreferenced file {os.path.relpath(p, RP)}')
    if total > SIZE_BUDGET:
        errors.append(f'total sound size {total / 1048576:.2f} MB exceeds {SIZE_BUDGET / 1048576:.0f} MB')
    # entity sounds
    if os.path.exists(ENTITY_SOUNDS_PATH):
        es = json.load(open(ENTITY_SOUNDS_PATH))
        for ent, cfg in es.get('entity_sounds', {}).get('entities', {}).items():
            for ev, val in cfg.get('events', {}).items():
                snd = val if isinstance(val, str) else val.get('sound')
                if snd and snd.startswith('sp.') and snd not in defs:
                    errors.append(f'sounds.json {ent}.{ev} -> undefined {snd}')
    else:
        errors.append('sounds.json missing')
    # scripts
    used, dynamic = script_sound_ids()
    undefined = []
    for sid, where in sorted(used.items()):
        if sid.startswith('sp.') and sid not in defs:
            undefined.append(sid)
            errors.append(f'script uses undefined sound {sid} ({", ".join(where[:3])})')
    for w in dynamic:
        warns.append(f'dynamic sound id (template literal) at {w}: verify manually')
    sp_used = sorted(s for s in used if s.startswith('sp.'))
    vanilla = sorted(s for s in used if not s.startswith('sp.'))
    for w in warns:
        print('WARN ', w)
    for e in errors:
        print('ERROR', e)
    print(f'check: {len(defs)} ids defined, contract {len(contract)}, scripts use {len(sp_used)} sp ids '
          f'({len(undefined)} undefined){", vanilla: " + ", ".join(vanilla) if vanilla else ""}; '
          f'files {len(referenced)} = {total / 1048576:.2f} MB; {len(errors)} error(s), {len(warns)} warning(s)')
    return 1 if errors else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='validate instead of generating')
    ap.add_argument('--only', default='', help='comma separated sound ids to regenerate')
    ap.add_argument('--preview', default=None, help='also write .wav + spectrogram .png to this dir')
    a = ap.parse_args()
    if a.check:
        sys.exit(check())
    only = [s.strip() for s in a.only.split(',') if s.strip()]
    for s in only:
        if s not in SOUNDS:
            sys.exit(f'unknown sound id {s}')
    generate(only or None, a.preview)
    sys.exit(check())


if __name__ == '__main__':
    main()
