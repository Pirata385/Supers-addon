// Meteor Call world system: a telegraphed meteor that streaks in from the sky, explodes on
// impact, flings burning debris and leaves meteorite ore in its crater. Meteors are world state:
// they keep falling even if the caster leaves, dies or loses the power.
import { world, system, EntityDamageCause } from '@minecraft/server';
import { ENTITIES, BLOCKS, POWERS, TUNING, IMMUNITY_TAGS } from '../config.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import { creaturesNear, damage, knockFrom, isValid } from '../core/entities.js';
import { getBlockSafe, tierOf, blockColor, transformBlock } from '../core/blocks.js';
import { griefingAllowed, pvpAllowed, hasRuntime, rt } from '../core/state.js';
import { grantTemporaryFlag } from '../core/powers.js';
import { onTick } from '../core/loop.js';
import { spawnDebris, throwDebris } from './debris.js';

const T = TUNING.esper;
const PSI = POWERS.esper.rgb;
const RED = { red: 1, green: 0.25, blue: 0.08 };
const FIRE = { red: 1, green: 0.55, blue: 0.15 };
const METEORITE_COLOR = { red: 0.35, green: 0.18, blue: 0.3 };

// Local tuning (no entries in config.TUNING.esper).
const MARKER_RADIUS = 6;
const MARKER_EVERY = 10;
const FALL_BACK = 30; // horizontal offset of the spawn point behind the caster's aim
const FALL_HEIGHT = 70;
const FALL_STEP = 2.6; // blocks per tick
const FALL_MAX_TICKS = 120; // safety: impact anyway after this many ticks of flight
const METEOR_SIZE = 3;
const DAMAGE_RADIUS = 8;
const CASTER_SAFE_RADIUS = 20;
const CASTER_BLASTPROOF_TICKS = 20;
const DEBRIS_MIN = 6;
const DEBRIS_MAX = 10;
const DEBRIS_DAMAGE = 4;
const METEORITES_MAX = 3;
const MAX_ACTIVE = 16; // world-wide cap

/**
 * @typedef {Object} Meteor
 * @property {'warn'|'fall'} phase
 * @property {import('@minecraft/server').Dimension} dim
 * @property {V.Vec3} target          impact point
 * @property {V.Vec3} fwd             caster's horizontal forward at cast time
 * @property {string} casterId
 * @property {import('@minecraft/server').Entity|undefined} caster
 * @property {number} start            tick of the call
 * @property {number} fallAt           tick the meteor appears
 * @property {import('@minecraft/server').Entity} [entity]
 * @property {V.Vec3} [pos]
 * @property {V.Vec3} [dir]
 * @property {number} [fallStart]
 * @property {any} [impact]
 */

/** @type {Meteor[]} */
const meteors = [];

import { rayBlockPoint } from '../core/blocks.js';

export { rayBlockPoint };

/** Number of meteors (warning or falling) called by a player. */
export function meteorCount(casterId) {
  let n = 0;
  for (const m of meteors) if (!casterId || m.casterId === casterId) n++;
  return n;
}

/**
 * Call a meteor onto `target`. Returns false when the world-wide cap is reached.
 * @param {import('@minecraft/server').Player} caster
 * @param {V.Vec3} target
 */
export function callMeteor(caster, target, delay = T.meteorDelay) {
  if (meteors.length >= MAX_ACTIVE) return false;
  let fwd = { x: 0, y: 0, z: 1 };
  try {
    const h = V.hnorm(caster.getViewDirection());
    if (V.lenSq(h) > 1e-4) fwd = h;
  } catch {
    /* ignore */
  }
  const tick = system.currentTick;
  const m = {
    phase: /** @type {'warn'} */ ('warn'),
    dim: caster.dimension,
    target: { x: target.x, y: target.y, z: target.z },
    fwd,
    casterId: caster.id,
    caster,
    start: tick,
    fallAt: tick + Math.max(1, delay),
  };
  meteors.push(m);
  marker(m);
  fx.sound(m.dim, 'sp.esper.meteor_call', caster.location, 0.9, 1.2);
  fx.sound(m.dim, 'sp.esper.meteor_call', m.target, 0.8, 3);
  return true;
}

