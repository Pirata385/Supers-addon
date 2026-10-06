// Power registry, lifecycle (grant / revoke), ability activation and immunity tags.
import { world, system, ItemStack, ItemLockMode } from '@minecraft/server';
import { POWERS, POWER_IDS, MAX_POWERS, IMMUNITY_TAGS, GLYPH } from '../config.js';
import { rt, savePowers, selectedAbility, pdata, discover } from './state.js';
import * as fx from './fx.js';

/**
 * @typedef {import('@minecraft/server').Player} Player
 * @typedef {Object} PowerHandlers
 * @property {(p:Player, r:any) => void} [onGain]       Power just granted.
 * @property {(p:Player, r:any) => void} [onLose]       Power removed: undo every side effect.
 * @property {(p:Player, r:any) => void} [onJoin]       Player (re)joined with this power.
 * @property {(p:Player, r:any, tick:number) => void} [tick]    Every tick.
 * @property {(p:Player, r:any, abilityId:string) => boolean|number|void} [activate]
 *   instant/toggle abilities. Return false = not executed (no cooldown); a number = custom cooldown ticks.
 * @property {(p:Player, r:any, abilityId:string) => boolean} [holdStart]  hold abilities; false = rejected.
 * @property {(p:Player, r:any, abilityId:string, info:{duration:number, sneaking:boolean, reason:string}) => void} [holdEnd]
 * @property {(p:Player, r:any, button:string, pressed:boolean, tick:number) => void} [onButton]
 * @property {(p:Player, r:any, target:import('@minecraft/server').Entity) => void} [onMelee]
 * @property {(p:Player, r:any) => string|undefined} [hud]  status line for the action bar
 * @property {(p:Player, r:any) => Record<string, boolean>} [flags]  immunity flags (see IMMUNITY_TAGS keys)
 * @property {(p:Player, r:any, abilityId:string) => boolean} [isToggled]  HUD shows ON for active toggles
 * @property {(p:Player, r:any) => void} [onDeath]
 * @property {(p:Player, r:any) => void} [onDimensionChange]
 * @property {(p:Player, r:any) => void} [onLeave]  runs one tick after leaving: only touch world state you own
 * @property {(p:Player, r:any) => any} [debug]  JSON snapshot for tests
 */

/** @type {Map<string, PowerHandlers>} */
const handlers = new Map();

/** Register behaviour for a power id declared in config.POWERS. */
export function definePower(id, h) {
  if (!POWERS[id]) throw new Error(`Unknown power ${id}`);
  handlers.set(id, h);
}

export function handlersOf(id) {
  return handlers.get(id) ?? {};
}

export function cdKey(power, ability) {
  return `${power}.${ability}`;
}

export function cooldownLeft(player, power, ability) {
  const ready = rt(player).cd[cdKey(power, ability)] ?? 0;
  return Math.max(0, ready - system.currentTick);
}

export function startCooldown(player, power, ability, ticks) {
  rt(player).cd[cdKey(power, ability)] = system.currentTick + Math.max(0, Math.round(ticks));
}

export function abilityDef(power, ability) {
  return POWERS[power]?.abilities.find((a) => a.id === ability);
}

// ------------------------------------------------------------------ emblems
function findEmblemSlots(player, itemId) {
  const slots = [];
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    if (!inv) return slots;
    for (let i = 0; i < inv.size; i++) {
      const it = inv.getItem(i);
      if (it?.typeId === itemId) slots.push(i);
    }
  } catch {
    /* ignore */
  }
  return slots;
}

export function hasEmblem(player, power) {
  if (findEmblemSlots(player, POWERS[power].emblem).length) return true;
  try {
    const off = player.getComponent('minecraft:equippable')?.getEquipment('Offhand');
    return off?.typeId === POWERS[power].emblem;
  } catch {
    return false;
  }
}

export function giveEmblem(player, power) {
  const def = POWERS[power];
  const item = new ItemStack(def.emblem, 1);
  item.lockMode = ItemLockMode.inventory;
  item.keepOnDeath = true;
  item.setLore([`§r${def.color}${def.tagline}`, '§r§7Use: activate ability', '§r§7Sneak + Use: switch ability']);
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    const left = inv?.addItem(item);
    if (left) player.dimension.spawnItem(left, player.location);
  } catch {
    try {
      player.dimension.spawnItem(item, player.location);
    } catch {
      /* ignore */
    }
  }
}

