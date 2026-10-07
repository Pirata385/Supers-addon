// Heat Vision: twin beams of concentrated heat fired from the eyes. The beam burns creatures,
// ignites wood, melts sand into glass, vaporises soft blocks, turns stone into magma and, at full
// power, bores tunnels. Firing stores heat in the eyes; a full gauge overheats them. A single
// overcharged Scorching Blast detonates where it lands.
// Built only from raycasts, safe block edits, particles, sounds, light flashes and a body pose.
import { system, EntityDamageCause } from '@minecraft/server';
import { TUNING, GLYPH } from '../config.js';
import { definePower, grantTemporaryFlag, startCooldown, endHold, isHolding } from '../core/powers.js';
import { rt, griefingAllowed, pvpAllowed } from '../core/state.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import { canAffect, creaturesNear, damage, knockFrom, isValid, isVulnerablePlayer, eyes } from '../core/entities.js';
import { tierOf, breakBlock, breakSphere, transformBlock } from '../core/blocks.js';
import { bar } from '../core/hud.js';

const ID = 'heat_vision';
const BEAM = 'heat_beam';
const T = TUNING.heat_vision;
const ANIM_BEAM = 'animation.sp.heat.beam';

// ------------------------------------------------------------------ local tuning
const MIN_INTENSITY = 1;
const MAX_INTENSITY = 5;
const START_INTENSITY = 3;
const GAUGE_MAX = 100;
// heatPerTick[] is scaled so a full gauge takes ~8 s at intensity 3 (and ~4 s at intensity 5).
const GAUGE_SCALE = GAUGE_MAX / (160 * T.heatPerTick[3]);
const DAMAGE_INTERVAL = 4; // ticks between damage pulses on a creature
// Measured on BDS 1.26.3: after a hit a mob ignores equal damage for ~10 ticks (a bigger hit only
// deals the difference), so 4-tick pulses would mostly be swallowed. Each pulse therefore adds
// its share to a per-creature pool that is dealt once the hurt window has passed: the creature
// still takes damagePerSecond[intensity] per second.
const HURT_WINDOW = 10;
const HEAT_FORGET = 40; // heat map entries untouched for this long are dropped
const HEAT_MAP_LIMIT = 256;
const FIREWALK_AFTER = 60; // sp_fireproof stays this long after firing / blasting
const EYE_SPREAD = 0.11;
const EYE_FORWARD = 0.2;
const EYE_DOWN = 0.05;
const MAX_SEE_THROUGH = 3; // light blocks / fire skipped by one beam raycast
const IGNITE_HEAT = 8;
const SNOW_HEAT = 5;
const ICE_HEAT = 12;
const SAND_HEAT = 25;
const SOFT_BASE = 40; // soft blocks vaporise at heat > SOFT_BASE - SOFT_PER_INTENSITY * intensity
const SOFT_PER_INTENSITY = 5;
const MAGMA_HEAT = 60; // hard blocks -> magma (intensity >= 4)
const MAGMA_MELT_EXTRA = 40; // magma -> air after a further +40
const BORE_HEAT = 18; // heat given to the 6 neighbours of a vaporised block at intensity 5
const LAVA_CHANCE = 0.3;
const BLAST_RANGE = 64;
const BLAST_GAUGE = 35;
const BLAST_FX_TICKS = 3;
const BLAST_SELF_GUARD = 8;
const BLAST_PROOF_TICKS = 10;
const BLAST_WIDTH = 0.35;
const BLAST_POSE_TICKS = 10;
const INTENSITY_NAMES = ['', 'Precise', 'Searing', 'Melting', 'Molten', 'Devastating'];

const FLAMMABLE_HINTS = [
  'log', 'planks', 'leaves', 'wool', 'hay', 'grass', 'carpet', 'wood', 'bookshelf', 'fence', 'vine', 'bamboo',
  'scaffolding', 'dried_kelp', 'moss', 'azalea', 'tnt', 'target', 'coal_block', 'lectern', 'stairs', 'slab',
];
const NON_FLAMMABLE_HINTS = ['crimson', 'warped', 'stone', 'brick', 'deepslate', 'copper', 'quartz', 'purpur', 'sandstone', 'blackstone', 'mud', 'tuff', 'resin', 'nether'];
const SNOW = new Set(['minecraft:snow', 'minecraft:snow_layer', 'minecraft:powder_snow']);
const ICE = new Set(['minecraft:ice', 'minecraft:packed_ice', 'minecraft:frosted_ice']);
const SAND = new Set(['minecraft:sand', 'minecraft:red_sand']);
const MAGMA = 'minecraft:magma';

