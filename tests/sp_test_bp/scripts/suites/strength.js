// Test suite: Super Strength — punch, charged jump (hold + crouch shortcut), ground destruction,
// supersonic charge, thunderclap, passive toughness and cleanup on revoke.
import { GameMode, EntityTypes, world } from '@minecraft/server';

const NAME = 'Strongman';
const S = 'strength';

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

function hdist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function loc(e) {
  const l = e.location;
  return { x: l.x, y: l.y, z: l.z };
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

/** @param {import('../ctx.js').Ctx} ctx */
export async function run(ctx) {
  const p = await ctx.player(NAME, 0, -8, GameMode.Survival);
  // every hit the player takes, for diagnosing the fall-damage assertions
  const hurtLog = [];
  const hurtSub = world.afterEvents.entityHurt.subscribe((ev) => {
    try {
      if (ev.hurtEntity.id === p.id) hurtLog.push(`${ev.damageSource.cause}:${ev.damage}`);
    } catch {
      /* ignore */
    }
  });
  try {
    await suite(ctx, p, hurtLog);
  } finally {
    world.afterEvents.entityHurt.unsubscribe(hurtSub);
  }
}

/**
 * @param {import('../ctx.js').Ctx} ctx
 * @param {any} p simulated player
 * @param {string[]} hurtLog
 */
async function suite(ctx, p, hurtLog) {
  const st = async () => (await ctx.dump(p)).data?.[S] ?? {};
  /** Put the simulated player at a lane start, looking along +z. */
  const place = async (dx, dz) => {
    p.teleport(ctx.at(dx, 0, dz));
    await ctx.wait(3);
    p.lookAtLocation(ctx.at(dx, 1.62, dz + 40));
    await ctx.wait(2);
  };

  let r = await ctx.sp('grant', `${NAME} ${S} silent`);
  ctx.assert(r.ok === true, 'grant strength', r);
  await ctx.wait(3);
  let d = await ctx.dump(p);
  ctx.assert(d.tags.includes('sp_tough'), 'passive: sp_tough tag (all other damage x0.35)', d.tags);
  ctx.assert(!d.tags.includes('sp_nofall'), 'no nofall tag outside a leap', d.tags);

  // ---------------------------------------------------------------- super punch (passive)
  {
    await place(0, -8);
    const husk = ctx.spawn('minecraft:husk', 0, 0, -5.5);
    await ctx.wait(2);
    p.lookAtEntity(husk);
    await ctx.wait(1);
    const h0 = hp(husk);
    const l0 = loc(husk);
    const swung = p.attackEntity(husk);
    await ctx.wait(1);
    let v = { x: 0, y: 0, z: 0 };
    try {
      v = husk.getVelocity();
    } catch {
      /* dead */
    }
    await ctx.wait(7);
    const h1 = hp(husk);
    const moved = valid(husk) ? hdist(loc(husk), l0) : 99;
    const s = await st();
    ctx.log(`punch: husk ${h0} -> ${h1} hp, moved ${moved.toFixed(1)} blocks, v=${Math.hypot(v.x, v.z).toFixed(2)}`);
    ctx.assert(swung, 'simulated player swings at the husk');
    ctx.assert(h0 - h1 >= 6, 'super punch deals far more than a vanilla fist (1 dmg)', { h0, h1, punch: s.lastPunch });
    ctx.assert(moved >= 4 || Math.hypot(v.x, v.z) > 1.2, 'super punch launches the target', { moved, v });
    remove(husk);
  }

  // ---------------------------------------------------------------- charged jump (hold)
  {
    await ctx.sp('cd', NAME);
    await place(0, -10);
    const hp0 = hp(p);
    const y0 = p.location.y;
    r = await ctx.sp('hold', `${NAME} ${S} charged_jump start`);
    ctx.assert(r.started === true, 'charged jump: hold starts on the ground', r);
    await ctx.wait(18);
    let s = await st();
    ctx.assert(s.charging === true && s.charge > 0.25 && s.charge < 0.8, 'charge builds while holding', s);
    ctx.assert(s.pose === 'animation.sp.strength.charge', 'charge pose while charging', s.pose);
    await ctx.wait(26);
    s = await st();
    ctx.assert(s.charging === true && s.charge >= 0.99, 'full charge after jumpChargeTicks', s);
    await ctx.sp('hold', `${NAME} ${S} charged_jump end`);
    let maxY = y0;
    let nofall = false;
    let landedAt = -1;
    for (let t = 0; t < 160; t++) {
      await ctx.wait(1);
      maxY = Math.max(maxY, p.location.y);
      if (t === 8 || t === 30) nofall = nofall || p.hasTag('sp_nofall');
      if (t > 8 && p.isOnGround) {
        landedAt = t;
        break;
      }
    }
    ctx.log(`leap apex ${(maxY - y0).toFixed(1)} blocks, landed after ${landedAt} ticks`);
    ctx.assert(maxY - y0 >= 25, 'full charged jump rises roughly 30-40 blocks', { rise: maxY - y0 });
    ctx.assert(maxY - y0 <= 45, 'full charged jump stays below ~45 blocks', { rise: maxY - y0 });
    ctx.assert(nofall, 'sp_nofall tag while leaping');
    ctx.assert(landedAt > 0, 'player landed after the leap', { landedAt });
    await ctx.wait(6);
    s = await st();
    ctx.assert(s.leaping === false && s.lastLanding && s.lastLanding.charge >= 0.99, 'landing impact recorded at full charge', s.lastLanding);
    ctx.assert(s.lastLanding && s.lastLanding.broken > 0, 'full-charge landing carves a crater', s.lastLanding);
    ctx.assert(hp(p) >= hp0, 'no fall damage from the super leap', { before: hp0, after: hp(p), hurt: hurtLog });
  }

  // ---------------------------------------------------------------- landing hits nearby mobs
  {
    await ctx.sp('cd', NAME);
    await place(-30, -10);
    // look straight down-ish so the leap goes (almost) straight up and back down
    p.lookAtLocation(ctx.at(-30, -1, -9.6));
    await ctx.wait(2);
    const y0 = p.location.y;
    r = await ctx.sp('hold', `${NAME} ${S} charged_jump start`);
    await ctx.wait(14);
    await ctx.sp('hold', `${NAME} ${S} charged_jump end`);
    // drop a husk next to the predicted landing spot while the player comes down
    let husk;
    let h0 = 0;
    let landedAt = -1;
    for (let t = 0; t < 120; t++) {
      await ctx.wait(1);
      const l = p.location;
      if (!husk && t > 6 && p.getVelocity().y < 0 && l.y < y0 + 6) {
        husk = ctx.dim.spawnEntity('minecraft:husk', { x: l.x + 2, y: y0, z: l.z });
        h0 = hp(husk);
      }
      if (t > 6 && p.isOnGround) {
        landedAt = t;
        break;
      }
    }
    await ctx.wait(3);
    const s = await st();
    ctx.assert(landedAt > 0 && s.lastLanding && s.lastLanding.hits >= 1, 'landing shockwave hits a nearby mob', { landedAt, landing: s.lastLanding });
    ctx.assert(hp(husk) < h0, 'landing shockwave damages the mob', { h0, h1: hp(husk) });
    remove(husk);
  }

  // ---------------------------------------------------------------- crouch shortcut
  {
    await ctx.sp('cd', NAME);
    await place(-14, -10);
    await ctx.sp('input', `${NAME} button sneak 1`);
    await ctx.wait(8);
    let s = await st();
    ctx.assert(s.charging === false, 'crouching briefly does not charge yet', s);
    await ctx.wait(20);
    s = await st();
    ctx.assert(s.charging === true && s.chargeSource === 'sneak' && s.charge >= 0.15, 'crouching builds the leap charge', s);
    const y0 = p.location.y;
    await ctx.sp('input', `${NAME} button jump 1`);
    await ctx.sp('input', `${NAME} button jump 0`);
    await ctx.sp('input', `${NAME} button sneak 0`);
    let maxY = y0;
    let landedAt = -1;
    for (let t = 0; t < 120; t++) {
      await ctx.wait(1);
      maxY = Math.max(maxY, p.location.y);
      if (t > 8 && p.isOnGround) {
        landedAt = t;
        break;
      }
    }
    ctx.assert(maxY - y0 >= 5, 'crouch + jump launches a charged leap', { rise: maxY - y0 });
    ctx.assert(landedAt > 0, 'landed after the crouch leap', { landedAt });
    // releasing sneak without jumping cancels
    await ctx.sp('cd', NAME);
    await ctx.wait(3);
    await ctx.sp('input', `${NAME} button sneak 1`);
    await ctx.wait(22);
    s = await st();
    ctx.assert(s.charging === true, 'crouch charge started again', s);
    const y1 = p.location.y;
    await ctx.sp('input', `${NAME} button sneak 0`);
    await ctx.wait(6);
    s = await st();
    ctx.assert(s.charging === false && s.leaping === false && Math.abs(p.location.y - y1) < 0.6, 'releasing sneak cancels the charge', { s, dy: p.location.y - y1 });
    await ctx.sp('input', `${NAME} clear`);
  }

  // ---------------------------------------------------------------- ground destruction
  const debrisType = !!EntityTypes.get('sp:debris');
  if (!debrisType) {
    ctx.skip('ground destruction: sp:debris entity is not defined in this build');
  } else {
    await ctx.sp('cd', NAME);
    await place(14, -10);
    p.lookAtLocation(ctx.at(14, -0.5, -7));
    await ctx.wait(2);
    const before = ctx.block(14, -1, -7)?.typeId;
    r = await ctx.sp('ability', `${NAME} ${S} ground_destruction force`);
    ctx.assert(r.fired === true, 'ground destruction: tear out a boulder', r);
    await ctx.wait(8);
    const after = ctx.block(14, -1, -7)?.typeId;
    let s = await st();
    ctx.assert(before !== 'minecraft:air' && after === 'minecraft:air', 'targeted ground block was torn out', { before, after, rip: s.lastRip });
    ctx.assert(s.lastRip && s.lastRip.removed >= 3, 'a cluster of blocks was removed', s.lastRip);
    const boulders = ctx.entities('sp:debris', 80);
    ctx.assert(boulders.length === 1, 'one sp:debris boulder exists', boulders.length);
    ctx.assert(s.holdingBoulder === true && s.pose === 'animation.sp.strength.lift', 'player holds the boulder (lift pose)', s);
    if (boulders[0]) ctx.assert(boulders[0].location.y > p.location.y + 2.2, 'boulder floats above the head', { b: boulders[0].location.y, p: p.location.y });

    const husk = ctx.spawn('minecraft:husk', 14, 0, -1);
    await ctx.wait(3);
    p.lookAtEntity(husk);
    await ctx.wait(1);
    const h0 = hp(husk);
    r = await ctx.sp('ability', `${NAME} ${S} ground_destruction force`);
    ctx.assert(r.fired === true, 'second use throws the boulder', r);
    let goneAt = -1;
    for (let t = 0; t < 40; t++) {
      await ctx.wait(1);
      if (ctx.entities('sp:debris', 80).length === 0) {
        goneAt = t;
        break;
      }
    }
    await ctx.wait(2);
    s = await st();
    ctx.log(`boulder: ${JSON.stringify(s.lastRip)}, gone after ${goneAt} ticks, husk ${h0} -> ${hp(husk)}`);
    ctx.assert(goneAt >= 0, 'boulder shatters on impact', { goneAt });
    ctx.assert(!valid(husk) || hp(husk) < h0, 'boulder damages the target mob', { h0, h1: hp(husk) });
    ctx.assert(s.holdingBoulder === false && s.pose === null, 'boulder released (no lift pose)', s);
    d = await ctx.dump(p);
    ctx.assert((d.cd[`${S}.ground_destruction`] ?? 0) > 10, 'throw starts the full cooldown', d.cd);
    remove(husk);
  }

  // ---------------------------------------------------------------- supersonic charge
  {
    await ctx.sp('cd', NAME);
    await place(28, -20);
    ctx.fill([27, 0, -2], [29, 1, -2], 'dirt'); // soft wall in the path: plowed through
    const husk = ctx.spawn('minecraft:husk', 28, 0, -12);
    await ctx.wait(3);
    p.lookAtLocation(ctx.at(28, 1.62, 40));
    await ctx.wait(1);
    const start = loc(p);
    const h0 = hp(husk);
    r = await ctx.sp('ability', `${NAME} ${S} supersonic_charge force`);
    ctx.assert(r.fired === true, 'supersonic charge fires', r);
    await ctx.wait(3);
    d = await ctx.dump(p);
    ctx.assert(d.data[S].dashing === true && d.tags.includes('sp_nokinetic') && d.tags.includes('sp_nofall'), 'dashing with nokinetic + nofall', { s: d.data[S], tags: d.tags });
    await ctx.wait(26);
    const moved = hdist(start, p.location);
    const s = await st();
    ctx.log(`dash: moved ${moved.toFixed(1)} blocks, ${JSON.stringify(s.lastDash)}, husk ${h0} -> ${hp(husk)}`);
    ctx.assert(moved >= 15, 'supersonic charge covers >= 15 blocks', { moved, dash: s.lastDash });
    ctx.assert(!valid(husk) || hp(husk) < h0, 'mob in the path is damaged', { h0, h1: hp(husk), dash: s.lastDash });
    ctx.assert(s.dashing === false && s.lastDash && s.lastDash.hits >= 1, 'dash ended and recorded the hit', s.lastDash);
    ctx.assert(s.lastDash && s.lastDash.broken >= 1 && ctx.block(28, 0, -2)?.typeId === 'minecraft:air', 'dash plows through soft blocks', { dash: s.lastDash, b: ctx.block(28, 0, -2)?.typeId });
    remove(husk);
  }

  // ---------------------------------------------------------------- supersonic charge into a hard wall
  {
    await ctx.sp('cd', NAME);
    ctx.fill([55, 0, -6], [57, 2, -6], 'stone');
    await place(56, -12);
    const hp0 = hp(p);
    r = await ctx.sp('ability', `${NAME} ${S} supersonic_charge force`);
    await ctx.wait(12);
    const s = await st();
    ctx.assert(s.dashing === false && s.lastDash && s.lastDash.crashed === true && s.lastDash.distance < 7, 'dash stops dead against a hard wall', s.lastDash);
    ctx.assert(ctx.block(56, 0, -6)?.typeId === 'minecraft:stone', 'hard wall is not destroyed by the dash');
    ctx.assert(hp(p) >= hp0, 'no damage from slamming into the wall', { hp0, hp: hp(p), hurt: hurtLog });
    d = await ctx.dump(p);
    ctx.assert(d.data[S].pose === null, 'dash pose cleared after the crash', d.data[S].pose);
  }

  // ---------------------------------------------------------------- thunderclap
  {
    await ctx.sp('cd', NAME);
    ctx.fill([44, 0, 5], [46, 2, 5], 'glass');
    ctx.fill([44, 0, -14], [46, 2, -14], 'glass');
    await place(44, -4);
    const front = ctx.spawn('minecraft:husk', 42, 0, 2);
    const back = ctx.spawn('minecraft:husk', 44, 0, -10);
    await ctx.wait(2);
    p.lookAtLocation(ctx.at(44, 1.62, 40));
    await ctx.wait(1);
    const hf0 = hp(front), hb0 = hp(back);
    const lf0 = loc(front);
    const db0 = hdist(loc(back), p.location);
    r = await ctx.sp('ability', `${NAME} ${S} thunderclap force`);
    ctx.assert(r.fired === true, 'thunderclap fires', r);
    // an arrow flying at the player inside the cone gets sent back
    const arrow = ctx.spawn('minecraft:arrow', 45, 1.5, 3);
    try {
      arrow.applyImpulse({ x: 0, y: 0.05, z: -0.35 });
    } catch {
      /* ignore */
    }
    await ctx.wait(10);
    let av = { x: 0, y: 0, z: 0 };
    try {
      av = arrow.getVelocity();
    } catch {
      /* gone */
    }
    const s = await st();
    ctx.log(`clap: ${JSON.stringify(s.lastClap)}, front ${hf0} -> ${hp(front)}, back ${hb0} -> ${hp(back)}`);
    ctx.assert(hp(front) < hf0 || !valid(front), 'thunderclap damages the mob in front', { hf0, hf1: hp(front), clap: s.lastClap });
    ctx.assert(!valid(front) || hdist(loc(front), lf0) >= 2.5, 'thunderclap blows the front mob away', { moved: valid(front) ? hdist(loc(front), lf0) : 'dead' });
    ctx.assert(hp(back) === hb0, 'mob behind the player is not hurt', { hb0, hb1: hp(back) });
    ctx.assert(hdist(loc(back), p.location) <= db0 + 1, 'mob behind the player is not knocked back', { before: db0, after: hdist(loc(back), p.location) });
    let glassFront = 0, glassBack = 0;
    for (let x = 44; x <= 46; x++) {
      for (let y = 0; y <= 2; y++) {
        if (ctx.block(x, y, 5)?.typeId === 'minecraft:glass') glassFront++;
        if (ctx.block(x, y, -14)?.typeId === 'minecraft:glass') glassBack++;
      }
    }
    ctx.assert(ctx.block(44, 1, 5)?.typeId === 'minecraft:air' && glassFront < 9, 'glass in front shatters', { glassFront, clap: s.lastClap });
    ctx.assert(glassBack === 9, 'glass behind the player is intact', { glassBack });
    ctx.assert(s.lastClap && s.lastClap.hits >= 1 && s.lastClap.broken >= 1, 'thunderclap recorded hits and broken blocks', s.lastClap);
    ctx.assert(s.lastClap && s.lastClap.reflected >= 1 && (!valid(arrow) || av.z > 0 || ctx.block(45, 1, 5)?.typeId !== 'minecraft:glass'), 'projectile in the cone is reflected', { clap: s.lastClap, av });
    remove(front, back, arrow);
  }

  // ---------------------------------------------------------------- revoke cleans up
  {
    await ctx.sp('cd', NAME);
    await place(-44, -10);
    if (debrisType) {
      // rip the boulder from beside the dash lane: a randomly shaped (sometimes 2-deep)
      // hole straight ahead would legitimately stop the dash at its far edge
      p.lookAtLocation(ctx.at(-47, -0.5, -10));
      await ctx.wait(2);
      await ctx.sp('ability', `${NAME} ${S} ground_destruction force`);
      await ctx.wait(8);
      p.lookAtLocation(ctx.at(-44, 1.62, 40));
      await ctx.wait(1);
    }
    r = await ctx.sp('ability', `${NAME} ${S} supersonic_charge force`);
    await ctx.wait(3);
    let s = await st();
    ctx.assert(s.dashing === true && (!debrisType || s.holdingBoulder === true), 'dashing (with a boulder) before revoke', s);
    r = await ctx.sp('revoke', `${NAME} ${S}`);
    ctx.assert(r.ok === true, 'revoke strength', r);
    await ctx.wait(2);
    d = await ctx.dump(p);
    const leftover = d.tags.filter((t) => ['sp_tough', 'sp_nofall', 'sp_nokinetic', 'sp_has_strength'].includes(t));
    ctx.assert(!d.powers.includes(S) && leftover.length === 0, 'revoke removes every strength tag', { powers: d.powers, tags: d.tags });
    ctx.assert(d.data[S] === undefined, 'no strength runtime state left', d.data);
    let debrisLeft = 0;
    for (let t = 0; t < 60; t++) {
      await ctx.wait(1);
      debrisLeft = ctx.entities('sp:debris', 120).length;
      if (debrisLeft === 0) break;
    }
    ctx.assert(debrisLeft === 0, 'released boulder is gone after revoke', { debrisLeft });
  }
}
