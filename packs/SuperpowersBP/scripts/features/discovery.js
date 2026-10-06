// Records Codex discoveries: items held, structures explored, mutants encountered.
import { world } from '@minecraft/server';
import { ENTITIES, BLOCKS } from '../config.js';
import { discover } from '../core/state.js';
import { onTick } from '../core/loop.js';
import * as fx from '../core/fx.js';

const LABELS = {
  'structure:mutagen_lab': 'Mutagen Lab',
  'structure:meteor_crash': 'Meteor Crash Site',
  'mob:rogue_mutant': 'Rogue Mutant',
};

function announce(player, key) {
  const label = LABELS[key];
  if (!label) return;
  fx.soundTo(player, 'sp.ui.select', 0.8, 0.8);
  try {
    player.sendMessage(`§8[§dCodex§8]§7 New entry recorded: §f${label}`);
  } catch {
    /* ignore */
  }
}

function record(player, key) {
  if (discover(player, key)) announce(player, key);
}

world.afterEvents.playerInventoryItemChange.subscribe(
  (ev) => {
    const id = ev.itemStack?.typeId;
    if (id && id.startsWith('sp:') && !id.startsWith('sp:emblem_')) discover(ev.player, id);
  },
  { ignoreQuantityChange: true },
);

world.afterEvents.entityHurt.subscribe((ev) => {
  const a = ev.hurtEntity;
  const b = ev.damageSource.damagingEntity;
  if (a?.typeId === ENTITIES.mutant && b?.typeId === 'minecraft:player') record(/** @type {any} */ (b), 'mob:rogue_mutant');
  else if (b?.typeId === ENTITIES.mutant && a?.typeId === 'minecraft:player') record(/** @type {any} */ (a), 'mob:rogue_mutant');
});

world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const id = ev.brokenBlockPermutation.type.id;
  if (id === BLOCKS.meteorite) record(ev.player, 'structure:meteor_crash');
  if (id === BLOCKS.tank) record(ev.player, 'structure:mutagen_lab');
});

/** Periodic proximity scan: a small cube of blocks around each player (cheap, every 2 s). */
onTick('discovery', (tick) => {
  if (tick % 40 !== 0) return;
  for (const p of world.getAllPlayers()) {
    if (!p || !p.isValid) continue;
    const l = p.location;
    let lab = false, crash = false;
    try {
      for (let dx = -3; dx <= 3 && !(lab && crash); dx += 1) {
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dz = -3; dz <= 3; dz += 1) {
            const b = p.dimension.getBlock({ x: Math.floor(l.x) + dx, y: Math.floor(l.y) + dy, z: Math.floor(l.z) + dz });
            if (!b) continue;
            const id = b.typeId;
            if (id === BLOCKS.tank) lab = true;
            else if (id === BLOCKS.meteorite) crash = true;
          }
        }
      }
    } catch {
      /* unloaded */
    }
    if (lab) record(p, 'structure:mutagen_lab');
    if (crash) record(p, 'structure:meteor_crash');
    // seeing a mutant nearby also counts
    if (tick % 120 === 0) {
      try {
        if (p.dimension.getEntities({ type: ENTITIES.mutant, location: l, maxDistance: 12 }).length) record(p, 'mob:rogue_mutant');
      } catch {
        /* ignore */
      }
    }
  }
});
