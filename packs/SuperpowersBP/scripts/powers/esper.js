// Esper: telekinesis (creatures, dropped items or whole blocks), a levitation field that can
// slam everything back down, a projectile-reflecting psionic barrier and a called-down meteor.
// Built only from velocity control, teleport-driven holds, safe block edits, particles, sounds
// and player animations.
import { system, EntityDamageCause } from '@minecraft/server';
import { POWERS, TUNING } from '../config.js';
import { definePower, startCooldown, abilityDef, endHold, isHolding } from '../core/powers.js';
import { rt, griefingAllowed } from '../core/state.js';
import * as V from '../core/math.js';
import * as fx from '../core/fx.js';
import {
  canAffect, creaturesNear, creatureInSight, damage, setVelocity, knockFrom, launch, lockMotion, trackThrown,
  isValid, isProjectile, isThrown, untrackThrown, eyes,
} from '../core/entities.js';
import { getBlockSafe, blockColor, isPassable } from '../core/blocks.js';
import { liftBlock, holdDebris, throwDebris, setDown, debrisInfo } from '../features/debris.js';
import { callMeteor, meteorCount, lastMeteorImpact, rayBlockPoint } from '../features/meteor.js';
import { onTick } from '../core/loop.js';

const ID = 'esper';
const T = TUNING.esper;
const COLOR = POWERS.esper.rgb;
const BRIGHT = { red: 0.92, green: 0.7, blue: 1 };

const ANIM = {
  channel: 'animation.sp.esper.channel',
  cast: 'animation.sp.esper.cast',
  barrier: 'animation.sp.esper.barrier',
};

// Local tuning (values that have no entry in config.TUNING.esper).
const BOSSES = new Set(['minecraft:ender_dragon', 'minecraft:wither', 'minecraft:warden', 'minecraft:elder_guardian']);
const ITEM_CLUSTER_RADIUS = 2.5;
const ITEM_MAX = 24;
const ITEM_RAY_PAD = 1.3; // how far from the look ray a dropped item may lie to be picked
const PUSH_STEP = 1.5; // Jump / Sneak while holding
const BLOCK_MAX_TIER = 3;
const BLOCK_THROW = { damage: 14, radius: 2.5, breakTier: 2 };
const WALL_MARGIN = 0.7; // the held object never goes deeper than this into a wall in front
const HOLD_SOUND_EVERY = 20;
const LEVITATE_REARM = 20; // short cooldown after raising the field, so the slam can follow
const LEVITATE_MAX = 32; // creatures per field
// Measured on BDS 1.26.3: a mob released from the grip loses ~45% of its launch speed on the
// first tick (stale on-ground friction) and ~9%/tick after, so a telekinetic throw is sustained
// for a few ticks to fly straight instead of flopping short of its target.
const SUSTAIN_TICKS = 6;
const SUSTAIN_DECAY = 0.96;
const SUSTAIN_GRAVITY = 0.04;
const SLAM_SPEED = 3.2;
const SLAM_TRACK_TICKS = 40;
const BARRIER_PUSH_EVERY = 5;
const BARRIER_SHIELD_EVERY = 2;
const REFLECT_SPEEDUP = 1.2;
const REFLECT_LIFT = 0.1;

/**
 * A telekinetic grip (r.data.esper.grip).
 * @typedef {Object} Grip
 * @property {'entity'|'items'|'block'} kind
 * @property {import('@minecraft/server').Entity} [entity]  held creature or block debris
 * @property {import('@minecraft/server').Entity[]} [items]
 * @property {number} dist      hold distance from the eyes
 * @property {number} half      half height of a held creature (anchor = its centre)
 * @property {string} name
 * @property {V.Vec3} anchor
 * @property {string} dimId
 * @property {number} since
 */

/**
 * @typedef {Object} Levitated
 * @property {import('@minecraft/server').Entity} e
 * @property {number} baseY
 * @property {number} phase
 * @property {number} k
 */

/**
 * Transient per-player state (r.data.esper).
 * @typedef {Object} EsperState
 * @property {Grip|null} [grip]
 * @property {{list: Map<string, Levitated>, start:number, until:number}|null} [field]
 * @property {{start:number, until:number, reflected:number}|null} [barrier]
 * @property {Map<string, number>} [reflected]  projectile id -> tick reflected
 * @property {string|null} [pose]
 * @property {any} [lastGrab]
 * @property {any} [lastRelease]
 * @property {any} [lastField]
 * @property {any} [lastSlam]
 * @property {any} [lastReflect]
 * @property {any} [lastMeteor]
 */

/** @returns {EsperState} */
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
  fx.soundTo(p, 'sp.ui.deny', 1, 0.7);
}

