// Rogue Mutant AI: vanilla behaviour components handle walking/melee; this script adds the
// telegraphed power attacks of each variant (0 Brute/strength, 1 Scorcher/heat vision,
// 2 Blur/speedster, 3 Psion/esper).
import { world, system, EntityDamageCause } from '@minecraft/server';
import { ENTITIES, POWERS } from '../config.js';
import { worldSettings, griefingAllowed } from '../core/state.js';
import { onTick } from '../core/loop.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import { setVelocity, damage, eyes, isValid, isVulnerablePlayer, knockFrom, creaturesNear } from '../core/entities.js';
import { breakBlock, getBlockSafe } from '../core/blocks.js';

const VARIANT_POWER = ['strength', 'heat_vision', 'speedster', 'esper'];

/** @type {Map<string, {e: import('@minecraft/server').Entity, next: number, action?: any}>} */
const mutants = new Map();

function track(e) {
  if (e?.typeId !== ENTITIES.mutant || mutants.has(e.id)) return;
  mutants.set(e.id, { e, next: system.currentTick + 60 + Math.floor(Math.random() * 60) });
  // Blurs are permanently fast.
  system.runTimeout(() => {
    if (!isValid(e)) return;
    if (variantOf(e) === 2) {
      try {
        e.getComponent('minecraft:movement')?.setCurrentValue(0.34);
      } catch {
        /* ignore */
      }
    }
  }, 2);
}

world.afterEvents.entitySpawn.subscribe((ev) => track(ev.entity));
world.afterEvents.entityLoad.subscribe((ev) => track(ev.entity));

function variantOf(e) {
  try {
    return e.getComponent('minecraft:variant')?.value ?? 0;
  } catch {
    return 0;
  }
}

