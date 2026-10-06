// Visual / audio feedback helpers. All calls are defensive: effects must never break gameplay.
import { world, system, MolangVariableMap, EasingType } from '@minecraft/server';
import { rt } from './state.js';
import { currentOwner } from './context.js';
import * as V from './math.js';

/**
 * Build a MolangVariableMap.
 * Supported keys: color {red,green,blue} -> variable.color ; dir Vec3 -> variable.dir ;
 * any other numeric key -> variable.<key>.
 */
export function molang(vars) {
  const m = new MolangVariableMap();
  if (!vars) return m;
  for (const k in vars) {
    const v = vars[k];
    if (v === undefined || v === null) continue;
    if (k === 'color') m.setColorRGB('variable.color', v);
    else if (typeof v === 'number') m.setFloat(`variable.${k}`, v);
    else if (typeof v === 'object' && 'x' in v) m.setVector3(`variable.${k}`, v);
  }
  return m;
}

/** Spawn a particle effect for everyone. */
export function particle(dim, id, loc, vars) {
  try {
    dim.spawnParticle(id, loc, vars instanceof MolangVariableMap ? vars : molang(vars));
  } catch {
    /* unloaded chunk or invalid location */
  }
}

/** Spawn a particle visible only to one player. */
export function particleFor(player, id, loc, vars) {
  try {
    player.spawnParticle(id, loc, vars instanceof MolangVariableMap ? vars : molang(vars));
  } catch {
    /* ignore */
  }
}

/** Spawn particles along a segment. */
export function line(dim, id, from, to, step, vars) {
  const d = V.dist(from, to);
  const n = Math.max(1, Math.min(64, Math.floor(d / step)));
  const m = vars instanceof MolangVariableMap ? vars : molang(vars);
  for (let i = 0; i <= n; i++) particle(dim, id, V.lerpV(from, to, i / n), m);
}

/** Spawn particles on a horizontal circle. */
export function ring(dim, id, center, radius, count, vars) {
  const m = vars instanceof MolangVariableMap ? vars : molang(vars);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    particle(dim, id, { x: center.x + Math.cos(a) * radius, y: center.y, z: center.z + Math.sin(a) * radius }, m);
  }
}

/** Play a sound at a location for everyone in range. */
export function sound(dim, id, loc, pitch = 1, volume = 1) {
  try {
    dim.playSound(id, loc, { pitch, volume });
  } catch {
    /* ignore */
  }
}

/** Play a sound only for a player (UI feedback). */
export function soundTo(player, id, pitch = 1, volume = 1) {
  try {
    player.playSound(id, { pitch, volume });
  } catch {
    /* ignore */
  }
}

function screenFx(player) {
  try {
    return rt(player).settings.screenFx !== false;
  } catch {
    return true;
  }
}

/** Camera shake for one player. */
export function shake(player, intensity, seconds, rotational = false) {
  if (!screenFx(player)) return;
  try {
    player.runCommand(`camerashake add @s ${V.clamp(intensity, 0, 4).toFixed(2)} ${seconds.toFixed(2)} ${rotational ? 'rotational' : 'positional'}`);
  } catch {
    /* ignore */
  }
}

/** Camera shake for every player within radius, scaled by distance. */
export function shakeArea(dim, center, radius, intensity, seconds) {
  for (const p of dim.getPlayers({ location: center, maxDistance: radius })) {
    const f = 1 - V.dist(p.location, center) / radius;
    if (f > 0.05) shake(p, intensity * f, seconds);
  }
}

/**
 * Field of view warp (e.g. high speed). Each power owns one FOV request; the widest active
 * request wins, so one power resetting its FOV never cancels another power's warp.
 */
export function fov(player, value, easeTime = 0.35) {
  const r = rt(player);
  r.input.fovs ??= {};
  r.input.fovs[currentOwner() ?? 'misc'] = value;
  applyFov(player, r, easeTime);
}

/** Drop the calling power's FOV request (outside a power handler: drop all requests). */
export function resetFov(player, easeTime = 0.4) {
  const r = rt(player);
  const owner = currentOwner();
  if (owner && r.input.fovs) delete r.input.fovs[owner];
  else r.input.fovs = {};
  applyFov(player, r, easeTime);
}

function applyFov(player, r, easeTime) {
  const vals = Object.values(r.input.fovs ?? {});
  const target = vals.length && screenFx(player) ? Math.max(...vals) : null;
  if (target === (r.input.fovApplied ?? null)) return;
  r.input.fovApplied = target;
  try {
    if (target === null) player.camera.setFov({ easeOptions: { easeTime, easeType: EasingType.OutQuad } });
    else player.camera.setFov({ fov: target, easeOptions: { easeTime, easeType: EasingType.OutQuad } });
  } catch {
    try {
      if (target === null) player.camera.setFov();
    } catch {
      /* ignore */
    }
  }
}

/** Push a resource-pack fog onto the player's fog stack under a named slot. */
export function fogPush(player, fogId, slot) {
  if (!screenFx(player)) return;
  try {
    player.runCommand(`fog @s push ${fogId} ${slot}`);
  } catch {
    /* ignore */
  }
}

export function fogPop(player, slot) {
  try {
    player.runCommand(`fog @s remove ${slot}`);
  } catch {
    /* ignore */
  }
}

