// Flight: superman-style free flight steered with the camera. Hold forward to ramp up from a
// cruise to supersonic speed (sonic boom, speed lines, FOV warp), smash through fragile blocks,
// ram creatures out of the way, kick in the afterburner, and grab creatures to carry or hurl them.
// Built only from per-tick velocity control, safe block edits, particles, sounds and animations.
import { system, GameMode } from '@minecraft/server';
import { POWERS, TUNING } from '../config.js';
import { definePower, tryActivate, cooldownLeft } from '../core/powers.js';
import { rt, griefingAllowed } from '../core/state.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import {
  creaturesNear, creatureInSight, damage, setVelocity, launch, lockMotion, unlockMotion, motionLocked,
  trackThrown, untrackThrown, isValid,
} from '../core/entities.js';
import { getBlockSafe, tierOf, breakBlock, blockColor, isPassable } from '../core/blocks.js';
import { moveInput, buttonDown } from '../core/input.js';
import { onTick } from '../core/loop.js';

const ID = 'flight';
const T = TUNING.flight;
const COLOR = POWERS.flight.rgb;
const WHITE = { red: 1, green: 1, blue: 1 };

const ANIM = {
  hover: 'animation.sp.flight.hover',
  cruise: 'animation.sp.flight.cruise',
  carry: 'animation.sp.flight.carry',
  throw: 'animation.sp.strength.throw', // shared one-shot throwing motion
};

// Local tuning (values without an entry in config.TUNING.flight).
const TOGGLE_COOLDOWN = 10;
const TAKEOFF_VY = 0.8; // initial upward speed, decays into a hover (~4.5 blocks of lift)
const TAKEOFF_DECAY = 0.82;
const AUTO_LAND_TICKS = 10; // on the ground without rising for longer than this: land
const AUTO_LAND_GRACE = 6; // ticks after take off before ground contact counts
const BOOST_TICKS = 40;
const BOOST_LOCK = 8; // ticks the afterburner reserves the player's motion against other powers
const BOOST_FOV = 110;
const BOOM_INTERVAL = 60;
const CRASH_SPEED = 2; // hitting a wall faster than this is a crash
const CRASH_RESIDUAL = 0.3;
const RAM_SPEED = 1.5;
const RAM_REHIT = 12; // ticks before the same creature can be rammed again
const RAM_RADIUS = 1.6; // distance from the flight path that still counts as "in the way"
const CARRY_AHEAD = 1.1;
const CARRY_DROP = -0.6;
const CARRY_MAX_DIST = 8; // carried entity left behind (blocked teleport...): let go
const HOVER_BOB = 0.02;
const GLIDE_DECAY = 0.9; // speed multiplier per tick with no input
const DRIFT_SPEED = 0.3; // gently released creatures sink at this speed (blocks/tick)
const DRIFT_TICKS = 300;
const WIND_INTERVAL = 20;

/** Creatures that are far too big (or too dangerous) to be carried. */
const NO_GRAB = new Set([
  'minecraft:ender_dragon', 'minecraft:wither', 'minecraft:warden', 'minecraft:elder_guardian',
  'minecraft:ghast', 'minecraft:happy_ghast', 'minecraft:ravager',
]);

/**
 * Transient per-player state (r.data.flight).
 * @typedef {Object} FlightState
 * @property {boolean} flying
 * @property {number} speed          scalar speed along `dir` (blocks/tick)
 * @property {number} prevSpeed
 * @property {V.Vec3} dir            unit direction of travel
 * @property {number} forwardTicks   consecutive ticks with forward input
 * @property {number} boostUntil     afterburner end tick
 * @property {number} lift           remaining take-off lift (blocks/tick)
 * @property {number} since          take-off tick
 * @property {number} groundTicks
 * @property {import('@minecraft/server').Entity|null} carried
 * @property {string|null} carriedId
 * @property {number} lastBoom
 * @property {number} lastWind
 * @property {number|string|null} fovKey  applied FOV bucket ('boost' while afterburning)
 * @property {string|null} pose
 * @property {V.Vec3|null} cmd       velocity commanded last tick
 * @property {V.Vec3|null} lastLoc   position when `cmd` was commanded
 * @property {Map<string, number>} rammed
 * @property {number} smashed        blocks smashed during this flight
 * @property {number} rams           creatures rammed during this flight
 * @property {any} lastCrash
 * @property {any} lastThrow
 * @property {any} [lastRam]
 */