function marker(m) {
  const at = { x: m.target.x, y: m.target.y + 0.1, z: m.target.z };
  fx.particle(m.dim, 'sp:meteor_marker', at, { radius: MARKER_RADIUS });
  fx.particle(m.dim, 'sp:psi_aura', V.add(at, { x: 0, y: 1, z: 0 }), { color: RED });
}

function casterOf(m) {
  return m.caster && isValid(m.caster) ? m.caster : undefined;
}

/** Spawn the meteor entity high above, behind the caster's line of sight. */
function beginFall(m) {
  const dim = m.dim;
  let maxY = 300;
  try {
    maxY = dim.heightRange.max - 2;
  } catch {
    /* ignore */
  }
  let start = {
    x: m.target.x - m.fwd.x * FALL_BACK,
    y: Math.min(m.target.y + FALL_HEIGHT, maxY),
    z: m.target.z - m.fwd.z * FALL_BACK,
  };
  if (start.y < m.target.y + 8) start.y = m.target.y + 8;
  const dir = V.norm(V.sub(m.target, start));
  // the sky above the target may be outside loaded chunks: try closer points along the path
  let e;
  for (const f of [0, 0.35, 0.6, 0.8]) {
    const at = V.lerpV(start, m.target, f);
    try {
      e = dim.spawnEntity(ENTITIES.meteor, at);
      start = at;
      break;
    } catch {
      e = undefined;
    }
  }
  if (!e) {
    impact(m, m.target);
    return false;
  }
  try {
    e.setProperty('sp:size', METEOR_SIZE);
  } catch {
    /* ignore */
  }
  try {
    e.teleport(start, { facingLocation: m.target });
  } catch {
    /* ignore */
  }
  m.phase = 'fall';
  m.entity = e;
  m.pos = start;
  m.dir = dir;
  m.fallStart = system.currentTick;
  fx.sound(dim, 'sp.esper.meteor_fall', start, 0.9, 4);
  fx.sound(dim, 'sp.esper.meteor_fall', m.target, 0.9, 4);
  return true;
}

/** Advance a falling meteor. Returns false once it has hit something. */
function fallStep(m, tick) {
  const dim = m.dim;
  if (!isValid(m.entity)) {
    // removed externally (e.g. /kill): still deliver the impact where it was heading
    impact(m, m.target);
    return false;
  }
  const remaining = V.dist(m.pos, m.target);
  const step = Math.min(FALL_STEP, remaining);
  let hitPoint;
  try {
    const hit = dim.getBlockFromRay(m.pos, m.dir, { maxDistance: step + 1, includeLiquidBlocks: true, includePassableBlocks: false });
    if (hit) hitPoint = rayBlockPoint(m.pos, m.dir, hit.block.location);
  } catch {
    hitPoint = undefined;
  }
  if (!hitPoint && remaining <= FALL_STEP) hitPoint = m.target;
  if (!hitPoint && tick - (m.fallStart ?? tick) > FALL_MAX_TICKS) hitPoint = m.pos;
  if (hitPoint) {
    impact(m, hitPoint);
    return false;
  }
  const next = V.addScaled(m.pos, m.dir, step);
  m.pos = next;
  try {
    m.entity.teleport(next, { facingLocation: V.addScaled(next, m.dir, 4) });
  } catch {
    /* ignore */
  }
  const center = V.add(next, { x: 0, y: METEOR_SIZE * 0.5, z: 0 });
  fx.particle(dim, 'sp:meteor_trail', center, { size: METEOR_SIZE });
  if (tick % 3 === 0) fx.particle(dim, 'sp:fireball', V.addScaled(center, m.dir, -2), { size: 1.2 });
  if (tick % 2 === 0) fx.flashLight(dim, center, 15, 3);
  if (tick % 4 === 0) marker(m);
  return true;
}

