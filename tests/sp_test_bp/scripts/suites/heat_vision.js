// Test suite: Heat Vision — focus cycling, beam damage / fire / splash, intensity buttons,
// block heating (sand -> glass, wood ignites then vaporises, stone -> magma at intensity 5),
// heat gauge + overheat lock-out, Scorching Blast (blocks + target, player unharmed) and cleanup.
import { GameMode, world } from '@minecraft/server';

const NAME = 'Cyclops';
const S = 'heat_vision';

function hp(e) {
  try {
    return e.getComponent('minecraft:health').currentValue;
  } catch {
    return 0;
  }
}

function valid(e) {
  try {
    return !!e && e.isValid;
  } catch {
    return false;
  }
}

function onFire(e) {
  try {
    return !!e.getComponent('minecraft:onfire');
  } catch {
    return false;
  }
}

function remove(...list) {
  for (const e of list) {
    try {
      if (valid(e)) e.remove();
    } catch {
      /* ignore */
    }
  }
}

function typeAt(ctx, dx, dy, dz) {
  return ctx.block(dx, dy, dz)?.typeId ?? 'none';
}

/** @param {import('../ctx.js').Ctx} ctx */
export async function run(ctx) {
  const p = await ctx.player(NAME, 0, -10, GameMode.Survival);
  const playerHurt = [];
  const mobHurt = [];
  const sub = world.afterEvents.entityHurt.subscribe((ev) => {
    try {
      const src = ev.damageSource;
      if (ev.hurtEntity.id === p.id) playerHurt.push(`${src.cause}:${ev.damage}`);
      else mobHurt.push({ id: ev.hurtEntity.id, cause: src.cause, by: src.damagingEntity?.id ?? null, dmg: ev.damage });
    } catch {
      /* ignore */
    }
  });
  try {
    await suite(ctx, p, playerHurt, mobHurt);
  } finally {
    world.afterEvents.entityHurt.unsubscribe(sub);
  }
}

/**
 * @param {import('../ctx.js').Ctx} ctx
 * @param {any} p simulated player
 * @param {string[]} playerHurt
 * @param {{id:string, cause:string, by:string|null, dmg:number}[]} mobHurt
 */
