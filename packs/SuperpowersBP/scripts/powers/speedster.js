// Speedster: Speed Force gears up to supersonic, runs on water, dodges projectiles and bowls over
// whatever stands in the way; Time Dilation slows the world around the runner to a crawl; Blitz Dash
// flash-steps through everything in a straight line.
// Built only from movement attributes, velocity control, teleports, particles, sounds and animations.
import { world, system } from '@minecraft/server';
import { POWERS, TUNING } from '../config.js';
import { definePower, grantTemporaryFlag, startCooldown, abilityDef } from '../core/powers.js';
import { rt, griefingAllowed } from '../core/state.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import {
  canAffect, creaturesNear, damage, setVelocity, launch, lockMotion, unlockMotion, motionLocked, trackThrown, isThrown,
  isValid, isProjectile, isCreature,
} from '../core/entities.js';
import { getBlockSafe, tierOf, breakBlock, isPassable } from '../core/blocks.js';
import { moveInput } from '../core/input.js';
import { onTick } from '../core/loop.js';
import { withOwner } from '../core/context.js';

const ID = 'speedster';
const T = TUNING.speedster;
const COLOR = POWERS.speedster.rgb;
const HOT = { red: 1, green: 0.28, blue: 0.08 }; // trail colour at top gear
const WHITE = { red: 1, green: 0.97, blue: 0.9 };
const TIME_BLUE = { red: 0.45, green: 0.78, blue: 1 };

const ANIM = {
  run: 'animation.sp.speed.run',
  blitz: 'animation.sp.speed.blitz',
};

// Local tuning (values without an entry in config.TUNING.speedster).
const MAX_GEAR = T.gearMovement.length - 1;
const DEFAULT_MOVEMENT = 0.1;
const GROUND_SPEED_PER_MOVEMENT = 2.15; // measured: blocks/tick per movement attribute point
const MOVING_SPEED = 0.08; // horizontal blocks/tick that count as "moving"
const SPRINT_DECAY = 4;
const REAPPLY_INTERVAL = 20;
const FOV_BASE = 70;
const FOV_PER_GEAR = 8;
const FOV_DILATION = 10;
const HISTORY = 4; // positions kept for afterimages (3 ticks old + current)
// plow
const PLOW_MIN_SPEED = 0.8;
const PLOW_RADIUS = 1.6;
const PLOW_REHIT = 10;
const PLOW_MAX_LAUNCH = 3.2;
// fragile blocks a runner tramples but never smashes: infrastructure and floor coverings
const PLOW_SPARE = ['rail', 'redstone', 'torch', 'lantern', 'button', 'lever', 'pressure_plate', 'tripwire', 'string',
  'ladder', 'scaffolding', 'carpet', 'snow', 'repeater', 'comparator', 'frame', 'pot'];
// dodge
const DODGE_SCAN_RADIUS = 8;
const DODGE_HORIZON = 12; // ticks of projectile flight considered
const DODGE_MISS = 1.6; // closest approach that counts as "heading at the player"
const DODGE_SPEED = 1.2;
const DODGE_LOCK = 4;
// water running
const WATER_HOLD = 0.05; // feet height above the water surface
const WATER_MAX_DEPTH = 1.3; // how deep under the surface the feet may be and still get pulled up
const WATER_ABOVE = 0.6; // how high above the surface the feet may be
const WATER_COAST = 0.9; // horizontal speed kept per tick without movement input
const WATER_MIN_COAST = 0.3;
// time dilation
const DILATION_SCAN_INTERVAL = 2;
const DILATION_OWNER_STALE = 5;
const DILATION_MAX_TRACKED = 256;
const MOB_VELOCITY_SCALE = 0.35;
const MOB_VELOCITY_MIN = 0.05;
const ORIG_PROP = 'sp:td_orig'; // original movement value saved on slowed mobs (restored after unloads)
const PHYS_TYPES = new Set(['minecraft:item', 'minecraft:xp_orb', 'minecraft:falling_block', 'minecraft:tnt', 'minecraft:tnt_minecart']);
const PHYS_GRAVITY = 0.04;
const PROJ_GRAVITY = 0.05;
const DILATION_SKIP = new Set([
  'minecraft:player', 'sp:debris', 'sp:meteor', 'minecraft:painting', 'minecraft:leash_knot', 'minecraft:lightning_bolt',
  'minecraft:area_effect_cloud', 'minecraft:ender_crystal', 'minecraft:fishing_hook', 'minecraft:npc', 'minecraft:agent',
  'minecraft:tripod_camera', 'minecraft:evocation_fang',
]);
// blitz
const BLITZ_STEP = 0.5;
const BLITZ_MAX_DY = 0.35;
const BLITZ_HIT_RADIUS = 1.6;
const BLITZ_BODY = [0.1, 0.9, 1.7]; // heights checked along the path (feet, waist, head)
const BLITZ_CORNERS = [-0.29, 0.29]; // player hitbox half-width (0.3) minus a hair: flush walls stay free
const BLITZ_MAX_STEP_UPS = 6;
const BLITZ_MIN_TRAVEL = 1;
const BLITZ_NOFALL = 40;
const BLITZ_GUARD_TICKS = 200; // nofall until landing after a blitz into the air
const BLITZ_LOCK = 4;