const FACE_OFFSET = {
  Up: { x: 0, y: 1, z: 0 },
  Down: { x: 0, y: -1, z: 0 },
  North: { x: 0, y: 0, z: -1 },
  South: { x: 0, y: 0, z: 1 },
  East: { x: 1, y: 0, z: 0 },
  West: { x: -1, y: 0, z: 0 },
};
const NEIGHBOURS = Object.values(FACE_OFFSET);

// Beam colour by intensity: deep red (1) -> orange (3) -> white-hot (5).
const COLORS = [
  { red: 0.75, green: 0.04, blue: 0.02 },
  { red: 0.75, green: 0.04, blue: 0.02 },
  { red: 0.92, green: 0.2, blue: 0.04 },
  { red: 1.0, green: 0.45, blue: 0.08 },
  { red: 1.0, green: 0.72, blue: 0.42 },
  { red: 1.0, green: 0.96, blue: 0.86 },
];
const CORE_COLORS = COLORS.map((c) => ({ red: 1, green: Math.min(1, c.green * 0.5 + 0.5), blue: Math.min(1, c.blue * 0.5 + 0.45) }));
const BLAST_COLOR = { red: 1.0, green: 0.62, blue: 0.22 };
const BLAST_CORE = { red: 1.0, green: 0.95, blue: 0.85 };

/**
 * Transient per-player state (r.data.heat_vision).
 * @typedef {Object} HeatState
 * @property {boolean} firing
 * @property {number} intensity
 * @property {number} defaultIntensity
 * @property {number} gauge
 * @property {number} overheatedUntil
 * @property {number} start
 * @property {number} fireproofUntil
 * @property {Map<string, {heat:number, last:number}>} heat
 * @property {Map<string, {owed:number, last:number, seen:number}>} hitTicks
 * @property {any} blastFx
 * @property {number} blastPoseUntil
 * @property {Record<string, number>} temp
 * @property {Record<string, number>} stats
 * @property {any} lastHit
 * @property {any} lastBlast
 * @property {any} lastDamage
 */

/** @returns {HeatState} */
function state(r) {
  let d = r.data[ID];
  if (!d) {
    d = r.data[ID] = {
      firing: false,
      intensity: START_INTENSITY,
      defaultIntensity: START_INTENSITY,
      gauge: 0,
      overheatedUntil: 0,
      start: 0,
      fireproofUntil: 0,
      heat: new Map(),
      hitTicks: new Map(),
      blastFx: null,
      blastPoseUntil: 0,
      temp: {},
      stats: { ignited: 0, vaporised: 0, glassed: 0, magma: 0, melted: 0, lava: 0, steamed: 0, thawed: 0, hits: 0 },
      lastHit: null,
      lastBlast: null,
      lastDamage: null,
    };
  }
  return d;
}

// ------------------------------------------------------------------ helpers
function hint(p, msg, deny = true) {
  try {
    p.onScreenDisplay.setActionBar(msg);
    rt(p).input.hudHoldUntil = system.currentTick + 30;
  } catch {
    /* ignore */
  }
  if (deny) fx.soundTo(p, 'sp.ui.deny', 1, 0.6);
}

function overheated(d, tick) {
  return d.overheatedUntil > tick;
}

function tempFlag(p, d, flag, ticks) {
  grantTemporaryFlag(p, flag, ticks);
  d.temp[flag] = Math.max(d.temp[flag] ?? 0, system.currentTick + ticks);
}

/** Remove temporary immunity flags this power granted (keeps longer ones granted by other powers). */
function clearOwnTempFlags(r, d) {
  const tf = r.input.tempFlags;
  if (tf) for (const k in d.temp) if (tf[k] !== undefined && tf[k] <= d.temp[k]) delete tf[k];
  d.temp = {};
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function cellKey(x, y, z) {
  return `${x},${y},${z}`;
}

function isSeeThrough(id) {
  return id.startsWith('minecraft:light_block') || id === 'minecraft:fire' || id === 'minecraft:soul_fire';
}

function isFlammable(id) {
  const plain = id.startsWith('minecraft:') ? id.slice(10) : id;
  for (const h of NON_FLAMMABLE_HINTS) if (plain.includes(h)) return false;
  for (const h of FLAMMABLE_HINTS) if (plain.includes(h)) return true;
  return false;
}

/** Ray parameters [tEnter, tExit] of the unit cell at `c` (slab method). */
function cellSpan(o, d, c) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes = [
    [o.x, d.x, c.x],
    [o.y, d.y, c.y],
    [o.z, d.z, c.z],
  ];
  for (const [oa, da, ca] of axes) {
    if (Math.abs(da) < 1e-9) {
      if (oa < ca || oa > ca + 1) return [Infinity, -Infinity];
      continue;
    }
    let t1 = (ca - oa) / da;
    let t2 = (ca + 1 - oa) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  }
  return [tmin, tmax];
}

