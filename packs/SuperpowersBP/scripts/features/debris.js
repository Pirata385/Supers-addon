// Shared "debris" system: chunks of the world (boulders, telekinetically lifted blocks)
// rendered by the sp:debris entity, which can be held, thrown and that shatter on impact.
import { world, system, BlockPermutation, EntityDamageCause } from '@minecraft/server';
import { ENTITIES } from '../config.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import { creaturesNear, damage, knockFrom, isValid } from '../core/entities.js';
import { getBlockSafe, breakSphere, tierOf, blockColor, debrisTextureFor } from '../core/blocks.js';
import { griefingAllowed } from '../core/state.js';
import { onTick } from '../core/loop.js';

/**
 * @typedef {Object} DebrisInfo
 * @property {import('@minecraft/server').Entity} entity
 * @property {'held'|'flying'|'idle'} state
 * @property {() => (import('../core/math.js').Vec3|undefined)} [anchor]  hold target point provider
 * @property {import('@minecraft/server').Entity} [owner]
 * @property {BlockPermutation} [permutation]  block to restore when set down / landing
 * @property {number} size
 * @property {{red:number,green:number,blue:number}} color
 * @property {number} damage
 * @property {number} radius
 * @property {number} breakTier
 * @property {boolean} placeOnLand
 * @property {number} lastSpeed
 * @property {number} launchedAt
 * @property {number} expires
 * @property {Set<string>} hit
 * @property {(info: DebrisInfo, at: import('../core/math.js').Vec3) => void} [onImpact]
 */

/** @type {Map<string, DebrisInfo>} */
const debris = new Map();

/**
 * Spawn a debris chunk.
 * @param {import('@minecraft/server').Dimension} dim
 * @param {import('../core/math.js').Vec3} loc
 * @param {{blockId?:string, permutation?:BlockPermutation, size?:number, owner?:any, color?:any, ttl?:number}} opts
 */
export function spawnDebris(dim, loc, opts = {}) {
  let e;
  try {
    e = dim.spawnEntity(ENTITIES.debris, loc);
  } catch (err) {
    console.warn(`[SP] debris spawn failed: ${err}`);
    return undefined;
  }
  const blockId = opts.blockId ?? opts.permutation?.type.id ?? 'minecraft:stone';
  const size = opts.size ?? 1;
  try {
    e.setProperty('sp:tex', debrisTextureFor(blockId));
    e.setProperty('sp:size', V.clamp(size, 0.25, 4));
  } catch {
    /* properties missing in a mismatched RP/BP: still functional */
  }
  debris.set(e.id, {
    entity: e,
    state: 'idle',
    owner: opts.owner,
    permutation: opts.permutation,
    size,
    color: opts.color ?? { red: 0.5, green: 0.48, blue: 0.45 },
    damage: 0,
    radius: 0,
    breakTier: 0,
    placeOnLand: false,
    lastSpeed: 0,
    launchedAt: 0,
    expires: system.currentTick + (opts.ttl ?? 1200),
    hit: new Set(opts.owner ? [opts.owner.id] : []),
  });
  return e;
}

export function debrisInfo(entity) {
  return entity ? debris.get(entity.id) : undefined;
}

/** Keep a debris chunk pinned to a moving anchor point (teleported every tick). */
export function holdDebris(entity, anchor) {
  const d = debris.get(entity.id);
  if (!d) return;
  d.state = 'held';
  d.anchor = anchor;
}

/**
 * Launch a debris chunk.
 * @param {import('@minecraft/server').Entity} entity
 * @param {import('../core/math.js').Vec3} velocity
 * @param {{owner?:any, damage?:number, radius?:number, breakTier?:number, placeOnLand?:boolean, onImpact?:(info: DebrisInfo, at: import('../core/math.js').Vec3) => void}} opts
 */
export function throwDebris(entity, velocity, opts = {}) {
  const d = debris.get(entity.id);
  if (!d || !isValid(entity)) return;
  d.state = 'flying';
  d.anchor = undefined;
  d.owner = opts.owner ?? d.owner;
  if (d.owner) d.hit.add(d.owner.id);
  d.damage = opts.damage ?? 10;
  d.radius = opts.radius ?? 2.5;
  d.breakTier = opts.breakTier ?? 2;
  d.placeOnLand = opts.placeOnLand ?? false;
  d.onImpact = opts.onImpact;
  d.launchedAt = system.currentTick;
  d.lastSpeed = V.len(velocity);
  d.expires = system.currentTick + 200;
  try {
    entity.clearVelocity();
    entity.applyImpulse(velocity);
  } catch {
    /* ignore */
  }
}

/** Drop a held chunk gently; if it carries a block it is placed back into the world. */
export function setDown(entity, at) {
  const d = debris.get(entity.id);
  if (!d) return false;
  const loc = at ?? entity.location;
  const placed = d.permutation ? placeBlockNear(entity.dimension, loc, d.permutation) : false;
  if (placed || !d.permutation) {
    fx.particle(entity.dimension, 'sp:dust', loc, { color: d.color });
    removeDebris(entity);
  } else {
    // nowhere to put it: let it fall and settle as a thrown chunk
    throwDebris(entity, { x: 0, y: -0.2, z: 0 }, { owner: d.owner, damage: 0, radius: 0, breakTier: 0, placeOnLand: true });
  }
  return true;
}

export function removeDebris(entity) {
  debris.delete(entity?.id);
  try {
    if (isValid(entity)) entity.remove();
  } catch {
    /* ignore */
  }
}