/** Block types around the impact, sampled before the explosion: used for the debris look. */
function sampleGround(dim, at) {
  const out = [];
  for (const [dx, dy, dz] of [[0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1], [0, -2, 0], [2, -1, 1], [-1, -1, -2]]) {
    const b = getBlockSafe(dim, { x: at.x + dx, y: at.y + dy, z: at.z + dz });
    if (!b || b.isAir || b.isLiquid) continue;
    const t = tierOf(b);
    if (t === 0 || t >= 4) continue;
    out.push({ id: b.typeId, color: blockColor(b) });
  }
  return out;
}

/**
 * The vanilla explosion hurts every player in range: when PvP is off, other players are made
 * blast-proof for a moment (powered players through their immunity flags, others by tag).
 */
function shieldBystanders(dim, point, casterId) {
  if (pvpAllowed()) return;
  let players = [];
  try {
    players = dim.getPlayers({ location: point, maxDistance: T.meteorPower * 2 + 4 });
  } catch {
    players = [];
  }
  const tag = IMMUNITY_TAGS.blastproof;
  for (const pl of players) {
    if (pl.id === casterId) continue;
    try {
      if (hasRuntime(pl.id) && rt(pl).powers.length) {
        grantTemporaryFlag(pl, 'blastproof', 10);
      } else if (!pl.hasTag(tag)) {
        pl.addTag(tag);
        system.runTimeout(() => {
          try {
            if (pl.isValid && !(hasRuntime(pl.id) && rt(pl).powers.length)) pl.removeTag(tag);
          } catch {
            /* ignore */
          }
        }, 10);
      }
    } catch {
      /* ignore */
    }
  }
}

function impact(m, point) {
  const dim = m.dim;
  const caster = casterOf(m);
  const grief = griefingAllowed();
  try {
    if (isValid(m.entity)) m.entity.remove();
  } catch {
    /* ignore */
  }
  m.entity = undefined;
  // nothing to hit in an unloaded area (the caster flew away): the meteor burns up
  if (!getBlockSafe(dim, point)) return;
  shieldBystanders(dim, point, m.casterId);
  if (caster) {
    let near = false;
    try {
      near = caster.dimension.id === dim.id && V.dist(caster.location, point) <= CASTER_SAFE_RADIUS;
    } catch {
      near = false;
    }
    if (near) grantTemporaryFlag(caster, 'blastproof', CASTER_BLASTPROOF_TICKS);
  }
  const ground = sampleGround(dim, point);
  const center = V.add(point, { x: 0, y: 0.5, z: 0 });

  // direct damage + knockback first, so the explosion does not shield or pre-kill the numbers
  let hits = 0;
  for (const e of creaturesNear(dim, center, DAMAGE_RADIUS, caster)) {
    let d;
    try {
      d = V.dist(e.location, center);
    } catch {
      continue;
    }
    const f = 1 - V.clamp(d / DAMAGE_RADIUS, 0, 1);
    damage(e, T.meteorDamage * (0.25 + 0.75 * f), caster, EntityDamageCause.entityExplosion);
    knockFrom(e, center, 0.8 + 2.4 * f, 0.6 + 0.9 * f);
    hits++;
  }
  try {
    dim.createExplosion(point, T.meteorPower, { breaksBlocks: grief, causesFire: grief, source: caster });
  } catch {
    try {
      dim.createExplosion(point, T.meteorPower, { breaksBlocks: grief, causesFire: grief });
    } catch {
      /* unloaded */
    }
  }

  // effects
  fx.particle(dim, 'sp:explosion_flash', center, { size: 8 });
  fx.particle(dim, 'sp:fireball', point, { size: 3 });
  fx.particle(dim, 'sp:shockwave', { x: point.x, y: point.y + 0.2, z: point.z }, { radius: 16, color: FIRE });
  fx.particle(dim, 'sp:shockwave_air', center, { radius: 10, color: PSI });
  fx.particle(dim, 'sp:smoke', center);
  fx.particle(dim, 'sp:debris_chunks', center, { color: ground[0]?.color ?? METEORITE_COLOR, size: 2 });
  fx.sound(dim, 'sp.esper.meteor_impact', point, 0.9 + Math.random() * 0.15, 6);
  fx.flashLight(dim, V.add(point, { x: 0, y: 2, z: 0 }), 15, 10);
  fx.shakeArea(dim, point, 64, 1.5, 1.2);

  // fling burning chunks outward
  const n = V.randInt(DEBRIS_MIN, DEBRIS_MAX);
  const owner = caster;
  for (let i = 0; i < n; i++) {
    const g = ground.length && Math.random() < 0.65 ? ground[Math.floor(Math.random() * ground.length)] : null;
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const out = { x: Math.cos(a), y: 0, z: Math.sin(a) };
    const at = V.add(center, { x: out.x * 1.2, y: 1 + Math.random(), z: out.z * 1.2 });
    const e = spawnDebris(dim, at, {
      blockId: g ? g.id : BLOCKS.meteorite,
      size: V.rand(0.6, 1),
      owner,
      color: g ? g.color : METEORITE_COLOR,
      ttl: 200,
    });
    if (!e) continue;
    const h = V.rand(0.6, 1.3);
    throwDebris(e, { x: out.x * h, y: V.rand(0.6, 1.1), z: out.z * h }, { owner, damage: DEBRIS_DAMAGE, radius: 1.2, breakTier: 0 });
  }

  if (grief) system.runTimeout(() => placeMeteorites(dim, point), 2);
  m.impact = { tick: system.currentTick, hits, point: { x: point.x, y: point.y, z: point.z } };
  lastImpacts.set(m.casterId, m.impact);
}