/** @returns {FlightState} */
function fresh() {
  return {
    flying: false, speed: 0, prevSpeed: 0, dir: { x: 0, y: 0, z: 1 }, forwardTicks: 0, boostUntil: 0, lift: 0,
    since: 0, groundTicks: 0, carried: null, carriedId: null, lastBoom: -1000, lastWind: -1000, fovKey: null, pose: null,
    cmd: null, lastLoc: null, rammed: new Map(), smashed: 0, rams: 0, lastCrash: null, lastThrow: null,
  };
}

/** @returns {FlightState} */
function state(r) {
  let d = r.data[ID];
  if (!d) d = r.data[ID] = fresh();
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

function round2(v) {
  return Math.round(v * 100) / 100;
}

function velocityOf(e) {
  try {
    return e.getVelocity();
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function alive(e) {
  if (!isValid(e)) return false;
  try {
    const h = e.getComponent('minecraft:health');
    return !h || h.currentValue > 0;
  } catch {
    return false;
  }
}

function gameModeOf(p) {
  try {
    return p.getGameMode();
  } catch {
    return GameMode.Survival;
  }
}

/** Vanilla movement states that take over from our flight. */
function vanillaFlight(p) {
  try {
    return p.isFlying || p.isGliding;
  } catch {
    return false;
  }
}

function riding(p) {
  try {
    return !!p.getComponent('minecraft:riding');
  } catch {
    return false;
  }
}

function descending(p, r) {
  if (buttonDown(p, 'Sneak')) return true;
  if (r.input.buttonOverride?.Sneak !== undefined) return false;
  try {
    return p.isSneaking;
  } catch {
    return false;
  }
}

/** Horizontal forward direction from the body yaw (valid even when looking straight up/down). */
function yawForward(p) {
  try {
    return V.dirFromRotation({ x: 0, y: p.getRotation().y });
  } catch {
    return { x: 0, y: 0, z: 1 };
  }
}

function nameOf(e) {
  try {
    if (e.nameTag) return e.nameTag;
    if (e.typeId === 'minecraft:player') return e.name;
  } catch {
    /* ignore */
  }
  const id = e.typeId.includes(':') ? e.typeId.split(':')[1] : e.typeId;
  return id.replace(/_/g, ' ');
}

// ------------------------------------------------------------------ gently released creatures
/** Entities released mid-air: they sink slowly (teleport steps) instead of falling to their death. */
/** @type {Map<string, {entity: import('@minecraft/server').Entity, until: number}>} */
const drifting = new Map();
/** entity id -> carrier player id (an entity can only be carried by one flyer). */
/** @type {Map<string, string>} */
const carriedBy = new Map();

function startDrift(e) {
  if (!isValid(e)) return;
  drifting.set(e.id, { entity: e, until: system.currentTick + DRIFT_TICKS });
}

onTick('flight.drift', (tick) => {
  if (!drifting.size) return;
  for (const [id, it] of drifting) {
    const e = it.entity;
    if (!isValid(e) || tick > it.until || carriedBy.has(id)) {
      drifting.delete(id);
      continue;
    }
    let settled = true;
    let loc;
    try {
      settled = e.isOnGround || e.isInWater;
      loc = e.location;
    } catch {
      settled = true;
    }
    if (settled) {
      drifting.delete(id);
      continue;
    }
    let ok = false;
    try {
      ok = e.tryTeleport({ x: loc.x, y: loc.y - DRIFT_SPEED, z: loc.z }, { checkForBlocks: true, keepVelocity: false });
    } catch {
      ok = false;
    }
    if (!ok) drifting.delete(id); // the ground is less than a step below
    else if (tick % 4 === 0) fx.particle(e.dimension, 'sp:cloud_puff', loc);
  }
});

// ------------------------------------------------------------------ carrying
function releaseCarried(d, mode) {
  const e = d.carried;
  if (d.carriedId) carriedBy.delete(d.carriedId);
  d.carried = null;
  d.carriedId = null;
  if (!e || !isValid(e)) return undefined;
  if (mode === 'gentle') {
    try {
      e.clearVelocity();
    } catch {
      /* players reject clearVelocity: they sink with the drift */
    }
    startDrift(e);
  }
  return e;
}

/** Spot in front of / below the flyer where the carried creature hangs (one tick ahead). */
function carrySpot(p, d) {
  const loc = p.location;
  const look = p.getViewDirection();
  const ahead = d.cmd ?? { x: 0, y: 0, z: 0 };
  const base = { x: loc.x + ahead.x, y: loc.y + ahead.y, z: loc.z + ahead.z };
  const spot = { x: base.x + look.x * CARRY_AHEAD, y: base.y + look.y * CARRY_AHEAD + CARRY_DROP, z: base.z + look.z * CARRY_AHEAD };
  // never push it into a wall: fall back to the flyer's own (next / current) position
  const dim = p.dimension;
  for (const c of [spot, base]) {
    const b0 = getBlockSafe(dim, c);
    const b1 = getBlockSafe(dim, { x: c.x, y: c.y + 0.9, z: c.z });
    if ((!b0 || isPassable(b0)) && (!b1 || isPassable(b1))) return c;
  }
  return { x: loc.x, y: loc.y, z: loc.z };
}

function carryTick(p, d) {
  const e = d.carried;
  if (!alive(e)) {
    releaseCarried(d, 'drop');
    return;
  }
  let far = false;
  try {
    far = e.dimension.id !== p.dimension.id || V.dist(e.location, p.location) > CARRY_MAX_DIST;
  } catch {
    far = true;
  }
  if (far) {
    releaseCarried(d, 'gentle');
    return;
  }
  const spot = carrySpot(p, d);
  if (e.typeId === 'minecraft:player') {
    // a carried player keeps control of their camera; their own powers must not fight the grip
    try {
      e.teleport(spot, { keepVelocity: false });
    } catch {
      /* ignore */
    }
    lockMotion(e, 3, 'external');
    return;
  }
  let yaw = 0;
  try {
    yaw = p.getRotation().y;
  } catch {
    /* ignore */
  }
  try {
    e.teleport(spot, { keepVelocity: false, rotation: { x: 0, y: yaw } });
    e.clearVelocity();
  } catch {
    /* ignore */
  }
}

function grab(p, d) {
  if (!d.flying) {
    hint(p, '§bTake off first §7to grab a creature.');
    return false;
  }
  const target = creatureInSight(p, T.grabRange);
  if (!target) {
    hint(p, '§7Nothing to grab in front of you.');
    return false;
  }
  if (NO_GRAB.has(target.typeId)) {
    hint(p, '§7That creature is far too big to carry.');
    return false;
  }
  if (carriedBy.has(target.id)) {
    hint(p, '§7Someone else is already carrying that.');
    return false;
  }
  d.carried = target;
  d.carriedId = target.id;
  carriedBy.set(target.id, p.id);
  drifting.delete(target.id);
  untrackThrown(target.id);
  const dim = p.dimension;
  let at = p.location;
  try {
    at = V.add(target.location, { x: 0, y: 0.6, z: 0 });
  } catch {
    /* ignore */
  }
  fx.particle(dim, 'sp:shockwave_air', at, { radius: 1.2, color: COLOR });
  fx.sound(dim, 'sp.flight.grab', at, 1, 1);
  carryTick(p, d);
  syncPose(p, d, 0, system.currentTick);
  return TOGGLE_COOLDOWN;
}

function throwCarried(p, d, tick) {
  const e = releaseCarried(d, 'throw');
  if (!e || !alive(e)) return false;
  const look = p.getViewDirection();
  const pv = velocityOf(p);
  const v = {
    x: look.x * T.throwSpeed + pv.x * 0.5,
    y: look.y * T.throwSpeed + pv.y * 0.5 + 0.1,
    z: look.z * T.throwSpeed + pv.z * 0.5,
  };
  launch(e, v, 10);
  const speed = V.len(v);
  trackThrown(e, p, { damagePerSpeed: T.impactDamagePerSpeed, ticks: 100, initialSpeed: speed });
  const dim = p.dimension;
  let at = p.location;
  try {
    at = V.add(e.location, { x: 0, y: 0.5, z: 0 });
  } catch {
    /* ignore */
  }
  fx.particle(dim, 'sp:sonic_boom', at, { dir: V.norm(v) });
  fx.particle(dim, 'sp:wind_streak', at, { dir: V.norm(v), len: 3 });
  fx.sound(dim, 'sp.flight.throw', at, 1, 1.2);
  fx.anim(p, ANIM.throw);
  fx.shake(p, 0.15, 0.2);
  d.lastThrow = { tick, target: e.typeId, speed: round2(speed) };
  syncPose(p, d, 0, tick);
  return TOGGLE_COOLDOWN;
}

// ------------------------------------------------------------------ take off / land
/** @param {boolean} [kick] apply the upward take-off impulse (the afterburner sets its own velocity) */
function takeOff(p, d, tick, kick = true) {
  drifting.delete(p.id); // a player who was gently dropped by another flyer takes over
  d.flying = true;
  d.since = tick;
  d.speed = 0;
  d.prevSpeed = 0;
  d.forwardTicks = 0;
  d.boostUntil = 0;
  d.groundTicks = 0;
  d.smashed = 0;
  d.rams = 0;
  d.rammed.clear();
  d.dir = V.hnorm(p.getViewDirection());
  if (V.lenSq(d.dir) < 1e-4) d.dir = yawForward(p);
  // a quick upward kick that eases into the hover
  d.lift = kick ? TAKEOFF_VY * TAKEOFF_DECAY : 0;
  if (kick) {
    const cur = velocityOf(p);
    setVelocity(p, { x: cur.x * 0.5, y: TAKEOFF_VY, z: cur.z * 0.5 });
  }
  d.cmd = null;
  d.lastLoc = null;
  const dim = p.dimension;
  const feet = p.location;
  const at = { x: feet.x, y: feet.y + 0.1, z: feet.z };
  fx.particle(dim, 'sp:cloud_puff', at);
  fx.particle(dim, 'sp:shockwave', at, { radius: 3, color: WHITE });
  fx.sound(dim, 'sp.flight.takeoff', feet, 1, 1);
  syncPose(p, d, 0, tick);
}

/** reason: toggle | auto | vanilla | lose | death | dimension | leave */
function land(p, d, reason) {
  const wasFlying = d.flying;
  d.flying = false;
  d.speed = 0;
  d.prevSpeed = 0;
  d.lift = 0;
  d.forwardTicks = 0;
  d.boostUntil = 0;
  d.groundTicks = 0;
  d.cmd = null;
  d.lastLoc = null;
  releaseCarried(d, 'gentle');
  if (reason !== 'leave') {
    if (d.pose) fx.stopPose(p);
    if (d.fovKey !== null) fx.resetFov(p, 0.5);
    unlockMotion(p);
    if (wasFlying && (reason === 'toggle' || reason === 'auto' || reason === 'vanilla')) {
      fx.sound(p.dimension, 'sp.flight.land', p.location, 1, 0.9);
      if (reason === 'auto') fx.particle(p.dimension, 'sp:cloud_puff', p.location);
    }
  }
  d.pose = null;
  d.fovKey = null;
}

// ------------------------------------------------------------------ afterburner
function afterburner(p, d, tick) {
  if (!d.flying) takeOff(p, d, tick, false);
  const look = p.getViewDirection();
  let dir = V.norm(look);
  let onGround = false;
  try {
    onGround = p.isOnGround;
  } catch {
    /* ignore */
  }
  // from the ground, angle the burst slightly upwards so it does not plough along the floor
  if (onGround && dir.y < 0.12) dir = V.norm({ x: dir.x, y: 0.12, z: dir.z });
  d.dir = dir;
  d.speed = T.maxSpeed;
  d.prevSpeed = T.maxSpeed;
  d.boostUntil = tick + BOOST_TICKS;
  d.lift = 0;
  const v = V.scale(dir, T.maxSpeed);
  lockMotion(p, BOOST_LOCK);
  setVelocity(p, v);
  d.cmd = v;
  const loc = p.location;
  d.lastLoc = { x: loc.x, y: loc.y, z: loc.z };
  const dim = p.dimension;
  const chest = { x: loc.x, y: loc.y + 0.9, z: loc.z };
  d.lastBoom = tick;
  fx.particle(dim, 'sp:sonic_boom', V.addScaled(chest, dir, 0.8), { dir });
  fx.particle(dim, 'sp:shockwave_air', chest, { radius: 4, color: WHITE });
  fx.particle(dim, 'sp:cloud_puff', V.addScaled(chest, dir, -1));
  fx.sound(dim, 'sp.flight.boom', loc, 1, 1.5);
  fx.shake(p, 0.4, 0.35);
  fx.fov(p, BOOST_FOV, 0.2);
  d.fovKey = 'boost';
  syncPose(p, d, 0, tick);
}

// ------------------------------------------------------------------ flight control
function syncPose(p, d, forward, tick) {
  let want = null;
  if (d.flying) {
    const boosting = tick < d.boostUntil;
    if (d.speed > 1 && (forward > 0.3 || boosting)) want = ANIM.cruise;
    else if (d.carried) want = ANIM.carry;
    else want = ANIM.hover;
  }
  if (want === d.pose) return;
  if (want) fx.pose(p, want);
  else fx.stopPose(p);
  d.pose = want;
}

function updateFov(p, d, boosting) {
  let key = null;
  let value = 0;
  if (boosting) {
    key = 'boost';
    value = BOOST_FOV;
  } else if (d.speed > 1) {
    key = Math.round(d.speed * 2) / 2;
    value = 70 + key * 8;
  }
  if (key === d.fovKey) return;
  d.fovKey = key;
  if (key === null) fx.resetFov(p, 0.5);
  else fx.fov(p, value, 0.4);
}

/** First solid (non passable) block in front of the body along `dir`, if any. */
function wallAhead(dim, loc, dir) {
  for (const f of [0.7, 1.3]) {
    for (const h of [0.2, 1.0, 1.6]) {
      const b = getBlockSafe(dim, { x: loc.x + dir.x * f, y: loc.y + h + dir.y * f, z: loc.z + dir.z * f });
      if (b && !b.isAir && !b.isLiquid && !isPassable(b)) return b;
    }
  }
  return undefined;
}

function crash(p, d, dim, loc, dir, speed, wall, tick) {
  d.speed = CRASH_RESIDUAL;
  d.forwardTicks = 0;
  d.boostUntil = 0;
  // recoil away from the wall
  const back = V.norm({ x: -dir.x, y: 0.35, z: -dir.z });
  d.dir = V.lenSq(back) > 1e-4 ? back : { x: 0, y: 1, z: 0 };
  const col = blockColor(wall);
  const at = V.addScaled({ x: loc.x, y: loc.y + 0.9, z: loc.z }, dir, 0.8);
  fx.particle(dim, 'sp:debris_chunks', at, { color: col, size: 0.6 + speed * 0.2 });
  fx.particle(dim, 'sp:dust', at, { color: col });
  fx.particle(dim, 'sp:shockwave_air', at, { radius: 2 + speed * 0.5, color: WHITE });
  fx.sound(dim, 'sp.impact.heavy', at, 0.8, 1.4);
  fx.shake(p, 0.3 + speed * 0.12, 0.4);
  let wallId = 'unknown';
  try {
    wallId = wall.typeId;
  } catch {
    /* ignore */
  }
  d.lastCrash = { tick, speed: round2(speed), wall: wallId };
}

/** Break fragile (and at high speed soft) blocks in a 3x3 cross-section ahead of the body. */
function smashAhead(p, d, dim, loc, dir, speed, tick) {
  if (!griefingAllowed()) return;
  const maxTier = speed > T.smashSoftSpeed ? 2 : 1;
  let u = V.rightOf(dir);
  if (V.lenSq(u) < 1e-4) u = V.rightOf(yawForward(p));
  const w = V.norm(V.cross(u, dir));
  const cx = loc.x, cy = loc.y + 0.9, cz = loc.z;
  const steps = Math.ceil(speed);
  let broken = 0;
  for (let f = 1; f <= steps; f++) {
    for (let s = -1; s <= 1; s++) {
      for (let h = -1; h <= 1; h++) {
        const o = h * 0.8;
        const b = getBlockSafe(dim, {
          x: cx + dir.x * f + u.x * s + w.x * o,
          y: cy + dir.y * f + u.y * s + w.y * o,
          z: cz + dir.z * f + u.z * s + w.z * o,
        });
        if (!b || b.isAir || b.isLiquid) continue;
        if (tierOf(b) > maxTier) continue;
        if (breakBlock(b, { maxTier, effects: broken < 6 })) broken++;
      }
    }
  }
  if (broken) {
    d.smashed += broken;
    if (tick % 3 === 0 || broken > 3) fx.sound(dim, 'sp.impact.light', V.addScaled({ x: cx, y: cy, z: cz }, dir, 1.5), 0.8 + Math.random() * 0.3, 1);
  }
}

/** Ram creatures in the flight path. */
function ram(p, d, dim, loc, dir, speed, tick) {
  const center = { x: loc.x, y: loc.y + 0.9, z: loc.z };
  const mid = V.addScaled(center, dir, speed * 0.5);
  const carriedId = d.carriedId;
  for (const e of creaturesNear(dim, mid, speed * 0.5 + RAM_RADIUS + 0.6, p)) {
    if (e.id === carriedId) continue;
    const last = d.rammed.get(e.id);
    if (last !== undefined && tick - last < RAM_REHIT) continue;
    const ec = V.add(e.location, { x: 0, y: 0.6, z: 0 });
    const rel = V.sub(ec, center);
    const along = V.dot(rel, dir);
    if (along < -0.6 || along > speed + 1.2) continue;
    const perp = V.sub(rel, V.scale(dir, along));
    if (V.len(perp) > RAM_RADIUS) continue;
    if (d.rammed.size > 32) for (const [k, t] of d.rammed) if (tick - t >= RAM_REHIT) d.rammed.delete(k);
    d.rammed.set(e.id, tick);
    d.rams++;
    damage(e, 3 + speed * 2, p);
    // knock it to the side it is on (horizontal, perpendicular to the path); head-on: random side
    const dh = V.hnorm(dir);
    const k = perp.x * dh.x + perp.z * dh.z;
    const side = { x: perp.x - dh.x * k, y: 0, z: perp.z - dh.z * k };
    let aside = V.lenSq(side) > 0.01 ? V.hnorm(side) : V.scale(V.rightOf(dir), Math.random() < 0.5 ? 1 : -1);
    if (V.lenSq(aside) < 1e-4) aside = V.randomUnit();
    const kv = {
      x: aside.x * 1.2 + dir.x * speed * 0.35,
      y: 0.45 + Math.max(0, dir.y) * speed * 0.3,
      z: aside.z * 1.2 + dir.z * speed * 0.35,
    };
    launch(e, kv);
    d.lastRam = { tick, target: e.typeId, speed: round2(speed), knock: round2(V.len(kv)) };
    const at = V.lerpV(center, ec, 0.5);
    fx.particle(dim, 'sp:shockwave_air', at, { radius: 1.5 + speed * 0.3, color: WHITE });
    fx.sound(dim, 'sp.impact.heavy', at, 1.1, 1);
    fx.shake(p, 0.15, 0.15);
  }
}

function sonicBoom(d, dim, center, dir, tick) {
  d.lastBoom = tick;
  fx.particle(dim, 'sp:sonic_boom', V.addScaled(center, dir, 0.8), { dir });
  fx.particle(dim, 'sp:shockwave_air', center, { radius: 4, color: WHITE });
  fx.sound(dim, 'sp.flight.boom', center, 1, 1.5);
  fx.shakeArea(dim, center, 24, 0.35, 0.3);
}

function effectsTick(p, d, dim, loc, v, tick, boosting) {
  const speed = d.speed;
  const center = { x: loc.x, y: loc.y + 0.9, z: loc.z };
  const vlen = V.len(v);
  const vdir = vlen > 1e-3 ? V.scale(v, 1 / vlen) : d.dir;
  if (speed > 1 && tick % 2 === 0) fx.particle(dim, 'sp:wind_streak', center, { dir: vdir, len: Math.min(3, speed) });
  if (speed > 2.4 && tick % 5 === 0) fx.particle(dim, 'sp:cloud_puff', V.addScaled(center, vdir, -1.5));
  if (speed < 0.3 && tick % 12 === 0) fx.particle(dim, 'sp:wind_streak', { x: loc.x, y: loc.y + 0.1, z: loc.z }, { dir: { x: 0, y: -1, z: 0 }, len: 0.8 });
  if (speed > 0.35 && tick - d.lastWind >= WIND_INTERVAL) {
    d.lastWind = tick;
    fx.sound(dim, 'sp.flight.wind', loc, 0.7 + speed * 0.15, V.clamp(0.2 + speed * 0.22, 0.2, 1));
  }
  if (d.prevSpeed < T.boomSpeed && speed >= T.boomSpeed && tick - d.lastBoom >= BOOM_INTERVAL) sonicBoom(d, dim, center, vdir, tick);
  updateFov(p, d, boosting);
}

function controlTick(p, r, d, tick) {
  const dim = p.dimension;
  const loc = p.location;
  let onGround = false;
  try {
    onGround = p.isOnGround;
  } catch {
    /* ignore */
  }
  const mv = moveInput(p);
  const mx = V.clamp(mv.x ?? 0, -1, 1);
  const my = V.clamp(mv.y ?? 0, -1, 1);
  const up = buttonDown(p, 'Jump');
  const down = !up && descending(p, r);
  let boosting = tick < d.boostUntil;

  // auto-land after resting on the ground for a moment
  if (onGround && !up && !boosting && d.lift === 0 && tick - d.since > AUTO_LAND_GRACE) d.groundTicks++;
  else d.groundTicks = 0;
  if (d.groundTicks > AUTO_LAND_TICKS) {
    land(p, d, 'auto');
    return;
  }

  // another power holds our motion (dash, leap, knockback): follow it and keep its momentum
  if (motionLocked(p)) {
    const v = velocityOf(p);
    d.speed = Math.min(T.maxSpeed, V.len(v));
    if (d.speed > 0.05) d.dir = V.norm(v);
    d.prevSpeed = d.speed;
    d.lift = 0;
    d.cmd = null;
    d.lastLoc = null;
    syncPose(p, d, my, tick);
    return;
  }

  // crash detection: we commanded a fast move last tick but hardly moved
  if (d.cmd && d.lastLoc) {
    const cmdSpeed = V.len(d.cmd);
    if (cmdSpeed > CRASH_SPEED) {
      const moved = V.dist(loc, d.lastLoc);
      if (moved < cmdSpeed * 0.4) {
        const cdir = V.scale(d.cmd, 1 / cmdSpeed);
        const wall = wallAhead(dim, loc, cdir);
        if (wall) {
          crash(p, d, dim, loc, cdir, cmdSpeed, wall, tick);
          boosting = false; // the crash ends the afterburner
        }
      }
    }
  }

  // ---- desired direction from look + movement input
  const look = p.getViewDirection();
  const fwd = yawForward(p);
  const left = { x: fwd.z, y: 0, z: -fwd.x }; // -rightOf(forward)
  const inMag = Math.min(1, Math.hypot(mx, my));
  let desired = null;
  if (inMag > 0.05) desired = V.add(V.scale(look, my), V.scale(left, mx));
  else if (boosting) desired = look; // the afterburner steers with the camera
  const want = desired && V.lenSq(desired) > 1e-4 ? V.norm(desired) : null;

  // ---- speed
  if (my > 0.3) d.forwardTicks++;
  else d.forwardTicks = 0;
  const prev = d.speed;
  const braking = !!want && !boosting && V.dot(want, d.dir) < -0.2 && d.speed > T.cruiseSpeed;
  if (boosting) {
    d.speed = T.maxSpeed;
  } else if (braking) {
    d.speed = Math.max(T.cruiseSpeed * inMag, d.speed * 0.85 - 0.02);
  } else if (d.forwardTicks > T.rampDelayTicks) {
    d.speed = Math.min(T.maxSpeed, d.speed + T.accelPerTick * (1 + d.speed * 0.5));
  } else if (inMag > 0.05) {
    const target = T.cruiseSpeed * inMag;
    if (d.speed < target) d.speed = Math.min(target, d.speed + Math.max(0.05, (target - d.speed) * 0.3));
    else if (my <= 0.3) d.speed = Math.max(target, d.speed - Math.max(0.03, (d.speed - target) * 0.06));
    // holding forward never slows you down while the ramp kicks in
  } else {
    d.speed = d.speed > 0.03 ? Math.max(0, d.speed * GLIDE_DECAY - 0.01) : 0;
  }
  d.prevSpeed = prev;

  // ---- steering (a little inertia at high speed)
  if (want && !braking) {
    const steer = boosting ? 0.3 : V.clamp(0.55 - d.speed * 0.09, 0.22, 0.55);
    const blended = V.lerpV(d.dir, want, steer);
    // (nearly) opposite input at low speed: turn around at once instead of stalling
    d.dir = V.lenSq(blended) > 0.25 ? V.norm(blended) : want;
  }

  // ---- velocity
  const v = V.scale(d.dir, d.speed);
  if (d.lift > 0.02) {
    v.y += d.lift;
    d.lift *= TAKEOFF_DECAY;
  } else d.lift = 0;
  if (up) v.y += T.verticalSpeed;
  else if (down) v.y -= T.verticalSpeed;
  else if (d.speed < 0.05 && d.lift === 0) v.y += Math.sin(tick * 0.12) * HOVER_BOB;

  // ---- world interaction along the path
  const spd = V.len(v);
  if (spd > T.smashFragileSpeed) smashAhead(p, d, dim, loc, V.scale(v, 1 / spd), spd, tick);
  if (spd > RAM_SPEED) ram(p, d, dim, loc, V.scale(v, 1 / spd), spd, tick);

  setVelocity(p, v);
  d.cmd = v;
  d.lastLoc = { x: loc.x, y: loc.y, z: loc.z };

  effectsTick(p, d, dim, loc, v, tick, boosting);
  syncPose(p, d, my, tick);
}

// ------------------------------------------------------------------ lifecycle
/** mode: lose | death | dimension | leave */
function cleanup(p, r, mode) {
  const d = r.data[ID];
  if (!d) return;
  land(p, d, mode);
  d.rammed.clear();
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
    const d = r.data[ID];
    if (!d) return;
    if (!d.flying) {
      if (d.carried) releaseCarried(d, 'gentle');
      return;
    }
    const gm = gameModeOf(p);
    if (vanillaFlight(p) || gm === GameMode.Spectator || (tick % 10 === 0 && riding(p))) {
      land(p, d, 'vanilla');
      return;
    }
    controlTick(p, r, d, tick);
    if (d.carried) {
      if (d.flying) carryTick(p, d);
      else releaseCarried(d, 'gentle');
    }
  },

  activate(p, r, abilityId) {
    const d = state(r);
    const tick = system.currentTick;
    switch (abilityId) {
      case 'take_off':
        if (d.flying) {
          land(p, d, 'toggle');
          return TOGGLE_COOLDOWN;
        }
        if (vanillaFlight(p) || riding(p) || gameModeOf(p) === GameMode.Spectator) {
          hint(p, '§7You cannot take off right now.');
          return false;
        }
        takeOff(p, d, tick);
        return TOGGLE_COOLDOWN;
      case 'afterburner':
        if (vanillaFlight(p) || riding(p) || gameModeOf(p) === GameMode.Spectator) {
          hint(p, '§7You cannot fly right now.');
          return false;
        }
        afterburner(p, d, tick);
        return undefined;
      case 'grab_throw':
        if (d.carried && alive(d.carried)) return throwCarried(p, d, tick);
        if (d.carried) releaseCarried(d, 'drop');
        return grab(p, d);
      default:
        return false;
    }
  },

  onButton(p, r, button, pressed) {
    // double-tap Jump in mid-air toggles flight (creative keeps vanilla double-jump flight)
    if (button !== 'Jump' || !pressed || !r.input.doubleJump) return;
    const gm = gameModeOf(p);
    if (gm === GameMode.Creative || gm === GameMode.Spectator) return;
    try {
      if (p.isOnGround) return;
    } catch {
      return;
    }
    if (cooldownLeft(p, ID, 'take_off') > 0) return;
    tryActivate(p, ID, 'take_off');
  },

  isToggled(p, r, abilityId) {
    return abilityId === 'take_off' && !!r.data[ID]?.flying;
  },

  hud(p, r) {
    const d = r.data[ID];
    if (!d?.flying) return undefined;
    let s = `§bFlight §f${Math.round(d.speed * 72)} km/h`;
    if (system.currentTick < d.boostUntil) s += ' §6| BOOST';
    if (d.carried && isValid(d.carried)) s += ` §7| carrying §f${nameOf(d.carried)}`;
    return s;
  },

  flags() {
    return { nofall: true, nokinetic: true };
  },

  debug(p, r) {
    const d = r.data[ID];
    if (!d) return { flying: false, speed: 0, carrying: null };
    let carrying = null;
    try {
      carrying = d.carried && isValid(d.carried) ? d.carried.typeId : null;
    } catch {
      carrying = null;
    }
    return {
      flying: d.flying,
      speed: round2(d.speed),
      carrying,
      boosting: system.currentTick < d.boostUntil,
      forwardTicks: d.forwardTicks,
      pose: d.pose,
      fov: d.fovKey,
      lift: round2(d.lift),
      smashed: d.smashed,
      rams: d.rams,
      lastBoom: d.lastBoom,
      lastCrash: d.lastCrash,
      lastThrow: d.lastThrow,
      lastRam: d.lastRam ?? null,
    };
  },
});
