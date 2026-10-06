// Entity helpers: velocity control, target selection, damage and thrown-object physics.
import { system, Player, GameMode, EntityDamageCause } from '@minecraft/server';
import { pvpAllowed } from './state.js';
import * as V from './math.js';
import * as fx from './fx.js';
import { breakBlock, getBlockSafe, tierOf } from './blocks.js';
import { ENTITIES } from '../config.js';
import { currentOwner } from './context.js';

/** Entity types that are never valid power targets. */
const NON_TARGETS = new Set([
  'minecraft:item', 'minecraft:xp_orb', 'minecraft:painting', 'minecraft:leash_knot', 'minecraft:area_effect_cloud',
  'minecraft:lightning_bolt', 'minecraft:fishing_hook', 'minecraft:evocation_fang', 'minecraft:shulker_bullet',
  'minecraft:tripod_camera', 'minecraft:npc', 'minecraft:agent', 'minecraft:ender_crystal', 'minecraft:eye_of_ender_signal',
  'minecraft:fireworks_rocket', 'minecraft:tnt', 'minecraft:falling_block', 'minecraft:xp_bottle',
  ENTITIES.debris, ENTITIES.meteor,
]);

export function isValid(e) {
  try {
    return !!e && e.isValid;
  } catch {
    return false;
  }
}

/** Player that can be affected (not creative/spectator). */
export function isVulnerablePlayer(p) {
  try {
    const gm = p.getGameMode();
    return gm !== GameMode.Creative && gm !== GameMode.Spectator;
  } catch {
    return false;
  }
}

export function isProjectile(e) {
  try {
    return e.hasComponent('minecraft:projectile');
  } catch {
    return false;
  }
}

