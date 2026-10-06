// Item behaviour: mutagen syringes, unstable mutagen, suppressor serum and the Mutant Codex.
import { system, ItemStack, GameMode } from '@minecraft/server';
import { MessageFormData } from '@minecraft/server-ui';
import { POWERS, POWER_IDS, MAX_POWERS, GLYPH, ITEMS } from '../config.js';
import { rt, discover } from '../core/state.js';
import { grantPower, revokeAll } from '../core/powers.js';
import * as fx from '../core/fx.js';
import { openCodex } from '../ui/codex.js';

/** Players currently mid-injection (prevents double use). */
const injecting = new Set();

function isCreative(player) {
  try {
    return player.getGameMode() === GameMode.Creative;
  } catch {
    return false;
  }
}

/** Remove one item of `typeId` from the selected slot (or anywhere) and optionally give a return item. */
function consumeOne(player, typeId, returnItem) {
  if (isCreative(player)) return true;
  try {
    const inv = player.getComponent('minecraft:inventory')?.container;
    if (!inv) return false;
    let slot = player.selectedSlotIndex;
    let it = inv.getItem(slot);
    if (it?.typeId !== typeId) {
      slot = -1;
      for (let i = 0; i < inv.size; i++) {
        if (inv.getItem(i)?.typeId === typeId) {
          slot = i;
          break;
        }
      }
      if (slot < 0) return false;
      it = inv.getItem(slot);
    }
    if (it.amount > 1) {
      it.amount -= 1;
      inv.setItem(slot, it);
    } else inv.setItem(slot, undefined);
    if (returnItem) {
      const left = inv.addItem(new ItemStack(returnItem, 1));
      if (left) player.dimension.spawnItem(left, player.location);
    }
    return true;
  } catch {
    return false;
  }
}

/** Shared injection sequence: animation, sounds, particles, then `onDone`. */
function injectSequence(player, color, onDone) {
  injecting.add(player.id);
  fx.anim(player, 'animation.sp.inject');
  fx.sound(player.dimension, 'sp.syringe.inject', player.location);
  let t = 0;
  const id = system.runInterval(() => {
    t++;
    if (!player.isValid) {
      system.clearRun(id);
      injecting.delete(player.id);
      return;
    }
    if (t % 3 === 0) {
      const l = player.location;
      fx.particle(player.dimension, 'sp:inject', { x: l.x, y: l.y + 1.1, z: l.z }, { color });
    }
    if (t >= 16) {
      system.clearRun(id);
      injecting.delete(player.id);
      fx.shake(player, 0.25, 0.4);
      onDone();
    }
  }, 1);
}

function pickRandomPower(player) {
  const owned = rt(player).powers;
  const options = POWER_IDS.filter((p) => !owned.includes(p));
  return options[Math.floor(Math.random() * options.length)];
}

async function confirmInjection(player, power) {
  const r = rt(player);
  if (r.settings.confirmInjections === false) return true;
  const def = power === 'random' ? null : POWERS[power];
  const form = new MessageFormData()
    .title(def ? `${def.color}${def.name} Mutagen` : '§5Unstable Mutagen')
    .body(
      (def
        ? `§f${GLYPH[power]} ${def.color}${def.name}§r\n§7${def.tagline}\n\n§fPassive: §7${def.passive}\n\n§fAbilities:\n${def.abilities.map((a) => `§8- §f${a.name}`).join('\n')}`
        : '§7A volatile cocktail. It will rewrite your DNA with a §5random§7 power you do not have yet.') +
        `\n\n§7Power slots: §f${r.powers.length}/${MAX_POWERS}`,
    )
    .button1('§2Inject')
    .button2('Cancel');
  try {
    const res = await form.show(player);
    return !res.canceled && res.selection === 0;
  } catch {
    return false;
  }
}

/** Use of a mutagen syringe. */
async function useSyringe(player, itemTypeId, power) {
  if (injecting.has(player.id)) return;
  const r = rt(player);
  if (r.powers.length >= MAX_POWERS) {
    fx.soundTo(player, 'sp.ui.deny');
    player.sendMessage(`§c${GLYPH.lock} Your body cannot hold more than ${MAX_POWERS} powers. Use a §7Suppressor Serum§c or the Codex to free a slot.`);
    return;
  }
  if (power !== 'random' && r.powers.includes(power)) {
    fx.soundTo(player, 'sp.ui.deny');
    player.sendMessage(`§eYou already have ${POWERS[power].color}${POWERS[power].name}§e.`);
    return;
  }
  if (power === 'random' && !pickRandomPower(player)) {
    fx.soundTo(player, 'sp.ui.deny');
    return;
  }
  if (!(await confirmInjection(player, power))) return;
  if (!player.isValid) return;
  const target = power === 'random' ? pickRandomPower(player) : power;
  if (!target || !consumeOne(player, itemTypeId, ITEMS.emptySyringe)) return;
  const color = POWERS[target].rgb;
  injectSequence(player, color, () => {
    const res = grantPower(player, target);
    if (!res.ok) {
      player.sendMessage(`§cThe mutagen was rejected (${res.reason}).`);
      fx.sound(player.dimension, 'sp.ui.deny', player.location);
    }
  });
}

async function useSuppressor(player, itemTypeId) {
  if (injecting.has(player.id)) return;
  const r = rt(player);
  if (!r.powers.length) {
    fx.soundTo(player, 'sp.ui.deny');
    player.sendMessage('§7You have no powers to suppress.');
    return;
  }
  if (r.settings.confirmInjections !== false) {
    const form = new MessageFormData()
      .title('§7Suppressor Serum')
      .body(`§7This serum permanently strips §fall§7 of your powers:\n\n${r.powers.map((p) => `§f${GLYPH[p]} ${POWERS[p].color}${POWERS[p].name}`).join('\n')}\n\n§cThis cannot be undone.`)
      .button1('§4Suppress all powers')
      .button2('Cancel');
    let ok = false;
    try {
      const res = await form.show(player);
      ok = !res.canceled && res.selection === 0;
    } catch {
      ok = false;
    }
    if (!ok || !player.isValid) return;
  }
  if (!consumeOne(player, itemTypeId, ITEMS.emptySyringe)) return;
  injectSequence(player, { red: 0.7, green: 0.7, blue: 0.7 }, () => {
    const n = revokeAll(player);
    player.sendMessage(`§7${n} power(s) suppressed. Your emblems crumble to dust.`);
  });
}

export function registerItemComponents(registry) {
  registry.registerCustomComponent('sp:syringe', {
    onUse(ev, params) {
      const player = ev.source;
      const power = /** @type {any} */ (params.params)?.power ?? 'random';
      const typeId = ev.itemStack?.typeId;
      if (!typeId) return;
      discover(player, typeId);
      system.run(() => useSyringe(player, typeId, power));
    },
  });
  registry.registerCustomComponent('sp:suppressor', {
    onUse(ev) {
      const player = ev.source;
      const typeId = ev.itemStack?.typeId;
      if (!typeId) return;
      system.run(() => useSuppressor(player, typeId));
    },
  });
  registry.registerCustomComponent('sp:codex', {
    onUse(ev) {
      const player = ev.source;
      system.run(() => {
        fx.soundTo(player, 'sp.ui.open');
        openCodex(player);
      });
    },
  });
  // Emblems: behaviour is routed through core/input.js; the component exists so the
  // item JSON can declare it and future data-driven parameters can be added.
  registry.registerCustomComponent('sp:emblem', {});
}
