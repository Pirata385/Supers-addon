// Main tick loop and player lifecycle wiring.
import { world, system, Player } from '@minecraft/server';
import { rt, dropRuntime, hasRuntime } from './state.js';
import { handlersOf, restorePlayer, updateImmunity, endHold } from './powers.js';
import { validateHold } from './input.js';
import { updateHud } from './hud.js';
import { tickThrown } from './entities.js';
import { tickLights, restoreStaleLights } from './fx.js';

/** @type {{name:string, fn:(tick:number)=>void}[]} */
const globalTickers = [];
const errorCounts = new Map();

/** Register a function that runs once per tick (projectiles, meteors, mobs...). */
export function onTick(name, fn) {
  globalTickers.push({ name, fn });
}

function guard(name, fn) {
  try {
    fn();
  } catch (e) {
    const n = (errorCounts.get(name) ?? 0) + 1;
    errorCounts.set(name, n);
    if (n <= 5 || n % 200 === 0) console.warn(`[SP] tick error in ${name} (#${n}): ${e}\n${e?.stack ?? ''}`);
  }
}

function lifecycle(player, hook, ...args) {
  if (!hasRuntime(player.id)) return;
  const r = rt(player);
  for (const id of r.powers) guard(`${id}.${hook}`, () => handlersOf(id)[hook]?.(player, r, ...args));
}

export function startLoop() {
  system.runInterval(() => {
    const tick = system.currentTick;
    for (const player of world.getAllPlayers()) {
      if (!player.isValid) continue;
      const r = rt(player);
      if (!r.powers.length) continue;
      guard('validateHold', () => validateHold(player));
      for (const id of r.powers) {
        const h = handlersOf(id);
        if (h.tick) guard(`${id}.tick`, () => h.tick(player, r, tick));
      }
      guard('immunity', () => updateImmunity(player, r));
      if ((tick + r.id.length) % 4 === 0) guard('hud', () => updateHud(player));
    }
    guard('thrown', () => tickThrown(tick));
    guard('lights', () => tickLights(tick));
    for (const t of globalTickers) guard(t.name, () => t.fn(tick));
  }, 1);

  world.afterEvents.playerSpawn.subscribe((ev) => {
    const p = ev.player;
    system.runTimeout(() => {
      if (!p.isValid) return;
      guard('restore', () => restorePlayer(p));
    }, ev.initialSpawn ? 20 : 2);
  });

  world.beforeEvents.playerLeave.subscribe((ev) => {
    const p = ev.player;
    const id = p.id;
    // Handlers may modify the world, so defer; player object stays readable this tick.
    system.run(() => {
      dropRuntime(id);
    });
    try {
      if (hasRuntime(id)) {
        const r = rt(p);
        for (const pid of r.powers) {
          const h = handlersOf(pid);
          if (h.onLeave) system.run(() => guard(`${pid}.onLeave`, () => h.onLeave(p, r)));
        }
      }
    } catch {
      /* ignore */
    }
  });

  world.afterEvents.entityDie.subscribe(
    (ev) => {
      const p = ev.deadEntity;
      if (!(p instanceof Player)) return;
      if (!hasRuntime(p.id)) return;
      guard('death.hold', () => endHold(p, 'death'));
      lifecycle(p, 'onDeath');
    },
    { entityTypes: ['minecraft:player'] },
  );

  world.afterEvents.playerDimensionChange.subscribe((ev) => {
    const p = ev.player;
    guard('dim.hold', () => endHold(p, 'dimension'));
    lifecycle(p, 'onDimensionChange');
  });

  world.afterEvents.worldLoad.subscribe(() => {
    restoreStaleLights();
    for (const p of world.getAllPlayers()) guard('restore', () => restorePlayer(p));
  });
}