function isPlayerEntity(e) {
  try {
    return e.typeId === 'minecraft:player';
  } catch {
    return false;
  }
}

function healthOf(e) {
  try {
    return e.getComponent('minecraft:health')?.currentValue ?? 0;
  } catch {
    return 0;
  }
}

/** Valid and not dead. */
function alive(e) {
  if (!isValid(e)) return false;
  try {
    const h = e.getComponent('minecraft:health');
    return !h || h.currentValue > 0;
  } catch {
    return false;
  }
}

function idOf(e) {
  try {
    return e.id;
  } catch {
    return undefined;
  }
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

function r2v(v) {
  return v ? { x: round2(v.x), y: round2(v.y), z: round2(v.z) } : null;
}

function prettyId(id) {
  return id.replace(/^[a-z0-9_]+:/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function nameOf(e) {
  try {
    if (isPlayerEntity(e)) return /** @type {any} */ (e).name;
    if (e.nameTag) return e.nameTag;
    return prettyId(e.typeId);
  } catch {
    return '?';
  }
}

/** Half the eye height of a creature: teleporting to anchor - half keeps it centred on the anchor. */
function halfHeight(e) {
  try {
    return V.clamp((e.getHeadLocation().y - e.location.y) * 0.55, 0.15, 2.5);
  } catch {
    return 0.9;
  }
}

/** Velocity control that overrides a victim's own motion controller (levitation, slam, set down). */
function drive(e, v, lockTicks = 2) {
  if (isPlayerEntity(e)) launch(e, v, lockTicks);
  else setVelocity(e, v, { force: true });
}

/** Keep the looping body pose in sync with the current state (only plays on change). */
function syncPose(p, d) {
  const want = d.grip ? ANIM.channel : null;
  if (want === (d.pose ?? null)) return;
  if (want) fx.pose(p, want);
  else if (d.pose) fx.stopPose(p, d.pose);
  d.pose = want;
}

function handPos(p, look) {
  const right = V.rightOf(look);
  return V.add(V.addScaled(eyes(p), right, 0.35), { x: 0, y: -0.3, z: 0 });
}

// ------------------------------------------------------------------ telekinesis
/** Point the grip is centred on, kept out of walls in front of the player. */
function computeAnchor(p, g) {
  const eye = eyes(p);
  const look = p.getViewDirection();
  let dist = g.dist;
  try {
    const hit = p.getBlockFromViewDirection({ maxDistance: dist + 1, includeLiquidBlocks: false, includePassableBlocks: false });
    if (hit) {
      const bd = V.dist(eye, rayBlockPoint(eye, look, hit.block.location));
      dist = Math.max(1.2, Math.min(dist, bd - WALL_MARGIN));
    }
  } catch {
    /* ignore */
  }
  return V.addScaled(eye, look, dist);
}

/** Raise a held creature's feet out of solid ground (never bury it). */
function clearOfGround(dim, feet) {
  const out = { x: feet.x, y: feet.y, z: feet.z };
  for (let i = 0; i < 3; i++) {
    const b = getBlockSafe(dim, out);
    if (!b || isPassable(b)) break;
    out.y = Math.floor(out.y) + 1;
  }
  return out;
}

/** Centre of what is held (for particles). */
function gripCenter(g) {
  try {
    if (g.kind === 'entity') return V.add(g.entity.location, { x: 0, y: g.half, z: 0 });
    if (g.kind === 'block') return V.add(g.entity.location, { x: 0, y: 0.5, z: 0 });
  } catch {
    /* fall through */
  }
  return g.anchor;
}

function holdDistance(d) {
  return V.clamp(d, T.holdMinDist, T.holdMaxDist);
}

/**
 * Choose what to seize: creature > dropped items > block.
 * @returns {Grip|null|undefined} undefined = nothing there, null = refused (a hint was shown)
 */
function pickTarget(p) {
  const dim = p.dimension;
  const eye = eyes(p);
  const look = p.getViewDirection();
  const tick = system.currentTick;
  let blockHit;
  try {
    blockHit = p.getBlockFromViewDirection({ maxDistance: T.grabRange, includeLiquidBlocks: false, includePassableBlocks: false });
  } catch {
    blockHit = undefined;
  }
  const blockDist = blockHit ? V.dist(eye, rayBlockPoint(eye, look, blockHit.block.location)) : T.grabRange;
  const base = { anchor: eye, dimId: dim.id, since: tick };

  // (1) creature in sight, not hidden behind the block we look at
  const c = creatureInSight(p, T.grabRange);
  if (c) {
    const half = halfHeight(c);
    const cc = V.add(c.location, { x: 0, y: half, z: 0 });
    const cd = V.dist(eye, cc);
    if (cd <= blockDist + 1.5) {
      if (BOSSES.has(c.typeId)) {
        hint(p, '§7That mind is far too strong to seize.');
        return null;
      }
      return { ...base, kind: 'entity', entity: c, half, dist: holdDistance(cd), name: nameOf(c), anchor: cc };
    }
  }

  // (2) dropped items near the look ray, up to the first block hit
  const reach = Math.min(T.grabRange, blockDist + 0.5);
  let items = [];
  try {
    items = dim.getEntities({ type: 'minecraft:item', location: V.addScaled(eye, look, reach / 2), maxDistance: reach / 2 + ITEM_RAY_PAD + 1 });
  } catch {
    items = [];
  }
  let first, firstAlong = Infinity;
  for (const it of items) {
    let to;
    try {
      to = V.sub(V.add(it.location, { x: 0, y: 0.15, z: 0 }), eye);
    } catch {
      continue;
    }
    const along = V.dot(to, look);
    if (along < 0.5 || along > reach + 1) continue;
    const off = V.len(V.sub(to, V.scale(look, along)));
    if (off > ITEM_RAY_PAD + along * 0.03) continue;
    if (along < firstAlong) {
      first = it;
      firstAlong = along;
    }
  }
  if (first) {
    let cluster = [];
    try {
      cluster = dim.getEntities({ type: 'minecraft:item', location: first.location, maxDistance: ITEM_CLUSTER_RADIUS, closest: ITEM_MAX });
    } catch {
      cluster = [first];
    }
    if (!cluster.some((e) => e.id === first.id)) cluster.unshift(first);
    cluster = cluster.slice(0, ITEM_MAX);
    const center = first.location;
    const n = cluster.length;
    return {
      ...base, kind: 'items', items: cluster, half: 0, dist: holdDistance(V.dist(eye, center)),
      name: n === 1 ? itemName(first) : `${n} items`, anchor: center,
    };
  }

  // (3) the block we look at, lifted out of the world
  if (blockHit) {
    const b = blockHit.block;
    if (b.isAir || b.isLiquid) return undefined;
    if (!griefingAllowed()) {
      hint(p, '§7Block telekinesis is disabled in this world (griefing off).');
      return null;
    }
    let blockName = 'Block';
    try {
      blockName = prettyId(b.typeId);
    } catch {
      /* ignore */
    }
    const center = V.centerOf(b.location);
    const e = liftBlock(b, p, BLOCK_MAX_TIER);
    if (!e) {
      hint(p, '§7That block is anchored too firmly to lift.');
      return null;
    }
    return { ...base, kind: 'block', entity: e, half: 0.5, dist: holdDistance(V.dist(eye, center)), name: blockName, anchor: center };
  }
  return undefined;
}

function itemName(it) {
  try {
    const st = it.getComponent('minecraft:item')?.itemStack;
    if (st) return `${st.amount > 1 ? `${st.amount}x ` : ''}${prettyId(st.typeId)}`;
  } catch {
    /* ignore */
  }
  return 'Item';
}

function grab(p, d) {
  const g = pickTarget(p);
  if (g === undefined) hint(p, '§7Nothing to seize: aim at a creature, dropped items or a block.');
  if (!g) return false;
  const tick = system.currentTick;
  d.grip = g;
  // a creature taken out of the levitation field / mid-flight belongs to the grip now
  if (g.kind === 'entity') {
    const id = g.entity.id;
    if (d.field) d.field.list.delete(id);
    untrackThrown(id);
    for (let i = flights.length - 1; i >= 0; i--) if (idOf(flights[i].e) === id) flights.splice(i, 1);
    for (let i = slams.length - 1; i >= 0; i--) if (idOf(slams[i].e) === id) slams.splice(i, 1);
  }
  if (g.kind === 'block') {
    holdDebris(g.entity, () => (d.grip === g ? V.sub(g.anchor, { x: 0, y: 0.5, z: 0 }) : undefined));
  }
  g.anchor = computeAnchor(p, g);
  const at = gripCenter(g);
  const dim = p.dimension;
  fx.particle(dim, 'sp:psi_aura', at, { color: COLOR });
  fx.particle(dim, 'sp:shockwave_air', at, { radius: 1.2, color: COLOR });
  fx.sound(dim, 'sp.esper.grab', at, 1, 1);
  fx.soundTo(p, 'sp.esper.grab', 1.1, 0.6);
  syncPose(p, d);
  d.lastGrab = { tick, kind: g.kind, name: g.name, dist: round2(g.dist), count: g.items?.length ?? 1, id: g.entity?.id ?? null };
  return true;
}

function gripTick(p, r, d, tick) {
  const g = d.grip;
  if (!isHolding(p, ID, 'telekinesis')) {
    // the hold was taken over without a holdEnd (should not happen): let go gently
    releaseGrip(p, d, 'drop');
    syncPose(p, d);
    return;
  }
  if (g.dimId !== p.dimension.id) {
    endHold(p, 'interrupted');
    return;
  }
  if (g.kind === 'items') {
    g.items = g.items.filter((e) => isValid(e));
    if (!g.items.length) {
      endHold(p, 'interrupted');
      return;
    }
  } else if (!alive(g.entity) || (g.kind === 'entity' && (tick - g.since) % 10 === 9 && !canAffect(p, g.entity))) {
    endHold(p, 'interrupted');
    return;
  }
  const anchor = (g.anchor = computeAnchor(p, g));
  let target = anchor;
  if (g.kind === 'entity') {
    const e = g.entity;
    const feet = clearOfGround(p.dimension, V.sub(anchor, { x: 0, y: g.half, z: 0 }));
    target = V.add(feet, { x: 0, y: g.half, z: 0 });
    try {
      e.teleport(feet, { keepVelocity: false });
    } catch {
      /* ignore */
    }
    // a held player's own powers must not fight the grip
    if (isPlayerEntity(e)) lockMotion(e, 3, 'external');
  } else if (g.kind === 'items') {
    const n = g.items.length;
    const spin = (tick - g.since) * 0.15;
    for (let i = 0; i < n; i++) {
      const a = spin + (i / n) * Math.PI * 2;
      const rad = n === 1 ? 0 : 0.3 + 0.15 * (i % 3);
      const off = { x: Math.cos(a) * rad, y: Math.sin(spin * 0.7 + i) * 0.15 - 0.15, z: Math.sin(a) * rad };
      try {
        g.items[i].teleport(V.add(anchor, off), { keepVelocity: false });
      } catch {
        /* ignore */
      }
    }
  } else {
    // block debris follows g.anchor through holdDebris; keep it from expiring while held
    const info = debrisInfo(g.entity);
    if (info) info.expires = Math.max(info.expires, tick + 200);
  }
  if (tick % 2 === 0) {
    const dim = p.dimension;
    fx.particle(dim, 'sp:psi_aura', target, { color: COLOR });
    const hand = handPos(p, p.getViewDirection());
    const span = V.sub(target, hand);
    const len = V.len(span);
    if (len > 0.3) fx.particle(dim, 'sp:psi_link', V.lerpV(hand, target, 0.5), { dir: V.scale(span, 1 / len), len, color: COLOR });
  }
  if (tick > g.since && (tick - g.since) % HOLD_SOUND_EVERY === 0) fx.sound(p.dimension, 'sp.esper.hold', anchor, 0.9 + Math.random() * 0.15, 0.7);
}

/**
 * Let go of the grip gently. `p` may be undefined (player gone): only world state is touched.
 * @param {any} p
 * @param {EsperState} d
 */
function releaseGrip(p, d, why = 'drop') {
  const g = d.grip;
  d.grip = null;
  if (!g) return;
  const tick = system.currentTick;
  const at = g.anchor;
  if (g.kind === 'entity') {
    if (alive(g.entity)) drive(g.entity, { x: 0, y: -0.15, z: 0 }, 1);
  } else if (g.kind === 'block') {
    if (isValid(g.entity)) setDown(g.entity, at);
  }
  // items: left where they float, gravity takes over
  try {
    const dim = g.entity && isValid(g.entity) ? g.entity.dimension : p?.dimension;
    if (dim) {
      fx.sound(dim, 'sp.esper.drop', at, 1, 0.9);
      fx.particle(dim, 'sp:psi_aura', at, { color: COLOR });
    }
  } catch {
    /* ignore */
  }
  d.lastRelease = { tick, mode: 'drop', why, kind: g.kind, at: r2v(at) };
}

function launchGrip(p, d) {
  const g = d.grip;
  d.grip = null;
  if (!g) return;
  const tick = system.currentTick;
  const dim = p.dimension;
  const look = p.getViewDirection();
  const pv = velocityOf(p);
  const v = V.add(V.scale(look, T.launchSpeed), pv);
  const speed = V.len(v);
  const at = gripCenter(g);
  if (g.kind === 'entity') {
    const e = g.entity;
    if (alive(e)) {
      launch(e, v, 6);
      trackThrown(e, p, { damagePerSpeed: T.launchDamagePerSpeed, ticks: 100, initialSpeed: speed });
      sustainFlight(e, v);
    }
  } else if (g.kind === 'items') {
    for (const it of g.items) {
      if (!isValid(it)) continue;
      const spread = { x: (Math.random() - 0.5) * 0.3, y: Math.random() * 0.15, z: (Math.random() - 0.5) * 0.3 };
      try {
        it.clearVelocity();
        it.applyImpulse(V.add(v, spread));
      } catch {
        /* ignore */
      }
    }
  } else if (isValid(g.entity)) {
    throwDebris(g.entity, v, { owner: p, ...BLOCK_THROW, breakTier: griefingAllowed() ? BLOCK_THROW.breakTier : 0, placeOnLand: true });
  }
  fx.particle(dim, 'sp:shockwave_air', at, { radius: 1.8, color: COLOR });
  fx.particle(dim, 'sp:psi_aura', at, { color: BRIGHT });
  fx.sound(dim, 'sp.esper.launch', at, 0.95 + Math.random() * 0.1, 1.2);
  fx.anim(p, ANIM.cast);
  fx.shake(p, 0.1, 0.15);
  d.lastRelease = { tick, mode: 'launch', kind: g.kind, speed: round2(speed), v: r2v(v), at: r2v(at) };
}

/** @type {{e: import('@minecraft/server').Entity, v: V.Vec3, last: V.Vec3, start: number}[]} */
const flights = [];

function sustainFlight(e, v) {
  let last;
  try {
    last = e.location;
  } catch {
    return;
  }
  flights.push({ e, v, last, start: system.currentTick });
}

/**
 * Keep a thrown creature on its telekinetic trajectory for SUSTAIN_TICKS. Runs as a global
 * ticker, i.e. after the thrown-object tracker read this tick's real velocity, so wall impacts
 * are still detected; stops as soon as the creature is blocked or has hit something.
 */
function tickFlights(tick) {
  for (let i = flights.length - 1; i >= 0; i--) {
    const f = flights[i];
    if (!alive(f.e) || !isThrown(f.e) || tick - f.start > SUSTAIN_TICKS) {
      flights.splice(i, 1);
      continue;
    }
    let pos;
    try {
      pos = f.e.location;
    } catch {
      flights.splice(i, 1);
      continue;
    }
    const moved = V.dist(pos, f.last);
    f.last = pos;
    if (tick - f.start >= 2 && moved < 0.35 * V.len(f.v)) {
      flights.splice(i, 1); // blocked by terrain
      continue;
    }
    if (tick <= f.start) continue;
    f.v = { x: f.v.x * SUSTAIN_DECAY, y: f.v.y * SUSTAIN_DECAY - SUSTAIN_GRAVITY, z: f.v.z * SUSTAIN_DECAY };
    drive(f.e, f.v, 2);
  }
}

onTick('esper.flights', tickFlights);

// ------------------------------------------------------------------ levitation field
function startField(p, d, tick) {
  const dim = p.dimension;
  const feet = p.location;
  const heldId = d.grip?.entity?.id;
  let list = creaturesNear(dim, feet, T.levitateRadius, p).filter((e) => !BOSSES.has(e.typeId) && e.id !== heldId);
  if (!list.length) {
    hint(p, '§7No creatures within reach to lift.');
    return false;
  }
  if (list.length > LEVITATE_MAX) {
    list = list
      .map((e) => ({ e, d2: V.distSq(e.location, feet) }))
      .sort((a, b) => a.d2 - b.d2)
      .slice(0, LEVITATE_MAX)
      .map((x) => x.e);
  }
  const map = new Map();
  let k = 0;
  for (const e of list) {
    let y;
    try {
      y = e.location.y;
    } catch {
      continue;
    }
    map.set(e.id, { e, baseY: y + T.levitateHeight, phase: Math.random() * Math.PI * 2, k: k++ });
  }
  d.field = { list: map, start: tick, until: tick + T.levitateTicks };
  fx.sound(dim, 'sp.esper.levitate', feet, 1, 1.2);
  fx.anim(p, ANIM.cast);
  fx.particle(dim, 'sp:shockwave', { x: feet.x, y: feet.y + 0.1, z: feet.z }, { radius: T.levitateRadius, color: COLOR });
  fx.particle(dim, 'sp:psi_aura', V.add(feet, { x: 0, y: 1, z: 0 }), { color: COLOR });
  for (const L of map.values()) {
    try {
      fx.particle(dim, 'sp:levitate', L.e.location, { color: COLOR });
    } catch {
      /* ignore */
    }
  }
  d.lastField = { tick, count: map.size };
  return LEVITATE_REARM;
}

function fieldTick(p, d, tick) {
  const F = d.field;
  if (tick >= F.until) {
    endField(p, d, 'expired');
    return;
  }
  const t = tick - F.start;
  for (const [id, L] of F.list) {
    const e = L.e;
    if (!alive(e)) {
      F.list.delete(id);
      continue;
    }
    let loc, v;
    try {
      loc = e.location;
      v = e.getVelocity();
    } catch {
      F.list.delete(id);
      continue;
    }
    const want = L.baseY + Math.sin(t * 0.12 + L.phase) * 0.35;
    const vy = V.clamp((want - loc.y) * 0.25, -0.4, 0.5);
    const drift = 0.025;
    drive(e, {
      x: v.x * 0.5 + Math.cos(t * 0.05 + L.phase) * drift,
      y: vy,
      z: v.z * 0.5 + Math.sin(t * 0.05 + L.phase) * drift,
    });
    if ((t + L.k) % 3 === 0) fx.particle(e.dimension, 'sp:levitate', loc, { color: COLOR });
  }
  if (!F.list.size) endField(p, d, 'empty');
}

/** End the field: creatures simply drop. `why` expired/empty start the config cooldown. */
function endField(p, d, why) {
  const F = d.field;
  d.field = null;
  if (!F) return;
  if (p && (why === 'expired' || why === 'empty' || why === 'death' || why === 'dimension')) {
    startCooldown(p, ID, 'levitation', abilityDef(ID, 'levitation')?.cooldown ?? 240);
  }
  d.lastField = { ...(d.lastField ?? {}), ended: system.currentTick, why };
}

/** @type {{e: import('@minecraft/server').Entity, caster: any, start:number, until:number}[]} */
const slams = [];

function slam(p, d, tick) {
  const F = d.field;
  d.field = null;
  const dim = p.dimension;
  let n = 0;
  for (const L of F.list.values()) {
    if (!alive(L.e)) continue;
    drive(L.e, { x: 0, y: -SLAM_SPEED, z: 0 }, 6);
    slams.push({ e: L.e, caster: p, start: tick, until: tick + SLAM_TRACK_TICKS });
    try {
      fx.particle(dim, 'sp:wind_streak', V.add(L.e.location, { x: 0, y: 0.6, z: 0 }), { dir: { x: 0, y: -1, z: 0 }, len: 3 });
    } catch {
      /* ignore */
    }
    n++;
  }
  fx.anim(p, ANIM.cast);
  fx.sound(dim, 'sp.esper.launch', p.location, 0.7, 1);
  d.lastSlam = { tick, count: n, landed: 0 };
  return abilityDef(ID, 'levitation')?.cooldown ?? 240;
}

function slamImpact(s) {
  const e = s.e;
  let at;
  try {
    at = e.location;
  } catch {
    return;
  }
  const dim = e.dimension;
  const caster = isValid(s.caster) ? s.caster : undefined;
  if (!caster || canAffect(caster, e)) damage(e, T.slamDamage, caster, EntityDamageCause.entityAttack);
  const ground = getBlockSafe(dim, { x: at.x, y: at.y - 0.5, z: at.z });
  const col = ground && !ground.isAir ? blockColor(ground) : { red: 0.5, green: 0.48, blue: 0.45 };
  const flat = { x: at.x, y: at.y + 0.1, z: at.z };
  fx.particle(dim, 'sp:shockwave', flat, { radius: 3, color: COLOR });
  fx.particle(dim, 'sp:debris_chunks', flat, { color: col, size: 0.8 });
  fx.particle(dim, 'sp:dust', flat, { color: col });
  fx.sound(dim, 'sp.esper.slam', at, 0.9 + Math.random() * 0.2, 1.3);
  fx.shakeArea(dim, at, 16, 0.5, 0.35);
  if (caster) {
    const d = rt(caster).data[ID];
    if (d?.lastSlam) d.lastSlam.landed++;
  }
}

/** Slammed creatures are world state: they land even if the caster is gone. */
function tickSlams(tick) {
  for (let i = slams.length - 1; i >= 0; i--) {
    const s = slams[i];
    if (!alive(s.e)) {
      slams.splice(i, 1);
      continue;
    }
    let landed = false;
    let v;
    try {
      v = s.e.getVelocity();
      landed = tick >= s.start + 2 && (s.e.isOnGround || v.y > -0.05);
    } catch {
      slams.splice(i, 1);
      continue;
    }
    if (landed || tick >= s.until) {
      slams.splice(i, 1);
      slamImpact(s);
    } else if (tick > s.start) {
      // keep driving it down until it hits something
      drive(s.e, { x: v.x * 0.5, y: Math.min(v.y, -SLAM_SPEED * 0.8), z: v.z * 0.5 }, 2);
    }
  }
}

onTick('esper.slam', tickSlams);

// ------------------------------------------------------------------ psionic barrier
function barrierCenter(p) {
  return V.add(p.location, { x: 0, y: 0.9, z: 0 });
}

function barrierOn(p, d, tick) {
  d.barrier = { start: tick, until: tick + T.barrierTicks, reflected: 0 };
  const c = barrierCenter(p);
  fx.sound(p.dimension, 'sp.esper.barrier_up', c, 1, 1.2);
  fx.anim(p, ANIM.barrier);
  fx.particle(p.dimension, 'sp:psi_shield', c, { radius: T.barrierRadius });
  fx.particle(p.dimension, 'sp:shockwave_air', c, { radius: T.barrierRadius, color: COLOR });
  return 0; // the cooldown starts when the barrier drops
}

/** Drop the barrier; `p` undefined = player gone (no effects). */
function barrierOff(p, d, cooldown) {
  d.barrier = null;
  if (!p) return;
  fx.sound(p.dimension, 'sp.esper.barrier_down', barrierCenter(p), 1, 1);
  if (cooldown) startCooldown(p, ID, 'barrier', abilityDef(ID, 'barrier')?.cooldown ?? 300);
}

function projectileOwnerId(e) {
  try {
    return e.getComponent('minecraft:projectile')?.owner?.id;
  } catch {
    return undefined;
  }
}

function barrierTick(p, d, tick) {
  const B = d.barrier;
  if (tick >= B.until) {
    barrierOff(p, d, true);
    return;
  }
  const dim = p.dimension;
  const c = barrierCenter(p);
  const R = T.barrierRadius;
  if (tick % BARRIER_SHIELD_EVERY === 0) fx.particle(dim, 'sp:psi_shield', c, { radius: R });
  d.reflected ??= new Map();
  if (d.reflected.size > 32) for (const [k, t] of d.reflected) if (tick - t > 100) d.reflected.delete(k);
  let list = [];
  try {
    list = dim.getEntities({ location: c, maxDistance: R + 3, excludeTypes: ['minecraft:player', 'minecraft:item', 'minecraft:xp_orb'] });
  } catch {
    list = [];
  }
  for (const e of list) {
    if (!isProjectile(e) || d.reflected.has(e.id)) continue;
    if (projectileOwnerId(e) === p.id) continue;
    let pos;
    try {
      pos = e.location;
    } catch {
      continue;
    }
    const v = velocityOf(e);
    const s = V.len(v);
    if (s < 0.05) continue; // stuck in the ground / resting
    const rel = V.sub(c, pos);
    if (V.dot(rel, v) <= 0) continue; // heading away
    const dist = V.len(rel);
    if (dist > R && dist - s * 1.5 > R) continue; // not reaching the shell yet
    const tc = V.dot(rel, v) / (s * s);
    if (V.len(V.sub(rel, V.scale(v, tc))) > R) continue; // passes by outside the shell
    reflect(p, d, e, v, c, pos, dist, tick);
  }
  if (tick % BARRIER_PUSH_EVERY === 0) {
    const heldId = d.grip?.entity?.id;
    for (const e of creaturesNear(dim, c, R * 0.6, p)) {
      if (e.id === heldId) continue;
      knockFrom(e, c, 0.7, 0.25);
      fx.particle(dim, 'sp:reflect', V.lerpV(c, V.add(e.location, { x: 0, y: 0.9, z: 0 }), 0.7));
    }
  }
}

function reflect(p, d, e, v, c, pos, dist, tick) {
  const R = T.barrierRadius;
  const nv = V.add(V.scale(v, -REFLECT_SPEEDUP), { x: 0, y: REFLECT_LIFT, z: 0 });
  const comp = (() => {
    try {
      return e.getComponent('minecraft:projectile');
    } catch {
      return undefined;
    }
  })();
  try {
    if (comp) comp.owner = p; // the reflected projectile is credited to the esper
  } catch {
    /* ignore */
  }
  let ok = true;
  try {
    e.clearVelocity();
    e.applyImpulse(nv);
  } catch {
    ok = false;
  }
  if (!ok) {
    try {
      comp?.shoot(nv);
      ok = true;
    } catch {
      /* ignore */
    }
  }
  d.reflected.set(e.id, tick);
  const contact = dist > R ? V.addScaled(c, V.norm(V.sub(pos, c)), R) : pos;
  const dim = p.dimension;
  fx.particle(dim, 'sp:reflect', contact);
  fx.sound(dim, 'sp.esper.reflect', contact, 0.9 + Math.random() * 0.2, 1);
  d.barrier.reflected++;
  d.lastReflect = { tick, type: e.typeId, ok, from: r2v(v), to: r2v(nv) };
}

// ------------------------------------------------------------------ meteor call
function meteorCall(p, d, tick) {
  let hit;
  try {
    hit = p.getBlockFromViewDirection({ maxDistance: T.meteorRange, includeLiquidBlocks: true, includePassableBlocks: false });
  } catch {
    hit = undefined;
  }
  if (!hit) {
    hint(p, `§7Look at the ground (within ${T.meteorRange} blocks) to call a meteor onto it.`);
    return false;
  }
  const target = rayBlockPoint(eyes(p), p.getViewDirection(), hit.block.location);
  if (!callMeteor(p, target, T.meteorDelay)) {
    hint(p, '§7The sky is already full of meteors.');
    return false;
  }
  fx.anim(p, ANIM.cast);
  fx.particle(p.dimension, 'sp:psi_aura', handPos(p, p.getViewDirection()), { color: COLOR });
  d.lastMeteor = { tick, target: r2v(target), block: r2v(hit.block.location), face: r2v(hit.faceLocation) };
  return true;
}

// ------------------------------------------------------------------ lifecycle
/** mode: lose | death | dimension | leave */
function cleanup(p, r, mode) {
  const d = r.data[ID];
  if (!d) return;
  const player = mode === 'leave' ? undefined : p;
  if (d.grip) releaseGrip(player, d, mode);
  if (d.field) endField(mode === 'lose' ? undefined : player, d, mode);
  if (d.barrier) barrierOff(player, d, mode === 'death' || mode === 'dimension');
  d.reflected?.clear();
  if (player && d.pose) fx.stopPose(player, d.pose);
  d.pose = null;
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
    if (d.grip) gripTick(p, r, d, tick);
    if (d.field) fieldTick(p, d, tick);
    if (d.barrier) barrierTick(p, d, tick);
    syncPose(p, d);
  },

  activate(p, r, abilityId) {
    const d = state(r);
    const tick = system.currentTick;
    switch (abilityId) {
      case 'levitation':
        return d.field ? slam(p, d, tick) : startField(p, d, tick);
      case 'barrier':
        if (d.barrier) {
          barrierOff(p, d, true);
          return true;
        }
        return barrierOn(p, d, tick);
      case 'meteor':
        return meteorCall(p, d, tick);
      default:
        return false;
    }
  },

  holdStart(p, r, abilityId) {
    if (abilityId !== 'telekinesis') return false;
    const d = state(r);
    if (d.grip) releaseGrip(p, d, 'replaced');
    return grab(p, d);
  },

  holdEnd(p, r, abilityId, info) {
    if (abilityId !== 'telekinesis') return;
    const d = state(r);
    if (!d.grip) return;
    if (info.sneaking || info.reason !== 'release') releaseGrip(p, d, info.reason);
    else launchGrip(p, d);
    syncPose(p, d);
  },

  onButton(p, r, button, pressed) {
    const d = r.data[ID];
    if (!pressed || !d?.grip) return;
    const g = d.grip;
    const before = g.dist;
    if (button === 'Jump') g.dist = Math.min(T.holdMaxDist, g.dist + PUSH_STEP);
    else if (button === 'Sneak') g.dist = Math.max(T.holdMinDist, g.dist - PUSH_STEP);
    if (g.dist !== before) fx.soundTo(p, 'sp.ui.select', button === 'Jump' ? 1.3 : 0.8, 0.5);
  },

  hud(p, r) {
    const d = r.data[ID];
    if (!d) return undefined;
    const now = system.currentTick;
    const parts = [];
    if (d.grip) parts.push(`§dTelekinesis §f${d.grip.name} §7${d.grip.dist.toFixed(1)}m`);
    if (d.barrier) parts.push(`§dBarrier §f${(Math.max(0, d.barrier.until - now) / 20).toFixed(1)}s`);
    if (d.field) parts.push(`§dLevitating §f${d.field.list.size} §7${(Math.max(0, d.field.until - now) / 20).toFixed(1)}s - Use to slam`);
    return parts.length ? parts.join(' §8| ') : undefined;
  },

  isToggled(p, r, abilityId) {
    const d = r.data[ID];
    if (abilityId === 'barrier') return !!d?.barrier;
    if (abilityId === 'levitation') return !!d?.field;
    return false;
  },

  flags(p, r) {
    const d = r.data[ID];
    const up = !!d?.barrier;
    return { dodge: up, blastproof: up };
  },

  debug(p, r) {
    const d = r.data[ID] ?? {};
    const g = d.grip;
    return {
      holding: g ? g.kind : null,
      dist: g ? round2(g.dist) : 0,
      target: g ? g.entity?.id ?? null : null,
      items: g?.items?.length ?? 0,
      anchor: g ? r2v(g.anchor) : null,
      levitating: d.field ? d.field.list.size : 0,
      barrier: !!d.barrier,
      reflected: d.barrier?.reflected ?? 0,
      meteors: meteorCount(p.id),
      pose: d.pose ?? null,
      lastGrab: d.lastGrab ?? null,
      lastRelease: d.lastRelease ?? null,
      lastField: d.lastField ?? null,
      lastSlam: d.lastSlam ?? null,
      lastReflect: d.lastReflect ?? null,
      lastMeteor: d.lastMeteor ?? null,
      lastImpact: lastMeteorImpact(p.id),
    };
  },
});
