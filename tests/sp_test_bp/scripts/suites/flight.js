// Test suite: Flight - passive immunity, take off / hover / land, vertical buttons, forward ramp,
// afterburner smashing glass panes and leaves, ramming, crashing into a hard wall, grab & throw,
// gentle release, the double-tap Jump shortcut (ignored in creative) and cleanup on revoke.
import { GameMode, world } from '@minecraft/server';

const NAME = 'Flyer';
const F = 'flight';
const POSE = {
  hover: 'animation.sp.flight.hover',
  cruise: 'animation.sp.flight.cruise',
  carry: 'animation.sp.flight.carry',
};

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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function r2(v) {
  return Math.round(v * 100) / 100;
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
  const p = await ctx.player(NAME, 0, -20, GameMode.Survival);
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
  const G = ctx.origin.y; // standing height on the flat world
  const st = async () => (await ctx.dump(p)).data?.[F] ?? {};
  const fire = (ability) => ctx.sp('ability', `${NAME} ${F} ${ability} force`);
  const input = (args) => ctx.sp('input', `${NAME} ${args}`);
  /** Look horizontally along +z from the current eye position. */
  const lookZ = () => {
    const l = p.location;
    p.lookAtLocation({ x: l.x, y: l.y + 1.62, z: l.z + 300 });
  };
  const landNow = async () => {
    if ((await st()).flying) await fire('take_off');
    await input('clear');
  };
  /** Put the player on the ground at a lane start, looking along +z, not flying. */
  const place = async (dx, dz) => {
    await landNow();
    await ctx.sp('cd', NAME);
    p.teleport(ctx.at(dx, 0, dz));
    await ctx.wait(4);
    lookZ();
    await ctx.wait(2);
  };
  const waitGround = async (max) => {
    for (let t = 0; t < max; t++) {
      await ctx.wait(1);
      if (t > 2 && p.isOnGround) return t;
    }
    return -1;
  };
  /** Double-tap Jump (two presses a tick or two apart). */
  const doubleTap = async () => {
    await input('button jump 1');
    await input('button jump 0');
    await input('button jump 1');
    await input('button jump 0');
  };

  let r = await ctx.sp('grant', `${NAME} ${F} silent`);
  ctx.assert(r.ok === true, 'grant flight', r);
  await ctx.wait(3);
  let d = await ctx.dump(p);
  ctx.assert(d.tags.includes('sp_nofall') && d.tags.includes('sp_nokinetic'), 'passive: sp_nofall + sp_nokinetic tags', d.tags);
  ctx.assert(d.data[F] && d.data[F].flying === false && d.data[F].carrying === null, 'not flying after grant', d.data[F]);

  // ---------------------------------------------------------------- passive: no fall damage
  {
    await place(0, -20);
    const hp0 = hp(p);
    p.teleport(ctx.at(0, 25, -20));
    await ctx.wait(2);
    const landed = await waitGround(100);
    await ctx.wait(3);
    ctx.assert(landed > 0, 'fell 25 blocks and landed', { landed });
    ctx.assert(hp(p) >= hp0, 'no fall damage from 25 blocks with flight (not flying)', { hp0, hp: hp(p), hurt: hurtLog });
    ctx.assert((await st()).flying === false, 'falling does not start flight by itself');
  }

  // ---------------------------------------------------------------- take off, hover, buttons, land
  {
    await place(0, -20);
    const hp0 = hp(p);
    const y0 = p.location.y;
    r = await fire('take_off');
    ctx.assert(r.fired === true, 'take off fires', r);
    await ctx.wait(25);
    let s = await st();
    const y1 = p.location.y;
    ctx.log(`take off: rose ${r2(y1 - y0)} blocks, ${JSON.stringify(s)}`);
    ctx.assert(s.flying === true && y1 - y0 > 2 && !p.isOnGround, 'take off lifts the player into the air', { rise: y1 - y0, s });
    ctx.assert(s.pose === POSE.hover, 'hover pose while hovering', s.pose);
    const l1 = loc(p);
    let minY = y1, maxY = y1;
    for (let t = 0; t < 40; t++) {
      await ctx.wait(1);
      minY = Math.min(minY, p.location.y);
      maxY = Math.max(maxY, p.location.y);
    }
    ctx.assert(maxY - minY < 1, 'hover holds altitude for 40 ticks without input', { minY: r2(minY), maxY: r2(maxY) });
    ctx.assert(hdist(loc(p), l1) < 1, 'hover holds position', { drift: r2(hdist(loc(p), l1)) });

    const ya = p.location.y;
    await input('button jump 1');
    await ctx.wait(10);
    await input('button jump 0');
    const yb = p.location.y;
    ctx.assert(yb - ya > 3, 'holding Jump rises', { rise: r2(yb - ya) });
    await ctx.wait(4);
    const yc = p.location.y;
    await input('button sneak 1');
    await ctx.wait(8);
    await input('button sneak 0');
    const ye = p.location.y;
    ctx.assert(yc - ye > 2.5, 'holding Sneak descends', { drop: r2(yc - ye) });
    await ctx.wait(3);
    s = await st();
    ctx.assert(s.flying === true && !p.isOnGround, 'still flying after the vertical moves', s);

    // strafe left (+x when facing +z) and fly backwards (-z) at cruise speed
    lookZ();
    await ctx.wait(1);
    const ls = loc(p);
    await input('move 1 0');
    await ctx.wait(10);
    const lm = loc(p);
    await input('move 0 -1');
    await ctx.wait(12);
    const lb = loc(p);
    await input('move 0 0');
    ctx.log(`strafe dx ${r2(lm.x - ls.x)} dz ${r2(lm.z - ls.z)}, back dz ${r2(lb.z - lm.z)}`);
    ctx.assert(lm.x - ls.x > 2.5 && Math.abs(lm.z - ls.z) < 1.5, 'strafe input flies sideways (left)', { dx: r2(lm.x - ls.x), dz: r2(lm.z - ls.z) });
    ctx.assert(lm.z - lb.z > 2.5, 'back input reverses and flies backwards', { dz: r2(lb.z - lm.z) });
    await ctx.wait(15);
    r = await fire('grab_throw');
    ctx.assert(r.fired === false && (await st()).carrying === null, 'grab with nothing in sight does not fire', r);

    r = await fire('take_off');
    ctx.assert(r.fired === true, 'take off toggles again (land)', r);
    await ctx.wait(2);
    d = await ctx.dump(p);
    s = d.data[F];
    ctx.assert(s.flying === false && s.pose === null && s.fov === null, 'landing ends flight, pose and FOV', s);
    ctx.assert((d.cd[`${F}.take_off`] ?? 0) > 0, 'toggle cooldown started', d.cd);
    const landed = await waitGround(80);
    await ctx.wait(3);
    ctx.assert(landed > 0 && hp(p) >= hp0, 'falls back to the ground without damage', { landed, hp0, hp: hp(p), hurt: hurtLog });
  }

  // ---------------------------------------------------------------- forward input: cruise, ramp, glide
  {
    await place(-12, -62);
    await fire('take_off');
    await ctx.wait(22);
    lookZ();
    await ctx.wait(1);
    const start = loc(p);
    await input('move 0 1');
    await ctx.wait(10);
    let s = await st();
    ctx.assert(s.speed >= 0.55 && s.speed <= 0.95, 'forward input cruises at about cruiseSpeed before the ramp', s);
    await ctx.wait(36);
    s = await st();
    const v = p.getVelocity();
    const moved = hdist(loc(p), start);
    ctx.log(`ramp: speed ${s.speed}, v=${r2(Math.hypot(v.x, v.z))}, moved ${r2(moved)}, dy ${r2(p.location.y - start.y)}`);
    ctx.assert(s.speed > 1.8, 'holding forward ramps the speed well above cruise', s);
    ctx.assert(Math.hypot(v.x, v.z) > 1.5, 'actual velocity follows the flight speed', v);
    ctx.assert(moved > 30, 'large horizontal displacement', { moved: r2(moved) });
    ctx.assert(Math.abs(p.location.y - start.y) < 2.5, 'level flight keeps its altitude', { dy: r2(p.location.y - start.y) });
    ctx.assert(s.pose === POSE.cruise, 'cruise pose at speed', s.pose);
    ctx.assert(typeof s.fov === 'number' && s.fov >= 1.5, 'FOV widens with speed', s.fov);
    if (s.speed >= 2.3) ctx.assert(s.lastBoom > 0, 'sonic boom when crossing boomSpeed', s.lastBoom);
    await input('move 0 0');
    await ctx.wait(40);
    s = await st();
    ctx.assert(s.flying === true && s.speed < 0.1, 'releasing the input glides to a hover', s);
    ctx.assert(s.pose === POSE.hover && s.fov === null, 'hover pose and normal FOV after slowing down', s);
  }

  // ---------------------------------------------------------------- afterburner: smash, ram, crash
  {
    await place(12, -46);
    const hp0 = hp(p);
    await fire('take_off');
    await ctx.wait(25);
    const hy = Math.floor(p.location.y - G); // block row of the feet, relative to the ground
    ctx.fill([9, hy - 2, -38], [15, hy + 3, -38], 'glass_pane');
    ctx.fill([9, hy - 2, -32], [15, hy + 3, -32], 'oak_leaves ["persistent_bit"=true]');
    ctx.fill([12, 0, -26], [12, hy - 1, -26], 'stone'); // pillar: the husk stands in the flight path
    ctx.fill([8, 0, -16], [16, hy + 5, -15], 'stone');
    await ctx.wait(2);
    const husk = ctx.spawn('minecraft:husk', 12, hy, -25.5);
    await ctx.wait(3);
    lookZ();
    await ctx.wait(1);
    const h0 = hp(husk);
    const hl0 = loc(husk);
    r = await fire('afterburner');
    ctx.assert(r.fired === true, 'afterburner fires', r);
    await ctx.wait(2);
    let s = await st();
    const v = p.getVelocity();
    ctx.assert(s.boosting === true && s.speed >= 3.4 && s.fov === 'boost', 'afterburner: max speed and wide FOV at once', s);
    ctx.assert(Math.hypot(v.x, v.y, v.z) > 2.8, 'afterburner: real velocity near maxSpeed', v);
    let crashed = -1;
    let huskMoved = 0;
    const huskPath = [];
    for (let t = 0; t < 30; t++) {
      await ctx.wait(1);
      if (valid(husk)) {
        huskMoved = Math.max(huskMoved, hdist(loc(husk), hl0));
        const hv = husk.getVelocity();
        huskPath.push(`${r2(hdist(loc(husk), hl0))}/${r2(Math.hypot(hv.x, hv.z))}`);
      }
      s = await st();
      if (s.lastCrash) {
        crashed = t;
        break;
      }
    }
    await ctx.wait(4);
    let panes = 0, leaves = 0;
    for (let y = hy; y <= hy + 1; y++) {
      for (let x = 11; x <= 13; x++) {
        if (ctx.block(x, y, -38)?.typeId !== 'minecraft:air') panes++;
        if (ctx.block(x, y, -32)?.typeId !== 'minecraft:air') leaves++;
      }
    }
    s = await st();
    ctx.log(`afterburner: crash ${JSON.stringify(s.lastCrash)} after ${crashed}, smashed ${s.smashed}, rams ${s.rams}, husk ${h0} -> ${hp(husk)}`);
    ctx.assert(panes === 0, 'glass pane wall in the path is smashed', { left: panes, smashed: s.smashed });
    ctx.assert(leaves === 0, 'leaves in the path are smashed', { left: leaves, smashed: s.smashed });
    ctx.assert(ctx.block(12, hy + 3, -38)?.typeId === 'minecraft:glass_pane', 'panes outside the path stay', ctx.block(12, hy + 3, -38)?.typeId);
    ctx.assert(s.rams >= 1 && (!valid(husk) || hp(husk) < h0), 'ramming damages a creature in the path', { rams: s.rams, h0, h1: hp(husk) });
    for (let t = 0; t < 6 && valid(husk); t++) {
      await ctx.wait(1);
      huskMoved = Math.max(huskMoved, hdist(loc(husk), hl0));
    }
    ctx.log(`husk path ${huskPath.join(' ')} ram ${JSON.stringify(s.lastRam)}`);
    ctx.assert(!valid(husk) || huskMoved > 1.5, 'rammed creature is knocked away', { moved: r2(huskMoved), ram: s.lastRam });
    ctx.assert(crashed >= 0 && s.lastCrash.speed > 2, 'hitting a hard wall at speed is a crash', s.lastCrash);
    ctx.assert(s.flying === true && s.speed < 0.5 && !s.boosting, 'crash stops the flight (residual speed)', s);
    ctx.assert(ctx.block(12, hy, -16)?.typeId === 'minecraft:stone', 'hard wall is not destroyed', ctx.block(12, hy, -16)?.typeId);
    ctx.assert(hp(p) >= hp0, 'no damage from the crash (nokinetic)', { hp0, hp: hp(p), hurt: hurtLog });
    remove(husk);
  }

  // ---------------------------------------------------------------- grab & throw
  {
    await place(28, -46);
    const pig = ctx.spawn('minecraft:pig', 28, 0, -43.5);
    await ctx.wait(3);
    r = await fire('grab_throw');
    ctx.assert(r.fired === false, 'grab needs flight (take off first)', r);
    p.lookAtEntity(pig);
    await ctx.wait(1);
    await fire('take_off');
    r = await fire('grab_throw');
    ctx.assert(r.fired === true, 'grab fires while flying', r);
    let s = await st();
    ctx.assert(s.carrying === 'minecraft:pig', 'carrying the pig', s);
    await ctx.wait(20);
    lookZ();
    await input('button jump 1');
    await ctx.wait(5);
    await input('button jump 0');
    await ctx.wait(3);
    s = await st();
    ctx.log(`carry: player ${r2(p.location.y - G)} pig ${valid(pig) ? r2(pig.location.y - G) : 'gone'}`);
    ctx.assert(valid(pig) && pig.location.y > G + 3 && dist(loc(pig), loc(p)) < 2.5, 'carried pig follows the flyer up', valid(pig) ? { pig: r2(pig.location.y - G), d: r2(dist(loc(pig), loc(p))) } : 'gone');
    ctx.assert(s.pose === POSE.carry, 'carry pose', s.pose);
    ctx.fill([24, 0, -34], [32, 14, -33], 'stone');
    await ctx.wait(2);
    const h0 = hp(pig);
    const pl0 = loc(pig);
    r = await fire('grab_throw');
    ctx.assert(r.fired === true, 'second use throws', r);
    s = await st();
    ctx.assert(s.carrying === null && s.lastThrow && s.lastThrow.target === 'minecraft:pig', 'pig released by the throw', s);
    let maxSpeed = 0, maxDist = 0;
    for (let t = 0; t < 30 && valid(pig); t++) {
      await ctx.wait(1);
      if (!valid(pig)) break;
      const pv = pig.getVelocity();
      maxSpeed = Math.max(maxSpeed, Math.hypot(pv.x, pv.y, pv.z));
      maxDist = Math.max(maxDist, dist(loc(pig), pl0));
    }
    ctx.log(`throw: pig max speed ${r2(maxSpeed)}, max dist ${r2(maxDist)}, hp ${h0} -> ${hp(pig)}`);
    ctx.assert(maxSpeed > 1.5 || maxDist > 8, 'thrown pig flies away fast', { maxSpeed: r2(maxSpeed), maxDist: r2(maxDist) });
    ctx.assert(!valid(pig) || hp(pig) < h0, 'thrown pig takes impact damage against the wall', { h0, h1: hp(pig) });
    remove(pig);

    // gentle release: carry a pig high up, then land - it floats down unharmed
    const hy = p.location.y - G;
    const pig2 = ctx.spawn('minecraft:pig', 28, hy, p.location.z - ctx.origin.z + 2);
    await ctx.wait(1);
    p.lookAtEntity(pig2);
    await ctx.wait(1);
    r = await fire('grab_throw');
    ctx.assert(r.fired === true && (await st()).carrying === 'minecraft:pig', 'grab a second pig', r);
    await input('button jump 1');
    await ctx.wait(10);
    await input('button jump 0');
    await ctx.wait(3);
    const high = valid(pig2) ? pig2.location.y - G : 0;
    ctx.log(`gentle: player ${r2(p.location.y - G)} pig ${r2(high)}`);
    const h2 = hp(pig2);
    r = await fire('take_off');
    s = await st();
    ctx.assert(s.flying === false && s.carrying === null, 'landing lets go of the carried pig', s);
    let settled = -1;
    for (let t = 0; t < 90 && valid(pig2); t++) {
      await ctx.wait(1);
      if (t > 3 && pig2.isOnGround) {
        settled = t;
        break;
      }
    }
    await ctx.wait(3);
    ctx.log(`gentle release from ${r2(high)} blocks, settled after ${settled} ticks, hp ${h2} -> ${hp(pig2)}`);
    ctx.assert(high > 5, 'pig was carried high up', { high: r2(high) });
    ctx.assert(settled > 0 && valid(pig2) && hp(pig2) >= h2, 'released pig floats down unharmed', { settled, h2, h: hp(pig2) });
    remove(pig2);
  }

  // ---------------------------------------------------------------- double-tap Jump shortcut
  {
    await place(-28, -46);
    p.teleport(ctx.at(-28, 6, -46));
    await ctx.wait(3);
    await doubleTap();
    await ctx.wait(3);
    let s = await st();
    ctx.assert(s.flying === true, 'double-tap Jump in mid-air takes off', s);
    await ctx.wait(15);
    ctx.assert(!p.isOnGround, 'shortcut flight hovers', p.location.y - G);
    await doubleTap();
    await ctx.wait(2);
    s = await st();
    ctx.assert(s.flying === false, 'double-tap Jump again lands', s);
    await waitGround(60);
    await input('clear');

    ctx.run(`gamemode creative ${NAME}`);
    await ctx.wait(3);
    p.teleport(ctx.at(-28, 6, -46));
    await ctx.wait(3);
    await doubleTap();
    await ctx.wait(3);
    s = await st();
    ctx.assert(s.flying === false, 'creative mode keeps vanilla double-jump (shortcut ignored)', s);
    ctx.run(`gamemode survival ${NAME}`);
    await waitGround(60);
    await input('clear');
  }

  // ---------------------------------------------------------------- revoke cleans up
  {
    await place(-28, -30);
    const pig = ctx.spawn('minecraft:pig', -28, 0, -27.5);
    await ctx.wait(3);
    p.lookAtEntity(pig);
    await ctx.wait(1);
    await fire('take_off');
    r = await fire('grab_throw');
    await ctx.wait(12);
    let s = await st();
    ctx.assert(s.flying === true && s.carrying === 'minecraft:pig', 'flying with a pig before revoke', s);
    const yr = p.location.y;
    r = await ctx.sp('revoke', `${NAME} ${F}`);
    ctx.assert(r.ok === true, 'revoke flight', r);
    await ctx.wait(6);
    ctx.assert(yr - p.location.y > 0.5 || p.isOnGround, 'player falls once flight is revoked', { dy: r2(p.location.y - yr) });
    d = await ctx.dump(p);
    const leftover = d.tags.filter((t) => ['sp_nofall', 'sp_nokinetic', 'sp_has_flight'].includes(t));
    ctx.assert(!d.powers.includes(F) && leftover.length === 0, 'revoke removes every flight tag', { powers: d.powers, tags: d.tags });
    ctx.assert(d.data[F] === undefined, 'no flight runtime state left', d.data);
    p.teleport(ctx.at(-20, 0, -30));
    const pigAt = valid(pig) ? loc(pig) : null;
    await ctx.wait(10);
    ctx.assert(valid(pig) && pigAt && hdist(loc(pig), pigAt) < 2, 'released pig no longer follows the player', pigAt && valid(pig) ? r2(hdist(loc(pig), pigAt)) : 'gone');
    remove(pig);
  }
}