/** A creature (has health) that powers may target. */
export function isCreature(e) {
  if (!isValid(e)) return false;
  if (NON_TARGETS.has(e.typeId)) return false;
  try {
    if (!e.hasComponent('minecraft:health')) return false;
    if (e.hasComponent('minecraft:projectile')) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Whether `source` may harm/manipulate `target` with powers.
 * Players only when PvP is allowed and the victim is not creative/spectator.
 */
export function canAffect(source, target) {
  if (!isCreature(target)) return false;
  if (source && target.id === source.id) return false;
  if (target instanceof Player || target.typeId === 'minecraft:player') {
    if (!isVulnerablePlayer(target)) return false;
    if (source && (source instanceof Player || source.typeId === 'minecraft:player') && !pvpAllowed()) return false;
  }
  // Never hurt your own tamed pets.
  try {
    const tame = target.getComponent('minecraft:tameable');
    if (tame?.isTamed && source && tame.tamedToPlayerId === source.id) return false;
  } catch {
    /* ignore */
  }
  return true;
}

/** Creatures around a point that `source` may affect. */
export function creaturesNear(dim, loc, radius, source, extra = {}) {
  let list;
  try {
    list = dim.getEntities({ location: loc, maxDistance: radius, ...extra });
  } catch {
    return [];
  }
  return list.filter((e) => canAffect(source, e));
}

/** Apply damage with attribution. Returns true if damage was dealt. */
export function damage(target, amount, source, cause = EntityDamageCause.entityAttack) {
  if (!isValid(target) || amount <= 0) return false;
  try {
    if (source && isValid(source)) return target.applyDamage(amount, { cause, damagingEntity: source });
    return target.applyDamage(amount, { cause });
  } catch {
    try {
      return target.applyDamage(amount);
    } catch {
      return false;
    }
  }
}

// Measured on BDS 1.26.x: for players, applyKnockback(F, Vy) produces next-tick velocity
//   v.xz = v_now.xz * k + 0.4 * F      (k = 0.455 airborne, 0.273 on ground)
//   v.y  = (v_now.y - 0.08) * 0.49 + Vy
// Solving for F / Vy lets us set an exact velocity on players, which have no applyImpulse.
const KB_SCALE = 0.4;

/** @type {Map<string, {owner:string, until:number}>} */
const motionLocks = new Map();

/**
 * Reserve an entity's motion for `ticks` ticks: setVelocity calls made by other powers are
 * ignored meanwhile (e.g. a Super Strength dash is not cancelled by Flight's hover control).
 */
export function lockMotion(entity, ticks, owner = currentOwner() ?? 'misc') {
  if (!isValid(entity)) return;
  motionLocks.set(entity.id, { owner, until: system.currentTick + Math.max(1, ticks) });
}

export function unlockMotion(entity, owner = currentOwner()) {
  const l = motionLocks.get(entity?.id);
  if (l && (!owner || l.owner === owner)) motionLocks.delete(entity.id);
}

/** True when another owner currently holds the entity's motion. */
export function motionLocked(entity, owner = currentOwner()) {
  const l = motionLocks.get(entity?.id);
  if (!l) return false;
  if (l.until < system.currentTick) {
    motionLocks.delete(entity.id);
    return false;
  }
  return l.owner !== (owner ?? 'misc');
}

/**
 * Set an entity's velocity as exactly as the engine allows.
 * Ignored while another power holds a motion lock on the entity unless opts.force.
 */
export function setVelocity(entity, v, opts = undefined) {
  if (!isValid(entity)) return;
  if (!opts?.force && motionLocked(entity)) return;
  try {
    if (entity.typeId === 'minecraft:player') {
      const c = entity.getVelocity();
      const k = entity.isOnGround ? 0.273 : 0.455;
      entity.applyKnockback({ x: (v.x - c.x * k) / KB_SCALE, z: (v.z - c.z * k) / KB_SCALE }, v.y - (c.y - 0.08) * 0.49);
    } else {
      entity.clearVelocity();
      entity.applyImpulse(v);
    }
  } catch {
    /* some entities (e.g. riding) reject motion */
  }
}

/** Add velocity on top of the current one. */
export function addVelocity(entity, dv) {
  if (!isValid(entity)) return;
  try {
    if (entity.typeId === 'minecraft:player') {
      const c = entity.getVelocity();
      setVelocity(entity, V.add(c, dv));
    } else {
      entity.applyImpulse(dv);
    }
  } catch {
    /* ignore */
  }
}

/** Knock a target away from a point with given horizontal speed and lift. */
export function knockFrom(target, from, horizontal, lift) {
  const d = V.hnorm(V.sub(target.location, from));
  const dir = d.x === 0 && d.z === 0 ? V.randomUnit() : d;
  launch(target, { x: dir.x * horizontal, y: lift, z: dir.z * horizontal });
}

/**
 * Launch an entity hit by a power. Overrides (and briefly locks) the victim's own motion
 * control, so e.g. a flying player hit by a Thunderclap is really blown away.
 */
export function launch(target, v, lockTicks = 8) {
  if (!isValid(target)) return;
  setVelocity(target, v, { force: true });
  if (target.typeId === 'minecraft:player') motionLocks.set(target.id, { owner: 'external', until: system.currentTick + lockTicks });
}

/** Eye position of an entity (falls back to location + 1.6). */
export function eyes(entity) {
  try {
    return entity.getHeadLocation();
  } catch {
    return V.add(entity.location, { x: 0, y: 1.6, z: 0 });
  }
}

/**
 * First creature along the view ray of `source` within range (ignores blocks behind).
 * @returns {import('@minecraft/server').Entity | undefined}
 */
export function creatureInSight(source, range, radiusPadding = 1.2) {
  try {
    const hits = source.getEntitiesFromViewDirection({ maxDistance: range });
    for (const h of hits) if (canAffect(source, h.entity)) return h.entity;
  } catch {
    /* ignore */
  }
  // Generous fallback: closest creature within a narrow cone.
  const eye = eyes(source);
  const dir = source.getViewDirection();
  let best, bestScore = Infinity;
  for (const e of creaturesNear(source.dimension, V.addScaled(eye, dir, range / 2), range / 2 + 2, source)) {
    const to = V.sub(V.add(e.location, { x: 0, y: 0.9, z: 0 }), eye);
    const along = V.dot(to, dir);
    if (along < 0.5 || along > range) continue;
    const off = V.len(V.sub(to, V.scale(dir, along)));
    if (off > radiusPadding + along * 0.06) continue;
    const score = along + off * 4;
    if (score < bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

// ------------------------------------------------------------------ thrown objects
/**
 * @typedef {Object} Thrown
 * @property {import('@minecraft/server').Entity} entity
 * @property {import('@minecraft/server').Entity|undefined} thrower
 * @property {number} damagePerSpeed
 * @property {number} until
 * @property {number} lastSpeed
 * @property {number} grace
 * @property {Set<string>} hit
 * @property {(t: Thrown, at: import('./math.js').Vec3, speed: number) => void} [onImpact]
 * @property {boolean} breaksBlocks
 */
/** @type {Map<string, Thrown>} */
const thrown = new Map();

/**
 * Track an entity launched as a projectile: it damages what it slams into, and takes
 * impact damage itself when it hits terrain at speed.
 */
export function trackThrown(entity, thrower, opts = {}) {
  if (!isValid(entity)) return;
  thrown.set(entity.id, {
    entity,
    thrower,
    damagePerSpeed: opts.damagePerSpeed ?? 6,
    until: system.currentTick + (opts.ticks ?? 80),
    lastSpeed: opts.initialSpeed ?? 2,
    grace: system.currentTick + 3,
    hit: new Set(thrower ? [thrower.id, entity.id] : [entity.id]),
    onImpact: opts.onImpact,
    breaksBlocks: opts.breaksBlocks ?? true,
  });
}

export function isThrown(entity) {
  return thrown.has(entity.id);
}

export function untrackThrown(entityId) {
  thrown.delete(entityId);
}

function impact(t, at, speed) {
  const dim = t.entity.dimension;
  const dmg = Math.min(40, speed * t.damagePerSpeed);
  fx.particle(dim, 'sp:shockwave', at, { radius: 1.5 + speed, color: { red: 0.85, green: 0.85, blue: 0.85 } });
  fx.particle(dim, 'sp:dust', at, { color: { red: 0.6, green: 0.55, blue: 0.5 } });
  fx.sound(dim, 'sp.impact.heavy', at, 1.1 - Math.min(0.4, speed * 0.08), Math.min(2, 0.6 + speed * 0.3));
  if (isCreature(t.entity)) damage(t.entity, dmg * 0.7, t.thrower, EntityDamageCause.flyIntoWall);
  for (const e of creaturesNear(dim, at, 2.2 + speed * 0.4, t.thrower)) {
    if (t.hit.has(e.id)) continue;
    t.hit.add(e.id);
    damage(e, dmg * 0.6, t.thrower);
    knockFrom(e, at, 0.6 + speed * 0.3, 0.4);
  }
  if (t.breaksBlocks && speed > 1.2) {
    const r = Math.min(2, speed * 0.6);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > r + 1) continue;
          const b = getBlockSafe(dim, { x: at.x + dx, y: at.y + dy, z: at.z + dz });
          if (b && tierOf(b) <= (speed > 2.4 ? 2 : 1)) breakBlock(b, { maxTier: speed > 2.4 ? 2 : 1 });
        }
  }
  fx.shakeArea(dim, at, 12 + speed * 4, 0.25 + speed * 0.15, 0.35);
  t.onImpact?.(t, at, speed);
}

/** Per-tick update of all thrown objects. */
export function tickThrown(tick) {
  for (const [id, t] of thrown) {
    const e = t.entity;
    if (!isValid(e) || tick > t.until) {
      thrown.delete(id);
      continue;
    }
    let vel, loc;
    try {
      vel = e.getVelocity();
      loc = e.location;
    } catch {
      thrown.delete(id);
      continue;
    }
    const speed = V.len(vel);
    const center = V.add(loc, { x: 0, y: 0.6, z: 0 });
    if (tick % 2 === 0 && speed > 0.5) fx.particle(e.dimension, 'sp:wind_streak', center, { dir: V.norm(vel), len: Math.min(3, speed) });
    // Hit another creature in flight.
    if (speed > 0.6 && tick >= t.grace) {
      for (const other of creaturesNear(e.dimension, center, 1.3 + speed * 0.25, t.thrower)) {
        if (t.hit.has(other.id)) continue;
        impact(t, center, speed);
        thrown.delete(id);
        break;
      }
      if (!thrown.has(id)) continue;
    }
    // Sudden deceleration = slammed into terrain.
    if (tick >= t.grace && t.lastSpeed > 0.9 && speed < t.lastSpeed * 0.45) {
      impact(t, center, t.lastSpeed);
      thrown.delete(id);
      continue;
    }
    if (tick >= t.grace && speed < 0.15 && e.isOnGround) {
      thrown.delete(id);
      continue;
    }
    t.lastSpeed = speed;
  }
}
