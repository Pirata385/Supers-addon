// Visual / audio feedback helpers. All calls are defensive: effects must never break gameplay.
import { world, system, MolangVariableMap, EasingType } from '@minecraft/server';
import { rt } from './state.js';
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

/** Field of view warp (e.g. high speed). */
export function fov(player, value, easeTime = 0.35) {
  if (!screenFx(player)) return;
  try {
    player.camera.setFov({ fov: value, easeOptions: { easeTime, easeType: EasingType.OutQuad } });
  } catch {
    /* ignore */
  }
}

export function resetFov(player, easeTime = 0.4) {
  try {
    player.camera.setFov({ easeOptions: { easeTime, easeType: EasingType.OutQuad } });
  } catch {
    try {
      player.camera.setFov();
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

/** Start a looping pose that lasts until replaced/stopped. */
export function pose(player, animation) {
  const r = rt(player);
  if (r.input.pose === animation) return;
  r.input.pose = animation;
  anim(player, animation, 'sp_pose', '0', 0.2);
}

export function stopPose(player, animation) {
  const r = rt(player);
  if (animation && r.input.pose !== animation) return;
  if (!r.input.pose) return;
  r.input.pose = null;
  anim(player, 'animation.sp.reset', 'sp_pose', 'query.any_animation_finished', 0.25);
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