function removeEmblems(player, power) {
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    for (const i of findEmblemSlots(player, POWERS[power].emblem)) inv?.setItem(i, undefined);
    const eq = player.getComponent('minecraft:equippable');
    if (eq?.getEquipment('Offhand')?.typeId === POWERS[power].emblem) eq.setEquipment('Offhand', undefined);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ lifecycle
/**
 * Grant a power. Returns {ok:true} or {ok:false, reason:'unknown'|'owned'|'full'}.
 * @param {Player} player
 */
export function grantPower(player, power, opts = {}) {
  const r = rt(player);
  if (!POWERS[power]) return { ok: false, reason: 'unknown' };
  if (r.powers.includes(power)) return { ok: false, reason: 'owned' };
  if (r.powers.length >= MAX_POWERS) return { ok: false, reason: 'full' };
  r.powers.push(power);
  r.powers.sort((a, b) => POWER_IDS.indexOf(a) - POWER_IDS.indexOf(b));
  savePowers(player);
  try {
    player.addTag(`sp_has_${power}`);
  } catch {
    /* ignore */
  }
  if (opts.emblem !== false) giveEmblem(player, power);
  discover(player, `power:${power}`);
  try {
    handlersOf(power).onGain?.(player, r);
  } catch (e) {
    console.warn(`[SP] onGain ${power}: ${e}`);
  }
  if (!opts.silent) {
    const def = POWERS[power];
    fx.title(player, `${def.color}§l${def.name}`, `§r§f${GLYPH[power]} §7${def.tagline}`, 5, 50, 15);
    fx.particle(player.dimension, 'sp:power_gain', player.location, { color: def.rgb });
    fx.sound(player.dimension, 'sp.power.gain', player.location);
    player.sendMessage(`§8[§5Mutagen§8]§r ${def.color}${def.name}§r awakened (${r.powers.length}/${MAX_POWERS}). Hold its emblem and press Use; Sneak + Use switches ability.`);
  }
  return { ok: true };
}

/** Remove one power and undo all its effects. */
export function revokePower(player, power, opts = {}) {
  const r = rt(player);
  if (!r.powers.includes(power)) return false;
  if (r.hold?.power === power) endHold(player, 'revoked');
  try {
    handlersOf(power).onLose?.(player, r);
  } catch (e) {
    console.warn(`[SP] onLose ${power}: ${e}`);
  }
  delete r.data[power];
  r.powers = r.powers.filter((p) => p !== power);
  savePowers(player);
  try {
    player.removeTag(`sp_has_${power}`);
  } catch {
    /* ignore */
  }
  removeEmblems(player, power);
  for (const k of Object.keys(r.cd)) if (k.startsWith(`${power}.`)) delete r.cd[k];
  updateImmunity(player, r);
  if (!opts.silent) {
    fx.sound(player.dimension, 'sp.power.lose', player.location);
  }
  return true;
}

export function revokeAll(player, opts = {}) {
  const list = [...rt(player).powers];
  for (const p of list) revokePower(player, p, { silent: true });
  if (!opts.silent && list.length) {
    fx.particle(player.dimension, 'sp:power_purge', player.location);
    fx.sound(player.dimension, 'sp.power.purge', player.location);
    fx.title(player, '§7§lPowers Suppressed', '§8Your cells return to baseline human.', 5, 50, 15);
  }
  return list.length;
}

/** Called when a player joins / respawns: re-apply tags and passive state. */
export function restorePlayer(player) {
  const r = rt(player);
  for (const id of POWER_IDS) {
    try {
      if (r.powers.includes(id)) player.addTag(`sp_has_${id}`);
      else player.removeTag(`sp_has_${id}`);
    } catch {
      /* ignore */
    }
  }
  // Clear stale transient tags; updateImmunity re-adds what is needed.
  for (const tag of Object.values(IMMUNITY_TAGS)) {
    try {
      player.removeTag(tag);
    } catch {
      /* ignore */
    }
  }
  r.tags.clear();
  for (const id of r.powers) {
    try {
      handlersOf(id).onJoin?.(player, r);
    } catch (e) {
      console.warn(`[SP] onJoin ${id}: ${e}`);
    }
  }
  updateImmunity(player, r);
}

// ------------------------------------------------------------------ immunity tags
/** Temporary flags set by abilities (e.g. "nofall for the next 3 seconds"). */
export function grantTemporaryFlag(player, flag, ticks) {
  const r = rt(player);
  r.input.tempFlags ??= {};
  r.input.tempFlags[flag] = Math.max(r.input.tempFlags[flag] ?? 0, system.currentTick + ticks);
  updateImmunity(player, r);
}

export function updateImmunity(player, r = rt(player)) {
  const want = new Set();
  for (const id of r.powers) {
    let f;
    try {
      f = handlersOf(id).flags?.(player, r);
    } catch {
      f = undefined;
    }
    if (f) for (const k in f) if (f[k] && IMMUNITY_TAGS[k]) want.add(IMMUNITY_TAGS[k]);
  }
  const tf = r.input.tempFlags;
  if (tf) {
    for (const k in tf) {
      if (tf[k] > system.currentTick) want.add(IMMUNITY_TAGS[k]);
      else delete tf[k];
    }
  }
  for (const tag of r.tags) {
    if (!want.has(tag)) {
      try {
        player.removeTag(tag);
      } catch {
        /* ignore */
      }
    }
  }
  for (const tag of want) {
    if (!r.tags.has(tag)) {
      try {
        player.addTag(tag);
      } catch {
        /* ignore */
      }
    }
  }
  r.tags = want;
}

// ------------------------------------------------------------------ ability activation
function deny(player, msg) {
  fx.soundTo(player, 'sp.ui.deny', 1, 0.7);
  try {
    player.onScreenDisplay.setActionBar(msg);
  } catch {
    /* ignore */
  }
}

/** Run an instant/toggle ability with cooldown handling. Returns true if it fired. */
export function tryActivate(player, power, ability) {
  const r = rt(player);
  if (!r.powers.includes(power)) return false;
  const def = abilityDef(power, ability);
  if (!def) return false;
  const left = cooldownLeft(player, power, ability);
  if (left > 0) {
    deny(player, `§c${GLYPH.cooldown} ${def.name} recharging: ${(left / 20).toFixed(1)}s`);
    return false;
  }
  let result;
  try {
    result = handlersOf(power).activate?.(player, r, ability);
  } catch (e) {
    console.warn(`[SP] ${power}.${ability} failed: ${e}\n${e?.stack ?? ''}`);
    return false;
  }
  if (result === false) return false;
  if (typeof result === 'number') startCooldown(player, power, ability, result);
  else if (def.mode === 'instant') startCooldown(player, power, ability, def.cooldown);
  return true;
}

/** Start a hold ability. */
export function beginHold(player, power, ability) {
  const r = rt(player);
  if (r.hold) endHold(player, 'replaced');
  const def = abilityDef(power, ability);
  if (!def || !r.powers.includes(power)) return false;
  const left = cooldownLeft(player, power, ability);
  if (left > 0) {
    deny(player, `§c${GLYPH.cooldown} ${def.name} recharging: ${(left / 20).toFixed(1)}s`);
    return false;
  }
  r.hold = { power, ability, start: system.currentTick, slot: player.selectedSlotIndex };
  let ok;
  try {
    ok = handlersOf(power).holdStart?.(player, r, ability);
  } catch (e) {
    console.warn(`[SP] holdStart ${power}.${ability}: ${e}\n${e?.stack ?? ''}`);
    ok = false;
  }
  if (ok === false) {
    r.hold = null;
    return false;
  }
  return true;
}

/** End the current hold ability (release, switch item, death, ...). */
export function endHold(player, reason = 'release', sneaking = undefined) {
  const r = rt(player);
  const h = r.hold;
  if (!h) return;
  r.hold = null;
  const info = { duration: system.currentTick - h.start, sneaking: sneaking ?? safeSneaking(player), reason };
  try {
    handlersOf(h.power).holdEnd?.(player, r, h.ability, info);
  } catch (e) {
    console.warn(`[SP] holdEnd ${h.power}.${h.ability}: ${e}\n${e?.stack ?? ''}`);
  }
  const def = abilityDef(h.power, h.ability);
  if (def && cooldownLeft(player, h.power, h.ability) === 0 && reason !== 'revoked') {
    startCooldown(player, h.power, h.ability, def.cooldown);
  }
}

export function isHolding(player, power, ability) {
  const h = rt(player).hold;
  return !!h && h.power === power && (!ability || h.ability === ability);
}

function safeSneaking(player) {
  try {
    return player.isSneaking;
  } catch {
    return false;
  }
}

/** Selected ability for the emblem the player is holding, if any. */
export function heldEmblemPower(player) {
  try {
    const item = player.getComponent('minecraft:inventory')?.container?.getItem(player.selectedSlotIndex);
    if (!item) return undefined;
    for (const id of POWER_IDS) if (POWERS[id].emblem === item.typeId) return id;
  } catch {
    /* ignore */
  }
  return undefined;
}

export { selectedAbility, pdata };

/** Iterate players that currently have at least one power. */
export function poweredPlayers() {
  const out = [];
  for (const p of world.getAllPlayers()) {
    try {
      if (rt(p).powers.length) out.push(p);
    } catch {
      /* ignore */
    }
  }
  return out;
}