/** Trail colour per gear: power yellow, redder at high gear. */
const GEAR_COLOR = T.gearMovement.map((_, g) => {
  const k = V.clamp((g - 1) / Math.max(1, MAX_GEAR - 1), 0, 1);
  return { red: V.lerp(COLOR.red, HOT.red, k), green: V.lerp(COLOR.green, HOT.green, k), blue: V.lerp(COLOR.blue, HOT.blue, k) };
});
/** @type {any[]} */
let gearMaps = null;
/** Cached Molang map with the trail colour of a gear (built lazily: no native objects at import). */
function gearMap(g) {
  if (!gearMaps) gearMaps = GEAR_COLOR.map((c) => fx.molang({ color: c }));
  return gearMaps[V.clamp(g, 0, MAX_GEAR)];
}

/**
 * Transient per-player state (r.data.speedster).
 * @typedef {Object} SpeedState
 * @property {boolean} active
 * @property {number} gear
 * @property {number} sprintTicks
 * @property {{x:number,y:number,z:number}[]} hist   recent feet positions (oldest first)
 * @property {{start:number, until:number, ignored:Set<string>}|null} dilation
 * @property {Map<string, number>} dodged            projectile id -> tick dodged
 * @property {Map<string, number>} plowed            creature id -> tick hit
 * @property {boolean} water                         water running this tick
 * @property {boolean} moving
 * @property {number} speed                          horizontal blocks/tick
 * @property {number} dodgeUntil
 * @property {number} [lastApply]                    tick the movement attribute was last (re)applied
 * @property {number} dodges
 * @property {number} plowHits
 * @property {number} plowBroken
 * @property {boolean} airGuard                      nofall until landing (after a blitz)
 * @property {number} guardUntil
 * @property {number|null} fov
 * @property {string|null} pose
 * @property {any} lastBlitz
 * @property {any} lastDodge
 */

