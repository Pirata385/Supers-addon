// Player power state: persistent (dynamic properties) + transient runtime data.
import { world, system } from '@minecraft/server';
import { MAX_POWERS, POWER_IDS, POWERS, DEFAULT_PLAYER_SETTINGS, DEFAULT_WORLD_SETTINGS } from '../config.js';

const PROP_POWERS = 'sp:powers';
const PROP_SELECTED = 'sp:selected';
const PROP_SETTINGS = 'sp:settings';
const PROP_DISCOVERED = 'sp:discovered';
const PROP_WORLD = 'sp:world_settings';

/**
 * @typedef {Object} Runtime
 * @property {string} id
 * @property {string[]} powers         Active power ids (persisted).
 * @property {Record<string, number>} sel  Selected ability index per power (persisted).
 * @property {Record<string, any>} settings  Player preferences (persisted).
 * @property {Record<string, number>} cd   Cooldown key -> tick when ready.
 * @property {{power:string, ability:string, start:number, slot:number}|null} hold
 * @property {Record<string, any>} data    Per-power transient state, keyed by power id.
 * @property {Object} input                Input bookkeeping.
 * @property {Set<string>} tags            Immunity tags currently applied.
 * @property {string[]} discovered
 */

/** @type {Map<string, Runtime>} */
const runtimes = new Map();

function readJSON(holder, prop, fallback) {
  try {
    const raw = holder.getDynamicProperty(prop);
    if (typeof raw === 'string' && raw.length) return JSON.parse(raw);
  } catch (e) {
    console.warn(`[SP] corrupt dynamic property ${prop}: ${e}`);
  }
  return fallback;
}

function writeJSON(holder, prop, value) {
  try {
    holder.setDynamicProperty(prop, JSON.stringify(value));
  } catch (e) {
    console.warn(`[SP] failed to save ${prop}: ${e}`);
  }
}

/** @param {import('@minecraft/server').Player} player @returns {Runtime} */
export function rt(player) {
  let r = runtimes.get(player.id);
  if (!r) {
    const powers = readJSON(player, PROP_POWERS, []).filter((p) => POWER_IDS.includes(p)).slice(0, MAX_POWERS);
    r = {
      id: player.id,
      powers,
      sel: readJSON(player, PROP_SELECTED, {}),
      settings: { ...DEFAULT_PLAYER_SETTINGS, ...readJSON(player, PROP_SETTINGS, {}) },
      cd: {},
      hold: null,
      data: {},
      input: { lastJumpTick: -100, sneakSince: -1, sneaking: false, cycledTick: -1, heldPower: null, heldSince: 0, moveOverride: null },
      tags: new Set(),
      discovered: readJSON(player, PROP_DISCOVERED, []),
    };
    runtimes.set(player.id, r);
  }
  return r;
}

export function hasRuntime(playerId) {
  return runtimes.has(playerId);
}

export function dropRuntime(playerId) {
  runtimes.delete(playerId);
}

export function allRuntimes() {
  return runtimes;
}

/** Per-power transient data bag. */
export function pdata(player, powerId) {
  const r = rt(player);
  let d = r.data[powerId];
  if (!d) d = r.data[powerId] = {};
  return d;
}

export function savePowers(player) {
  writeJSON(player, PROP_POWERS, rt(player).powers);
}

export function saveSelection(player) {
  writeJSON(player, PROP_SELECTED, rt(player).sel);
}

export function saveSettings(player) {
  writeJSON(player, PROP_SETTINGS, rt(player).settings);
}

export function hasPower(player, powerId) {
  return rt(player).powers.includes(powerId);
}

export function selectedAbility(player, powerId) {
  const r = rt(player);
  const list = POWERS[powerId].abilities;
  const idx = Math.max(0, Math.min(list.length - 1, r.sel[powerId] ?? 0));
  return list[idx];
}

export function selectAbility(player, powerId, index) {
  const r = rt(player);
  const n = POWERS[powerId].abilities.length;
  r.sel[powerId] = ((index % n) + n) % n;
  saveSelection(player);
  return POWERS[powerId].abilities[r.sel[powerId]];
}

/** Marks a catalog entry (item / mob / structure id) as discovered. Returns true if new. */
export function discover(player, entryId) {
  const r = rt(player);
  if (r.discovered.includes(entryId)) return false;
  r.discovered.push(entryId);
  writeJSON(player, PROP_DISCOVERED, r.discovered);
  return true;
}

export function isDiscovered(player, entryId) {
  return rt(player).discovered.includes(entryId);
}

// ---------------------------------------------------------------- world settings
let worldSettingsCache = null;

export function worldSettings() {
  if (!worldSettingsCache) {
    worldSettingsCache = { ...DEFAULT_WORLD_SETTINGS, ...readJSON(world, PROP_WORLD, {}) };
  }
  return worldSettingsCache;
}

export function setWorldSetting(key, value) {
  const s = worldSettings();
  s[key] = value;
  writeJSON(world, PROP_WORLD, s);
}

/** True when powers may destroy or transform blocks. */
export function griefingAllowed() {
  return worldSettings().griefing !== false;
}

/** True when powers may harm players. */
export function pvpAllowed() {
  try {
    return worldSettings().pvp !== false && world.gameRules.pvp;
  } catch {
    return worldSettings().pvp !== false;
  }
}

export function now() {
  return system.currentTick;
}
