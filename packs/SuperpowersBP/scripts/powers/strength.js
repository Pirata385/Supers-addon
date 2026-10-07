// Super Strength: titanic punches, charged leaps that crater the ground on landing, boulders torn
// out of the earth and hurled, a supersonic shoulder charge and a concussive thunderclap.
// Built only from velocity control, safe block edits, particles, sounds and player animations.
import { system, EntityDamageCause } from '@minecraft/server';
import { POWERS, TUNING } from '../config.js';
import { definePower, grantTemporaryFlag, startCooldown, cooldownLeft, abilityDef } from '../core/powers.js';
import { rt, griefingAllowed } from '../core/state.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import {
  canAffect, creaturesNear, creatureInSight, damage, setVelocity, knockFrom, launch, lockMotion, unlockMotion, trackThrown,
  isValid, isProjectile, eyes,
} from '../core/entities.js';
import { withOwner } from '../core/context.js';
import { getBlockSafe, tierOf, breakBlock, breakSphere, blockColor, transformBlock, isPassable, rayBlockPoint } from '../core/blocks.js';
import { spawnDebris, holdDebris, throwDebris, removeDebris } from '../features/debris.js';
import { bar } from '../core/hud.js';
import { buttonDown } from '../core/input.js';

const ID = 'strength';
const T = TUNING.strength;
const COLOR = POWERS.strength.rgb;
const WHITE = { red: 1, green: 0.97, blue: 0.9 };
const PUNCH_DUST = { red: 0.85, green: 0.8, blue: 0.7 };

const ANIM = {
  charge: 'animation.sp.strength.charge',
  leap: 'animation.sp.strength.leap',
  lift: 'animation.sp.strength.lift',
  throw: 'animation.sp.strength.throw',
  clap: 'animation.sp.strength.clap',
  dash: 'animation.sp.strength.dash',
};

// Local tuning (values that have no entry in config.TUNING.strength).
const PUNCH_TARGET_COOLDOWN = 8; // ticks before the same target can be super-punched again
const PUNCH_THROWN = { damagePerSpeed: 4, ticks: 40 };
const MIN_CHARGE_TICKS = 4; // releasing the charge earlier than this does nothing
const SNEAK_LAUNCH_MIN = 0.15; // minimum charge for the crouch + jump shortcut
const GROUND_GRACE = 2; // ticks after leaving the ground that still count as "on the ground"
const LAND_MIN_AIR_TICKS = 5;
const NOFALL_LAUNCH = 40;
const NOFALL_REFRESH = 30;
const NOFALL_AFTER_LANDING = 20;
const LEAP_TIMEOUT = 600;
// config jumpMaxVertical 3.6 measures a ~54 block apex on BDS 26.3; the design target for a full
// charge is 30-40 blocks, so the launch speed is capped (2.85 -> ~36 blocks).
const JUMP_MAX_VERTICAL = Math.min(T.jumpMaxVertical, 2.85);

const LEAP_MOTION_LOCK = 8; // ticks other powers' velocity control is held off after take-off
const LANDING_BREAK_RADIUS_MAX = 7;
const CRATER_CHARGE = 0.8;
const RIP_RANGE = 6;
const RIP_MAX_BLOCKS = 9;
const RIP_COOLDOWN = 8;
const LIFT_TICKS = 6;
const BOULDER_AIM_RANGE = 64;
const DASH_HIT_RADIUS = 1.8;
const DASH_KNOCK = 2.2;
const DASH_STUCK_SPEED = 0.3;
const DASH_EXTRA_IMMUNITY = 40;
const DASH_FOV = 100;
const CLAP_DELAY = 4;
const CLAP_RAY_RINGS = [[0, 1], [0.34, 8], [0.67, 13], [1, 18]]; // [fraction of half angle, ray count] = 40 rays
const CLAP_MAX_BLOCKS = 80;
const CLAP_RINGS = [2, 5, 8, 11]; // sonic boom ring distances, one per wave step
const CLAP_WAVE_STEPS = CLAP_RINGS.length;

const EDGES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CORNERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const UP = V.UP;

/**
 * Transient per-player state (r.data.strength).
 * @typedef {Object} StrengthState
 * @property {{source:'hold'|'sneak', start:number}|null} [charging]
 * @property {number} [charge]
 * @property {number} [sneakSince]
 * @property {number} [lastGround]
 * @property {{charge:number, start:number, air:number}|null} [leap]
 * @property {boolean} [airGuard]   nofall until the next landing (after a leap / airborne dash)
 * @property {any} [boulder]
 * @property {any} [dash]
 * @property {any} [wave]
 * @property {number} [clapTimer]
 * @property {string|null} [pose]
 * @property {Map<string, number>} [punched]
 * @property {Record<string, number>} [temp]  expiry ticks of temporary immunity flags this power granted
 * @property {any} [lastLanding]
 * @property {any} [lastDash]
 * @property {any} [lastClap]
 * @property {any} [lastRip]
 * @property {any} [lastPunch]
 */

/** @returns {StrengthState} */
function state(r) {
  let d = r.data[ID];
  if (!d) d = r.data[ID] = {};
  return d;
}

// ------------------------------------------------------------------ helpers
function hint(p, msg) {
  try {
    p.onScreenDisplay.setActionBar(msg);
    rt(p).input.hudHoldUntil = system.currentTick + 30;
  } catch {
    /* ignore */
  }
  fx.soundTo(p, 'sp.ui.deny', 1, 0.6);
}

function tempFlag(p, d, flag, ticks) {
  grantTemporaryFlag(p, flag, ticks);
  d.temp ??= {};
  d.temp[flag] = Math.max(d.temp[flag] ?? 0, system.currentTick + ticks);
}