/** @returns {SpeedState} */
function state(r) {
  let d = r.data[ID];
  if (!d) {
    d = r.data[ID] = {
      active: false, gear: 0, sprintTicks: 0, hist: [], dilation: null, dodged: new Map(), plowed: new Map(),
      water: false, moving: false, speed: 0, dodgeUntil: 0, dodges: 0, plowHits: 0, plowBroken: 0,
      airGuard: false, guardUntil: 0, fov: null, pose: null, lastBlitz: null, lastDodge: null,
    };
  }
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

function velocityOf(e) {
  try {
    return e.getVelocity();
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function movementComp(e) {
  try {
    return e.getComponent('minecraft:movement');
  } catch {
    return undefined;
  }
}

function movementValue(p) {
  try {
    return movementComp(p)?.currentValue ?? -1;
  } catch {
    return -1;
  }
}

function setMovement(p, value) {
  try {
    movementComp(p)?.setCurrentValue(value);
  } catch {
    /* ignore */
  }
}

function resetMovement(p) {
  const mv = movementComp(p);
  if (!mv) return;
  try {
    mv.resetToDefaultValue();
  } catch {
    /* ignore */
  }
  try {
    if (Math.abs(mv.currentValue - DEFAULT_MOVEMENT) > 1e-6) mv.setCurrentValue(DEFAULT_MOVEMENT);
  } catch {
    /* ignore */
  }
}

function gearSpeed(gear) {
  return GROUND_SPEED_PER_MOVEMENT * T.gearMovement[gear];
}

function isSneaking(p, r) {
  const o = r.input.sneakOverride;
  if (o !== undefined) return o;
  try {
    return p.isSneaking;
  } catch {
    return false;
  }
}

/** Horizontal direction of the movement input in world space (undefined without input). */
function inputDirection(p) {
  const inp = moveInput(p);
  const mag = Math.hypot(inp.x, inp.y);
  if (mag < 0.1) return undefined;
  let yaw = 0;
  try {
    yaw = p.getRotation().y;
  } catch {
    /* ignore */
  }
  const f = V.dirFromRotation({ x: 0, y: yaw });
  // left of forward (x>0 = left, see core/input.js)
  const left = { x: f.z, y: 0, z: -f.x };
  return V.hnorm({ x: f.x * inp.y + left.x * inp.x, y: 0, z: f.z * inp.y + left.z * inp.x });
}

/** Desired FOV: wider per gear, wider still while time is dilated. */
function updateFov(p, d) {
  let want = null;
  if (d.active) want = FOV_BASE + d.gear * FOV_PER_GEAR;
  if (d.dilation) want = (want ?? FOV_BASE) + FOV_DILATION;
  if (want === d.fov) return;
  d.fov = want;
  if (want === null) fx.resetFov(p, 0.4);
  else fx.fov(p, want, 0.35);
}

function syncPose(p, d) {
  const want = d.active && d.gear >= 2 && d.moving ? ANIM.run : null;
  if (want === d.pose) return;
  if (want) fx.pose(p, want);
  else fx.stopPose(p, ANIM.run);
  d.pose = want;
}

function waist(loc) {
  return { x: loc.x, y: loc.y + 0.9, z: loc.z };
}

// ------------------------------------------------------------------ Speed Force
function startSpeed(p, d) {
  d.active = true;
  d.sprintTicks = 0;
  d.hist = [];
  const dim = p.dimension;
  const loc = p.location;
  setGear(p, d, 1, true);
  fx.sound(dim, 'sp.speed.start', loc, 1, 1);
  fx.particle(dim, 'sp:lightning', waist(loc), gearMap(1));
  fx.particle(dim, 'sp:lightning', { x: loc.x, y: loc.y + 0.3, z: loc.z }, gearMap(1));
  fx.particle(dim, 'sp:lightning', { x: loc.x, y: loc.y + 1.5, z: loc.z }, gearMap(1));
}

/** mode: 'toggle' | 'lose' | 'death' | 'dimension' | 'leave' */
function stopSpeed(p, d, mode) {
  const was = d.active;
  d.active = false;
  d.gear = 0;
  d.sprintTicks = 0;
  d.water = false;
  d.moving = false;
  d.hist = [];
  if (mode === 'leave') return;
  resetMovement(p);
  updateFov(p, d);
  syncPose(p, d);
  if (was && mode === 'toggle') fx.sound(p.dimension, 'sp.speed.stop', p.location, 1, 1);
}

function setGear(p, d, gear, initial = false) {
  const prev = d.gear;
  d.gear = gear;
  setMovement(p, T.gearMovement[gear]);
  d.lastApply = system.currentTick;
  updateFov(p, d);
  const dim = p.dimension;
  const loc = p.location;
  if (!initial) fx.sound(dim, 'sp.speed.gear', loc, 0.8 + 0.15 * gear, gear > prev ? 0.9 : 0.5);
  if (gear === MAX_GEAR && prev < MAX_GEAR && !initial) {
    const v = velocityOf(p);
    let dir = V.hnorm(v);
    if (V.lenSq(dir) < 1e-4) dir = V.hnorm(p.getViewDirection());
    const at = waist(loc);
    fx.particle(dim, 'sp:sonic_boom', V.addScaled(at, dir, 0.8), { dir });
    fx.particle(dim, 'sp:shockwave_air', at, { radius: 3, color: WHITE });
    fx.sound(dim, 'sp.speed.boom', loc, 1, 1.4);
    fx.shake(p, 0.3, 0.35);
  }
}

function speedTick(p, r, d, tick) {
  const dim = p.dimension;
  const loc = p.location;
  const v = velocityOf(p);
  const hs = V.hlen(v);
  d.speed = hs;
  d.moving = hs > MOVING_SPEED;
  let sprinting = false;
  try {
    sprinting = p.isSprinting;
  } catch {
    /* ignore */
  }
  if ((sprinting || d.water) && d.moving) d.sprintTicks++;
  else d.sprintTicks = Math.max(0, d.sprintTicks - SPRINT_DECAY);
  let gear = 1;
  for (let g = MAX_GEAR; g >= 1; g--) {
    if (T.gearUpTicks[g] <= d.sprintTicks) {
      gear = g;
      break;
    }
  }
  // the counter cannot outgrow the top gear by much (keeps downshifting responsive)
  d.sprintTicks = Math.min(d.sprintTicks, T.gearUpTicks[MAX_GEAR] + 20);
  if (gear !== d.gear) setGear(p, d, gear);
  else if (tick - (d.lastApply ?? 0) >= REAPPLY_INTERVAL) {
    d.lastApply = tick;
    if (Math.abs(movementValue(p) - T.gearMovement[gear]) > 1e-4) setMovement(p, T.gearMovement[gear]);
  }

  // position history for afterimages
  d.hist.push({ x: loc.x, y: loc.y, z: loc.z });
  if (d.hist.length > HISTORY) d.hist.shift();

  waterRun(p, r, d, tick, loc, v, hs);
  if (d.gear >= T.plowGear && hs > PLOW_MIN_SPEED) plow(p, d, tick, loc, v, hs);
  if (d.gear >= T.dodgeGear && tick % 2 === 0 && tick >= d.dodgeUntil) dodgeScan(p, d, tick, loc);

  if (d.moving) trail(p, d, tick, dim, loc, v, hs);
  syncPose(p, d);
}

function trail(p, d, tick, dim, loc, v, hs) {
  const g = d.gear;
  fx.particle(dim, 'sp:lightning', waist(loc), gearMap(g));
  if (g >= 2 && tick % 3 === 0 && d.hist.length >= HISTORY) fx.particle(dim, 'sp:afterimage', d.hist[0], gearMap(g));
  if (g >= 3 && hs > 0.3) {
    const dir = V.norm(v);
    fx.particle(dim, 'sp:wind_streak', V.addScaled(waist(loc), dir, -0.6), { dir, len: Math.min(3, hs * 1.2) });
  }
  if (tick % 15 === 0 && Math.random() < 0.6) fx.sound(dim, 'sp.speed.zap', loc, 0.85 + Math.random() * 0.4, 0.45);
}

// ------------------------------------------------------------------ water running
function isWater(b) {
  if (!b) return false;
  try {
    const id = b.typeId;
    if (id === 'minecraft:water' || id === 'minecraft:flowing_water') return true;
    return b.isWaterlogged && tierOf(b) <= 1;
  } catch {
    return false;
  }
}

/** Y of the water surface the player is running on (top of the topmost water block), if any. */
function waterSurface(dim, loc) {
  const x = loc.x, z = loc.z;
  const lo = Math.floor(loc.y - WATER_ABOVE);
  const hi = Math.floor(loc.y + WATER_MAX_DEPTH);
  for (let y = hi; y >= lo; y--) {
    const b = getBlockSafe(dim, { x, y, z });
    if (!isWater(b)) continue;
    if (isWater(getBlockSafe(dim, { x, y: y + 1, z }))) return undefined; // too deep under the surface
    const surf = y + 1;
    if (loc.y > surf + WATER_ABOVE || loc.y < surf - WATER_MAX_DEPTH) return undefined;
    return surf;
  }
  return undefined;
}

function waterRun(p, r, d, tick, loc, v, hs) {
  d.water = false;
  if (d.gear < T.waterRunGear || tick < d.dodgeUntil || motionLocked(p)) return;
  if (isSneaking(p, r)) return; // sneak to sink / swim
  const dir0 = inputDirection(p);
  if (!dir0 && hs < WATER_MIN_COAST) return;
  const dim = p.dimension;
  const surf = waterSurface(dim, loc);
  if (surf === undefined) return;
  let dir, speed;
  if (dir0) {
    dir = dir0;
    speed = Math.max(hs, gearSpeed(d.gear));
  } else {
    dir = V.hnorm(v);
    speed = hs * WATER_COAST;
  }
  const vy = V.clamp((surf + WATER_HOLD - loc.y) * 0.5, -0.15, 0.45);
  setVelocity(p, { x: dir.x * speed, y: vy, z: dir.z * speed });
  d.water = true;
  d.moving = true;
  if (tick % 2 === 0) fx.particle(dim, 'sp:water_splash', { x: loc.x, y: surf + 0.02, z: loc.z });
  if (tick % 6 === 0 && Math.random() < 0.6) fx.sound(dim, 'random.splash', loc, 1.2 + Math.random() * 0.4, 0.35);
}

// ------------------------------------------------------------------ plow
function plowSpares(id) {
  for (const h of PLOW_SPARE) if (id.includes(h)) return true;
  return false;
}

function plow(p, d, tick, loc, v, hs) {
  const dim = p.dimension;
  const dir = V.hnorm(v);
  const center = waist(loc);
  const ahead = V.addScaled(center, dir, hs * 0.5 + 0.4);
  for (const e of creaturesNear(dim, ahead, PLOW_RADIUS + hs * 0.5, p)) {
    const last = d.plowed.get(e.id);
    if (last !== undefined && tick - last < PLOW_REHIT) continue;
    let ec;
    try {
      ec = waist(e.location);
    } catch {
      continue;
    }
    const to = V.sub(ec, center);
    const along = V.dot(to, dir);
    if (along < -0.3) continue; // behind us
    if (V.hlen(V.sub(to, V.scale(dir, along))) > PLOW_RADIUS) continue;
    d.plowed.set(e.id, tick);
    d.plowHits++;
    damage(e, T.plowDamage, p);
    const s = Math.min(PLOW_MAX_LAUNCH, hs * 1.1);
    launch(e, { x: dir.x * s, y: 0.5, z: dir.z * s });
    trackThrown(e, p, { damagePerSpeed: 4, ticks: 40, initialSpeed: s });
    const at = V.lerpV(center, ec, 0.5);
    fx.particle(dim, 'sp:shockwave_air', at, { radius: 1.6, color: GEAR_COLOR[d.gear] });
    fx.sound(dim, 'sp.impact.heavy', at, 1.1, 0.9);
    fx.shake(p, 0.15, 0.15);
  }
  if (d.plowed.size > 32) for (const [k, t] of d.plowed) if (tick - t >= PLOW_REHIT) d.plowed.delete(k);
  // fragile blocks at feet and head height 1-2 (+ the distance covered this tick) blocks ahead
  if (!griefingAllowed()) return;
  let broken = 0;
  const reach = 2 + Math.min(2, hs);
  for (let f = 1; f <= reach; f += 0.8) {
    for (const h of [0.5, 1.5]) {
      const b = getBlockSafe(dim, { x: loc.x + dir.x * f, y: loc.y + h, z: loc.z + dir.z * f });
      if (!b || b.isAir || b.isLiquid || tierOf(b) !== 1 || plowSpares(b.typeId)) continue;
      if (breakBlock(b, { maxTier: 1, effects: true })) broken++;
    }
  }
  if (broken) {
    d.plowBroken += broken;
    fx.sound(dim, 'sp.impact.light', V.addScaled(loc, dir, 1.5), 1 + Math.random() * 0.3, 0.8);
  }
}

// ------------------------------------------------------------------ dodge
function projectileOwnerId(e) {
  try {
    return e.getComponent('minecraft:projectile')?.owner?.id;
  } catch {
    return undefined;
  }
}

function dodgeScan(p, d, tick, loc) {
  if (d.dodged.size > 24) for (const [k, t] of d.dodged) if (tick - t > 100) d.dodged.delete(k);
  const dim = p.dimension;
  const center = waist(loc);
  let list;
  try {
    list = dim.getEntities({ location: center, maxDistance: DODGE_SCAN_RADIUS, excludeTypes: ['minecraft:player', 'minecraft:item', 'minecraft:xp_orb'] });
  } catch {
    return;
  }
  for (const e of list) {
    if (d.dodged.has(e.id) || !isProjectile(e)) continue;
    if (projectileOwnerId(e) === p.id) continue;
    let pl;
    try {
      pl = e.location;
    } catch {
      continue;
    }
    const v = velocityOf(e);
    const s2 = V.lenSq(v);
    if (s2 < 0.04) continue; // resting / stuck
    const rel = V.sub(center, pl);
    const t = V.dot(rel, v) / s2;
    if (t <= 0 || t > DODGE_HORIZON) continue;
    const off = V.sub(rel, V.scale(v, t));
    if (V.len(off) >= DODGE_MISS) continue;
    dodge(p, d, tick, e, v, off, loc);
    return;
  }
}

function dodge(p, d, tick, e, v, off, loc) {
  d.dodged.set(e.id, tick);
  const dim = p.dimension;
  let path = V.hnorm(v);
  if (V.lenSq(path) < 1e-4) path = V.hnorm(V.randomUnit());
  let perp = { x: -path.z, y: 0, z: path.x };
  let side = Math.sign(V.dot(off, perp)) || (Math.random() < 0.5 ? 1 : -1);
  // prefer the side with room to step into
  const probe = (s) => getBlockSafe(dim, { x: loc.x + perp.x * s * 1.5, y: loc.y + 0.5, z: loc.z + perp.z * s * 1.5 });
  const free = (b) => !!b && isPassable(b);
  if (!free(probe(side)) && free(probe(-side))) side = -side;
  perp = V.scale(perp, side);
  setVelocity(p, { x: perp.x * DODGE_SPEED, y: 0.12, z: perp.z * DODGE_SPEED });
  lockMotion(p, DODGE_LOCK);
  d.dodgeUntil = tick + DODGE_LOCK;
  d.dodges++;
  d.lastDodge = { tick, projectile: e.typeId, side };
  fx.particle(dim, 'sp:afterimage', { x: loc.x, y: loc.y, z: loc.z }, gearMap(d.gear));
  fx.particle(dim, 'sp:lightning', waist(loc), gearMap(d.gear));
  fx.sound(dim, 'sp.speed.dodge', loc, 0.9 + Math.random() * 0.2, 1);
}

// ------------------------------------------------------------------ time dilation
/**
 * Every entity slowed by any speedster, shared so overlapping dilations never stack.
 * @typedef {Object} Slowed
 * @property {import('@minecraft/server').Entity} e
 * @property {'mob'|'proj'|'phys'} kind
 * @property {Map<string, number>} owners   speedster id -> last tick the entity was inside its radius
 * @property {any} [mv]                     movement component (mobs)
 * @property {number} [orig]                original movement value (mobs)
 * @property {number} [slow]                applied slowed movement value (mobs)
 * @property {{x:number,y:number,z:number}} [u]   real-time velocity (projectiles / physics objects)
 * @property {number} [g]                   gravity per tick
 * @property {number} [comp]                learned vertical compensation for the engine's own gravity step
 * @property {{x:number,y:number,z:number}|null} [last]
 * @property {{x:number,y:number,z:number}|null} [want]   displacement intended last tick
 * @property {boolean} [rest]               not moving (stuck arrow, item on the ground): left alone
 * @property {number} [since]
 */
/** @type {Map<string, Slowed>} */
const slowed = new Map();

function classify(p, e) {
  if (DILATION_SKIP.has(e.typeId)) return null;
  if (isProjectile(e)) return 'proj';
  if (PHYS_TYPES.has(e.typeId)) return 'phys';
  if (isCreature(e) && canAffect(p, e)) return 'mob';
  return null;
}

function slowEntity(e, kind, tick) {
  /** @type {Slowed} */
  const s = { e, kind, owners: new Map() };
  if (kind === 'mob') {
    const mv = movementComp(e);
    if (mv) {
      let orig;
      try {
        const stored = e.getDynamicProperty(ORIG_PROP);
        orig = typeof stored === 'number' ? stored : mv.currentValue;
        e.setDynamicProperty(ORIG_PROP, orig);
        s.mv = mv;
        s.orig = orig;
        s.slow = orig * T.dilationFactor;
        mv.setCurrentValue(s.slow);
      } catch {
        s.mv = undefined;
      }
    }
  } else {
    const u = velocityOf(e);
    s.u = { x: u.x, y: u.y, z: u.z };
    let g = kind === 'proj' ? PROJ_GRAVITY : PHYS_GRAVITY;
    if (kind === 'proj') {
      try {
        const pg = e.getComponent('minecraft:projectile')?.gravity;
        if (typeof pg === 'number' && pg >= 0) g = pg;
      } catch {
        /* ignore */
      }
    }
    s.g = g;
    s.comp = 0;
    s.last = null;
    s.want = null;
    s.rest = V.lenSq(u) < 0.0004;
  }
  s.since = tick;
  return s;
}

function restoreSlowed(s) {
  const e = s.e;
  if (!isValid(e)) return;
  try {
    if (s.kind === 'mob') {
      if (s.mv && s.orig !== undefined) {
        s.mv.setCurrentValue(s.orig);
        e.setDynamicProperty(ORIG_PROP, undefined);
      }
    } else if (!s.rest && s.u) {
      e.clearVelocity();
      e.applyImpulse(s.u);
    }
  } catch {
    /* died / unloaded meanwhile */
  }
}

/** One slow-motion step for a tracked entity. */
function stepSlowed(s) {
  const e = s.e;
  const f = T.dilationFactor;
  if (s.kind === 'mob') {
    if (s.mv) {
      try {
        const cur = s.mv.currentValue;
        if (Math.abs(cur - s.slow) > 1e-4) {
          // someone else changed the speed (AI, other add-on): treat it as the new original
          s.orig = cur;
          s.slow = cur * f;
          e.setDynamicProperty(ORIG_PROP, cur);
          s.mv.setCurrentValue(s.slow);
        }
      } catch {
        s.mv = undefined;
      }
    }
    if (isThrown(e)) return; // knocked by a power: let the impact tracker see its real speed
    const v = velocityOf(e);
    if (V.lenSq(v) > MOB_VELOCITY_MIN * MOB_VELOCITY_MIN) setVelocity(e, V.scale(v, MOB_VELOCITY_SCALE));
    return;
  }
  let loc;
  try {
    loc = e.location;
  } catch {
    return;
  }
  if (s.rest) {
    // resting objects are left alone until something sets them in motion
    const v = velocityOf(e);
    if (V.lenSq(v) > 0.01 && !e.isOnGround) {
      s.rest = false;
      s.u = { x: v.x, y: v.y, z: v.z };
      s.last = null;
      s.want = null;
    } else return;
  }
  const u = s.u;
  let onGround = false;
  try {
    onGround = e.isOnGround;
  } catch {
    /* ignore */
  }
  if (s.last && s.want) {
    const moved = V.sub(loc, s.last);
    const wantH = V.hlen(s.want);
    const movedH = V.hlen(moved);
    if (s.kind === 'proj') {
      // stuck in a block / stopped by a hit: the engine took over
      if (wantH + Math.abs(s.want.y) > 0.02 && V.len(moved) < 0.25 * (wantH + Math.abs(s.want.y))) {
        s.rest = true;
        return;
      }
    } else if (wantH > 0.02 && movedH < 0.25 * wantH) {
      u.x = 0; // hit a wall
      u.z = 0;
    }
    if (!onGround) s.comp = V.clamp(s.comp - (moved.y - s.want.y) * 0.5, -0.05, 0.15);
  }
  if (onGround && s.kind === 'phys') {
    if (u.y < 0) u.y = 0;
    u.x *= 1 - 0.45 * f;
    u.z *= 1 - 0.45 * f;
    if (V.lenSq(u) < 0.0004) {
      s.rest = true; // came to rest: leave it to the engine
      return;
    }
  } else {
    u.y -= s.g * f; // gravity in slow motion
  }
  const want = V.scale(u, f);
  try {
    e.clearVelocity();
    e.applyImpulse({ x: want.x, y: want.y + (onGround ? 0 : s.comp), z: want.z });
  } catch {
    /* ignore */
  }
  s.last = { x: loc.x, y: loc.y, z: loc.z };
  s.want = want;
}

/** Global slow-motion step: runs once per tick after every player's power tick. */
function dilationTicker(tick) {
  if (!slowed.size) return;
  for (const [id, s] of slowed) {
    for (const [pid, seen] of s.owners) if (tick - seen > DILATION_OWNER_STALE) s.owners.delete(pid);
    if (!isValid(s.e)) {
      slowed.delete(id); // died or unloaded: mobs carry ORIG_PROP and are restored when loaded again
      continue;
    }
    if (!s.owners.size) {
      restoreSlowed(s);
      slowed.delete(id);
      continue;
    }
    try {
      stepSlowed(s);
    } catch {
      /* entity vanished mid-step */
    }
  }
}
onTick('speedster.dilation', (tick) => withOwner(ID, () => dilationTicker(tick)));

// A slowed mob that was unloaded (or saved) mid-effect gets its speed back when it loads again.
world.afterEvents.entityLoad.subscribe((ev) => {
  const e = ev.entity;
  try {
    const s = slowed.get(e.id);
    if (s) {
      s.e = e;
      if (s.kind === 'mob') s.mv = movementComp(e);
      return;
    }
    const o = e.getDynamicProperty(ORIG_PROP);
    if (typeof o !== 'number') return;
    movementComp(e)?.setCurrentValue(o);
    e.setDynamicProperty(ORIG_PROP, undefined);
  } catch {
    /* ignore */
  }
});

function dilationScan(p, D, tick) {
  let list;
  try {
    list = p.dimension.getEntities({ location: p.location, maxDistance: T.dilationRadius, excludeTypes: ['minecraft:player'] });
  } catch {
    return;
  }
  for (const e of list) {
    let s = slowed.get(e.id);
    if (!s) {
      if (D.ignored.has(e.id) || slowed.size >= DILATION_MAX_TRACKED) continue;
      let kind;
      try {
        kind = classify(p, e);
      } catch {
        kind = null;
      }
      if (!kind) {
        if (D.ignored.size < 512) D.ignored.add(e.id); // never classify the same bystander twice
        continue;
      }
      s = slowEntity(e, kind, tick);
      slowed.set(e.id, s);
    }
    s.owners.set(p.id, tick);
  }
}

function affectedBy(playerId) {
  let n = 0;
  for (const s of slowed.values()) if (s.owners.has(playerId)) n++;
  return n;
}

function startDilation(p, d, tick) {
  d.dilation = { start: tick, until: tick + T.dilationTicks, ignored: new Set() };
  const dim = p.dimension;
  const loc = p.location;
  fx.sound(dim, 'sp.speed.slow_in', loc, 1, 1);
  fx.fogPush(p, 'sp:time_dilation', 'sp_td');
  updateFov(p, d);
  fx.particle(dim, 'sp:shockwave_air', waist(loc), { radius: 6, color: TIME_BLUE });
  motes(p);
  dilationScan(p, d.dilation, tick);
}

function motes(p) {
  const dim = p.dimension;
  const loc = p.location;
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.5 + Math.random() * 5;
    fx.particle(dim, 'sp:time_motes', { x: loc.x + Math.cos(a) * r, y: loc.y + 0.5 + Math.random() * 2, z: loc.z + Math.sin(a) * r });
  }
}

/** Release every entity this speedster slows. Safe without a valid player (onLeave). */
function releaseAll(playerId) {
  for (const [id, s] of slowed) {
    if (!s.owners.delete(playerId) || s.owners.size) continue;
    restoreSlowed(s);
    slowed.delete(id);
  }
}

/** mode: 'toggle' | 'timeout' | 'lose' | 'death' | 'dimension' | 'leave' */
function endDilation(p, d, mode, playerId) {
  if (!d.dilation) return;
  d.dilation = null;
  releaseAll(playerId);
  if (mode === 'leave') return;
  fx.fogPop(p, 'sp_td');
  updateFov(p, d);
  try {
    fx.sound(p.dimension, 'sp.speed.slow_out', p.location, 1, 1);
  } catch {
    /* ignore */
  }
  if (mode !== 'lose') startCooldown(p, ID, 'time_dilation', abilityDef(ID, 'time_dilation')?.cooldown ?? 400);
}

function dilationTick(p, d, tick) {
  const D = d.dilation;
  if (tick >= D.until) {
    endDilation(p, d, 'timeout', p.id);
    return;
  }
  if ((tick - D.start) % DILATION_SCAN_INTERVAL === 0) dilationScan(p, D, tick);
  if ((tick - D.start) % 10 === 0) motes(p);
}

// ------------------------------------------------------------------ blitz dash
function blitzDirection(p) {
  const look = p.getViewDirection();
  let h = V.hnorm(look);
  if (V.lenSq(h) < 1e-4) h = V.hnorm(V.dirFromRotation({ x: 0, y: p.getRotation().y }));
  let dy = V.clamp(look.y, -BLITZ_MAX_DY, BLITZ_MAX_DY);
  let onGround = false;
  try {
    onGround = p.isOnGround;
  } catch {
    /* ignore */
  }
  // on the ground a downward look follows the ground instead of diving into it
  if (onGround && dy < 0) dy = 0;
  return { dir: V.norm({ x: h.x, y: dy, z: h.z }), ground: onGround && dy === 0 };
}

/**
 * Whether the player's whole hitbox fits with its feet at `q`. Checks the four footprint corners
 * (every block cell the footprint overlaps contains one) at feet, waist and head height.
 * Fragile blocks count as free when griefing is allowed; they are collected in `toBreak` and only
 * broken once the dash really passes through them.
 * @param {Map<string, any>} cache block lookups shared across the whole dash
 * @param {Map<string, any>} toBreak
 */
function bodyFits(dim, q, grief, cache, toBreak) {
  const found = [];
  for (const h of BLITZ_BODY) {
    const y = Math.floor(q.y + h);
    for (const cx of BLITZ_CORNERS) {
      for (const cz of BLITZ_CORNERS) {
        const x = Math.floor(q.x + cx), z = Math.floor(q.z + cz);
        const k = `${x},${y},${z}`;
        let b = cache.get(k);
        if (b === undefined) {
          b = getBlockSafe(dim, { x, y, z }) ?? null;
          cache.set(k, b);
        }
        if (!b) return false; // unloaded / outside the world
        if (isPassable(b)) continue;
        if (grief && tierOf(b) === 1) {
          found.push([k, b]);
          continue;
        }
        return false;
      }
    }
  }
  for (const [k, b] of found) toBreak.set(k, b);
  return true;
}

function blitz(p, d, tick) {
  const dim = p.dimension;
  const start = p.location;
  const { dir, ground } = blitzDirection(p);
  const grief = griefingAllowed();
  const cache = new Map();
  const toBreak = new Map();
  let last = { x: start.x, y: start.y, z: start.z };
  let lift = 0;
  let stepUps = 0;
  let blocked = false;
  for (let s = BLITZ_STEP; s <= T.blitzRange + 1e-6; s += BLITZ_STEP) {
    const q = { x: start.x + dir.x * s, y: start.y + dir.y * s + lift, z: start.z + dir.z * s };
    if (bodyFits(dim, q, grief, cache, toBreak)) {
      last = q;
      continue;
    }
    // running along the ground: hop up single steps
    const up = { x: q.x, y: Math.floor(q.y + 0.1) + 1, z: q.z };
    if (ground && stepUps < BLITZ_MAX_STEP_UPS && up.y - q.y <= 1.05 && bodyFits(dim, up, grief, cache, toBreak)) {
      lift += up.y - q.y;
      stepUps++;
      last = up;
      continue;
    }
    blocked = true;
    break;
  }
  const travel = V.dist(start, last);
  if (travel < BLITZ_MIN_TRAVEL) {
    hint(p, '§eBlitz Dash §7- no room to dash that way.');
    return false;
  }
  // fragile blocks on the travelled path shatter (only those the dash really passed through)
  const counter = { broken: 0 };
  for (const b of toBreak.values()) if (breakBlock(b, { maxTier: 1, effects: true })) counter.broken++;
  // creatures along the path
  const a = waist(start);
  const b = waist(last);
  const ab = V.sub(b, a);
  const ab2 = Math.max(1e-6, V.lenSq(ab));
  let hits = 0;
  for (const e of creaturesNear(dim, V.lerpV(a, b, 0.5), travel / 2 + BLITZ_HIT_RADIUS + 1, p)) {
    let c;
    try {
      c = waist(e.location);
    } catch {
      continue;
    }
    const t = V.clamp(V.dot(V.sub(c, a), ab) / ab2, 0, 1);
    const closest = V.addScaled(a, ab, t);
    if (V.dist(c, closest) > BLITZ_HIT_RADIUS) continue;
    hits++;
    damage(e, T.blitzDamage, p);
    let away = V.hnorm(V.sub(c, closest));
    if (V.lenSq(away) < 1e-4) away = V.hnorm({ x: -dir.z, y: 0, z: dir.x });
    launch(e, { x: away.x * 0.9 + dir.x * 0.6, y: 0.65, z: away.z * 0.9 + dir.z * 0.6 });
    trackThrown(e, p, { damagePerSpeed: 4, ticks: 30, initialSpeed: 1.2 });
    fx.particle(dim, 'sp:shockwave_air', c, { radius: 1.5, color: COLOR });
    fx.sound(dim, 'sp.impact.heavy', c, 1.1, 0.9);
  }
  // effects at the start, then the flash-step itself
  const col = gearMap(Math.max(1, d.gear));
  fx.particle(dim, 'sp:afterimage', { x: start.x, y: start.y, z: start.z }, col);
  fx.sound(dim, 'sp.speed.blitz', start, 1, 1.2);
  fx.line(dim, 'sp:lightning', a, b, 1, col);
  try {
    // with Speed Force on the runner keeps their momentum through the flash-step
    p.teleport(last, { dimension: dim, rotation: p.getRotation(), keepVelocity: d.active });
  } catch {
    return false;
  }
  lockMotion(p, BLITZ_LOCK);
  fx.anim(p, ANIM.blitz);
  fx.particle(dim, 'sp:sonic_boom', V.addScaled(b, dir, 0.6), { dir });
  fx.sound(dim, 'sp.speed.blitz', last, 1.25, 1.2);
  fx.shake(p, 0.2, 0.2);
  grantTemporaryFlag(p, 'nofall', BLITZ_NOFALL);
  d.airGuard = true;
  d.guardUntil = tick + BLITZ_GUARD_TICKS;
  d.hist = [];
  d.lastBlitz = {
    tick, distance: round2(travel), hits, broken: counter.broken, blocked, stepUps,
    from: { x: round2(start.x), y: round2(start.y), z: round2(start.z) }, to: { x: round2(last.x), y: round2(last.y), z: round2(last.z) },
  };
  return true;
}

function airGuardTick(p, d, tick) {
  let settled = false;
  try {
    settled = p.isOnGround || p.isInWater;
  } catch {
    settled = true;
  }
  // the first ticks after the teleport may still report the old ground state
  if ((settled && tick - (d.lastBlitz?.tick ?? 0) > 2) || tick > d.guardUntil) d.airGuard = false;
}

// ------------------------------------------------------------------ lifecycle
/** mode: 'lose' | 'death' | 'dimension' | 'leave' */
function cleanup(p, r, mode) {
  const d = r.data[ID];
  if (!d) return;
  endDilation(p, d, mode, r.id);
  stopSpeed(p, d, mode);
  d.airGuard = false;
  d.dodged.clear();
  d.plowed.clear();
  if (mode !== 'leave') {
    if (d.pose) fx.stopPose(p, d.pose);
    d.pose = null;
    fx.stopPose(p);
    fx.fogPop(p, 'sp_td');
    d.fov = null;
    fx.resetFov(p, 0.3);
    unlockMotion(p);
  }
}

definePower(ID, {
  onGain(p, r) {
    state(r);
  },
  onJoin(p, r) {
    const d = state(r);
    // the engine persists attributes: never leave a stale super speed behind after a rejoin
    if (d.active) setMovement(p, T.gearMovement[d.gear]);
    else resetMovement(p);
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
    const d = state(r);
    if (d.active) speedTick(p, r, d, tick);
    if (d.dilation) dilationTick(p, d, tick);
    if (d.airGuard) airGuardTick(p, d, tick);
  },

  activate(p, r, abilityId) {
    const d = state(r);
    const tick = system.currentTick;
    switch (abilityId) {
      case 'speed_force':
        if (d.active) stopSpeed(p, d, 'toggle');
        else startSpeed(p, d);
        return abilityDef(ID, 'speed_force')?.cooldown ?? 10;
      case 'time_dilation':
        if (d.dilation) endDilation(p, d, 'toggle', p.id);
        else startDilation(p, d, tick);
        return true;
      case 'blitz':
        return blitz(p, d, tick);
      default:
        return false;
    }
  },

  isToggled(p, r, abilityId) {
    const d = r.data[ID];
    if (!d) return false;
    if (abilityId === 'speed_force') return d.active;
    if (abilityId === 'time_dilation') return !!d.dilation;
    return false;
  },

  hud(p, r) {
    const d = r.data[ID];
    if (!d) return undefined;
    const parts = [];
    if (d.active) {
      parts.push(`§eGear ${d.gear} §f${Math.round(d.speed * 20)} m/s${d.gear >= MAX_GEAR ? ' §6§lSUPERSONIC§r' : ''}`);
    }
    if (d.dilation) {
      const left = Math.max(0, d.dilation.until - system.currentTick) / 20;
      parts.push(`§bTIME ${left.toFixed(1)}s`);
    }
    return parts.length ? parts.join(' §7| ') : undefined;
  },

  flags(p, r) {
    const d = r.data[ID];
    return {
      nokinetic: true,
      nofall: !!(d && (d.active || d.airGuard)),
      dodge: !!(d && d.active && d.gear >= T.dodgeGear),
    };
  },

  debug(p, r) {
    const d = r.data[ID];
    if (!d) return { active: false, gear: 0, movement: round2(movementValue(p)), dilation: false, affected: 0, waterRunning: false };
    return {
      active: d.active,
      gear: d.gear,
      movement: Math.round(movementValue(p) * 10000) / 10000,
      dilation: !!d.dilation,
      affected: affectedBy(p.id),
      waterRunning: d.water,
      sprintTicks: d.sprintTicks,
      speed: round2(d.speed),
      pose: d.pose,
      fov: d.fov,
      dodges: d.dodges,
      lastDodge: d.lastDodge,
      plowHits: d.plowHits,
      plowBroken: d.plowBroken,
      airGuard: d.airGuard,
      lastBlitz: d.lastBlitz,
      trackedGlobal: slowed.size,
    };
  },
});
