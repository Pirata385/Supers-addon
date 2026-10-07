// Operator commands (/sp:power, /sp:codex) and the scriptevent debug API used by tests.
import {
  world,
  system,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  ItemStack,
  Player,
} from '@minecraft/server';
import { POWER_IDS, POWERS, ITEMS, DEFAULT_WORLD_SETTINGS } from '../config.js';
import { rt, worldSettings, setWorldSetting } from './state.js';
import { grantPower, revokePower, revokeAll, tryActivate, beginHold, endHold, handlersOf, updateImmunity } from './powers.js';
import { handleButton, onEmblemUse } from './input.js';

const REASONS = {
  unknown: 'unknown power',
  owned: 'already has that power',
  full: 'already has the maximum of 3 powers',
};

export function registerCommands(registry) {
  registry.registerEnum('sp:action', ['add', 'remove', 'clear', 'list']);
  registry.registerEnum('sp:powerid', [...POWER_IDS]);
  registry.registerCommand(
    {
      name: 'sp:power',
      description: 'Grant, remove or list Superpowers & Mutants powers.',
      permissionLevel: CommandPermissionLevel.GameDirectors,
      mandatoryParameters: [{ name: 'sp:action', type: CustomCommandParamType.Enum }],
      optionalParameters: [
        { name: 'sp:powerid', type: CustomCommandParamType.Enum },
        { name: 'targets', type: CustomCommandParamType.PlayerSelector },
      ],
    },
    (origin, action, power, targets) => {
      let players = targets;
      if (!players || !players.length) {
        const src = origin.sourceEntity ?? origin.initiator;
        players = src instanceof Player ? [src] : [];
      }
      if (!players.length) return { status: CustomCommandStatus.Failure, message: 'No target players.' };
      if ((action === 'add' || action === 'remove') && !power) {
        return { status: CustomCommandStatus.Failure, message: 'Specify a power: ' + POWER_IDS.join(', ') };
      }
      const msgs = [];
      for (const p of players) {
        if (action === 'list') {
          const list = rt(p).powers.map((id) => POWERS[id].name).join(', ') || 'none';
          msgs.push(`${p.name}: ${list}`);
        }
      }
      system.run(() => {
        for (const p of players) {
          if (!p.isValid) continue;
          if (action === 'add') {
            const res = grantPower(p, power);
            if (!res.ok) p.sendMessage(`§c${p.name} ${REASONS[res.reason] ?? res.reason}.`);
          } else if (action === 'remove') {
            revokePower(p, power);
          } else if (action === 'clear') {
            revokeAll(p);
          }
        }
      });
      return { status: CustomCommandStatus.Success, message: msgs.length ? msgs.join('\n') : `Applied '${action}' to ${players.length} player(s).` };
    },
  );
  registry.registerCommand(
    {
      name: 'sp:codex',
      description: 'Give the Mutant Codex catalog to players.',
      permissionLevel: CommandPermissionLevel.GameDirectors,
      optionalParameters: [{ name: 'targets', type: CustomCommandParamType.PlayerSelector }],
    },
    (origin, targets) => {
      let players = targets;
      if (!players || !players.length) {
        const src = origin.sourceEntity ?? origin.initiator;
        players = src instanceof Player ? [src] : [];
      }
      system.run(() => {
        for (const p of players) {
          try {
            p.getComponent('minecraft:inventory')?.container?.addItem(new ItemStack(ITEMS.codex, 1));
          } catch {
            /* ignore */
          }
        }
      });
      return { status: CustomCommandStatus.Success };
    },
  );
}

// ---------------------------------------------------------------- scriptevent debug API
function findPlayer(name) {
  return world.getAllPlayers().find((p) => p && p.name === name);
}

function reply(kind, payload) {
  try {
    system.sendScriptEvent(`sp_test:${kind}`, JSON.stringify(payload));
  } catch (e) {
    console.warn(`[SP] reply failed ${e}`);
  }
}

/** Snapshot of a player's power state for tests and debugging. */
export function dumpState(player) {
  const r = rt(player);
  const data = {};
  for (const id of r.powers) {
    let extra;
    try {
      extra = handlersOf(id).debug?.(player, r);
    } catch (e) {
      extra = { error: String(e) };
    }
    data[id] = extra ?? Object.keys(r.data[id] ?? {});
  }
  return {
    name: player.name,
    powers: r.powers,
    sel: r.sel,
    hold: r.hold,
    tags: player.getTags(),
    cd: Object.fromEntries(Object.entries(r.cd).map(([k, v]) => [k, Math.max(0, v - system.currentTick)])),
    data,
  };
}

export function registerDebugEvents() {
  system.afterEvents.scriptEventReceive.subscribe(
    (ev) => {
      const args = ev.message.trim().split(/\s+/);
      const cmd = ev.id.slice(3);
      if (cmd === 'world') {
        // scriptevent sp:world <key> <json value>
        let value;
        try {
          value = JSON.parse(args[1]);
        } catch {
          value = args[1];
        }
        if (args[0] in DEFAULT_WORLD_SETTINGS) setWorldSetting(args[0], value);
        reply('world', { settings: worldSettings() });
        return;
      }
      const player = findPlayer(args[0]);
      if (!player) {
        reply('error', { cmd, msg: `no player ${args[0]}` });
        return;
      }
      const r = rt(player);
      switch (cmd) {
        case 'grant': {
          const res = grantPower(player, args[1], { silent: args[2] === 'silent' });
          reply('grant', { player: player.name, power: args[1], ...res });
          break;
        }
        case 'revoke':
          if (args[1] === 'all') reply('revoke', { count: revokeAll(player) });
          else reply('revoke', { ok: revokePower(player, args[1]) });
          break;
        case 'ability': {
          if (args[3] === 'force') delete r.cd[`${args[1]}.${args[2]}`];
          reply('ability', { power: args[1], ability: args[2], fired: tryActivate(player, args[1], args[2]) });
          break;
        }
        case 'use':
          onEmblemUse(player, args[1]);
          reply('use', { power: args[1] });
          break;
        case 'hold':
          if (args[3] === 'start') {
            delete r.cd[`${args[1]}.${args[2]}`];
            reply('hold', { started: beginHold(player, args[1], args[2]) });
          } else {
            endHold(player, 'release', args[4] === 'sneak');
            reply('hold', { ended: true });
          }
          break;
        case 'select': {
          const idx = POWERS[args[1]].abilities.findIndex((a) => a.id === args[2]);
          r.sel[args[1]] = Math.max(0, idx);
          reply('select', { idx });
          break;
        }
        case 'input':
          if (args[1] === 'move') r.input.moveOverride = { x: Number(args[2]), y: Number(args[3]) };
          else if (args[1] === 'sneak') r.input.sneakOverride = args[2] === '1' ? true : args[2] === '0' ? false : undefined;
          else if (args[1] === 'button') {
            r.input.buttonOverride ??= {};
            const btn = args[2] === 'jump' ? 'Jump' : 'Sneak';
            const pressed = args[3] === '1';
            r.input.buttonOverride[btn] = pressed;
            handleButton(player, btn, pressed);
          } else if (args[1] === 'clear') {
            r.input.moveOverride = null;
            r.input.sneakOverride = undefined;
            r.input.buttonOverride = undefined;
          }
          reply('input', { ok: true });
          break;
        case 'cd':
          r.cd = {};
          reply('cd', { ok: true });
          break;
        case 'dump':
          updateImmunity(player, r);
          reply('dump', dumpState(player));
          break;
        default:
          reply('error', { cmd, msg: 'unknown command' });
      }
    },
    { namespaces: ['sp'] },
  );
}