/** Remove temporary immunity flags this power granted (keeps longer ones granted by other powers). */
function clearOwnTempFlags(r, d) {
  const tf = r.input.tempFlags;
  if (!tf || !d.temp) return;
  for (const k in d.temp) if (tf[k] !== undefined && tf[k] <= d.temp[k]) delete tf[k];
  d.temp = {};
}

function grounded(p, d, tick) {
  try {
    if (p.isOnGround) return true;
  } catch {
    return false;
  }
  return d.lastGround !== undefined && tick - d.lastGround <= GROUND_GRACE;
}

function isSneaking(p, r) {
  const o = r.input.sneakOverride;
  if (o !== undefined) return o;
  if (buttonDown(p, 'Sneak')) return true;
  if (r.input.buttonOverride?.Sneak !== undefined) return false;
  try {
    return p.isSneaking;
  } catch {
    return false;
  }
}

function velocityOf(e) {
  try {
    return e.getVelocity();
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function groundBlockUnder(dim, loc) {
  return getBlockSafe(dim, { x: loc.x, y: loc.y - 0.5, z: loc.z });
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Keep the looping body pose in sync with the current state (only plays on change). */
function syncPose(p, d) {
  const want = d.dash ? ANIM.dash : d.charging ? ANIM.charge : d.boulder ? ANIM.lift : null;
  if (want === (d.pose ?? null)) return;
  if (want) fx.pose(p, want);
  else if (d.pose) fx.stopPose(p, d.pose);
  d.pose = want;
}

// ------------------------------------------------------------------ passive: super punch
function superPunch(p, d, target, tick) {
  const dim = p.dimension;
  const look = p.getViewDirection();
  let dir = V.hnorm(V.sub(target.location, p.location));
  if (V.lenSq(dir) < 1e-4) dir = V.hnorm(look);
  // lean towards the aim so a punch sends the target roughly where the player looks
  const aimed = V.hnorm(V.add(dir, V.hnorm(look)));
  if (V.lenSq(aimed) > 1e-4) dir = aimed;
  const before = healthOf(target);
  damage(target, T.punchBonusDamage, p, EntityDamageCause.entityAttack);
  const hitAt = V.lerpV(eyes(p), V.add(target.location, { x: 0, y: 0.9, z: 0 }), 0.7);
  if (isValid(target)) {
    launch(target, { x: dir.x * T.punchKnockback, y: T.punchLift, z: dir.z * T.punchKnockback });
    trackThrown(target, p, { ...PUNCH_THROWN, initialSpeed: T.punchKnockback });
  }
  fx.particle(dim, 'sp:shockwave_air', hitAt, { radius: 1.5, color: COLOR });
  fx.particle(dim, 'sp:dust', hitAt, { color: PUNCH_DUST });
  fx.sound(dim, 'sp.strength.punch', hitAt, 0.9 + Math.random() * 0.2, 1);
  fx.shake(p, 0.12, 0.15);
  d.lastPunch = { tick, target: target.typeId, before, after: healthOf(target) };
}

function healthOf(e) {
  try {
    return e.getComponent('minecraft:health')?.currentValue ?? -1;
  } catch {
    return -1;
  }
}

// ------------------------------------------------------------------ charged jump
function chargeOf(d, tick) {
  if (!d.charging) return 0;
  return V.clamp((tick - d.charging.start) / T.jumpChargeTicks, 0, 1);
}

function beginCharge(p, d, source, tick) {
  d.charging = { source, start: tick };
  d.charge = 0;
  fx.sound(p.dimension, 'sp.strength.charge', p.location, 0.8, 0.8);
  syncPose(p, d);
}

function cancelCharge(p, d) {
  if (!d.charging) return;
  d.charging = null;
  d.charge = 0;
  syncPose(p, d);
}

function chargeTick(p, d, tick) {
  const held = tick - d.charging.start;
  const c = (d.charge = chargeOf(d, tick));
  const dim = p.dimension;
  const feet = p.location;
  if (tick % 2 === 0) fx.particle(dim, 'sp:charge_aura', { x: feet.x, y: feet.y + 0.15, z: feet.z }, { color: COLOR });
  if (held > 0 && held % 10 === 0) {
    if (c > 0.5) fx.particle(dim, 'sp:crack', { x: feet.x, y: feet.y + 0.03, z: feet.z }, { size: 0.8 + c * 1.4 });
    // rising rumble; once fully charged it only pulses every second
    if (c < 1 || held % 20 === 0) fx.sound(dim, 'sp.strength.charge', feet, 0.8 + 0.6 * c, 0.6 + 0.4 * c);
  }
  if (held === T.jumpChargeTicks) {
    fx.particle(dim, 'sp:shockwave', { x: feet.x, y: feet.y + 0.1, z: feet.z }, { radius: 1.5, color: COLOR });
    fx.soundTo(p, 'sp.ui.select', 1.5, 0.5);
  }
}

function launchLeap(p, d, charge, tick) {
  const dim = p.dimension;
  const feet = p.location;
  const h = V.hnorm(p.getViewDirection());
  const vy = V.lerp(T.jumpMinVertical, JUMP_MAX_VERTICAL, charge);
  const fwd = T.jumpForward * charge;
  setVelocity(p, { x: h.x * fwd, y: vy, z: h.z * fwd });
  lockMotion(p, LEAP_MOTION_LOCK);
  d.leap = { charge, start: tick, air: 0 };
  d.airGuard = true;
  tempFlag(p, d, 'nofall', NOFALL_LAUNCH);
  fx.anim(p, ANIM.leap);
  const col = blockColor(groundBlockUnder(dim, feet));
  const at = { x: feet.x, y: feet.y + 0.1, z: feet.z };
  fx.particle(dim, 'sp:shockwave', at, { radius: 1.5 + 2.5 * charge, color: COLOR });
  fx.particle(dim, 'sp:dust', at, { color: col });
  fx.particle(dim, 'sp:debris_chunks', at, { color: col, size: 0.5 + 0.7 * charge });
  fx.sound(dim, 'sp.strength.leap', feet, 1.15 - 0.3 * charge, 0.8 + 0.6 * charge);
  fx.shake(p, 0.1 + 0.3 * charge, 0.25);
}

function leapTick(p, d, tick, onGround) {
  const L = d.leap;
  if (!onGround) {
    L.air++;
    if (tick % 10 === 0) tempFlag(p, d, 'nofall', NOFALL_REFRESH);
    if (tick % 3 === 0 && L.charge > 0.3) {
      const v = velocityOf(p);
      const s = V.len(v);
      if (s > 0.9) fx.particle(p.dimension, 'sp:wind_streak', V.add(p.location, { x: 0, y: 1, z: 0 }), { dir: V.norm(v), len: Math.min(3, s) });
    }
  } else if (L.air >= LAND_MIN_AIR_TICKS) {
    land(p, d, L.charge, tick);
    return;
  } else if (tick - L.start > 6) {
    // never really left the ground (low ceiling...)
    d.leap = null;
    d.airGuard = false;
    tempFlag(p, d, 'nofall', NOFALL_AFTER_LANDING);
    return;
  }
  let wet = false;
  try {
    wet = p.isInWater;
  } catch {
    /* ignore */
  }
  // splashdown / endless fall: stop tracking the leap, airGuard keeps nofall until the ground
  if (wet || tick - L.start > LEAP_TIMEOUT) d.leap = null;
}

function airGuardTick(p, d, tick, onGround) {
  let wet = false;
  try {
    wet = p.isInWater;
  } catch {
    /* ignore */
  }
  if (onGround || wet) {
    d.airGuard = false;
    tempFlag(p, d, 'nofall', NOFALL_AFTER_LANDING);
  } else if (tick % 10 === 0) {
    tempFlag(p, d, 'nofall', NOFALL_REFRESH);
  }
}

/** Ground impact after a leap, scaled by the charge. */
function land(p, d, charge, tick) {
  d.leap = null;
  d.airGuard = false;
  tempFlag(p, d, 'nofall', NOFALL_AFTER_LANDING);
  const dim = p.dimension;
  const feet = p.location;
  const radius = T.landingRadius * (0.6 + charge);
  const col = blockColor(groundBlockUnder(dim, feet));
  const at = { x: feet.x, y: feet.y + 0.1, z: feet.z };
  fx.particle(dim, 'sp:shockwave', at, { radius, color: COLOR });
  fx.particle(dim, 'sp:debris_chunks', at, { color: col, size: 0.8 + charge });
  fx.particle(dim, 'sp:crack', { x: feet.x, y: feet.y + 0.03, z: feet.z }, { size: 1.5 + 2.5 * charge });
  fx.particle(dim, 'sp:dust', at, { color: col });
  fx.ring(dim, 'sp:dust', at, radius * 0.6, 6, { color: col });
  fx.sound(dim, 'sp.strength.land', feet, 1.15 - 0.35 * charge, 1 + charge);
  fx.shake(p, 0.25 + 0.5 * charge, 0.45);
  fx.shakeArea(dim, feet, 16 + 16 * charge, 0.3 + 0.5 * charge, 0.5);

  let hits = 0;
  for (const e of creaturesNear(dim, feet, radius, p)) {
    const f = 1 - V.clamp(V.dist(e.location, feet) / radius, 0, 1);
    damage(e, T.landingDamage * (0.5 + charge) * (0.4 + 0.6 * f), p);
    knockFrom(e, feet, 0.5 + 1.4 * charge * (0.4 + 0.6 * f), 0.45 + 0.45 * f);
    hits++;
  }

  let broken = 0;
  if (griefingAllowed()) {
    // fragile blocks (plants, snow, glass, ice...) at ground level shatter
    const rr = Math.min(radius, LANDING_BREAK_RADIUS_MAX);
    const R = Math.ceil(rr);
    const fy = Math.floor(feet.y + 0.01);
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (dx * dx + dz * dz > rr * rr) continue;
        for (let dy = 0; dy >= -1; dy--) {
          const b = getBlockSafe(dim, { x: feet.x + dx, y: fy + dy, z: feet.z + dz });
          if (b && !b.isAir && tierOf(b) === 1 && breakBlock(b, { maxTier: 1, effects: Math.random() < 0.3 })) broken++;
        }
      }
    }
    if (charge > CRATER_CHARGE) broken += breakSphere(dim, { x: feet.x, y: feet.y - 1, z: feet.z }, 2, 2, { limit: 40, dropChance: 0.1 });
  }
  d.lastLanding = { tick, charge: round2(charge), radius: round2(radius), hits, broken, y: round2(feet.y) };
}

// ------------------------------------------------------------------ ground destruction
function rippable(b) {
  const t = tierOf(b);
  return t >= 1 && t <= 3;
}

/** Target block + neighbours (3x3 top layer, then part of the layer below), at most RIP_MAX_BLOCKS. */
function gatherCluster(dim, target) {
  const out = [target];
  const base = target.location;
  const seen = new Set([V.key(base)]);
  const add = (dx, dy, dz) => {
    if (out.length >= RIP_MAX_BLOCKS) return;
    const loc = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
    const k = V.key(loc);
    if (seen.has(k)) return;
    seen.add(k);
    const b = getBlockSafe(dim, loc);
    if (b && rippable(b)) out.push(b);
  };
  for (const [dx, dz] of EDGES) add(dx, 0, dz);
  for (const [dx, dz] of CORNERS) if (Math.random() < 0.5) add(dx, 0, dz);
  add(0, -1, 0);
  const lower = [...EDGES].sort(() => Math.random() - 0.5);
  for (const [dx, dz] of lower) add(dx, -1, dz);
  return out;
}

function ripBoulder(p, d, tick) {
  const dim = p.dimension;
  let target;
  try {
    target = p.getBlockFromViewDirection({ maxDistance: RIP_RANGE, includeLiquidBlocks: false, includePassableBlocks: false })?.block;
  } catch {
    target = undefined;
  }
  if (!target || target.isAir || target.isLiquid) target = groundBlockUnder(dim, p.location);
  if (!target || target.isAir || target.isLiquid) {
    hint(p, '§7Nothing solid to tear out of the ground here.');
    return false;
  }
  if (!rippable(target)) {
    hint(p, '§7That is too tough to tear out.');
    return false;
  }
  const grief = griefingAllowed();
  const cluster = gatherCluster(dim, target);
  // dominant block type decides the boulder texture
  const counts = new Map();
  for (const b of cluster) counts.set(b.typeId, (counts.get(b.typeId) ?? 0) + 1);
  let blockId = target.typeId;
  let best = 0;
  for (const [id, n] of counts) {
    if (n > best) {
      best = n;
      blockId = id;
    }
  }
  if (!grief) blockId = target.typeId;
  const colorBlock = cluster.find((b) => b.typeId === blockId) ?? target;
  const color = blockColor(colorBlock);
  const size = V.clamp(0.9 + 0.12 * cluster.length, 1, 2.2);
  const tl = target.location;
  const from = { x: tl.x + 0.5, y: tl.y, z: tl.z + 0.5 };
  const e = spawnDebris(dim, from, { blockId, permutation: undefined, size, owner: p, color, ttl: T.boulderMaxHoldTicks + 400 });
  if (!e) {
    hint(p, '§7The ground refuses to budge.');
    return false;
  }
  let removed = 0;
  if (grief) for (const b of cluster) if (breakBlock(b, { maxTier: 3, effects: true })) removed++;

  const B = { entity: e, since: tick, from, until: tick + T.boulderMaxHoldTicks, color, size };
  d.boulder = B;
  holdDebris(e, () => boulderAnchor(p, d, B));
  const hole = V.add(from, { x: 0, y: 0.5, z: 0 });
  fx.particle(dim, 'sp:debris_chunks', hole, { color, size });
  fx.particle(dim, 'sp:dust', hole, { color });
  fx.sound(dim, 'sp.debris.rip', hole, 1, 1.2);
  fx.sound(dim, 'sp.impact.heavy', hole, 0.6, 1);
  fx.shake(p, 0.2, 0.3);
  syncPose(p, d);
  d.lastRip = { tick, removed, size: round2(size), blockId, at: { x: tl.x, y: tl.y, z: tl.z } };
  return RIP_COOLDOWN;
}

/** Hold point of the boulder: rises from the hole to above the player's head over LIFT_TICKS. */
function boulderAnchor(p, d, B) {
  if (d.boulder !== B || !isValid(p)) return undefined;
  try {
    const look = p.getViewDirection();
    const top = V.add(V.addScaled(eyes(p), look, 0.4), { x: 0, y: 1.4, z: 0 });
    const t = V.clamp((system.currentTick - B.since) / LIFT_TICKS, 0, 1);
    const k = 1 - (1 - t) * (1 - t);
    return V.lerpV(B.from, top, k);
  } catch {
    return undefined;
  }
}

/** Point the player aims at: creature in sight, block hit, or far along the view ray. */
function aimPoint(p) {
  const eye = eyes(p);
  const look = p.getViewDirection();
  const mob = creatureInSight(p, BOULDER_AIM_RANGE);
  if (mob) {
    try {
      return V.add(mob.location, { x: 0, y: 0.8, z: 0 });
    } catch {
      /* ignore */
    }
  }
  try {
    const hit = p.getBlockFromViewDirection({ maxDistance: BOULDER_AIM_RANGE, includeLiquidBlocks: true, includePassableBlocks: false });
    if (hit) return rayBlockPoint(eye, look, hit.block.location);
  } catch {
    /* ignore */
  }
  return V.addScaled(eye, look, BOULDER_AIM_RANGE * 0.6);
}

function throwBoulder(p, d, tick) {
  const B = d.boulder;
  d.boulder = null;
  if (!B || !isValid(B.entity)) {
    syncPose(p, d);
    return false;
  }
  const e = B.entity;
  let pos = B.from;
  try {
    pos = e.location;
  } catch {
    /* ignore */
  }
  const center = V.add(pos, { x: 0, y: 0.45 * B.size, z: 0 });
  // fly from the boulder towards what the player aims at (the boulder floats above the eye line)
  let dir = V.norm(V.sub(aimPoint(p), center));
  const look = p.getViewDirection();
  if (V.lenSq(dir) < 1e-4 || V.dot(dir, look) < 0.2) dir = look;
  const pv = velocityOf(p);
  const v = V.add(V.scale(dir, T.boulderSpeed), { x: pv.x * 0.5, y: 0.15 + Math.max(0, pv.y) * 0.5, z: pv.z * 0.5 });
  throwDebris(e, v, { owner: p, damage: T.boulderDamage, radius: T.boulderRadius, breakTier: griefingAllowed() ? 2 : 0 });
  fx.anim(p, ANIM.throw);
  syncPose(p, d);
  fx.sound(p.dimension, 'sp.strength.throw', p.location, 0.9, 1.2);
  fx.particle(p.dimension, 'sp:shockwave_air', center, { radius: 1.5, color: COLOR });
  fx.shake(p, 0.15, 0.2);
  d.lastRip = { ...(d.lastRip ?? {}), thrownTick: tick, speed: round2(V.len(v)) };
  return true;
}

/** Let go of the boulder: 'drop' releases it with ~0 velocity, 'remove' deletes it (player gone). */
function releaseBoulder(p, d, mode) {
  const B = d.boulder;
  d.boulder = null;
  if (!B || !isValid(B.entity)) return;
  const e = B.entity;
  if (mode === 'remove' || !p) {
    try {
      fx.particle(e.dimension, 'sp:dust', e.location, { color: B.color });
    } catch {
      /* ignore */
    }
    removeDebris(e);
    return;
  }
  let nudge = { x: 0, y: -0.05, z: 0 };
  try {
    const h = V.hnorm(p.getViewDirection());
    nudge = { x: h.x * 0.2, y: -0.05, z: h.z * 0.2 };
  } catch {
    /* ignore */
  }
  throwDebris(e, nudge, { owner: p, damage: 0, radius: 0, breakTier: 0 });
}

function boulderTick(p, d, tick) {
  const B = d.boulder;
  if (!isValid(B.entity)) {
    d.boulder = null;
    return;
  }
  if (tick >= B.until) {
    releaseBoulder(p, d, 'drop');
    hint(p, '§7The boulder slipped from your grip.');
  }
}

// ------------------------------------------------------------------ supersonic charge
function startDash(p, d, tick) {
  if (d.dash) return false;
  const look = p.getViewDirection();
  let airborne = false;
  try {
    airborne = !p.isOnGround;
  } catch {
    /* ignore */
  }
  let dir;
  let fly = false;
  if (airborne && Math.abs(look.y) > 0.5) {
    dir = V.norm(look);
    fly = true;
  } else {
    dir = V.hnorm(look);
    if (V.lenSq(dir) < 1e-4) dir = V.hnorm(V.dirFromRotation({ x: 0, y: p.getRotation().y }));
  }
  cancelCharge(p, d);
  d.leap = null;
  const loc = p.location;
  d.dash = {
    dir, fly, start: tick, until: tick + T.chargeTicks,
    last: { x: loc.x, y: loc.y, z: loc.z }, from: { x: loc.x, y: loc.y, z: loc.z },
    hit: new Set(), hits: 0, broken: 0,
  };
  const imm = T.chargeTicks + DASH_EXTRA_IMMUNITY;
  tempFlag(p, d, 'nofall', imm);
  tempFlag(p, d, 'nokinetic', imm);
  const dim = p.dimension;
  const chest = V.add(loc, { x: 0, y: 1, z: 0 });
  fx.particle(dim, 'sp:sonic_boom', V.addScaled(chest, dir, 0.6), { dir });
  fx.particle(dim, 'sp:shockwave_air', chest, { radius: 2.5, color: WHITE });
  fx.sound(dim, 'sp.strength.dash', loc, 1, 1.3);
  fx.sound(dim, 'sp.flight.boom', loc, 1.1, 1.2);
  fx.fov(p, DASH_FOV, 0.2);
  fx.shake(p, 0.2, 0.25);
  syncPose(p, d);
  lockMotion(p, T.chargeTicks + 3);
  dashStep(p, d, tick, true);
  return true;
}

/** Break fragile / soft blocks in front of the body (3 wide x 2 tall, 1-2 blocks ahead). */
function plowAhead(dim, loc, D) {
  if (!griefingAllowed()) return;
  const dir = D.dir;
  const right = V.rightOf(dir);
  let broken = 0;
  for (let f = 1; f <= 2; f++) {
    for (let s = -1; s <= 1; s++) {
      for (let h = 0; h <= 1; h++) {
        const pos = {
          x: loc.x + dir.x * f + right.x * s,
          y: loc.y + 0.5 + h + dir.y * f,
          z: loc.z + dir.z * f + right.z * s,
        };
        const b = getBlockSafe(dim, pos);
        if (!b || b.isAir || b.isLiquid) continue;
        if (tierOf(b) <= 2 && breakBlock(b, { maxTier: 2, effects: Math.random() < 0.5 })) broken++;
      }
    }
  }
  if (broken) {
    D.broken += broken;
    fx.sound(dim, 'sp.impact.light', V.addScaled(loc, dir, 1.5), 0.8 + Math.random() * 0.3, 0.9);
  }
}

/** A single hard block at foot level ahead with free space above: hop up instead of crashing. */
function needsStepUp(dim, loc, dir) {
  const ahead = { x: loc.x + dir.x * 0.9, y: loc.y + 0.5, z: loc.z + dir.z * 0.9 };
  const b = getBlockSafe(dim, ahead);
  if (!b || isPassable(b)) return false;
  const a1 = getBlockSafe(dim, V.add(ahead, UP));
  const a2 = getBlockSafe(dim, V.add(ahead, { x: 0, y: 2, z: 0 }));
  return !!a1 && isPassable(a1) && !!a2 && isPassable(a2);
}

function dashStep(p, d, tick, first = false) {
  const D = d.dash;
  const dim = p.dimension;
  const loc = p.location;
  if (!first) {
    const moved = D.fly ? V.dist(loc, D.last) : V.hlen(V.sub(loc, D.last));
    if (tick - D.start >= 3 && moved < DASH_STUCK_SPEED) {
      endDash(p, d, tick, true);
      return;
    }
    if (tick >= D.until) {
      endDash(p, d, tick, false);
      return;
    }
  }
  D.last = { x: loc.x, y: loc.y, z: loc.z };
  const dir = D.dir;
  plowAhead(dim, loc, D);

  // creatures ahead / along the path
  const center = { x: loc.x, y: loc.y + 0.9, z: loc.z };
  for (const e of creaturesNear(dim, V.addScaled(center, dir, 0.9), DASH_HIT_RADIUS + 0.9, p)) {
    if (D.hit.has(e.id)) continue;
    const ec = V.add(e.location, { x: 0, y: 0.9, z: 0 });
    if (V.dot(V.sub(ec, center), dir) < -0.5) continue; // already behind us
    D.hit.add(e.id);
    D.hits++;
    damage(e, T.chargeDamage, p);
    launch(e, { x: dir.x * DASH_KNOCK, y: dir.y * DASH_KNOCK + 0.6, z: dir.z * DASH_KNOCK });
    trackThrown(e, p, { damagePerSpeed: 4, ticks: 40, initialSpeed: DASH_KNOCK });
    const at = V.lerpV(center, ec, 0.5);
    fx.particle(dim, 'sp:shockwave_air', at, { radius: 2, color: COLOR });
    fx.sound(dim, 'sp.impact.heavy', at, 0.9, 1.2);
    fx.shake(p, 0.25, 0.2);
  }

  let onGround = false;
  try {
    onGround = p.isOnGround;
  } catch {
    /* ignore */
  }
  let vy;
  if (D.fly) vy = dir.y * T.chargeSpeed;
  else if (onGround) vy = needsStepUp(dim, loc, dir) ? 0.5 : 0;
  else vy = Math.max(-1.5, Math.min(velocityOf(p).y, 0.3) - 0.05);
  setVelocity(p, { x: dir.x * T.chargeSpeed, y: vy, z: dir.z * T.chargeSpeed });

  fx.particle(dim, 'sp:wind_streak', center, { dir, len: 3 });
  if ((tick - D.start) % 3 === 0) fx.particle(dim, 'sp:cloud_puff', V.addScaled(center, dir, -1));
  if (onGround) fx.particle(dim, 'sp:dust', { x: loc.x, y: loc.y + 0.1, z: loc.z }, { color: blockColor(groundBlockUnder(dim, loc)) });
}

function endDash(p, d, tick, crashed) {
  const D = d.dash;
  if (!D) return;
  d.dash = null;
  fx.resetFov(p, 0.35);
  const dim = p.dimension;
  const loc = p.location;
  let onGround = false;
  try {
    onGround = p.isOnGround;
  } catch {
    /* ignore */
  }
  if (crashed) {
    const wallPos = V.addScaled({ x: loc.x, y: loc.y + 0.5, z: loc.z }, D.dir, 1);
    const col = blockColor(getBlockSafe(dim, wallPos));
    const at = V.addScaled({ x: loc.x, y: loc.y + 1, z: loc.z }, D.dir, 0.8);
    fx.particle(dim, 'sp:debris_chunks', at, { color: col, size: 1 });
    fx.particle(dim, 'sp:dust', at, { color: col });
    fx.sound(dim, 'sp.impact.heavy', at, 0.75, 1.5);
    fx.shake(p, 0.5, 0.35);
    setVelocity(p, { x: -D.dir.x * 0.35, y: 0.25, z: -D.dir.z * 0.35 });
  } else {
    const vy = D.fly ? D.dir.y * 0.5 : onGround ? 0 : Math.min(0, velocityOf(p).y);
    setVelocity(p, { x: D.dir.x * 0.45, y: vy, z: D.dir.z * 0.45 });
  }
  unlockMotion(p);
  if (!onGround || D.fly) d.airGuard = true;
  const dist = D.fly ? V.dist(loc, D.from) : V.hlen(V.sub(loc, D.from));
  d.lastDash = { tick, distance: round2(dist), hits: D.hits, broken: D.broken, crashed };
  syncPose(p, d);
}

// ------------------------------------------------------------------ thunderclap
function startClap(p, d) {
  if (d.clapTimer !== undefined || d.wave) return false;
  fx.anim(p, ANIM.clap);
  fx.sound(p.dimension, 'sp.whoosh', p.location, 1.3, 0.6);
  d.clapTimer = system.runTimeout(() => {
    d.clapTimer = undefined;
    try {
      if (!isValid(p)) return;
      const r = rt(p);
      if (!r.powers.includes(ID) || r.data[ID] !== d) return;
      const hp = p.getComponent('minecraft:health');
      if (hp && hp.currentValue <= 0) return;
      withOwner(ID, () => fireClap(p, d, system.currentTick));
    } catch (e) {
      console.warn(`[SP] strength thunderclap: ${e}\n${e?.stack ?? ''}`);
    }
  }, CLAP_DELAY);
  return true;
}

function makeRays(look) {
  const right = Math.abs(look.y) > 0.98 ? { x: 1, y: 0, z: 0 } : V.norm(V.cross(look, UP));
  const up = V.cross(right, look);
  const half = ((T.clapAngle / 2) * Math.PI) / 180;
  const spin = Math.random() * Math.PI * 2;
  const rays = [];
  for (const [frac, n] of CLAP_RAY_RINGS) {
    const a = half * frac;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < n; i++) {
      const az = spin + frac + (i / n) * Math.PI * 2;
      const c = Math.cos(az) * sa, s = Math.sin(az) * sa;
      rays.push({
        d: { x: look.x * ca + right.x * c + up.x * s, y: look.y * ca + right.y * c + up.y * s, z: look.z * ca + right.z * c + up.z * s },
        blocked: false,
      });
    }
  }
  return rays;
}

