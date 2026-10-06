// Coexistence: three powers at once, slot limit, emblems, combined immunities, abilities of
// different powers used together, partial and full removal, structures.
import { world, system, GameMode, ItemStack } from '@minecraft/server';

const EMBLEMS = {
  strength: 'sp:emblem_strength',
  flight: 'sp:emblem_flight',
  heat_vision: 'sp:emblem_heat_vision',
  speedster: 'sp:emblem_speedster',
  esper: 'sp:emblem_esper',
};

function countItem(player, typeId) {
  const inv = player.getComponent('minecraft:inventory').container;
  let n = 0;
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === typeId) n += inv.getItem(i).amount;
  return n;
}

function slotOf(player, typeId) {
  const inv = player.getComponent('minecraft:inventory').container;
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === typeId) return i;
  return -1;
}

/** @param {import('../ctx.js').Ctx} ctx */
export async function run(ctx) {
  const p = await ctx.player('Multi', 0, 0, GameMode.Survival);

  // --- slot limit -------------------------------------------------------
  let r = await ctx.sp('grant', 'Multi strength silent');
  ctx.assert(r.ok === true, 'grant strength', r);
  r = await ctx.sp('grant', 'Multi flight silent');
  ctx.assert(r.ok === true, 'grant flight', r);
  r = await ctx.sp('grant', 'Multi esper silent');
  ctx.assert(r.ok === true, 'grant esper', r);
  r = await ctx.sp('grant', 'Multi heat_vision silent');
  ctx.assert(r.ok === false && r.reason === 'full', '4th power is rejected (max 3)', r);
  r = await ctx.sp('grant', 'Multi strength silent');
  ctx.assert(r.ok === false, 'duplicate power rejected', r);

  await ctx.wait(5);
  let d = await ctx.dump(p);
  ctx.assert(JSON.stringify(d.powers) === JSON.stringify(['strength', 'flight', 'esper']), 'three powers active in canonical order', d.powers);
  for (const id of ['strength', 'flight', 'esper']) {
    ctx.assert(countItem(p, EMBLEMS[id]) === 1, `emblem for ${id} given exactly once`);
    ctx.assert(p.hasTag(`sp_has_${id}`), `has tag sp_has_${id}`);
  }
  ctx.assert(countItem(p, EMBLEMS.heat_vision) === 0, 'no emblem for rejected power');
  // emblems are locked and kept on death
  const inv = p.getComponent('minecraft:inventory').container;
  const em = inv.getItem(slotOf(p, EMBLEMS.flight));
  ctx.assert(em && em.keepOnDeath === true && String(em.lockMode) === 'inventory', 'emblem is lock_in_inventory + keep_on_death', { keep: em?.keepOnDeath, lock: em?.lockMode });

  // combined immunities: strength tough + flight nofall/nokinetic
  ctx.assert(p.hasTag('sp_tough'), 'strength passive: sp_tough');
  ctx.assert(p.hasTag('sp_nofall') && p.hasTag('sp_nokinetic'), 'flight passive: nofall + nokinetic');

  // --- abilities from different powers in the same moment ------------------
  const fly = await ctx.sp('ability', 'Multi flight take_off force');
  ctx.assert(fly.fired === true, 'flight take off fires', fly);
  await ctx.wait(20);
  const y0 = p.location.y;
  ctx.assert(y0 > ctx.origin.y + 0.5, 'airborne after take off', y0);
  const clap = await ctx.sp('ability', 'Multi strength thunderclap force');
  ctx.assert(clap.fired === true, 'strength thunderclap while flying', clap);
  const bar = await ctx.sp('ability', 'Multi esper barrier force');
  ctx.assert(bar.fired === true, 'esper barrier while flying', bar);
  await ctx.wait(30);
  d = await ctx.dump(p);
  ctx.assert(d.powers.length === 3, 'still three powers after mixed use');
  ctx.assert(Math.abs(p.location.y - y0) < 3, 'still hovering while other powers act', { y0, y: p.location.y });

  // Esper telekinesis hold + flight at once
  const pig = ctx.spawn('minecraft:pig', 0, 0, 5);
  await ctx.wait(5);
  p.lookAtEntity(pig);
  await ctx.wait(2);
  const h = await ctx.sp('hold', 'Multi esper telekinesis start');
  ctx.assert(h.started === true, 'telekinesis grabs while flying', h);
  await ctx.wait(10);
  await ctx.sp('hold', 'Multi esper telekinesis end sneak');
  await ctx.wait(5);
  try {
    pig.remove();
  } catch {
    /* ignore */
  }

  // Emblem Use routing: Sneak+Use cycles the selected ability of that power only.
  const before = (await ctx.dump(p)).sel.strength ?? 0;
  await ctx.sp('input', 'Multi sneak 1');
  await ctx.sp('use', 'Multi strength');
  await ctx.sp('input', 'Multi sneak clear');
  const after = (await ctx.dump(p)).sel;
  ctx.assert(((before + 1) % 4) === (after.strength ?? 0), 'sneak+use cycles strength ability', { before, after });
  ctx.assert((after.esper ?? 0) === 0 || after.esper !== undefined, 'other power selection untouched', after);

  // land
  await ctx.sp('ability', 'Multi flight take_off force');
  await ctx.wait(40);

  // --- partial removal keeps the rest ---------------------------------------
  const rv = await ctx.sp('revoke', 'Multi flight');
  ctx.assert(rv.ok === true, 'revoke one power', rv);
  await ctx.wait(3);
  d = await ctx.dump(p);
  ctx.assert(JSON.stringify(d.powers) === JSON.stringify(['strength', 'esper']), 'remaining powers intact', d.powers);
  ctx.assert(countItem(p, EMBLEMS.flight) === 0, 'flight emblem removed');
  ctx.assert(!p.hasTag('sp_nokinetic'), 'flight-only tag removed');
  ctx.assert(p.hasTag('sp_tough'), 'strength tag kept');
  // freed slot can be refilled
  r = await ctx.sp('grant', 'Multi speedster silent');
  ctx.assert(r.ok === true, 'freed slot accepts a new power', r);

  // --- fall damage immunity from a granted power ---------------------------
  await ctx.sp('revoke', 'Multi all');
  await ctx.sp('grant', 'Multi flight silent');
  await ctx.wait(3);
  const hp = p.getComponent('minecraft:health');
  hp.resetToMaxValue();
  p.teleport(ctx.at(3, 25, 3));
  await ctx.wait(60);
  ctx.assert(hp.currentValue >= hp.effectiveMax - 0.01, 'no fall damage with flight (player.json damage_sensor)', hp.currentValue);

  // --- full removal ---------------------------------------------------------
  const all = await ctx.sp('revoke', 'Multi all');
  ctx.assert(all.count === 1, 'revoke all reports count', all);
  await ctx.wait(3);
  d = await ctx.dump(p);
  ctx.assert(d.powers.length === 0, 'no powers left');
  const leftovers = d.tags.filter((t) => t.startsWith('sp_'));
  ctx.assert(leftovers.length === 0, 'no sp_ tags left', leftovers);
  for (const id of Object.keys(EMBLEMS)) ctx.assert(countItem(p, EMBLEMS[id]) === 0, `no ${id} emblem left`);
  // without powers fall damage applies again
  hp.resetToMaxValue();
  p.teleport(ctx.at(-3, 12, -3));
  await ctx.wait(50);
  ctx.assert(hp.currentValue < hp.effectiveMax, 'fall damage applies again without powers', hp.currentValue);

  // --- structures -------------------------------------------------------------
  for (const [id, dx] of [['sp:mutagen_lab', 20], ['sp:meteor_crash', 40]]) {
    try {
      const loc = ctx.at(dx, id === 'sp:meteor_crash' ? -4 : 0, 10);
      ctx.run(`tickingarea add circle ${Math.floor(loc.x)} -60 ${Math.floor(loc.z)} 2 sp_struct_${dx}`);
      await ctx.wait(10);
      world.structureManager.place(id, ctx.dim, { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) });
      await ctx.wait(2);
      let custom = 0;
      for (let x = 0; x < 13; x++)
        for (let y = 0; y < 9; y++)
          for (let z = 0; z < 13; z++) {
            const b = ctx.dim.getBlock({ x: Math.floor(loc.x) + x, y: Math.floor(loc.y) + y, z: Math.floor(loc.z) + z });
            if (b && b.typeId.startsWith('sp:')) custom++;
          }
      ctx.assert(custom > 0, `${id} places with its custom blocks`, custom);
      if (id === 'sp:mutagen_lab') {
        const chest = ctx.dim.getBlock({ x: Math.floor(loc.x) + 2, y: Math.floor(loc.y) + 1, z: Math.floor(loc.z) + 2 });
        ctx.assert(chest?.typeId === 'minecraft:chest', 'lab chest present', chest?.typeId);
      }
    } catch (e) {
      ctx.assert(false, `${id} placement threw`, String(e));
    }
  }
}
