// GameTest suite runner: drives simulated players through every power via the
// add-on's scriptevent debug API (see packs/SuperpowersBP/scripts/core/commands.js).
import { world, system } from '@minecraft/server';
import { SUITES } from './suite.js';
import { Ctx, stats } from './ctx.js';
import * as strength from './suites/strength.js';
import * as flight from './suites/flight.js';
import * as heat_vision from './suites/heat_vision.js';
import * as speedster from './suites/speedster.js';
import * as esper from './suites/esper.js';
import * as items from './suites/items.js';
import * as multi from './suites/multi.js';
import * as mutants from './suites/mutants.js';

const ALL = { strength, flight, heat_vision, speedster, esper, items, multi, mutants };
const ORDER = ['strength', 'flight', 'heat_vision', 'speedster', 'esper', 'items', 'multi', 'mutants'];

system.runTimeout(async () => {
  const dim = world.getDimension('overworld');
  try {
    dim.runCommand('gamerule domobspawning false');
    dim.runCommand('gamerule dodaylightcycle false');
    dim.runCommand('time set noon');
    dim.runCommand('gamerule showcoordinates true');
  } catch {
    /* ignore */
  }
  for (const name of ORDER) {
    if (!SUITES.includes(name)) continue;
    const ctx = new Ctx(name, ORDER.indexOf(name));
    console.warn(`[SPTEST] ===== suite ${name} =====`);
    try {
      await ALL[name].run(ctx);
    } catch (e) {
      stats.fail++;
      console.warn(`[SPTEST] FAIL ${name}: exception ${e}\n${e?.stack ?? ''}`);
    }
    try {
      await ctx.cleanup();
    } catch {
      /* ignore */
    }
  }
  console.warn(`[SPTEST] RESULT pass=${stats.pass} fail=${stats.fail} skip=${stats.skip}`);
  console.warn('[SPTEST] DONE');
}, 100);