async function suite(ctx, p, playerHurt, mobHurt) {
  const st = async () => (await ctx.dump(p)).data?.[S] ?? {};
  const place = async (dx, dz, look) => {
    p.teleport(ctx.at(dx, 0, dz));
    await ctx.wait(3);
    p.lookAtLocation(look);
    await ctx.wait(2);
  };
  const press = async (button, times = 1) => {
    for (let i = 0; i < times; i++) {
      await ctx.sp('input', `${NAME} button ${button} 1`);
      await ctx.sp('input', `${NAME} button ${button} 0`);
    }
  };
  const holdStart = () => ctx.sp('hold', `${NAME} ${S} heat_beam start`);
  const holdEnd = () => ctx.sp('hold', `${NAME} ${S} heat_beam end`);
  /** Let the eyes cool down below `limit` gauge. */
  const cool = async (limit) => {
    for (let i = 0; i < 30; i++) {
      const s = await st();
      if (!s.overheated && s.gauge <= limit) return s;
      await ctx.wait(10);
    }
    return st();
  };

  let r = await ctx.sp('grant', `${NAME} ${S} silent`);
  ctx.assert(r.ok === true, 'grant heat_vision', r);
  await ctx.wait(3);
  let d = await ctx.dump(p);
  let s = d.data?.[S] ?? {};
  ctx.assert(s.firing === false && s.defaultIntensity === 3 && s.gauge === 0 && s.overheated === false, 'initial state: idle, intensity 3, cold gauge', s);
  ctx.assert(!d.tags.includes('sp_fireproof'), 'no firewalk tag while idle', d.tags);

  // ---------------------------------------------------------------- focus intensity
  {
    const seen = [];
    for (let i = 0; i < 5; i++) {
      r = await ctx.sp('ability', `${NAME} ${S} focus force`);
      seen.push((await st()).defaultIntensity);
    }
    ctx.assert(r.fired === true, 'focus fires', r);
    ctx.assert(JSON.stringify(seen) === JSON.stringify([4, 5, 1, 2, 3]), 'focus cycles default intensity 3 -> 4 -> 5 -> 1 -> 2 -> 3', seen);
    d = await ctx.dump(p);
    ctx.assert((d.cd[`${S}.focus`] ?? 0) > 0, 'focus starts its short cooldown', d.cd);
  }

  // ---------------------------------------------------------------- beam burns a creature
  {
    const spot = ctx.at(0, 0, -2);
    await place(0, -10, ctx.at(0, 0.9, -2));
    const husk = ctx.dim.spawnEntity('minecraft:husk', spot);
    await ctx.wait(2);
    p.lookAtLocation(ctx.at(0, 0.9, -2));
    const h0 = hp(husk);
    mobHurt.length = 0;
    r = await holdStart();
    ctx.assert(r.started === true, 'heat beam: hold starts', r);
    await ctx.wait(1);
    d = await ctx.dump(p);
    s = d.data?.[S] ?? {};
    ctx.assert(s.firing === true && s.intensity === 3, 'firing at the default intensity', s);
    ctx.assert(s.pose === 'animation.sp.heat.beam', 'beam pose requested while firing', s.pose);
    ctx.assert(d.tags.includes('sp_fireproof'), 'firewalk (sp_fireproof) while firing', d.tags);
    let burning = false;
    for (let t = 0; t < 22; t++) {
      if (valid(husk)) husk.teleport(spot);
      await ctx.wait(1);
      burning = burning || (valid(husk) && onFire(husk));
    }
    s = await st();
    const h1 = valid(husk) ? hp(husk) : 0;
    const attributed = mobHurt.some((m) => m.id === husk.id && m.by === p.id && m.cause === 'fire');
    ctx.log(`beam: husk ${h0} -> ${h1} hp, lastHit=${JSON.stringify(s.lastHit)} lastDamage=${JSON.stringify(s.lastDamage)}`);
    ctx.assert(s.lastHit && s.lastHit.kind === 'entity' && s.lastHit.id === 'minecraft:husk', 'beam ray stops at the creature in front', s.lastHit);
    ctx.assert(h0 - h1 >= 4, 'beam damages the creature', { h0, h1, hurt: mobHurt.slice(0, 8) });
    ctx.assert(burning, 'beam sets the creature on fire');
    ctx.assert(attributed, 'beam damage is fire damage attributed to the player', mobHurt.slice(0, 6));
    ctx.assert(s.gauge > 5, 'heat gauge rises while firing', s.gauge);
    r = await holdEnd();
    await ctx.wait(2);
    s = await st();
    ctx.assert(s.firing === false && s.pose === null, 'release stops firing and the pose', s);
    remove(husk);
  }

  // ---------------------------------------------------------------- intensity via buttons while firing
  {
    await place(0, -10, ctx.at(0, 40, -6));
    r = await holdStart();
    await ctx.wait(1);
    await press('jump');
    const a = (await st()).intensity;
    await press('jump', 2);
    const b = (await st()).intensity;
    await press('sneak', 5);
    const c = (await st()).intensity;
    await press('jump', 2);
    s = await st();
    ctx.assert(a === 4, 'Jump raises the intensity while firing', a);
    ctx.assert(b === 5, 'intensity is capped at 5', b);
    ctx.assert(c === 1, 'Sneak lowers the intensity, floor 1', c);
    ctx.assert(s.intensity === 3 && s.defaultIntensity === 3, 'buttons change only the live intensity', s);
    ctx.assert(s.lastHit && s.lastHit.kind === 'none', 'beam into the sky hits nothing', s.lastHit);
    await holdEnd();
    await ctx.sp('input', `${NAME} clear`);
    await press('jump');
    s = await st();
    ctx.assert(s.intensity === 3, 'buttons do nothing while not firing', s.intensity);
    await ctx.sp('input', `${NAME} clear`);
  }

  // ---------------------------------------------------------------- splash damage near the impact
  {
    await cool(40);
    ctx.fill([-12, -1, -4], [-12, -1, -4], 'obsidian');
    const spot = ctx.at(-11.3, 0, -4);
    const pig = ctx.dim.spawnEntity('minecraft:pig', spot);
    await place(-12, -10, ctx.at(-12, 0, -4));
    const h0 = hp(pig);
    r = await holdStart();
    for (let t = 0; t < 18; t++) {
      if (valid(pig)) pig.teleport(spot);
      await ctx.wait(1);
    }
    s = await st();
    await holdEnd();
    const h1 = valid(pig) ? hp(pig) : 0;
    ctx.assert(s.lastHit && s.lastHit.kind === 'block' && s.lastHit.id === 'minecraft:obsidian', 'beam hits the obsidian target', s.lastHit);
    ctx.assert(h1 < h0, 'creatures next to the impact take splash damage', { h0, h1 });
    ctx.assert(typeAt(ctx, -12, -1, -4) === 'minecraft:obsidian', 'protected blocks are never altered');
    remove(pig);
  }

  // ---------------------------------------------------------------- sand melts into glass
  {
    await cool(40);
    ctx.fill([12, 0, -4], [12, 0, -4], 'sand');
    await place(12, -10, ctx.at(12, 0.5, -4.5));
    r = await holdStart();
    await ctx.wait(1);
    await press('sneak'); // intensity 2: no vaporising
    let glassAt = -1;
    for (let t = 0; t < 40; t++) {
      await ctx.wait(1);
      if (typeAt(ctx, 12, 0, -4) === 'minecraft:glass') {
        glassAt = t;
        break;
      }
    }
    s = await st();
    await holdEnd();
    ctx.log(`sand -> glass after ${glassAt} ticks at intensity ${s.intensity}`);
    ctx.assert(glassAt >= 0, 'sand turns into glass under the beam', { block: typeAt(ctx, 12, 0, -4), stats: s.stats, lastHit: s.lastHit });
    ctx.assert(s.stats && s.stats.glassed >= 1, 'glass conversion recorded', s.stats);
    await ctx.sp('input', `${NAME} clear`);
  }

  // ---------------------------------------------------------------- wood ignites, then vaporises at intensity 3
  // no vanilla fire spread here: the planks must only change through the beam
  ctx.run('gamerule dofiretick false');
  try {
    await woodTest(ctx, p, st, place, press, holdStart, holdEnd, cool);
  } finally {
    ctx.fill([20, 0, -12], [28, 2, 4], 'air');
    ctx.run('gamerule dofiretick true');
  }

  // ---------------------------------------------------------------- stone melts into magma at intensity 5
  {
    await cool(20);
    ctx.fill([36, 0, -4], [36, 1, -2], 'stone');
    await place(36, -10, ctx.at(36, 0.5, -4.5));
    r = await holdStart();
    await ctx.wait(1);
    await press('jump', 2); // intensity 5
    let magmaAt = -1;
    let meltedAt = -1;
    for (let t = 0; t < 45; t++) {
      await ctx.wait(1);
      const id = typeAt(ctx, 36, 0, -4);
      if (magmaAt < 0 && id === 'minecraft:magma') magmaAt = t;
      if (magmaAt >= 0 && id !== 'minecraft:magma') {
        meltedAt = t;
        break;
      }
    }
    s = await st();
    await holdEnd();
    ctx.log(`stone: magma after ${magmaAt} ticks, melted through after ${meltedAt} ticks, stats=${JSON.stringify(s.stats)}`);
    ctx.assert(magmaAt >= 0, 'stone becomes magma at intensity 5', { block: typeAt(ctx, 36, 0, -4), stats: s.stats, lastHit: s.lastHit });
    ctx.assert(meltedAt > magmaAt && s.stats.melted >= 1, 'magma melts through at intensity 5', { magmaAt, meltedAt, stats: s.stats });
    ctx.assert(s.heatBlocks >= 1, 'heat map tracks the heated blocks', s.heatBlocks);
    await ctx.sp('input', `${NAME} clear`);
  }

  // ---------------------------------------------------------------- overheat
  {
    await place(0, -10, ctx.at(0, 40, -6));
    r = await holdStart();
    await ctx.wait(1);
    await press('jump', 2); // intensity 5: ~4 s to a full gauge
    let overAt = -1;
    let lastGauge = 0;
    for (let t = 0; t < 140; t += 4) {
      await ctx.wait(4);
      const dd = await ctx.dump(p);
      lastGauge = dd.data?.[S]?.gauge ?? lastGauge;
      if (dd.data?.[S]?.overheated) {
        overAt = t;
        d = dd;
        break;
      }
    }
    s = d.data?.[S] ?? {};
    ctx.log(`overheated after ~${overAt} ticks`);
    ctx.assert(overAt >= 0, 'continuous firing overheats the eyes', { lastGauge });
    ctx.assert(d.hold === null && s.firing === false, 'overheat ends the hold', { hold: d.hold, firing: s.firing });
    ctx.assert((d.cd[`${S}.heat_beam`] ?? 0) > 60, 'overheat puts the beam on a long cooldown', d.cd);
    r = await holdStart();
    ctx.assert(r.started === false, 'the beam cannot restart while overheated', r);
    r = await ctx.sp('ability', `${NAME} ${S} scorch_blast force`);
    ctx.assert(r.fired === false, 'scorching blast is refused while overheated', r);
    await ctx.wait(10);
    s = await st();
    ctx.assert(s.gauge < 100 && s.gauge > 50, 'gauge cools down when not firing', s.gauge);
    await ctx.sp('input', `${NAME} clear`);
    s = await cool(100);
    ctx.assert(s.overheated === false, 'overheat wears off', s);
  }

  // ---------------------------------------------------------------- scorching blast
  {
    ctx.fill([47, 0, -5], [49, 2, -3], 'dirt');
    const spot = ctx.at(48, 0, -6);
    const husk = ctx.dim.spawnEntity('minecraft:husk', spot);
    await place(48, -10, ctx.at(48, 1, -6));
    husk.teleport(spot);
    await ctx.wait(1);
    p.lookAtLocation(ctx.at(48, 1, -6));
    await ctx.wait(1);
    let dirt0 = 0;
    for (let x = 47; x <= 49; x++) for (let y = 0; y <= 2; y++) for (let z = -5; z <= -3; z++) if (typeAt(ctx, x, y, z) === 'minecraft:dirt') dirt0++;
    const hpPlayer0 = hp(p);
    const hHusk0 = hp(husk);
    const g0 = (await st()).gauge;
    playerHurt.length = 0;
    r = await ctx.sp('ability', `${NAME} ${S} scorch_blast force`);
    ctx.assert(r.fired === true, 'scorching blast fires', r);
    d = await ctx.dump(p);
    await ctx.wait(8);
    s = await st();
    let dirt1 = 0;
    for (let x = 47; x <= 49; x++) for (let y = 0; y <= 2; y++) for (let z = -5; z <= -3; z++) if (typeAt(ctx, x, y, z) === 'minecraft:dirt') dirt1++;
    const hHusk1 = valid(husk) ? hp(husk) : 0;
    ctx.log(`blast: ${JSON.stringify(s.lastBlast)} dirt ${dirt0} -> ${dirt1}, husk ${hHusk0} -> ${hHusk1}, player ${hpPlayer0} -> ${hp(p)}, hurt=${playerHurt.join(',')}`);
    ctx.assert(s.lastBlast && s.lastBlast.target === 'minecraft:husk', 'blast ray hits the creature in front', s.lastBlast);
    ctx.assert(hHusk0 - hHusk1 >= 15, 'blast deals heavy damage to the directly hit creature', { hHusk0, hHusk1 });
    ctx.assert(dirt0 === 27 && dirt1 <= 24, 'blast destroys blocks at the target', { dirt0, dirt1 });
    ctx.assert(d.tags.includes('sp_blastproof'), 'player is blastproof right after a close blast', d.tags);
    ctx.assert(hp(p) >= hpPlayer0 && !playerHurt.some((h) => h.toLowerCase().includes('explosion')), 'blast does not hurt the player', { before: hpPlayer0, after: hp(p), hurt: playerHurt });
    ctx.assert(s.gauge >= g0 + 25, 'blast adds heat to the gauge', { g0, g1: s.gauge });
    d = await ctx.dump(p);
    ctx.assert((d.cd[`${S}.scorch_blast`] ?? 0) > 80, 'blast cooldown started', d.cd);
    remove(husk);
  }

  // ---------------------------------------------------------------- revoke while firing cleans up
  {
    await cool(60);
    await place(0, -10, ctx.at(0, 40, -6));
    r = await holdStart();
    ctx.assert(r.started === true, 'beam restarts once cooled', r);
    await ctx.wait(6);
    r = await ctx.sp('revoke', `${NAME} ${S}`);
    ctx.assert(r.ok === true, 'revoke heat_vision', r);
    await ctx.wait(6);
    d = await ctx.dump(p);
    ctx.assert(d.powers.length === 0 && d.hold === null, 'revoke ends the hold', d);
    ctx.assert(d.data[S] === undefined, 'no heat vision state left', d.data);
    ctx.assert(!d.tags.includes('sp_fireproof') && !d.tags.includes('sp_blastproof'), 'immunity tags removed', d.tags);
    const head = p.getHeadLocation();
    const headBlock = ctx.dim.getBlock({ x: Math.floor(head.x), y: Math.floor(head.y), z: Math.floor(head.z) });
    ctx.assert(!headBlock?.typeId.startsWith('minecraft:light_block'), 'eye glow light removed', headBlock?.typeId);
  }
}

