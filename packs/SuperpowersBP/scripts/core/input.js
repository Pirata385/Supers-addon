// Routes player input (emblem use, jump/sneak buttons, melee hits) to power handlers.
import { world, system, InputButton, ButtonState, Player } from '@minecraft/server';
import { POWERS, POWER_IDS, GLYPH } from '../config.js';
import { rt, selectedAbility, selectAbility } from './state.js';
import { tryActivate, beginHold, endHold, handlersOf, cooldownLeft } from './powers.js';
import * as fx from './fx.js';
import { withOwner } from './context.js';

const EMBLEM_TO_POWER = new Map(POWER_IDS.map((id) => [POWERS[id].emblem, id]));

export function emblemPower(typeId) {
  return EMBLEM_TO_POWER.get(typeId);
}

/** Movement input in player-local space: x = left(+)/right(-), y = forward(+)/back(-). */
export function moveInput(player) {
  const r = rt(player);
  if (r.input.moveOverride) return r.input.moveOverride;
  try {
    return player.inputInfo.getMovementVector();
  } catch {
    return { x: 0, y: 0 };
  }
}

export function buttonDown(player, button) {
  const r = rt(player);
  const o = r.input.buttonOverride?.[button];
  if (o !== undefined) return o;
  try {
    return player.inputInfo.getButtonState(button) === ButtonState.Pressed;
  } catch {
    return false;
  }
}

function cycle(player, power) {
  const r = rt(player);
  const cur = r.sel[power] ?? 0;
  const ab = selectAbility(player, power, cur + 1);
  const def = POWERS[power];
  const left = cooldownLeft(player, power, ab.id);
  fx.soundTo(player, 'sp.ui.select', 1 + (r.sel[power] ?? 0) * 0.08, 0.8);
  try {
    player.onScreenDisplay.setActionBar(
      `§f${GLYPH[power]} ${def.color}${def.short} §7${GLYPH.arrow} §f§l${ab.name}§r ${left ? `§c(${(left / 20).toFixed(1)}s)` : '§a(ready)'}\n§8${ab.desc}`,
    );
  } catch {
    /* ignore */
  }
  r.input.hudHoldUntil = system.currentTick + 50;
}

/** Use of an emblem item: Sneak+Use cycles, otherwise activates the selected ability. */
export function onEmblemUse(player, power) {
  const r = rt(player);
  if (!r.powers.includes(power)) {
    fx.soundTo(player, 'sp.ui.deny');
    player.onScreenDisplay.setActionBar('§cThis emblem is dormant: you do not have that power.');
    return;
  }
  const sneaking = r.input.sneakOverride ?? player.isSneaking;
  if (sneaking && !r.hold) {
    r.input.cycledTick = system.currentTick;
    cycle(player, power);
    return;
  }
  const ab = selectedAbility(player, power);
  if (ab.mode === 'hold') beginHold(player, power, ab.id);
  else tryActivate(player, power, ab.id);
}

export function onEmblemRelease(player) {
  const r = rt(player);
  if (r.hold) endHold(player, 'release');
}

/** Per-tick validation of holds (item switched, died, dimension change...). */
export function validateHold(player) {
  const r = rt(player);
  const h = r.hold;
  if (!h) return;
  let ok = true;
  try {
    if (player.selectedSlotIndex !== h.slot) ok = false;
    else {
      const it = player.getComponent('minecraft:inventory')?.container?.getItem(h.slot);
      if (it?.typeId !== POWERS[h.power].emblem) ok = false;
    }
    const hp = player.getComponent('minecraft:health');
    if (hp && hp.currentValue <= 0) ok = false;
  } catch {
    ok = false;
  }
  if (!ok) endHold(player, 'interrupted');
}

export function registerInput() {
  world.afterEvents.itemUse.subscribe((ev) => {
    const power = emblemPower(ev.itemStack.typeId);
    if (!power) return;
    onEmblemUse(ev.source, power);
  });
  world.afterEvents.itemStopUse.subscribe((ev) => {
    if (ev.itemStack && !emblemPower(ev.itemStack.typeId)) return;
    onEmblemRelease(ev.source);
  });
  world.afterEvents.itemReleaseUse.subscribe((ev) => {
    if (ev.itemStack && !emblemPower(ev.itemStack.typeId)) return;
    onEmblemRelease(ev.source);
  });

  world.afterEvents.playerButtonInput.subscribe((ev) => {
    handleButton(ev.player, ev.button, ev.newButtonState === ButtonState.Pressed);
  });

  world.afterEvents.entityHitEntity.subscribe((ev) => {
    const src = ev.damagingEntity;
    if (!(src instanceof Player) && src?.typeId !== 'minecraft:player') return;
    const r = rt(/** @type {Player} */ (src));
    for (const id of r.powers) {
      try {
        withOwner(id, () => handlersOf(id).onMelee?.(/** @type {Player} */ (src), r, ev.hitEntity));
      } catch (e) {
        console.warn(`[SP] onMelee ${id}: ${e}`);
      }
    }
  });

  world.afterEvents.playerHotbarSelectedSlotChange.subscribe((ev) => {
    const r = rt(ev.player);
    r.input.slotChangedTick = system.currentTick;
    if (r.hold) validateHold(ev.player);
  });
}

/** Shared button handling (also used by test overrides). */
export function handleButton(player, button, pressed) {
  const r = rt(player);
  const tick = system.currentTick;
  if (button === InputButton.Jump && pressed) {
    r.input.doubleJump = tick - r.input.lastJumpTick <= 7;
    r.input.lastJumpTick = tick;
  }
  if (button === InputButton.Sneak) {
    r.input.sneaking = pressed;
    r.input.sneakSince = pressed ? tick : -1;
  }
  for (const id of r.powers) {
    try {
      withOwner(id, () => handlersOf(id).onButton?.(player, r, button, pressed, tick));
    } catch (e) {
      console.warn(`[SP] onButton ${id}: ${e}`);
    }
  }
}