function placeBlockNear(dim, loc, permutation) {
  if (!griefingAllowed()) return false;
  const base = V.floorV(loc);
  const candidates = [base, V.add(base, V.UP), V.add(base, { x: 0, y: 2, z: 0 })];
  for (const c of candidates) {
    const b = getBlockSafe(dim, c);
    if (b && (b.isAir || (tierOf(b) === 1 && !b.typeId.includes('glass')))) {
      // must be in the open: avoid placing inside entities' heads
      try {
        b.setPermutation(permutation);
        fx.sound(dim, 'sp.debris.place', V.centerOf(c), 0.9, 0.8);
        return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

function shatter(d, at, speed) {
  const e = d.entity;
  const dim = e.dimension;
  const scaleF = Math.max(0.5, d.size);
  fx.particle(dim, 'sp:debris_chunks', at, { color: d.color, size: scaleF });
  fx.particle(dim, 'sp:dust', at, { color: d.color });
  fx.particle(dim, 'sp:shockwave', { x: at.x, y: Math.floor(at.y) + 0.1, z: at.z }, { radius: d.radius + 1, color: d.color });
  fx.sound(dim, 'sp.impact.heavy', at, 1.15 - Math.min(0.5, scaleF * 0.15), Math.min(2.5, 0.8 + speed * 0.4));
  fx.shakeArea(dim, at, 18 + d.radius * 3, 0.35 + scaleF * 0.15, 0.4);
  if (d.damage > 0) {
    for (const c of creaturesNear(dim, at, d.radius + 0.8, d.owner)) {
      const f = 1 - Math.min(1, V.dist(c.location, at) / (d.radius + 1));
      damage(c, d.damage * (0.4 + 0.6 * f), d.owner, EntityDamageCause.fallingBlock);
      knockFrom(c, at, 0.6 + speed * 0.35 * f, 0.45 + 0.3 * f);
    }
  }
  if (d.breakTier > 0 && d.radius > 0) breakSphere(dim, at, Math.min(4, d.radius * 0.7), d.breakTier, { limit: 60, dropChance: 0.08 });
  let placed = false;
  if (d.placeOnLand && d.permutation) placed = placeBlockNear(dim, at, d.permutation);
  if (!placed && d.permutation && d.placeOnLand) {
    // could not be placed: return the block as an item so nothing is lost
    try {
      const item = d.permutation.getItemStack(1);
      if (item) dim.spawnItem(item, at);
    } catch {
      /* ignore */
    }
  }
  try {
    d.onImpact?.(d, at);
  } catch (err) {
    console.warn(`[SP] debris onImpact: ${err}`);
  }
  removeDebris(e);
}

function tick(t) {
  for (const [id, d] of debris) {
    const e = d.entity;
    if (!isValid(e) || t > d.expires) {
      if (d.state !== 'flying' && d.permutation && isValid(e)) setDown(e);
      else removeDebris(e);
      debris.delete(id);
      continue;
    }
    if (d.state === 'held') {
      const p = d.anchor?.();
      if (!p) continue;
      d.expires = Math.max(d.expires, t + 40); // alive while something holds it
      try {
        e.teleport(p, { keepVelocity: false });
      } catch {
        /* ignore */
      }
      if (t % 3 === 0) fx.particle(e.dimension, 'sp:dust_fall', V.add(p, { x: 0, y: -0.4 * d.size, z: 0 }), { color: d.color });
      continue;
    }
    if (d.state !== 'flying') continue;
    let vel, loc;
    try {
      vel = e.getVelocity();
      loc = e.location;
    } catch {
      continue;
    }
    const speed = V.len(vel);
    const center = V.add(loc, { x: 0, y: 0.45 * d.size, z: 0 });
    if (t % 2 === 0) fx.particle(e.dimension, 'sp:dust_fall', center, { color: d.color });
    const age = t - d.launchedAt;
    // creature collision
    if (age > 1 && d.damage > 0) {
      const near = creaturesNear(e.dimension, center, 0.9 + d.size * 0.6, d.owner).filter((c) => !d.hit.has(c.id));
      if (near.length) {
        shatter(d, center, Math.max(speed, d.lastSpeed));
        continue;
      }
    }
    // terrain collision: sudden deceleration, or resting on the ground
    if (age > 2 && (speed < d.lastSpeed * 0.5 || (e.isOnGround && speed < 0.25))) {
      shatter(d, center, Math.max(speed, d.lastSpeed));
      continue;
    }
    d.lastSpeed = speed;
  }
}

onTick('debris', tick);

// Debris entities that outlived their script state (world reload) are cleaned up.
world.afterEvents.entityLoad.subscribe((ev) => {
  const e = ev.entity;
  if (e.typeId === ENTITIES.debris && !debris.has(e.id)) system.run(() => removeDebris(e));
});

/**
 * Lift a block out of the world as a debris chunk carrying its permutation.
 * Returns the debris entity or undefined if the block can't be moved.
 */
export function liftBlock(block, owner, maxTier = 3) {
  if (!block || !griefingAllowed()) return undefined;
  const tier = tierOf(block);
  if (tier === 0 || tier > maxTier) return undefined;
  const perm = block.permutation;
  const color = blockColor(block);
  const center = V.centerOf(block.location);
  try {
    block.setType('minecraft:air');
  } catch {
    return undefined;
  }
  const e = spawnDebris(block.dimension, V.add(center, { x: 0, y: -0.5, z: 0 }), { permutation: perm, owner, color, size: 1 });
  fx.particle(block.dimension, 'sp:dust', center, { color });
  return e;
}