function fireClap(p, d, tick) {
  const dim = p.dimension;
  const look = p.getViewDirection();
  const origin = V.add(eyes(p), look);
  const R = T.clapRange;
  const cosHalf = Math.cos(((T.clapAngle / 2) * Math.PI) / 180);
  fx.particle(dim, 'sp:shockwave_air', origin, { radius: 4, color: WHITE });
  fx.sound(dim, 'sp.strength.clap', origin, 1, 2);
  fx.shake(p, 0.45, 0.35);
  fx.shakeArea(dim, origin, 28, 0.35, 0.4);

  let hits = 0, reflected = 0;
  let list = [];
  try {
    list = dim.getEntities({ location: origin, maxDistance: R + 1 });
  } catch {
    list = [];
  }
  for (const e of list) {
    if (e.id === p.id) continue;
    let loc;
    try {
      loc = e.location;
    } catch {
      continue;
    }
    const proj = isProjectile(e);
    const c = proj ? loc : { x: loc.x, y: loc.y + 0.8, z: loc.z };
    const to = V.sub(c, origin);
    const dist = V.len(to);
    if (dist > R) continue;
    if (dist > 1.2 && V.dot(to, look) < cosHalf * dist) continue; // outside the cone
    if (proj) {
      const v = velocityOf(e);
      if (V.lenSq(v) > 0.01) {
        try {
          e.clearVelocity();
          e.applyImpulse(V.scale(v, -1.1));
          reflected++;
          fx.particle(dim, 'sp:shockwave_air', loc, { radius: 0.8, color: WHITE });
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    if (!canAffect(p, e)) continue;
    const f = dist / R;
    damage(e, T.clapDamage * (1 - 0.5 * f), p);
    let away = V.hnorm(V.sub(loc, p.location));
    if (V.lenSq(away) < 1e-4) away = V.hnorm(look);
    const h = T.clapKnockback * (1 - f) + 0.6;
    launch(e, { x: away.x * h, y: 0.6, z: away.z * h });
    trackThrown(e, p, { damagePerSpeed: 4, ticks: 40, initialSpeed: h });
    hits++;
  }
  const feet = p.location;
  d.wave = {
    dim, origin, look, tick, step: 0, broken: 0, extinguished: 0,
    feet: { x: feet.x, y: feet.y, z: feet.z }, rays: makeRays(look), cells: new Map(),
  };
  d.lastClap = { tick, hits, reflected, broken: 0, extinguished: 0 };
  waveStep(d, tick);
}

/** One block cell reached by the clap wave. Returns true if the wave passes through. */
function waveCell(dim, pos, W) {
  const b = getBlockSafe(dim, pos);
  if (!b) return false;
  if (b.isAir || b.isLiquid) return true;
  const id = b.typeId;
  if (id === 'minecraft:fire' || id === 'minecraft:soul_fire') {
    if (transformBlock(b, 'minecraft:air')) W.extinguished++;
    return true;
  }
  if (tierOf(b) === 1) {
    if (W.broken < CLAP_MAX_BLOCKS && breakBlock(b, { maxTier: 1, effects: Math.random() < 0.6 })) W.broken++;
    return true;
  }
  return false;
}

function groundDust(dim, W, dist) {
  const h = V.hnorm(W.look);
  if (V.lenSq(h) < 1e-4) return;
  const x = W.feet.x + h.x * (dist + 1), z = W.feet.z + h.z * (dist + 1);
  for (let dy = 0; dy >= -3; dy--) {
    const y = W.feet.y + dy - 0.5;
    const b = getBlockSafe(dim, { x, y, z });
    if (b && !b.isAir && !b.isLiquid) {
      fx.particle(dim, 'sp:dust', { x, y: Math.floor(y) + 1.05, z }, { color: blockColor(b) });
      return;
    }
  }
}

/** Advance the clap wave one step: blocks in the next distance band, a sonic ring, ground dust. */
function waveStep(d, tick) {
  const W = d.wave;
  W.tick = tick;
  const k = W.step++;
  const dim = W.dim;
  const R = T.clapRange;
  const i0 = Math.floor((k * R) / CLAP_WAVE_STEPS);
  const i1 = Math.floor(((k + 1) * R) / CLAP_WAVE_STEPS);
  for (const ray of W.rays) {
    for (let i = i0; i < i1 && !ray.blocked; i++) {
      const pos = V.addScaled(W.origin, ray.d, i + 0.5);
      const key = V.key(pos);
      let open = W.cells.get(key);
      if (open === undefined) {
        open = waveCell(dim, pos, W);
        W.cells.set(key, open);
      }
      if (!open) ray.blocked = true;
    }
  }
  const ringDist = CLAP_RINGS[k];
  fx.particle(dim, 'sp:sonic_boom', V.addScaled(W.origin, W.look, ringDist), { dir: W.look });
  groundDust(dim, W, ringDist);
  if (d.lastClap) {
    d.lastClap.broken = W.broken;
    d.lastClap.extinguished = W.extinguished;
  }
  if (W.step >= CLAP_WAVE_STEPS) d.wave = null;
}

// ------------------------------------------------------------------ sneak shortcut
function sneakTick(p, r, d, tick, onGround) {
  const sneaking = isSneaking(p, r);
  if (d.charging?.source === 'sneak') {
    if (!sneaking || !grounded(p, d, tick)) cancelCharge(p, d);
    return;
  }
  if (!sneaking || !onGround || d.charging || d.leap || d.dash || r.hold) {
    d.sneakSince = undefined;
    return;
  }
  if (d.sneakSince === undefined) {
    d.sneakSince = tick;
    return;
  }
  if (tick - d.sneakSince >= T.sneakChargeDelay && cooldownLeft(p, ID, 'charged_jump') === 0) beginCharge(p, d, 'sneak', tick);
}

// ------------------------------------------------------------------ lifecycle
/** mode: 'lose' | 'death' | 'dimension' | 'leave' */
function cleanup(p, r, mode) {
  const d = r.data[ID];
  if (!d) return;
  if (d.clapTimer !== undefined) {
    try {
      system.clearRun(d.clapTimer);
    } catch {
      /* ignore */
    }
    d.clapTimer = undefined;
  }
  d.wave = null;
  if (d.boulder) releaseBoulder(mode === 'leave' ? undefined : p, d, mode === 'leave' ? 'remove' : 'drop');
  const wasDashing = !!d.dash;
  d.charging = null;
  d.charge = 0;
  d.leap = null;
  d.dash = null;
  d.airGuard = false;
  d.sneakSince = undefined;
  d.punched?.clear();
  if (mode !== 'leave') {
    if (wasDashing) {
      fx.resetFov(p, 0.2);
      unlockMotion(p);
    }
    if (d.pose) fx.stopPose(p, d.pose);
  }
  d.pose = null;
  if (mode === 'lose') clearOwnTempFlags(r, d);
}

definePower(ID, {
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
    const d = state(r);
    const onGround = p.isOnGround;
    if (onGround) d.lastGround = tick;
    if (d.wave && tick > d.wave.tick) waveStep(d, tick);
    if (d.dash && tick > d.dash.start) dashStep(p, d, tick);
    if (d.leap) leapTick(p, d, tick, onGround);
    else if (d.airGuard && !d.dash) airGuardTick(p, d, tick, onGround);
    sneakTick(p, r, d, tick, onGround);
    if (d.charging) chargeTick(p, d, tick);
    if (d.boulder) boulderTick(p, d, tick);
    syncPose(p, d);
  },

  activate(p, r, abilityId) {
    const d = state(r);
    const tick = system.currentTick;
    switch (abilityId) {
      case 'ground_destruction':
        return d.boulder ? throwBoulder(p, d, tick) : ripBoulder(p, d, tick);
      case 'supersonic_charge':
        return startDash(p, d, tick);
      case 'thunderclap':
        return startClap(p, d);
      default:
        return false;
    }
  },

  holdStart(p, r, abilityId) {
    if (abilityId !== 'charged_jump') return false;
    const d = state(r);
    const tick = system.currentTick;
    if (d.dash || d.leap) return false;
    if (!grounded(p, d, tick)) {
      hint(p, '§6Charged Jump §7needs solid ground under your feet.');
      return false;
    }
    // a crouch charge in progress is taken over by the emblem hold
    if (d.charging) d.charging.source = 'hold';
    else beginCharge(p, d, 'hold', tick);
    return true;
  },

  holdEnd(p, r, abilityId, info) {
    if (abilityId !== 'charged_jump') return;
    const d = state(r);
    const tick = system.currentTick;
    if (!d.charging || d.charging.source !== 'hold') return;
    const charge = chargeOf(d, tick);
    cancelCharge(p, d);
    if (info.reason !== 'release' || info.duration < MIN_CHARGE_TICKS) {
      startCooldown(p, ID, abilityId, 4);
      return;
    }
    if (!grounded(p, d, tick)) {
      hint(p, '§7You need solid ground to leap from.');
      startCooldown(p, ID, abilityId, 4);
      return;
    }
    launchLeap(p, d, charge, tick);
  },

  onButton(p, r, button, pressed, tick) {
    const d = r.data[ID];
    if (!d) return;
    if (button === 'Jump' && pressed) {
      if (d.charging?.source !== 'sneak') return;
      const charge = chargeOf(d, tick);
      if (charge < SNEAK_LAUNCH_MIN || !grounded(p, d, tick)) return;
      cancelCharge(p, d);
      launchLeap(p, d, charge, tick);
      startCooldown(p, ID, 'charged_jump', abilityDef(ID, 'charged_jump')?.cooldown ?? 20);
    } else if (button === 'Sneak' && !pressed) {
      if (d.charging?.source === 'sneak') cancelCharge(p, d);
      d.sneakSince = undefined;
    }
  },

  onMelee(p, r, target) {
    if (!canAffect(p, target)) return;
    const d = state(r);
    const tick = system.currentTick;
    d.punched ??= new Map();
    const last = d.punched.get(target.id);
    if (last !== undefined && tick - last < PUNCH_TARGET_COOLDOWN) return;
    if (d.punched.size > 24) for (const [k, t] of d.punched) if (tick - t >= PUNCH_TARGET_COOLDOWN) d.punched.delete(k);
    d.punched.set(target.id, tick);
    superPunch(p, d, target, tick);
  },

  hud(p, r) {
    const d = r.data[ID];
    if (!d) return undefined;
    if (d.charging) {
      const c = d.charge ?? 0;
      const tip = d.charging.source === 'sneak' && c >= SNEAK_LAUNCH_MIN ? ' §7- Jump!' : '';
      return `§6Charge ${bar(c, '§6')} §f${Math.round(c * 100)}%${tip}`;
    }
    if (d.boulder) return '§6Boulder ready §7- Use to throw';
    return undefined;
  },

  flags(p, r) {
    const d = r.data[ID];
    return { tough: true, nofall: !!(d && (d.leap || d.airGuard)) };
  },

  debug(p, r) {
    const d = r.data[ID] ?? {};
    let boulderId = null;
    try {
      boulderId = d.boulder && isValid(d.boulder.entity) ? d.boulder.entity.id : null;
    } catch {
      boulderId = null;
    }
    return {
      charging: !!d.charging,
      chargeSource: d.charging?.source ?? null,
      charge: round2(d.charge ?? 0),
      holdingBoulder: !!d.boulder,
      boulderId,
      leaping: !!d.leap,
      dashing: !!d.dash,
      airGuard: !!d.airGuard,
      clapping: d.clapTimer !== undefined || !!d.wave,
      pose: d.pose ?? null,
      lastLanding: d.lastLanding ?? null,
      lastDash: d.lastDash ?? null,
      lastClap: d.lastClap ?? null,
      lastRip: d.lastRip ?? null,
      lastPunch: d.lastPunch ?? null,
    };
  },
});