/**
 * First solid (or liquid) block along a ray, skipping temporary light blocks and fire.
 * @returns {{block: import('@minecraft/server').Block, face: string, dist: number} | undefined}
 */
function castBlock(dim, origin, dir, range) {
  let from = origin;
  let travelled = 0;
  for (let i = 0; i <= MAX_SEE_THROUGH; i++) {
    let hit;
    try {
      hit = dim.getBlockFromRay(from, dir, { maxDistance: range - travelled, includeLiquidBlocks: true, includePassableBlocks: false });
    } catch {
      hit = undefined;
    }
    if (!hit || !hit.block) return undefined;
    const b = hit.block;
    const [tIn, tOut] = cellSpan(from, dir, b.location);
    let id;
    try {
      id = b.typeId;
    } catch {
      return undefined;
    }
    if (isSeeThrough(id)) {
      const step = Math.max(0.01, tOut + 0.002);
      travelled += step;
      if (travelled >= range) return undefined;
      from = V.addScaled(from, dir, step);
      continue;
    }
    // Prefer the exact face location (partial blocks), when it lies on the ray.
    let t = Math.max(0, Number.isFinite(tIn) ? tIn : 0);
    const fl = hit.faceLocation;
    if (fl) {
      const abs = { x: b.location.x + fl.x, y: b.location.y + fl.y, z: b.location.z + fl.z };
      const along = V.dot(V.sub(abs, from), dir);
      if (along >= 0 && V.dist(V.addScaled(from, dir, along), abs) < 0.2) t = along;
    }
    return { block: b, face: hit.face, dist: travelled + t };
  }
  return undefined;
}