/**
 * Wood: fire on the heated face at intensity 1 (planks intact), vaporised at intensity 3.
 * @param {import('../ctx.js').Ctx} ctx
 */
async function woodTest(ctx, p, st, place, press, holdStart, holdEnd, cool) {
  await cool(30);
  ctx.fill([24, 0, -4], [24, 0, -4], 'oak_planks');
  await place(24, -10, ctx.at(24, 0.5, -4.5));
  await holdStart();
  await ctx.wait(1);
  await press('sneak', 2); // intensity 1
  let fireSeen = false;
  for (let t = 0; t < 20; t++) {
    await ctx.wait(1);
    if (typeAt(ctx, 24, 0, -5) === 'minecraft:fire') fireSeen = true;
    if (fireSeen && t >= 12) break;
  }
  const plankAt1 = typeAt(ctx, 24, 0, -4);
  let s = await st();
  ctx.assert(s.intensity === 1, 'beam lowered to intensity 1', s.intensity);
  ctx.assert(fireSeen, 'wood catches fire: fire placed on the heated face', { front: typeAt(ctx, 24, 0, -5), stats: s.stats, lastHit: s.lastHit });
  ctx.assert(plankAt1 === 'minecraft:oak_planks', 'intensity 1 does not vaporise the planks', plankAt1);
  const v0 = s.stats?.vaporised ?? 0;
  await press('jump', 2); // intensity 3
  let goneAt = -1;
  for (let t = 0; t < 30; t++) {
    await ctx.wait(1);
    if (typeAt(ctx, 24, 0, -4) !== 'minecraft:oak_planks') {
      goneAt = t;
      break;
    }
  }
  s = await st();
  await holdEnd();
  ctx.assert(goneAt >= 0 && typeAt(ctx, 24, 0, -4) !== 'minecraft:oak_planks', 'planks vaporise at intensity 3', { goneAt, block: typeAt(ctx, 24, 0, -4) });
  ctx.assert((s.stats?.vaporised ?? 0) > v0 && s.stats.ignited >= 1, 'ignite + vaporise recorded', s.stats);
  await ctx.sp('input', `${p.name} clear`);
}