function nearestTarget(e, range) {
  let best, bestD = range;
  let players;
  try {
    players = e.dimension.getPlayers({ location: e.location, maxDistance: range });
  } catch {
    return undefined;
  }
  for (const p of players) {
    if (!isVulnerablePlayer(p)) continue;
    const d = V.dist(p.location, e.location);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function hasLineOfSight(e, target) {
  try {
    const from = eyes(e);
    const to = V.add(target.location, { x: 0, y: 1.2, z: 0 });
    const dir = V.norm(V.sub(to, from));
    const d = V.dist(from, to);
    const hit = e.dimension.getBlockFromRay(from, dir, { maxDistance: d, includePassableBlocks: false });
    return !hit;
  } catch {
    return false;
  }
}

function telegraph(e, power) {
  fx.anim(e, 'animation.sp.mutant.cast');
  fx.sound(e.dimension, 'sp.mutant.power', e.location, 1, 1.2);
  fx.particle(e.dimension, 'sp:charge_aura', V.add(e.location, { x: 0, y: 1, z: 0 }), { color: POWERS[power].rgb });
}

// ------------------------------------------------------------------ variant attacks
function startBrute(m, target) {
  telegraph(m.e, 'strength');
  m.action = { kind: 'leap', stage: 'windup', t: 0, target };
}

function startScorcher(m, target) {
  telegraph(m.e, 'heat_vision');
  m.action = { kind: 'beam', stage: 'windup', t: 0, target };
}

function startBlur(m, target) {
  telegraph(m.e, 'speedster');
  m.action = { kind: 'dash', stage: 'windup', t: 0, target };
}

function startPsion(m, target) {
  telegraph(m.e, 'esper');
  m.action = { kind: 'toss', stage: 'windup', t: 0, target };
}

function runAction(m, tick) {
  const e = m.e;
  const a = m.action;
  a.t++;
  const target = a.target;
  if (!isValid(target)) {
    m.action = undefined;
    return;
  }
  const dim = e.dimension;
  switch (a.kind) {
    case 'leap': {
      if (a.stage === 'windup') {
        if (a.t % 2 === 0) fx.particle(dim, 'sp:dust', e.location, { color: { red: 0.55, green: 0.45, blue: 0.35 } });
        if (a.t >= 12) {
          const to = V.sub(target.location, e.location);
          const h = V.hnorm(to);
          const dist = V.hlen(to);
          setVelocity(e, { x: h.x * Math.min(1.4, dist * 0.09), y: 0.95, z: h.z * Math.min(1.4, dist * 0.09) });
          fx.sound(dim, 'sp.strength.leap', e.location, 1.2, 0.8);
          a.stage = 'air';
          a.t = 0;
        }
      } else if (a.stage === 'air' && a.t > 4 && e.isOnGround) {
        const at = e.location;
        fx.particle(dim, 'sp:shockwave', V.add(at, { x: 0, y: 0.1, z: 0 }), { radius: 4, color: POWERS.strength.rgb });
        fx.particle(dim, 'sp:debris_chunks', at, { color: { red: 0.5, green: 0.45, blue: 0.4 }, size: 1 });
        fx.sound(dim, 'sp.strength.land', at, 1.1, 1.2);
        fx.shakeArea(dim, at, 12, 0.5, 0.4);
        for (const c of creaturesNear(dim, at, 4, e)) {
          if (c.typeId === ENTITIES.mutant) continue;
          damage(c, 7, e, EntityDamageCause.entityAttack);
          knockFrom(c, at, 1.0, 0.55);
        }
        if (griefingAllowed()) {
          for (let dx = -2; dx <= 2; dx++)
            for (let dz = -2; dz <= 2; dz++) {
              const b = getBlockSafe(dim, { x: at.x + dx, y: at.y, z: at.z + dz });
              if (b) breakBlock(b, { maxTier: 1 });
            }
        }
        m.action = undefined;
        m.next = tick + 120;
      } else if (a.t > 60) {
        m.action = undefined;
        m.next = tick + 80;
      }
      break;
    }
    case 'beam': {
      if (a.stage === 'windup') {
        fx.particle(dim, 'sp:glow', eyes(e), { color: POWERS.heat_vision.rgb, size: 0.3 });
        if (a.t >= 10) {
          a.stage = 'fire';
          a.t = 0;
          fx.sound(dim, 'sp.heat.start', e.location);
        }
        break;
      }
      const from = eyes(e);
      const to = V.add(target.location, { x: 0, y: 1.1, z: 0 });
      const dir = V.norm(V.sub(to, from));
      try {
        e.lookAt(to);
      } catch {
        /* ignore */
      }
      let end = to;
      try {
        const hit = dim.getBlockFromRay(from, dir, { maxDistance: V.dist(from, to), includePassableBlocks: false });
        if (hit) end = V.add(hit.block.location, hit.faceLocation);
      } catch {
        /* ignore */
      }
      const len = V.dist(from, end);
      fx.particle(dim, 'sp:beam', V.lerpV(from, end, 0.5), { dir, len, width: 0.06, color: { red: 1, green: 0.3, blue: 0.1 } });
      fx.particle(dim, 'sp:glow', end, { color: POWERS.heat_vision.rgb, size: 0.5 });
      if (a.t % 3 === 0) fx.particle(dim, 'sp:spark', end, { color: POWERS.heat_vision.rgb });
      if (a.t % 10 === 0) fx.sound(dim, 'sp.heat.loop', e.location, 1.1, 0.8);
      if (end === to && a.t % 5 === 0) {
        damage(target, 2, e, EntityDamageCause.fire);
        try {
          target.setOnFire(3, true);
        } catch {
          /* ignore */
        }
      }
      if (a.t >= 30) {
        m.action = undefined;
        m.next = tick + 140;
      }
      break;
    }
    case 'dash': {
      if (a.stage === 'windup') {
        if (a.t >= 8) {
          const to = V.sub(target.location, e.location);
          const dir = V.hnorm(to);
          const start = e.location;
          const dist = Math.max(0, V.hlen(to) - 1.2);
          // Flash-step next to the target, along the ground.
          const steps = Math.ceil(dist / 0.6);
          let pos = start;
          for (let i = 1; i <= steps; i++) {
            const p = V.addScaled(start, dir, Math.min(dist, i * 0.6));
            const feet = getBlockSafe(dim, p);
            const head = getBlockSafe(dim, V.add(p, V.UP));
            if ((feet && !feet.isAir && !feet.isLiquid) || (head && !head.isAir && !head.isLiquid)) break;
            pos = p;
          }
          fx.particle(dim, 'sp:afterimage', start, { color: POWERS.speedster.rgb });
          fx.line(dim, 'sp:lightning', V.add(start, { x: 0, y: 1, z: 0 }), V.add(pos, { x: 0, y: 1, z: 0 }), 1.5, { color: POWERS.speedster.rgb });
          try {
            e.teleport(pos, { facingLocation: target.location });
          } catch {
            /* ignore */
          }
          fx.sound(dim, 'sp.speed.zap', pos, 1.2, 1);
          if (V.dist(pos, target.location) < 2.5) {
            damage(target, 5, e, EntityDamageCause.entityAttack);
            knockFrom(target, pos, 0.8, 0.35);
          }
          m.action = undefined;
          m.next = tick + 90;
        }
      }
      break;
    }
    case 'toss': {
      if (a.stage === 'windup') {
        if (a.t % 2 === 0) fx.particle(dim, 'sp:psi_aura', V.add(target.location, { x: 0, y: 1, z: 0 }), { color: POWERS.esper.rgb });
        if (a.t >= 14) {
          a.stage = 'lift';
          a.t = 0;
          fx.sound(dim, 'sp.esper.grab', target.location, 0.8, 1);
        }
      } else if (a.stage === 'lift') {
        setVelocity(target, { x: 0, y: 0.35, z: 0 });
        if (a.t % 2 === 0) fx.particle(dim, 'sp:levitate', target.location, { color: POWERS.esper.rgb });
        if (a.t >= 20) {
          const away = V.hnorm(V.sub(target.location, e.location));
          setVelocity(target, { x: away.x * 1.6, y: 0.6, z: away.z * 1.6 });
          fx.sound(dim, 'sp.esper.launch', target.location, 0.9, 1);
          damage(target, 4, e, EntityDamageCause.magic);
          m.action = undefined;
          m.next = tick + 160;
        }
      }
      break;
    }
  }
}

function tick(t) {
  if (t % 2 !== 0) return;
  const powersOn = worldSettings().mutantPowers !== false;
  for (const [id, m] of mutants) {
    if (!isValid(m.e)) {
      mutants.delete(id);
      continue;
    }
    if (!powersOn) continue;
    if (m.action) {
      runAction(m, t);
      continue;
    }
    if (t < m.next) continue;
    m.next = t + 20;
    const target = nearestTarget(m.e, 16);
    if (!target) continue;
    const d = V.dist(target.location, m.e.location);
    const variant = variantOf(m.e);
    if (variant === 0 && d > 3.5 && d < 13) startBrute(m, target);
    else if (variant === 1 && d > 3 && d < 16 && hasLineOfSight(m.e, target)) startScorcher(m, target);
    else if (variant === 2 && d > 3 && d < 12) startBlur(m, target);
    else if (variant === 3 && d < 12 && hasLineOfSight(m.e, target)) startPsion(m, target);
  }
}

onTick('mutants', tick);

export function mutantVariantPower(e) {
  return VARIANT_POWER[variantOf(e)] ?? 'strength';
}