/** First creature the player may affect along the view ray, within maxDistance. */
function castCreature(p, maxDistance) {
  if (maxDistance <= 0.05) return undefined;
  try {
    for (const h of p.getEntitiesFromViewDirection({ maxDistance })) {
      if (canAffect(p, h.entity)) return h;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** The two beam origins in front of the player's eyes. */
function eyeOrigins(p, eye, dir) {
  let right = V.rightOf(dir);
  if (V.lenSq(right) < 1e-6) {
    // looking straight up/down: take the side direction from the body yaw
    let yaw = 0;
    try {
      yaw = p.getRotation().y;
    } catch {
      /* ignore */
    }
    right = V.rightOf(V.dirFromRotation({ x: 0, y: yaw }));
  }
  const base = { x: eye.x + dir.x * EYE_FORWARD, y: eye.y + dir.y * EYE_FORWARD - EYE_DOWN, z: eye.z + dir.z * EYE_FORWARD };
  return [V.addScaled(base, right, EYE_SPREAD), V.addScaled(base, right, -EYE_SPREAD)];
}

function drawBeam(dim, from, to, width, color, core) {
  const seg = V.sub(to, from);
  const len = V.len(seg);
  if (len < 0.05) return;
  const dir = V.scale(seg, 1 / len);
  const mid = V.lerpV(from, to, 0.5);
  fx.particle(dim, 'sp:beam', mid, { dir, len, width, color });
  fx.particle(dim, 'sp:beam_core', mid, { dir, len, width: width * 0.45, color: core });
}

function setOnFire(e, seconds) {
  try {
    e.setOnFire(seconds, true);
  } catch {
    /* fire-immune or invalid */
  }
}

function healthOf(e) {
  try {
    return e.getComponent('minecraft:health')?.currentValue ?? -1;
  } catch {
    return -1;
  }
}

// ------------------------------------------------------------------ firing lifecycle
function startFiring(p, d, tick) {
  d.firing = true;
  d.intensity = d.defaultIntensity;
  d.start = tick;
  d.fireproofUntil = tick + FIREWALK_AFTER;
  fx.sound(p.dimension, 'sp.heat.start', eyes(p), 0.9 + 0.05 * d.intensity, 1);
  fx.pose(p, ANIM_BEAM);
}

function stopFiring(p, d, effects = true) {
  if (!d.firing) return;
  d.firing = false;
  d.hitTicks.clear();
  d.fireproofUntil = Math.max(d.fireproofUntil, system.currentTick + FIREWALK_AFTER);
  if (!effects) return;
  fx.sound(p.dimension, 'sp.heat.stop', eyes(p), 1, 0.9);
  fx.stopPose(p);
}

function overheat(p, d, tick) {
  d.gauge = GAUGE_MAX;
  d.overheatedUntil = tick + T.overheatCooldown;
  startCooldown(p, ID, BEAM, T.overheatCooldown);
  const eye = eyes(p);
  fx.sound(p.dimension, 'sp.heat.overheat', eye, 1, 1);
  fx.particle(p.dimension, 'sp:smoke', eye);
  for (const o of eyeOrigins(p, eye, p.getViewDirection())) fx.particle(p.dimension, 'sp:smoke', o);
  if (isHolding(p, ID, BEAM)) endHold(p, 'overheat');
  stopFiring(p, d);
  hint(p, `§4§l${GLYPH.heat} OVERHEATED!§r §c Your eyes need ${(T.overheatCooldown / 20).toFixed(1)}s to cool down.`, false);
}

function setIntensity(p, d, value) {
  const n = V.clamp(value, MIN_INTENSITY, MAX_INTENSITY);
  const changed = n !== d.intensity;
  d.intensity = n;
  fx.soundTo(p, 'sp.heat.focus', 0.7 + 0.12 * n, changed ? 0.9 : 0.4);
  hint(p, `§c${GLYPH.heat} Intensity ${bar(n / MAX_INTENSITY, '§c', MAX_INTENSITY)} §f§l${n}§r §7${INTENSITY_NAMES[n]}`, false);
  rt(p).input.hudHoldUntil = system.currentTick + 20;
}

// ------------------------------------------------------------------ block heating
function heatEntry(d, x, y, z, tick) {
  const k = cellKey(x, y, z);
  let e = d.heat.get(k);
  if (!e) {
    if (d.heat.size >= HEAT_MAP_LIMIT) {
      const first = d.heat.keys().next().value;
      if (first !== undefined) d.heat.delete(first);
    }
    e = { heat: 0, last: tick };
    d.heat.set(k, e);
  }
  return e;
}

function pruneHeat(d, tick) {
  for (const [k, e] of d.heat) if (tick - e.last > HEAT_FORGET) d.heat.delete(k);
}

function center(b) {
  return { x: b.location.x + 0.5, y: b.location.y + 0.5, z: b.location.z + 0.5 };
}

/** Vaporise a block (breakBlock honours griefing / tiers); at intensity 5 heat spreads to its neighbours. */
function vaporise(d, b, intensity, tick, replaceWith = 'minecraft:air') {
  const dim = b.dimension;
  const c = center(b);
  const { x, y, z } = b.location;
  if (!breakBlock(b, { maxTier: 2, effects: true, replaceWith })) return false;
  fx.particle(dim, 'sp:smoke', c);
  fx.particle(dim, 'sp:melt', c);
  d.stats.vaporised++;
  if (intensity >= MAX_INTENSITY) {
    for (const n of NEIGHBOURS) heatEntry(d, x + n.x, y + n.y, z + n.z, tick).heat += BORE_HEAT;
  }
  d.heat.delete(cellKey(x, y, z));
  return true;
}

/**
 * Apply one tick of beam heat to the block it hits.
 * @param {import('@minecraft/server').Block} b
 */
function heatBlock(p, d, b, face, intensity, tick) {
  const dim = b.dimension;
  let id;
  try {
    id = b.typeId;
  } catch {
    return;
  }
  if (b.isLiquid) {
    // water boils into steam; nothing else happens
    if (tick % 6 === 0 && id.includes('water')) {
      fx.particle(dim, 'sp:smoke', V.add(center(b), { x: 0, y: 0.5, z: 0 }));
      d.stats.steamed++;
    }
    return;
  }
  const tier = tierOf(b);
  if (tier >= 4 || tier === 0) return;
  const { x, y, z } = b.location;
  const e = heatEntry(d, x, y, z, tick);
  e.heat += intensity;
  e.last = tick;
  const heat = e.heat;
  if (intensity >= 3 && tick % 3 === 0) fx.particle(dim, 'sp:melt', V.addScaled(center(b), FACE_OFFSET[face] ?? V.UP, 0.5));

  if (SNOW.has(id)) {
    if (heat > SNOW_HEAT && breakBlock(b, { maxTier: 2, effects: false })) {
      fx.particle(dim, 'sp:smoke', center(b));
      d.stats.thawed++;
      d.heat.delete(cellKey(x, y, z));
    }
    return;
  }
  if (ICE.has(id)) {
    if (heat > ICE_HEAT) {
      const ok = dim.id === 'minecraft:nether' ? breakBlock(b, { maxTier: 3, effects: false }) : transformBlock(b, 'minecraft:water');
      if (ok) {
        fx.particle(dim, 'sp:smoke', center(b));
        d.stats.thawed++;
        d.heat.delete(cellKey(x, y, z));
      }
    }
    return;
  }
  if (SAND.has(id) && heat > SAND_HEAT) {
    if (transformBlock(b, 'minecraft:glass')) {
      fx.particle(dim, 'sp:melt', center(b));
      fx.sound(dim, 'sp.heat.sizzle', center(b), 1.3, 0.8);
      d.stats.glassed++;
      e.heat = 0; // fresh glass starts cold
    }
    return;
  }
  if (id === MAGMA) {
    // molten rock only gives way to intensity 4+, after a further +40 heat
    if (intensity >= 4 && heat > MAGMA_HEAT + MAGMA_MELT_EXTRA) {
      const lava = intensity >= MAX_INTENSITY && Math.random() < LAVA_CHANCE;
      if (vaporise(d, b, intensity, tick, lava ? 'minecraft:lava' : 'minecraft:air')) {
        d.stats.melted++;
        if (lava) d.stats.lava++;
      }
    }
    return;
  }
  if (heat > IGNITE_HEAT && tick % 2 === 0 && isFlammable(id)) ignite(d, b, face);
  if (tier <= 2) {
    if (intensity >= 3 && heat > SOFT_BASE - SOFT_PER_INTENSITY * intensity) vaporise(d, b, intensity, tick);
    return;
  }
  // tier 3: hard blocks melt into magma at intensity 4+
  if (intensity >= 4 && heat > MAGMA_HEAT) {
    if (transformBlock(b, MAGMA)) {
      fx.particle(dim, 'sp:melt', center(b));
      fx.particle(dim, 'sp:ember', center(b));
      d.stats.magma++;
    }
  }
}

/** Place fire on the air block in front of the heated face. */
function ignite(d, b, face) {
  const off = FACE_OFFSET[face] ?? V.UP;
  let adj;
  try {
    adj = b.offset(off);
  } catch {
    adj = undefined;
  }
  if (!adj || !adj.isAir) return;
  if (transformBlock(adj, 'minecraft:fire')) d.stats.ignited++;
}

// ------------------------------------------------------------------ per-tick beam
function beamTick(p, d, tick) {
  const dim = p.dimension;
  const i = d.intensity;
  const color = COLORS[i];
  const eye = eyes(p);
  const dir = p.getViewDirection();
  const range = T.range[i];

  const blockHit = castBlock(dim, eye, dir, range);
  let dist = blockHit ? blockHit.dist : range;
  const creatureHit = castCreature(p, dist);
  let target;
  if (creatureHit) {
    target = creatureHit.entity;
    dist = Math.min(dist, creatureHit.distance);
  }
  const end = V.addScaled(eye, dir, dist);
  const hitSomething = !!(target || blockHit);

  // ---- visuals
  const width = 0.05 + 0.02 * i;
  const origins = eyeOrigins(p, eye, dir);
  for (const o of origins) {
    drawBeam(dim, o, end, width, color, CORE_COLORS[i]);
    fx.particle(dim, 'sp:glow', o, { color, size: 0.1 + 0.02 * i });
  }
  if (hitSomething) {
    const back = V.addScaled(end, dir, -0.08);
    fx.particle(dim, 'sp:glow', back, { color, size: 0.25 + 0.12 * i });
    if (tick % 2 === 0) fx.particle(dim, 'sp:spark', back, { color });
    if (tick % 4 === 0) fx.particle(dim, 'sp:ember', back);
    if (tick % 6 === 0) {
      fx.particle(dim, 'sp:smoke', back);
      fx.sound(dim, 'sp.heat.sizzle', end, 0.85 + 0.08 * i + Math.random() * 0.1, 0.7 + 0.06 * i);
    }
    // light at the impact (kept out of the cell a flammable block would ignite)
    let lightAt = V.addScaled(end, dir, -0.6);
    if (!target && blockHit && griefingAllowed()) {
      const off = FACE_OFFSET[blockHit.face];
      const bl = blockHit.block.location;
      if (off && V.key(lightAt) === cellKey(bl.x + off.x, bl.y + off.y, bl.z + off.z)) lightAt = V.addScaled(end, dir, -1.6);
    }
    fx.flashLight(dim, lightAt, 9 + i, 3);
  }
  if (tick % 2 === 0) fx.flashLight(dim, eye, 10, 3); // glowing eyes
  if (tick % 10 === 0) fx.sound(dim, 'sp.heat.loop', eye, 0.8 + 0.1 * i, 0.9);

  // ---- creatures
  if ((tick - d.start) % DAMAGE_INTERVAL === 0) {
    const dmg = T.damagePerSecond[i] / 5;
    if (target && isValid(target)) burn(p, d, target, dmg, 2 + i, tick);
    if (hitSomething) {
      for (const e of creaturesNear(dim, end, 0.8 + 0.2 * i, p)) {
        if (target && e.id === target.id) continue;
        burn(p, d, e, dmg / 2, 0, tick);
      }
    }
    if (d.hitTicks.size > 32) for (const [k, h] of d.hitTicks) if (tick - h.seen > 40) d.hitTicks.delete(k);
  }

  // ---- blocks
  if (!target && blockHit) heatBlock(p, d, blockHit.block, blockHit.face, i, tick);

  d.lastHit = target
    ? { kind: 'entity', id: target.typeId, dist: round1(dist) }
    : blockHit
      ? { kind: 'block', id: safeType(blockHit.block), face: blockHit.face, dist: round1(dist) }
      : { kind: 'none', dist: round1(dist) };

  // ---- heat gauge
  d.fireproofUntil = tick + FIREWALK_AFTER;
  d.gauge = Math.min(GAUGE_MAX, d.gauge + T.heatPerTick[i] * GAUGE_SCALE);
  if (d.gauge >= GAUGE_MAX) overheat(p, d, tick);
}

function safeType(b) {
  try {
    return b.typeId;
  } catch {
    return 'unknown';
  }
}

/** One damage pulse on a creature: pooled until its hurt window has passed (see HURT_WINDOW). */
function burn(p, d, e, amount, fireSeconds, tick) {
  let h = d.hitTicks.get(e.id);
  if (!h) d.hitTicks.set(e.id, (h = { owed: 0, last: -1000, seen: tick }));
  if (h.seen === tick && h.owed > 0) return; // already pulsed this tick (direct + splash)
  // a creature that left the beam for a while starts a fresh pool
  if (tick - h.seen > DAMAGE_INTERVAL * 3) h.owed = 0;
  h.seen = tick;
  h.owed = Math.min(h.owed + amount, amount * 6);
  if (fireSeconds > 0) setOnFire(e, fireSeconds);
  if (tick - h.last < HURT_WINDOW) return;
  const before = healthOf(e);
  const dealt = h.owed;
  damage(e, dealt, p, EntityDamageCause.fire);
  h.owed = 0;
  h.last = tick;
  d.stats.hits++;
  d.lastDamage = { id: e.typeId, amount: round1(dealt), before, after: healthOf(e), tick };
}

// ------------------------------------------------------------------ abilities
function focus(p, d) {
  d.defaultIntensity = (d.defaultIntensity % MAX_INTENSITY) + 1;
  const n = d.defaultIntensity;
  fx.soundTo(p, 'sp.heat.focus', 0.7 + 0.12 * n, 0.9);
  hint(p, `§c${GLYPH.heat} Focus ${bar(n / MAX_INTENSITY, '§c', MAX_INTENSITY)} §f§l${n}§r §7${INTENSITY_NAMES[n]}`, false);
}

function drawBlast(dim, fxs) {
  for (const o of fxs.origins) drawBeam(dim, o, fxs.end, BLAST_WIDTH, BLAST_COLOR, BLAST_CORE);
}

/** Whether a vanilla explosion here would hurt someone the PvP / pet rules protect. */
function blastNeedsCare(p, dim, at) {
  const r = T.burstRadius * 2 + 1;
  if (!pvpAllowed()) {
    try {
      for (const other of dim.getPlayers({ location: at, maxDistance: r })) {
        if (other.id !== p.id && isVulnerablePlayer(other)) return true;
      }
    } catch {
      /* ignore */
    }
  }
  try {
    for (const e of dim.getEntities({ location: at, maxDistance: r, excludeTypes: ['minecraft:item', 'minecraft:player'] })) {
      const tame = e.getComponent('minecraft:tameable');
      if (tame?.isTamed && tame.tamedToPlayerId === p.id) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Scripted explosion that only hurts creatures canAffect() allows (PvP off / own pets nearby). */
function carefulBlast(p, dim, at) {
  if (griefingAllowed()) breakSphere(dim, at, T.burstRadius * 0.75, 2, { limit: 60 });
  const reach = T.burstRadius * 1.6;
  for (const e of creaturesNear(dim, at, reach, p)) {
    const f = 1 - V.dist(e.location, at) / reach;
    if (f <= 0) continue;
    damage(e, T.burstDamage * 0.6 * f, p, EntityDamageCause.entityExplosion);
    if (isValid(e)) {
      knockFrom(e, at, 0.4 + 0.8 * f, 0.35 + 0.3 * f);
      setOnFire(e, 3);
    }
  }
}

function scorchBlast(p, d, tick) {
  if (overheated(d, tick)) {
    hint(p, `§4${GLYPH.heat} Overheated! §7Cooling down: ${((d.overheatedUntil - tick) / 20).toFixed(1)}s`);
    return false;
  }
  const dim = p.dimension;
  const eye = eyes(p);
  const dir = p.getViewDirection();
  const blockHit = castBlock(dim, eye, dir, BLAST_RANGE);
  let dist = blockHit ? blockHit.dist : BLAST_RANGE;
  const creatureHit = castCreature(p, dist);
  const target = creatureHit?.entity;
  if (creatureHit) dist = Math.min(dist, creatureHit.distance);
  const end = V.addScaled(eye, dir, dist);
  const at = V.addScaled(end, dir, -0.3);

  d.blastFx = { origins: eyeOrigins(p, eye, dir), end, left: BLAST_FX_TICKS - 1 };
  drawBlast(dim, d.blastFx);
  fx.particle(dim, 'sp:glow', eye, { color: BLAST_COLOR, size: 0.6 });
  fx.pose(p, ANIM_BEAM); // brief stare pose, released by tick()
  d.blastPoseUntil = tick + BLAST_POSE_TICKS;

  if (V.dist(p.location, at) <= BLAST_SELF_GUARD || V.dist(eye, at) <= BLAST_SELF_GUARD) tempFlag(p, d, 'blastproof', BLAST_PROOF_TICKS);
  d.fireproofUntil = Math.max(d.fireproofUntil, tick + FIREWALK_AFTER);

  const before = target ? healthOf(target) : -1;
  if (target && isValid(target)) {
    damage(target, T.burstDamage, p, EntityDamageCause.fire);
    if (isValid(target)) setOnFire(target, 6);
  }
  const grief = griefingAllowed();
  let vanilla = false;
  const care = blastNeedsCare(p, dim, at);
  if (!care) {
    const opts = { breaksBlocks: grief, causesFire: grief, source: p };
    try {
      vanilla = dim.createExplosion(at, T.burstRadius, opts);
    } catch {
      // measured: simulated players are rejected as `source`; the player is blastproof anyway
      delete opts.source;
      try {
        vanilla = dim.createExplosion(at, T.burstRadius, opts);
      } catch {
        vanilla = false;
      }
    }
  }
  if (!vanilla) carefulBlast(p, dim, at);
  fx.particle(dim, 'sp:explosion_flash', at, { size: 3 });
  fx.particle(dim, 'sp:fireball', at, { size: 0.9 });
  fx.particle(dim, 'sp:spark', at, { color: BLAST_COLOR });
  fx.sound(dim, 'sp.heat.burst', at, 0.95 + Math.random() * 0.1, 1.4);
  fx.sound(dim, 'sp.heat.burst', eye, 1.2, 0.6);
  fx.flashLight(dim, V.addScaled(at, dir, -0.8), 15, 6);
  fx.shakeArea(dim, at, 24, 0.6, 0.45);

  d.lastBlast = {
    tick,
    dist: round1(dist),
    at: { x: round1(at.x), y: round1(at.y), z: round1(at.z) },
    target: target ? target.typeId : null,
    targetBefore: before,
    targetAfter: target ? healthOf(target) : -1,
    vanilla,
    care,
  };
  d.gauge = Math.min(GAUGE_MAX, d.gauge + BLAST_GAUGE);
  if (d.gauge >= GAUGE_MAX) overheat(p, d, tick);
  return undefined;
}

// ------------------------------------------------------------------ cleanup
function cleanup(p, r, mode) {
  const d = r.data[ID];
  if (!d) return;
  if (mode === 'leave') d.firing = false;
  else {
    stopFiring(p, d, true);
    fx.stopPose(p);
  }
  d.heat.clear();
  d.hitTicks.clear();
  d.blastFx = null;
  d.blastPoseUntil = 0;
  if (mode === 'death' || mode === 'lose') {
    d.gauge = 0;
    d.overheatedUntil = 0;
    d.fireproofUntil = 0;
  }
  if (mode === 'lose') clearOwnTempFlags(r, d);
}

// ------------------------------------------------------------------ registration
definePower(ID, {
  onGain(p, r) {
    state(r);
  },
  onLose(p, r) {
    cleanup(p, r, 'lose');
  },
  onDeath(p, r) {
    cleanup(p, r, 'death');
  },
  onDimensionChange(p, r) {
    cleanup(p, r, 'dimension');
  },
  onLeave(p, r) {
    cleanup(p, r, 'leave');
  },

  tick(p, r, tick) {
    const d = r.data[ID];
    if (!d) return;
    if (d.blastFx) {
      if (d.blastFx.left > 0) {
        drawBlast(p.dimension, d.blastFx);
        d.blastFx.left--;
      } else d.blastFx = null;
    }
    if (d.firing && !isHolding(p, ID, BEAM)) stopFiring(p, d);
    if (d.blastPoseUntil && tick >= d.blastPoseUntil) {
      d.blastPoseUntil = 0;
      if (!d.firing) fx.stopPose(p);
    }
    if (d.firing) beamTick(p, d, tick);
    else if (d.gauge > 0) d.gauge = Math.max(0, d.gauge - T.coolPerTick);
    if (d.overheatedUntil && d.overheatedUntil <= tick) d.overheatedUntil = 0;
    if (tick % 20 === 0 && d.heat.size) pruneHeat(d, tick);
  },

  activate(p, r, abilityId) {
    const d = state(r);
    if (abilityId === 'focus') return focus(p, d);
    if (abilityId === 'scorch_blast') return scorchBlast(p, d, system.currentTick);
    return false;
  },

  holdStart(p, r, abilityId) {
    if (abilityId !== BEAM) return false;
    const d = state(r);
    const tick = system.currentTick;
    if (overheated(d, tick)) {
      hint(p, `§4${GLYPH.heat} Overheated! §7Your eyes are cooling down: ${((d.overheatedUntil - tick) / 20).toFixed(1)}s`);
      return false;
    }
    startFiring(p, d, tick);
    return true;
  },

  holdEnd(p, r, abilityId) {
    if (abilityId !== BEAM) return;
    const d = r.data[ID];
    if (d) stopFiring(p, d);
  },

  onButton(p, r, button, pressed) {
    const d = r.data[ID];
    if (!d || !d.firing || !pressed) return;
    if (button === 'Jump') setIntensity(p, d, d.intensity + 1);
    else if (button === 'Sneak') setIntensity(p, d, d.intensity - 1);
  },

  hud(p, r) {
    const d = r.data[ID];
    if (!d) return undefined;
    const tick = system.currentTick;
    if (overheated(d, tick)) return `§cHeat ${bar(d.gauge / GAUGE_MAX, '§4')} §4OVERHEATED ${((d.overheatedUntil - tick) / 20).toFixed(1)}s`;
    if (!d.firing && d.gauge <= 0) return undefined;
    return `§cHeat ${bar(d.gauge / GAUGE_MAX, '§c')} §fIntensity ${d.firing ? d.intensity : d.defaultIntensity}`;
  },

  flags(p, r) {
    const d = r.data[ID];
    return { firewalk: !!d && (d.firing || d.fireproofUntil > system.currentTick) };
  },

  debug(p, r) {
    const d = r.data[ID];
    if (!d) return { firing: false, intensity: START_INTENSITY, defaultIntensity: START_INTENSITY, gauge: 0, overheated: false };
    const tick = system.currentTick;
    return {
      firing: d.firing,
      intensity: d.intensity,
      defaultIntensity: d.defaultIntensity,
      gauge: round1(d.gauge),
      overheated: overheated(d, tick),
      overheatLeft: Math.max(0, d.overheatedUntil - tick),
      heatBlocks: d.heat.size,
      pose: r.input.poses?.heat ?? null,
      stats: { ...d.stats },
      lastHit: d.lastHit,
      lastDamage: d.lastDamage,
      lastBlast: d.lastBlast,
    };
  },
});