/** @type {Map<string, any>} last impact per caster (debug / tests) */
const lastImpacts = new Map();

export function lastMeteorImpact(casterId) {
  return lastImpacts.get(casterId) ?? null;
}

/** Leave 1-3 meteorite blocks on the crater floor (only into air or soft blocks). */
function placeMeteorites(dim, point) {
  if (!griefingAllowed()) return;
  const count = V.randInt(1, METEORITES_MAX);
  const offsets = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]];
  let placed = 0;
  for (const [ox, oz] of offsets) {
    if (placed >= count) break;
    const col = { x: point.x + ox, z: point.z + oz };
    // walk down from just above the impact to the first solid block: the crater floor
    for (let y = Math.floor(point.y) + 2; y >= Math.floor(point.y) - 10; y--) {
      const b = getBlockSafe(dim, { x: col.x, y, z: col.z });
      if (!b) break;
      // air, water and the temporary light of the impact flash are not the floor
      if (b.isAir || b.isLiquid || b.typeId.startsWith('minecraft:light_block')) continue;
      const t = tierOf(b);
      if (t === 1 || b.typeId.endsWith('fire')) {
        // burning debris / plants lying on the floor are replaced
        if (transformBlock(b, BLOCKS.meteorite)) placed++;
        break;
      }
      const above = getBlockSafe(dim, { x: col.x, y: y + 1, z: col.z });
      if (above && above.isAir && transformBlock(above, BLOCKS.meteorite)) placed++;
      else if (t === 2 && transformBlock(b, BLOCKS.meteorite)) placed++;
      break;
    }
  }
}

function tickMeteors(tick) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    let alive = true;
    try {
      if (m.phase === 'warn') {
        if (tick >= m.fallAt) alive = beginFall(m);
        else if ((tick - m.start) % MARKER_EVERY === 0) marker(m);
      } else {
        alive = fallStep(m, tick);
      }
    } catch (e) {
      console.warn(`[SP] meteor: ${e}`);
      try {
        if (isValid(m.entity)) m.entity.remove();
      } catch {
        /* ignore */
      }
      alive = false;
    }
    if (!alive) meteors.splice(i, 1);
  }
}

onTick('meteor', tickMeteors);

// Meteor entities that outlived their script state (world reload) are removed.
world.afterEvents.entityLoad.subscribe((ev) => {
  const e = ev.entity;
  try {
    if (e.typeId !== ENTITIES.meteor) return;
  } catch {
    return;
  }
  try {
    if (meteors.some((m) => m.entity && m.entity.id === e.id)) return;
  } catch {
    return;
  }
  system.run(() => {
    try {
      if (isValid(e)) e.remove();
    } catch {
      /* ignore */
    }
  });
});