/**
 * Animation controllers used on players (each is an independent layer):
 *  - 'sp_pose'   : looping body poses (flight, charging, carrying, channeling)
 *  - 'sp_action' : one-shot actions (throw, clap, cast)
 */
export function anim(entity, animation, controller = 'sp_action', stopExpression = 'query.any_animation_finished', blendOutTime = 0.15) {
  try {
    entity.playAnimation(animation, { controller, stopExpression, blendOutTime });
  } catch {
    /* ignore */
  }
}

/** Priority of looping poses when several powers request one at the same time. */
const POSE_PRIORITY = {
  'animation.sp.strength.lift': 90,
  'animation.sp.strength.charge': 85,
  'animation.sp.strength.dash': 80,
  'animation.sp.heat.beam': 75,
  'animation.sp.esper.channel': 70,
  'animation.sp.flight.carry': 60,
  'animation.sp.speed.run': 40,
  'animation.sp.flight.cruise': 30,
  'animation.sp.flight.hover': 20,
};
const POWER_POSE_GROUP = { heat_vision: 'heat', speedster: 'speed' };

function poseGroup(animation) {
  const m = /^animation\.sp\.([a-z_]+)\./.exec(animation);
  return m ? m[1] : 'misc';
}

function applyPose(player, r) {
  let best = null;
  let bestP = -1;
  for (const k in r.input.poses) {
    const a = r.input.poses[k];
    const pr = POSE_PRIORITY[a] ?? 50;
    if (pr > bestP) {
      best = a;
      bestP = pr;
    }
  }
  if (best === (r.input.pose ?? null)) return;
  r.input.pose = best;
  if (best) anim(player, best, 'sp_pose', '0', 0.2);
  else anim(player, 'animation.sp.reset', 'sp_pose', 'query.any_animation_finished', 0.25);
}

/**
 * Request a looping body pose (controller 'sp_pose'). Each power keeps at most one request;
 * the highest-priority request is displayed. Cheap to call every tick.
 */
export function pose(player, animation) {
  const r = rt(player);
  r.input.poses ??= {};
  const g = poseGroup(animation);
  if (r.input.poses[g] !== animation) r.input.poses[g] = animation;
  applyPose(player, r);
}

/**
 * Withdraw a pose request: a specific animation, or (without argument) the request of the
 * power currently executing; outside a power handler every request is cleared.
 */
export function stopPose(player, animation) {
  const r = rt(player);
  r.input.poses ??= {};
  if (animation) {
    const g = poseGroup(animation);
    if (r.input.poses[g] === animation) delete r.input.poses[g];
  } else {
    const owner = currentOwner();
    if (owner) delete r.input.poses[POWER_POSE_GROUP[owner] ?? owner];
    else r.input.poses = {};
  }
  applyPose(player, r);
}

export function title(player, text, sub, fadeIn = 4, stay = 30, fadeOut = 10) {
  try {
    player.onScreenDisplay.setTitle(text, { fadeInDuration: fadeIn, stayDuration: stay, fadeOutDuration: fadeOut, subtitle: sub ?? '' });
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------- temporary light sources
const LIGHT_PROP = 'sp:lights';
/** @type {Map<string, {dim:string, x:number, y:number, z:number, until:number, id:string}>} */
const lights = new Map();
let lightsDirty = false;

/** Place a temporary light block (only into air) for `ticks` ticks. */
export function flashLight(dim, loc, level = 15, ticks = 4) {
  const x = Math.floor(loc.x), y = Math.floor(loc.y), z = Math.floor(loc.z);
  const k = `${dim.id}|${x},${y},${z}`;
  const until = system.currentTick + ticks;
  const existing = lights.get(k);
  if (existing) {
    existing.until = Math.max(existing.until, until);
    return;
  }
  try {
    const b = dim.getBlock({ x, y, z });
    if (!b || !b.isAir) return;
    const id = `minecraft:light_block_${Math.max(1, Math.min(15, Math.round(level)))}`;
    b.setType(id);
    lights.set(k, { dim: dim.id, x, y, z, until, id });
    lightsDirty = true;
  } catch {
    /* unloaded */
  }
}

function clearLight(entry) {
  try {
    const b = world.getDimension(entry.dim).getBlock(entry);
    if (b && b.typeId.startsWith('minecraft:light_block')) b.setType('minecraft:air');
  } catch {
    /* unloaded: keep for later cleanup */
    return false;
  }
  return true;
}

export function tickLights(tick) {
  for (const [k, e] of lights) {
    if (e.until <= tick) {
      if (clearLight(e) || tick - e.until > 1200) {
        lights.delete(k);
        lightsDirty = true;
      }
    }
  }
  if (lightsDirty && tick % 40 === 0) {
    lightsDirty = false;
    try {
      world.setDynamicProperty(LIGHT_PROP, JSON.stringify([...lights.values()].slice(0, 400)));
    } catch {
      /* ignore */
    }
  }
}

/** Remove light blocks left behind by a previous session (crash / reload). */
export function restoreStaleLights() {
  try {
    const raw = world.getDynamicProperty(LIGHT_PROP);
    if (typeof raw !== 'string') return;
    for (const e of JSON.parse(raw)) {
      e.until = 0;
      lights.set(`${e.dim}|${e.x},${e.y},${e.z}`, e);
    }
  } catch {
    /* ignore */
  }
}
