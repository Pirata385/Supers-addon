// Test suite: Speedster — Speed Force gears (movement attribute, distance covered), passive tags,
// plow, projectile dodge, water running, Time Dilation (mob movement + projectile velocity, restore),
// Blitz Dash (distance, damage, fragile blocks, stops at walls) and cleanup on revoke.
import { GameMode } from '@minecraft/server';

const NAME = 'Blur';
const S = 'speedster';
const DILATION_FACTOR = 0.12; // config TUNING.speedster.dilationFactor

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

function loc(e) {
  const l = e.location;
  return { x: l.x, y: l.y, z: l.z };
}

function hdist(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function len(v) {
  return Math.hypot(v.x, v.y, v.z);
}

function vel(e) {
  try {
    return e.getVelocity();
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function movement(e) {
  try {
    return e.getComponent('minecraft:movement').currentValue;
  } catch {
    return -1;
  }
}

function r4(v) {
  return Math.round(v * 10000) / 10000;
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
  const o = ctx.origin;
  // keep the running lanes loaded and ticking
  const area = (name, x1, z1, x2, z2) =>
    ctx.run(`tickingarea add ${Math.floor(o.x + x1)} -64 ${Math.floor(o.z + z1)} ${Math.floor(o.x + x2)} -40 ${Math.floor(o.z + z2)} ${name}`);
  area('sp_speed_lane_a', -8, -30, 8, 330);
  area('sp_speed_lane_b', 22, -10, 38, 150);
  area('sp_speed_lane_c', -70, -50, -22, 10);
  const p = await ctx.player(NAME, 0, -20, GameMode.Survival);
  try {
    await suite(ctx, p);
  } finally {
    try {
      p.stopMoving();
    } catch {
      /* ignore */
    }
    for (const n of ['sp_speed_lane_a', 'sp_speed_lane_b', 'sp_speed_lane_c']) ctx.run(`tickingarea remove ${n}`);
  }
}

/**
 * @param {import('../ctx.js').Ctx} ctx
 * @param {any} p simulated player
 */
async function suite(ctx, p) {
  const st = async () => (await ctx.dump(p)).data?.[S] ?? {};
  const place = async (dx, dz) => {
    p.teleport(ctx.at(dx, 0, dz));
    await ctx.wait(3);
    p.lookAtLocation(ctx.at(dx, 1.62, dz + 2000));
    await ctx.wait(2);
  };
  const stopRunning = async () => {
    p.stopMoving();
    p.isSprinting = false;
    await ctx.sp('input', `${NAME} clear`);
  };
  /** Sprint forward (move override + sprint flag) for `ticks`, calling `each(t)` every tick. */
  const sprint = async (ticks, each) => {
    await ctx.sp('input', `${NAME} move 0 1`);
    p.isSprinting = true;
    p.moveRelative(0, 1, 1);
    for (let t = 0; t < ticks; t++) {
      await ctx.wait(1);
      if (!p.isSprinting) p.isSprinting = true;
      if (each && (await each(t)) === true) break;
    }
  };

  let r = await ctx.sp('grant', `${NAME} ${S} silent`);
  ctx.assert(r.ok === true, 'grant speedster', r);
  await ctx.wait(3);
  let d = await ctx.dump(p);
  let s = d.data?.[S] ?? {};
  ctx.assert(d.tags.includes('sp_nokinetic'), 'passive: sp_nokinetic tag (no fly-into-wall damage)', d.tags);
  ctx.assert(!d.tags.includes('sp_dodge') && !d.tags.includes('sp_nofall'), 'no dodge/nofall tags while Speed Force is off', d.tags);
  ctx.assert(s.active === false && Math.abs(movement(p) - 0.1) < 1e-4, 'idle: vanilla movement attribute 0.1', { s, movement: movement(p) });

  // ---------------------------------------------------------------- Speed Force + gears
  let runEnd;
  {
    await place(0, -20);
    r = await ctx.sp('ability', `${NAME} ${S} speed_force force`);
    ctx.assert(r.fired === true, 'speed force toggles on', r);
    await ctx.wait(2);
    d = await ctx.dump(p);
    s = d.data[S];
    ctx.assert(s.active === true && s.gear === 1, 'speed force active in gear 1', s);
    ctx.assert(movement(p) > 0.25 && s.movement > 0.25, 'movement attribute raised above vanilla 0.1', { movement: movement(p), s });
    ctx.assert(d.tags.includes('sp_nofall'), 'nofall while Speed Force is active', d.tags);

    const z0 = p.location.z;
    let maxGear = 0;
    let dodgeTagAtGear2 = null;
    let poseSeen = null;
    let maxSpeed = 0;
    let supersonicFov = null;
    await sprint(160, async (t) => {
      if (t % 10 === 9) {
        const dd = await ctx.dump(p);
        const ss = dd.data[S];
        maxGear = Math.max(maxGear, ss.gear);
        maxSpeed = Math.max(maxSpeed, ss.speed ?? 0);
        if (ss.gear >= 2 && dodgeTagAtGear2 === null) dodgeTagAtGear2 = dd.tags.includes('sp_dodge');
        if (ss.gear >= 2 && ss.pose) poseSeen = ss.pose;
        if (ss.gear === 4) supersonicFov = ss.fov;
        if (t === 39 || t === 99 || t === 159) ctx.log(`run t=${t + 1}: gear ${ss.gear} sprintTicks ${ss.sprintTicks} speed ${ss.speed} movement ${ss.movement} z=${(p.location.z - z0).toFixed(1)}`);
      }
    });
    const dist = p.location.z - z0;
    s = await st();
    ctx.log(`speed run: ${dist.toFixed(1)} blocks in 160 ticks, max gear ${maxGear}, max speed ${maxSpeed} b/t`);
    ctx.assert(maxGear >= 3 && s.gear >= 3, 'sprinting climbs to gear >= 3', { maxGear, s });
    ctx.assert(maxGear === 4 && s.gear === 4 && Math.abs(s.movement - 1.25) < 1e-3, 'gear 4 (supersonic) after gearUpTicks[4] of sprinting', { maxGear, s });
    ctx.assert(supersonicFov === 102, 'supersonic FOV 70 + 4 x 8', { supersonicFov });
    ctx.assert(dist > 150, 'covers far more ground than a vanilla sprint (~45 blocks in 160 ticks)', { dist });
    ctx.assert(dodgeTagAtGear2 === true, 'sp_dodge (projectile immunity) tag at gear >= 2', { dodgeTagAtGear2 });
    ctx.assert(poseSeen === 'animation.sp.speed.run', 'run pose at gear >= 2 while moving', { poseSeen });
    ctx.assert(s.fov >= 94, 'FOV widens with the gear', s.fov);

    // ---------------------------------------------------------------- plow (gear >= 3)
    const here = p.location;
    const husk = ctx.dim.spawnEntity('minecraft:husk', { x: here.x, y: here.y, z: here.z + 16 });
    const gz = Math.floor(here.z + 26);
    ctx.run(`setblock ${Math.floor(here.x)} ${Math.floor(here.y) + 1} ${gz} glass`);
    const h0 = hp(husk);
    const hl0 = loc(husk);
    const plowBefore = s.plowHits ?? 0;
    let gearAtPlow = s.gear;
    await sprint(16, async (t) => {
      if (t === 0) gearAtPlow = (await st()).gear;
    });
    s = await st();
    const h1 = hp(husk);
    const moved = valid(husk) ? hdist(loc(husk), hl0) : 99;
    let glass = ctx.dim.getBlock({ x: Math.floor(here.x), y: Math.floor(here.y) + 1, z: gz });
    ctx.assert(gearAtPlow >= 3, 'plow test runs at gear >= 3', { gearAtPlow });
    ctx.log(`plow: gear ${gearAtPlow}, husk ${h0} -> ${h1} hp, moved ${moved.toFixed(1)}, plowHits ${s.plowHits}, broken ${s.plowBroken}`);
    ctx.assert((s.plowHits ?? 0) > plowBefore && (h0 - h1 >= 6 || !valid(husk)), 'plow: running into a husk at gear 3 damages it', { h0, h1, s });
    ctx.assert(moved > 3, 'plow: the husk is launched along the run', { moved });
    ctx.assert(glass?.typeId === 'minecraft:air' && (s.plowBroken ?? 0) >= 1, 'plow: fragile glass at head height shatters', { glass: glass?.typeId, s });
    remove(husk);
    runEnd = p.location;
  }

  // ---------------------------------------------------------------- dodge (still at gear >= 2 right after stopping)
  {
    await stopRunning();
    await ctx.wait(5);
    const before = await st();
    const pl = p.location;
    const hp0 = hp(p);
    const arrow = ctx.dim.spawnEntity('minecraft:arrow', { x: pl.x + 7, y: pl.y + 1.0, z: pl.z });
    arrow.applyImpulse({ x: -1.6, y: 0.06, z: 0 });
    let after = before;
    for (let t = 0; t < 10; t++) {
      await ctx.wait(1);
      if (t % 2 === 1) {
        after = await st();
        if ((after.dodges ?? 0) > (before.dodges ?? 0)) break;
      }
    }
    await ctx.wait(6);
    const side = Math.abs(p.location.z - pl.z);
    ctx.log(`dodge: gear ${before.gear}, dodges ${before.dodges} -> ${after.dodges}, sidestep ${side.toFixed(2)}, hp ${hp0} -> ${hp(p)}`);
    ctx.assert(before.gear >= 2, 'still in gear >= 2 just after stopping', before);
    ctx.assert((after.dodges ?? 0) > (before.dodges ?? 0), 'dodge: an incoming arrow triggers a sidestep', { before: before.dodges, after: after.dodges, last: after.lastDodge });
    ctx.assert(side > 0.8, 'dodge: the player steps out of the arrow path', { side });
    ctx.assert(hp(p) >= hp0, 'dodge: no damage taken from the arrow', { hp0, hp1: hp(p) });
    remove(arrow);
  }

  // ---------------------------------------------------------------- Speed Force off
  {
    await ctx.wait(30); // gear falls back while standing still
    s = await st();
    ctx.assert(s.gear === 1, 'gear decays back to 1 when no longer sprinting', s);
    r = await ctx.sp('ability', `${NAME} ${S} speed_force force`);
    ctx.assert(r.fired === true, 'speed force toggles off', r);
    await ctx.wait(2);
    d = await ctx.dump(p);
    s = d.data[S];
    ctx.assert(s.active === false && Math.abs(movement(p) - 0.1) < 1e-4, 'off: movement attribute restored to 0.1', { s, movement: movement(p) });
    ctx.assert(!d.tags.includes('sp_dodge') && !d.tags.includes('sp_nofall') && d.tags.includes('sp_nokinetic'), 'off: dodge/nofall tags removed, nokinetic kept', d.tags);
    ctx.assert(s.fov === null && s.pose === null, 'off: FOV and pose reset', s);
  }

  // ---------------------------------------------------------------- Time Dilation
  {
    await place(-60, 0);
    const pig = ctx.spawn('minecraft:pig', -56, 0, 0);
    await ctx.wait(3);
    const pig0 = movement(pig);
    r = await ctx.sp('ability', `${NAME} ${S} time_dilation force`);
    ctx.assert(r.fired === true, 'time dilation starts', r);
    await ctx.wait(3);
    const pig1 = movement(pig);
    ctx.assert(pig0 > 0 && Math.abs(pig1 - pig0 * DILATION_FACTOR) < 1e-3, 'dilation: pig movement attribute slowed to orig x factor', { pig0, pig1 });
    // a snowball flying away from the player, high above the ground
    const ball = ctx.dim.spawnEntity('minecraft:snowball', ctx.at(-57, 8, 0));
    ball.applyImpulse({ x: 1.2, y: 0, z: 0 });
    await ctx.wait(4);
    const b0 = loc(ball);
    await ctx.wait(10);
    const b1 = valid(ball) ? loc(ball) : b0;
    const bv = vel(ball);
    const disp = Math.hypot(b1.x - b0.x, b1.z - b0.z);
    s = await st();
    ctx.log(`dilation: snowball moved ${disp.toFixed(2)} blocks (dy ${(b1.y - b0.y).toFixed(2)}) in 10 ticks, |v| ${len(bv).toFixed(3)}, affected ${s.affected}`);
    ctx.assert(valid(ball) && disp < 3 && disp > 0.3, 'dilation: snowball drifts in slow motion (~1.4 blocks instead of ~11)', { disp, b0, b1 });
    ctx.assert(Math.abs(b1.y - b0.y) < 1.2, 'dilation: snowball does not drop at full gravity', { dy: b1.y - b0.y });
    ctx.assert(len(bv) < 0.4, 'dilation: snowball velocity is scaled down', bv);
    ctx.assert(s.dilation === true && s.affected >= 2, 'dilation: debug reports the slowed entities', s);
    d = await ctx.dump(p);
    ctx.assert((d.cd['speedster.time_dilation'] ?? 0) === 0, 'no cooldown while dilation runs', d.cd);

    r = await ctx.sp('ability', `${NAME} ${S} time_dilation force`);
    ctx.assert(r.fired === true, 'time dilation toggles off', r);
    await ctx.wait(2);
    const pig2 = movement(pig);
    const bv2 = vel(ball);
    d = await ctx.dump(p);
    s = d.data[S];
    ctx.log(`dilation end: pig ${pig0} -> ${pig1} -> ${pig2}, snowball |v| ${len(bv2).toFixed(3)}`);
    ctx.assert(pig2 === pig0 || Math.abs(pig2 - pig0) < 1e-6, 'dilation end: pig movement restored exactly', { pig0, pig2 });
    ctx.assert(valid(ball) && len(bv2) > 0.7, 'dilation end: snowball resumes at full speed', bv2);
    ctx.assert(s.dilation === false && s.affected === 0, 'dilation end: nothing tracked any more', s);
    ctx.assert((d.cd['speedster.time_dilation'] ?? 0) > 300, 'dilation end: cooldown started', d.cd);
    remove(pig, ball);
  }

  // ---------------------------------------------------------------- Blitz Dash
  {
    await ctx.sp('cd', NAME);
    await place(-30, -45);
    const start = loc(p);
    const husk = ctx.spawn('minecraft:husk', -30, 0, -35);
    ctx.fill([-30, 1, -40], [-30, 1, -40], 'glass');
    await ctx.wait(2);
    const h0 = hp(husk);
    r = await ctx.sp('ability', `${NAME} ${S} blitz force`);
    ctx.assert(r.fired === true, 'blitz fires with Speed Force off', r);
    await ctx.wait(2);
    let d2 = await ctx.dump(p);
    s = d2.data[S];
    const travel = hdist(loc(p), start);
    const h1 = hp(husk);
    ctx.log(`blitz: travelled ${travel.toFixed(1)} blocks, husk ${h0} -> ${h1}, ${JSON.stringify(s.lastBlitz)}`);
    ctx.assert(travel >= 20, 'blitz teleports the player 20+ blocks forward', { travel, last: s.lastBlitz });
    ctx.assert(h0 - h1 >= 10 || !valid(husk), 'blitz damages the husk on the path', { h0, h1 });
    ctx.assert(ctx.block(-30, 1, -40)?.typeId === 'minecraft:air', 'blitz shatters fragile glass on the path', ctx.block(-30, 1, -40)?.typeId);
    ctx.assert(d2.tags.includes('sp_nofall'), 'blitz grants temporary nofall', d2.tags);
    d2 = await ctx.dump(p);
    ctx.assert((d2.cd['speedster.blitz'] ?? 0) > 40, 'blitz starts its cooldown', d2.cd);
    remove(husk);

    // a stone wall stops the dash in front of it
    await ctx.sp('cd', NAME);
    await place(-30, -45);
    ctx.fill([-33, 0, -37], [-27, 3, -37], 'stone');
    await ctx.wait(2);
    r = await ctx.sp('ability', `${NAME} ${S} blitz force`);
    await ctx.wait(2);
    s = await st();
    const z = p.location.z - ctx.origin.z;
    ctx.log(`blitz into wall: stopped at dz ${z.toFixed(2)} (wall at -37), ${JSON.stringify(s.lastBlitz)}`);
    ctx.assert(r.fired === true && z < -37.2 && z > -40, 'blitz stops right before a stone wall', { z, last: s.lastBlitz });
    ctx.assert(s.lastBlitz?.blocked === true, 'blitz reports the wall', s.lastBlitz);
    ctx.fill([-33, 0, -37], [-27, 3, -37], 'air');
  }

  // ---------------------------------------------------------------- water running
  {
    await ctx.sp('cd', NAME);
    ctx.fill([27, -3, 45], [33, -1, 125], 'water');
    await place(30, -5);
    r = await ctx.sp('ability', `${NAME} ${S} speed_force force`);
    ctx.assert(r.fired === true, 'speed force on for water running', r);
    const poolStart = ctx.origin.z + 45;
    const poolEnd = ctx.origin.z + 126;
    let gearAtEntry = -1;
    let minY = Infinity;
    let overPool = 0;
    let waterSeen = false;
    let crossed = false;
    await sprint(200, async (t) => {
      const l = p.location;
      if (l.z >= poolStart + 1 && l.z <= poolEnd - 1) {
        overPool++;
        minY = Math.min(minY, l.y);
        if (gearAtEntry < 0 || overPool % 6 === 0) {
          const ss = await st();
          if (gearAtEntry < 0) gearAtEntry = ss.gear;
          if (ss.waterRunning) waterSeen = true;
        }
      }
      if (l.z > poolEnd + 2) {
        crossed = true;
        return true;
      }
      if (t === 199) ctx.log(`water run timeout at dz ${(l.z - ctx.origin.z).toFixed(1)} y ${l.y.toFixed(2)}`);
      return false;
    });
    const surface = ctx.origin.y; // the pool's top water block is at y-1, its surface at origin y
    ctx.log(`water run: gear at entry ${gearAtEntry}, ${overPool} ticks over the pool, min y ${(minY - surface).toFixed(2)} vs surface, crossed ${crossed}`);
    ctx.assert(gearAtEntry >= 2, 'reaches the pool in gear >= 2', { gearAtEntry });
    ctx.assert(waterSeen, 'debug reports water running over the pool', { waterSeen });
    ctx.assert(overPool > 0 && minY >= surface - 0.45, 'water running: stays on top of the water surface', { minY, surface });
    ctx.assert(crossed, 'water running: crosses the whole 80-block pool', { crossed, at: loc(p) });
    await stopRunning();
    ctx.fill([27, -3, 45], [33, -1, 125], 'grass');
  }

  // ---------------------------------------------------------------- revoke cleans everything up
  {
    await ctx.wait(10);
    const pl = p.location;
    const pig = ctx.dim.spawnEntity('minecraft:pig', { x: pl.x + 3, y: pl.y, z: pl.z });
    await ctx.wait(2);
    const pig0 = movement(pig);
    await ctx.sp('cd', NAME);
    r = await ctx.sp('ability', `${NAME} ${S} time_dilation force`);
    await ctx.wait(4);
    const pig1 = movement(pig);
    s = await st();
    ctx.assert(r.fired === true && s.active === true && s.dilation === true && pig1 < pig0 * 0.5, 'before revoke: speed force + dilation running', { s, pig0, pig1 });
    r = await ctx.sp('revoke', `${NAME} ${S}`);
    ctx.assert(r.ok === true, 'revoke speedster', r);
    await ctx.wait(3);
    d = await ctx.dump(p);
    const pig2 = movement(pig);
    ctx.assert(Math.abs(movement(p) - 0.1) < 1e-4, 'revoke: player movement attribute back to 0.1', movement(p));
    ctx.assert(pig2 === pig0 || Math.abs(pig2 - pig0) < 1e-6, 'revoke: slowed pig restored', { pig0, pig2 });
    ctx.assert(!d.tags.some((t) => t === 'sp_nokinetic' || t === 'sp_dodge' || t === 'sp_nofall'), 'revoke: immunity tags removed', d.tags);
    ctx.assert(!d.powers.includes(S) && d.data[S] === undefined, 'revoke: power and state gone', d);
    remove(pig);
  }
}
