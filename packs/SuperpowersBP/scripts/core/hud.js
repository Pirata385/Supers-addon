// Action-bar HUD: selected ability, cooldown bars and live power status.
import { system } from '@minecraft/server';
import { POWERS, GLYPH } from '../config.js';
import { rt, selectedAbility } from './state.js';
import { cooldownLeft, handlersOf, heldEmblemPower, abilityDef } from './powers.js';

/** Render a 10-segment bar using custom glyphs, `fraction` in [0,1]. */
export function bar(fraction, color = '§a', segments = 10) {
  const f = Math.max(0, Math.min(1, fraction)) * segments;
  let s = color;
  for (let i = 0; i < segments; i++) {
    if (f >= i + 1) s += GLYPH.barFull;
    else if (f > i + 0.4) s += GLYPH.barHalf;
    else s += `§8${GLYPH.barEmpty}${color}`;
  }
  return s + '§r';
}

function abilityStatus(player, r, power, ab) {
  if (r.hold && r.hold.power === power && r.hold.ability === ab.id) return `§a${GLYPH.active} ACTIVE`;
  const left = cooldownLeft(player, power, ab.id);
  if (left > 0) {
    const total = Math.max(left, ab.cooldown || left);
    return `${bar(1 - left / total, '§c', 8)} §c${(left / 20).toFixed(1)}s`;
  }
  const h = handlersOf(power);
  const toggled = h.isToggled?.(player, r, ab.id);
  if (toggled) return `§b${GLYPH.active} ON`;
  return `§a${GLYPH.ready} READY`;
}

/** Build the action bar text for a player, or '' when there is nothing to show. */
export function composeHud(player) {
  const r = rt(player);
  if (!r.powers.length || r.settings.hud === false) return '';
  const lines = [];
  const held = heldEmblemPower(player);
  if (held && r.powers.includes(held)) {
    const def = POWERS[held];
    const ab = selectedAbility(player, held);
    const idx = def.abilities.indexOf(ab);
    const dots = def.abilities.map((_, i) => (i === idx ? '§f●' : '§8●')).join('');
    lines.push(`§f${GLYPH[held]} ${def.color}§l${def.short}§r ${dots} §7${GLYPH.arrow} §f${ab.name}  ${abilityStatus(player, r, held, ab)}`);
    if (r.settings.hints !== false && system.currentTick - (r.input.slotChangedTick ?? 0) < 60) {
      lines.push(`§8Use: ${ab.mode === 'hold' ? 'hold to channel' : ab.mode === 'toggle' ? 'toggle' : 'activate'} §7| §8Sneak+Use: switch ability`);
    }
  }
  for (const id of r.powers) {
    let status;
    try {
      status = handlersOf(id).hud?.(player, r);
    } catch {
      status = undefined;
    }
    if (status) lines.push(`§f${GLYPH[id]} ${status}`);
  }
  return lines.join('\n');
}

/** Called every few ticks for every powered player. */
export function updateHud(player) {
  const r = rt(player);
  if ((r.input.hudHoldUntil ?? 0) > system.currentTick) return; // a transient message is showing
  const text = composeHud(player);
  const tick = system.currentTick;
  if (!text) {
    if (r.input.lastHud) {
      r.input.lastHud = '';
      try {
        player.onScreenDisplay.setActionBar(' ');
      } catch {
        /* ignore */
      }
    }
    return;
  }
  // Re-send when changed, or periodically so the action bar never fades out.
  if (text !== r.input.lastHud || tick - (r.input.lastHudTick ?? 0) >= 30) {
    r.input.lastHud = text;
    r.input.lastHudTick = tick;
    try {
      player.onScreenDisplay.setActionBar(text);
    } catch {
      /* ignore */
    }
  }
}

export { abilityDef };
