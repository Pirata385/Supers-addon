// Test suite: Esper — telekinesis (creature / dropped items / block, push-pull, launch, set down),
// levitation field + slam, psionic barrier (projectile reflection, repel, immunity tags),
// meteor call (falls, explodes at the target) and cleanup on revoke.
import { GameMode, ItemStack, world } from '@minecraft/server';

const NAME = 'Psion';
const S = 'esper';

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

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function vel(e) {
  try {
    const v = e.getVelocity();
    return { x: v.x, y: v.y, z: v.z };
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function speed(v) {
  return Math.hypot(v.x, v.y, v.z);
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

function fmt(v) {
  return v ? `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.z.toFixed(1)}` : 'null';
}

/** @type {string[]} damage taken by other entities (diagnostics) */
const mobLog = [];

/** @param {import('../ctx.js').Ctx} ctx */
export async function run(ctx) {
  const p = await ctx.player(NAME, 0, -10, GameMode.Survival);
  const hurtLog = [];
  mobLog.length = 0;
  const hurtSub = world.afterEvents.entityHurt.subscribe((ev) => {
    try {
      if (ev.hurtEntity.id === p.id) hurtLog.push(`${ev.damageSource.cause}:${ev.damage}`);
      else mobLog.push(`${ev.hurtEntity.typeId}:${ev.damageSource.cause}:${ev.damage.toFixed(1)}@${ev.hurtEntity.location.z.toFixed(1)}`);
    } catch {
      /* ignore */
    }
  });
  try {
    await suite(ctx, p, hurtLog);
  } finally {
    world.afterEvents.entityHurt.unsubscribe(hurtSub);
    for (const e of ctx.entities('minecraft:item', 60)) remove(e);
  }
}

/**
 * @param {import('../ctx.js').Ctx} ctx
 * @param {any} p simulated player
 * @param {string[]} hurtLog
 */
async function suite(ctx, p, hurtLog) {
  const st = async () => (await ctx.dump(p)).data?.[S] ?? {};
  const place = async (dx, dz, look) => {
    p.teleport(ctx.at(dx, 0, dz));
    await ctx.wait(2);
    p.lookAtLocation(look ?? ctx.at(dx, 1.62, dz + 40));
    await ctx.wait(2);
  };
  const clearArea = () => {
    for (const t of ['minecraft:husk', 'minecraft:pig', 'minecraft:item', 'minecraft:arrow', 'sp:debris']) for (const e of ctx.entities(t, 60)) remove(e);
  };

  let r = await ctx.sp('grant', `${NAME} ${S} silent`);
  ctx.assert(r.ok === true, 'grant esper', r);
  await ctx.wait(3);

  // ---------------------------------------------------------------- telekinesis: creature
  {
    ctx.fill([-3, 0, 10], [3, 4, 10], 'stone'); // wall the husk will be thrown into
    await place(0, -10);
    const husk = ctx.spawn('minecraft:husk', 0, 0, -4);
    await ctx.wait(2);
    p.lookAtLocation(ctx.at(0, 1, -4)); // aim at the husk's body
    await ctx.wait(1);
    r = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    ctx.assert(r.started === true, 'telekinesis: grab starts while looking at a husk', r);
    await ctx.wait(4);
    let s = await st();
    ctx.assert(s.holding === 'entity' && s.target === husk.id, 'telekinesis holds the creature', s);
    ctx.assert(s.dist >= 2.5 && s.dist <= 8, 'hold distance = distance to the target', s.dist);
    ctx.assert(s.pose === 'animation.sp.esper.channel', 'channel pose while holding', s.pose);
    // raise it by looking up
    p.lookAtLocation(ctx.at(0, 3.2, -4));
    await ctx.wait(4);
    const lifted = loc(husk);
    ctx.assert(lifted.y > ctx.at(0, 0, 0).y + 1, 'held creature is lifted off the ground where the player looks', fmt(lifted));

    // follows the look direction
    p.lookAtLocation(ctx.at(8, 1.62, -10));
    await ctx.wait(4);
    const turned = loc(husk);
    ctx.log(`husk ${fmt(lifted)} -> ${fmt(turned)} after looking to +x`);
    ctx.assert(turned.x - ctx.at(0, 0, 0).x > 3 && turned.z < lifted.z - 2, 'held creature follows the look direction', { lifted, turned });

    // Jump pushes it further away
    const d0 = s.dist;
    await ctx.sp('input', `${NAME} button jump 1`);
    await ctx.sp('input', `${NAME} button jump 0`);
    s = await st();
    ctx.assert(Math.abs(s.dist - Math.min(14, d0 + 1.5)) < 0.01, 'Jump while holding pushes the target 1.5 blocks away', { d0, d1: s.dist });
    await ctx.sp('input', `${NAME} button sneak 1`);
    await ctx.sp('input', `${NAME} button sneak 0`);
    await ctx.sp('input', `${NAME} clear`);
    s = await st();
    ctx.assert(Math.abs(s.dist - d0) < 0.01, 'Sneak while holding pulls it back', { d0, d2: s.dist });

    // launch into the wall
    p.lookAtLocation(ctx.at(0, 2.4, 10));
    await ctx.wait(3);
    const h0 = hp(husk);
    await ctx.sp('hold', `${NAME} ${S} telekinesis end`);
    await ctx.wait(1);
    const v = vel(husk);
    let maxSpeed = speed(v);
    const series = [];
    for (let t = 0; t < 14; t++) {
      await ctx.wait(1);
      const vv = vel(husk);
      maxSpeed = Math.max(maxSpeed, speed(vv));
      if (valid(husk)) series.push(`${(husk.location.z - ctx.origin.z).toFixed(1)}/${husk.location.y.toFixed(1)}:${speed(vv).toFixed(2)}`);
    }
    ctx.log(`launch series ${series.join(' ')}`);
    s = await st();
    ctx.log(`launch: v=${speed(v).toFixed(2)} peak=${maxSpeed.toFixed(2)}, husk ${h0} -> ${hp(husk)} hp at ${valid(husk) ? fmt(loc(husk)) : 'dead'}`);
    ctx.assert(s.holding === null && s.lastRelease?.mode === 'launch', 'release launches the creature', s.lastRelease);
    ctx.assert(maxSpeed > 2, 'launched creature flies fast (> 2 blocks/tick)', { v, maxSpeed });
    ctx.assert(!valid(husk) || hp(husk) <= h0 - 5, 'launched creature takes impact damage against the wall', { h0, h1: hp(husk), hurt: mobLog });
    remove(husk);
  }

  // ---------------------------------------------------------------- telekinesis: sneak release sets down
  {
    await ctx.sp('cd', NAME);
    await place(-12, -10);
    const pig = ctx.spawn('minecraft:pig', -12, 0, -5);
    await ctx.wait(2);
    p.lookAtEntity(pig);
    await ctx.wait(1);
    const h0 = hp(pig);
    r = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    await ctx.wait(4);
    let s = await st();
    ctx.assert(r.started === true && s.holding === 'entity', 'grab a pig', { r, s });
    const anchor = s.anchor;
    await ctx.sp('hold', `${NAME} ${S} telekinesis end sneak`);
    await ctx.wait(2);
    const v = vel(pig);
    await ctx.wait(20);
    s = await st();
    const at = loc(pig);
    ctx.assert(s.lastRelease?.mode === 'drop', 'sneak release sets the creature down', s.lastRelease);
    ctx.assert(speed(v) < 1, 'set down gently (no launch)', v);
    ctx.assert(anchor && Math.hypot(at.x - anchor.x, at.z - anchor.z) < 2, 'set down below where it was held', { anchor, at });
    ctx.assert(hp(pig) >= h0 - 1, 'gentle set down does not hurt', { h0, h1: hp(pig) });
    remove(pig);
  }

  // ---------------------------------------------------------------- telekinesis: dropped items
  {
    await ctx.sp('cd', NAME);
    await place(12, -10);
    const types = ['minecraft:cobblestone', 'minecraft:stick', 'minecraft:apple', 'minecraft:dirt', 'minecraft:oak_planks'];
    const items = [];
    for (let i = 0; i < types.length; i++) {
      const it = ctx.dim.spawnItem(new ItemStack(types[i], 2), ctx.at(12 + (i % 3) * 0.5 - 0.5, 0.3, -4 + (i % 2) * 0.6));
      items.push(it);
    }
    await ctx.wait(20);
    p.lookAtLocation(items[0].location);
    await ctx.wait(1);
    r = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    await ctx.wait(5);
    let s = await st();
    ctx.assert(r.started === true && s.holding === 'items' && s.items >= 3, 'telekinesis grabs the cluster of dropped items', { r, holding: s.holding, items: s.items });
    const near = items.filter((it) => valid(it) && s.anchor && dist(loc(it), s.anchor) < 1.6).length;
    ctx.assert(near >= 3, 'held items orbit the anchor point', { near, anchor: s.anchor });
    const a0 = s.anchor;
    p.lookAtLocation(ctx.at(12, 4, 30));
    await ctx.wait(2);
    await ctx.sp('hold', `${NAME} ${S} telekinesis end`);
    await ctx.wait(6);
    s = await st();
    const flown = items.filter((it) => valid(it) && a0 && dist(loc(it), a0) > 6).length;
    ctx.log(`items flown ${flown}/${items.length}`);
    ctx.assert(s.lastRelease?.mode === 'launch' && s.lastRelease.kind === 'items', 'release launches the items', s.lastRelease);
    ctx.assert(flown >= 3, 'launched items fly away', { flown });
    remove(...items);
  }

  // ---------------------------------------------------------------- telekinesis: block
  {
    await ctx.sp('cd', NAME);
    await place(24, -10);
    ctx.fill([24, 0, -4], [24, 0, -4], 'oak_planks');
    await ctx.wait(2);
    p.lookAtLocation(ctx.at(24, 0.5, -4));
    await ctx.wait(1);
    r = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    await ctx.wait(3);
    let s = await st();
    const debris = ctx.entities('sp:debris', 80);
    ctx.assert(r.started === true && s.holding === 'block', 'telekinesis lifts the block', { r, holding: s.holding });
    ctx.assert(ctx.block(24, 0, -4)?.typeId === 'minecraft:air', 'lifted block is removed from the world', ctx.block(24, 0, -4)?.typeId);
    ctx.assert(debris.length >= 1, 'lifted block becomes an sp:debris chunk', debris.length);
    // raise it into the air, then set it down there
    p.lookAtLocation(ctx.at(24, 3.6, -4));
    await ctx.wait(4);
    s = await st();
    const a = s.anchor;
    const chunk = debris[0];
    ctx.assert(chunk && a && dist(V3(loc(chunk), 0.5), a) < 1.2, 'block chunk follows the anchor', { chunk: chunk && loc(chunk), a });
    await ctx.sp('hold', `${NAME} ${S} telekinesis end sneak`);
    await ctx.wait(2);
    let placed = null;
    if (a) {
      for (let dy = 0; dy <= 2 && !placed; dy++) {
        const b = ctx.dim.getBlock({ x: Math.floor(a.x), y: Math.floor(a.y) + dy, z: Math.floor(a.z) });
        if (b?.typeId === 'minecraft:oak_planks') placed = { x: b.x, y: b.y, z: b.z };
      }
    }
    ctx.log(`block anchor ${fmt(a)} placed at ${fmt(placed)}`);
    ctx.assert(!!placed, 'sneak release places the block back into the world at the anchor', { a, placed });
    ctx.assert(placed && placed.y > ctx.at(0, 0, 0).y + 1, 'the block was placed where it was held (in the air)', placed);
    ctx.assert(ctx.entities('sp:debris', 80).length === 0, 'debris chunk removed after placing', ctx.entities('sp:debris', 80).length);
    if (placed) ctx.run(`setblock ${placed.x} ${placed.y} ${placed.z} air`);
  }

  // ---------------------------------------------------------------- telekinesis: nothing to grab
  {
    await ctx.sp('cd', NAME);
    await place(0, -10, ctx.at(0, 60, -10.2));
    r = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    const d = await ctx.dump(p);
    ctx.assert(r.started === false && d.hold === null, 'telekinesis is refused when aiming at the sky', { r, hold: d.hold });
  }

  // ---------------------------------------------------------------- levitation field + slam
  {
    clearArea();
    await ctx.sp('cd', NAME);
    await place(0, -10);
    const pigs = [ctx.spawn('minecraft:pig', 3, 0, -10), ctx.spawn('minecraft:pig', -3, 0, -8)];
    await ctx.wait(3);
    const y0 = pigs.map((e) => loc(e).y);
    const h0 = pigs.map(hp);
    r = await ctx.sp('ability', `${NAME} ${S} levitation force`);
    ctx.assert(r.fired === true, 'levitation field starts', r);
    let d = await ctx.dump(p);
    ctx.assert(d.data[S].levitating === 2, 'both pigs are levitating', d.data[S].levitating);
    ctx.assert((d.cd[`${S}.levitation`] ?? 0) > 0 && d.cd[`${S}.levitation`] <= 20, 'short re-arm cooldown so the slam can follow', d.cd);
    await ctx.wait(30);
    const rise = pigs.map((e, i) => (valid(e) ? loc(e).y - y0[i] : 0));
    ctx.log(`pigs rose ${rise.map((x) => x.toFixed(2)).join(', ')}`);
    ctx.assert(rise.every((x) => x > 2.5), 'levitated pigs float several blocks up', rise);
    r = await ctx.sp('ability', `${NAME} ${S} levitation force`);
    ctx.assert(r.fired === true, 'using levitation again slams them down', r);
    d = await ctx.dump(p);
    ctx.assert(d.data[S].levitating === 0 && d.data[S].lastSlam?.count === 2, 'slam ends the field', d.data[S]);
    ctx.assert((d.cd[`${S}.levitation`] ?? 0) > 200, 'slam starts the full cooldown', d.cd);
    await ctx.wait(12);
    const h1 = pigs.map(hp);
    d = await ctx.dump(p);
    ctx.log(`slam: pigs ${h0.join('/')} -> ${h1.join('/')} hp`);
    ctx.assert(pigs.every((e, i) => !valid(e) || h1[i] < h0[i]), 'slammed pigs take damage', { h0, h1 });
    ctx.assert(d.data[S].lastSlam?.landed === 2, 'both slam impacts registered', d.data[S].lastSlam);
    remove(...pigs);
  }

  // ---------------------------------------------------------------- psionic barrier
  {
    clearArea();
    await ctx.sp('cd', NAME);
    await place(0, -10);
    const hp0 = hp(p);
    hurtLog.length = 0;
    r = await ctx.sp('ability', `${NAME} ${S} barrier force`);
    ctx.assert(r.fired === true, 'barrier raised', r);
    let d = await ctx.dump(p);
    ctx.assert(d.data[S].barrier === true, 'barrier active', d.data[S]);
    ctx.assert(d.tags.includes('sp_dodge') && d.tags.includes('sp_blastproof'), 'barrier grants sp_dodge + sp_blastproof', d.tags);
    ctx.assert(!d.cd[`${S}.barrier`], 'no cooldown while the barrier is up', d.cd);

    // a pig right next to the player gets repelled
    const pig = ctx.spawn('minecraft:pig', 1.2, 0, -10);
    // an arrow fired at the player from 14 blocks
    const arrow = ctx.dim.spawnEntity('minecraft:arrow', ctx.at(0, 1.4, 4));
    const shot = { x: 0, y: 0.05, z: -2.4 };
    try {
      arrow.getComponent('minecraft:projectile').shoot(shot);
    } catch {
      arrow.applyImpulse(shot);
    }
    let reversed = false;
    let minZ = 99;
    for (let t = 0; t < 12; t++) {
      await ctx.wait(1);
      if (!valid(arrow)) break;
      const v = vel(arrow);
      minZ = Math.min(minZ, arrow.location.z - ctx.origin.z);
      if (v.z > 0.5) reversed = true;
    }
    d = await ctx.dump(p);
    ctx.log(`arrow closest z=${minZ.toFixed(1)} (player at -10), reflect ${JSON.stringify(d.data[S].lastReflect)}`);
    ctx.assert(reversed, 'barrier reflects the arrow (velocity reverses)', { last: d.data[S].lastReflect });
    ctx.assert(d.data[S].reflected >= 1, 'reflection counted', d.data[S].reflected);
    ctx.assert(minZ > -10 + 1, 'arrow never reached the player', minZ);
    ctx.assert(hp(p) >= hp0, 'player unharmed by the arrow', { hp0, hp: hp(p), hurt: hurtLog });
    const pd = valid(pig) ? Math.hypot(pig.location.x - p.location.x, pig.location.z - p.location.z) : 99;
    ctx.assert(pd > 2.2, 'barrier repels a creature standing inside it', pd);
    remove(pig, arrow);

    // toggle off: cooldown starts, tags removed
    r = await ctx.sp('ability', `${NAME} ${S} barrier`);
    await ctx.wait(1);
    d = await ctx.dump(p);
    ctx.assert(r.fired === true && d.data[S].barrier === false, 'barrier toggles off', { r, b: d.data[S].barrier });
    ctx.assert((d.cd[`${S}.barrier`] ?? 0) > 250, 'barrier cooldown starts when it drops', d.cd);
    ctx.assert(!d.tags.includes('sp_dodge') && !d.tags.includes('sp_blastproof'), 'barrier tags removed', d.tags);
  }

  // ---------------------------------------------------------------- meteor call
  {
    clearArea();
    await ctx.sp('cd', NAME);
    await place(0, -14);
    const target = ctx.at(0, -1, 4);
    p.lookAtLocation({ x: target.x, y: target.y + 0.9, z: target.z });
    await ctx.wait(2);
    const husk = ctx.spawn('minecraft:husk', 2, 0, 4.5);
    await ctx.wait(1);
    const mob0 = hp(husk);
    const hp0 = hp(p);
    hurtLog.length = 0;
    r = await ctx.sp('ability', `${NAME} ${S} meteor force`);
    ctx.assert(r.fired === true, 'meteor called', r);
    let d = await ctx.dump(p);
    ctx.assert(d.data[S].meteors === 1 && d.data[S].lastMeteor, 'meteor warning phase active', d.data[S]);
    ctx.assert((d.cd[`${S}.meteor`] ?? 0) > 800, 'meteor cooldown started', d.cd);
    let seen = 0;
    let impactTick = -1;
    for (let t = 0; t < 140; t++) {
      await ctx.wait(1);
      if (ctx.entities('sp:meteor', 160).length) seen++;
      if (t > 50 && t % 2 === 0) {
        d = await ctx.dump(p);
        if (d.data[S].meteors === 0) {
          impactTick = t;
          break;
        }
      }
    }
    await ctx.wait(4);
    d = await ctx.dump(p);
    const imp = d.data[S].lastImpact;
    ctx.log(`meteor visible ${seen} ticks, impact after ${impactTick} ticks at ${fmt(imp?.point)} (call ${JSON.stringify(d.data[S].lastMeteor)}), husk ${mob0} -> ${hp(husk)}, player ${hp0} -> ${hp(p)} [${hurtLog.join(',')}]`);
    ctx.assert(seen >= 5, 'an sp:meteor entity falls from the sky', seen);
    ctx.assert(impactTick > 0 && imp, 'meteor impacts', { impactTick, imp });
    ctx.assert(imp && dist(imp.point, target) < 4, 'impact at the targeted spot', { imp, target });
    let air = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = 2; dz <= 6; dz++) if (ctx.block(dx, -1, dz)?.typeId === 'minecraft:air') air++;
    ctx.assert(air >= 8, 'impact blasts a crater (ground blocks destroyed)', air);
    ctx.assert(!valid(husk) || hp(husk) < mob0 - 10, 'mob near the impact is badly hurt', { mob0, mob1: hp(husk) });
    ctx.assert(hp(p) >= hp0, 'caster unharmed by the impact', { hp0, hp: hp(p), hurt: hurtLog });
    ctx.assert(ctx.entities('sp:meteor', 160).length === 0, 'meteor entity removed after impact');
    let ore = 0;
    let floating = 0;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dz = 1; dz <= 7; dz++) {
          if (ctx.block(dx, dy, dz)?.typeId !== 'sp:meteorite') continue;
          ore++;
          if (ctx.block(dx, dy - 1, dz)?.isAir) floating++;
        }
      }
    }
    ctx.assert(ore >= 1 && ore <= 3, 'meteorite blocks (1-3) left in the crater', ore);
    ctx.assert(floating === 0, 'meteorite blocks rest on the crater floor', floating);
    remove(husk);
    ctx.run(`fill ${Math.floor(ctx.origin.x) - 12} -62 ${Math.floor(ctx.origin.z) - 8} ${Math.floor(ctx.origin.x) + 12} -50 ${Math.floor(ctx.origin.z) + 16} air replace fire`);
  }

  // ---------------------------------------------------------------- telekinesis: thrown block
  {
    clearArea();
    await ctx.sp('cd', NAME);
    await place(36, -10);
    ctx.fill([36, 0, -6], [36, 0, -6], 'oak_planks');
    await ctx.wait(2);
    p.lookAtLocation(ctx.at(36, 0.5, -6));
    await ctx.wait(1);
    r = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    await ctx.wait(4);
    p.lookAtLocation(ctx.at(36, -1, 2));
    await ctx.wait(3);
    await ctx.sp('hold', `${NAME} ${S} telekinesis end`);
    await ctx.wait(1);
    const s = await st();
    ctx.assert(r.started === true && s.lastRelease?.mode === 'launch' && s.lastRelease.kind === 'block', 'release hurls the lifted block', s.lastRelease);
    let gone = false;
    for (let t = 0; t < 40 && !gone; t++) {
      await ctx.wait(1);
      gone = ctx.entities('sp:debris', 80).length === 0;
    }
    let planks = 0;
    for (let dx = 33; dx <= 39; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -8; dz <= 6; dz++) if (ctx.block(dx, dy, dz)?.typeId === 'minecraft:oak_planks') planks++;
    const drops = ctx.dim.getEntities({ type: 'minecraft:item', location: ctx.at(36, 0, -2), maxDistance: 10 }).length;
    ctx.log(`thrown block: debris gone=${gone}, planks placed=${planks}, drops=${drops}`);
    ctx.assert(gone, 'thrown block chunk shatters on landing', gone);
    ctx.assert(planks + drops >= 1, 'thrown block is placed where it lands (or dropped as an item)', { planks, drops });
    ctx.run(`fill ${Math.floor(ctx.origin.x) + 33} -63 ${Math.floor(ctx.origin.z) - 8} ${Math.floor(ctx.origin.x) + 39} -57 ${Math.floor(ctx.origin.z) + 6} air replace oak_planks`);
  }

  // ---------------------------------------------------------------- field + barrier expire on their own
  {
    clearArea();
    await ctx.sp('cd', NAME);
    await place(48, -10);
    const pig = ctx.spawn('minecraft:pig', 50, 0, -10);
    await ctx.wait(2);
    r = await ctx.sp('ability', `${NAME} ${S} levitation force`);
    const b = await ctx.sp('ability', `${NAME} ${S} barrier force`);
    ctx.assert(r.fired === true && b.fired === true, 'field and barrier raised together', { r, b });
    await ctx.wait(145);
    let d = await ctx.dump(p);
    ctx.assert(d.data[S].levitating === 0 && d.data[S].lastField?.why === 'expired', 'levitation field expires after levitateTicks', d.data[S].lastField);
    ctx.assert((d.cd[`${S}.levitation`] ?? 0) > 200, 'expired field starts the full cooldown', d.cd);
    ctx.assert(d.data[S].barrier === true, 'barrier still up before barrierTicks', d.data[S].barrier);
    await ctx.wait(60);
    d = await ctx.dump(p);
    ctx.assert(d.data[S].barrier === false && (d.cd[`${S}.barrier`] ?? 0) > 200, 'barrier expires after barrierTicks and starts its cooldown', { b: d.data[S].barrier, cd: d.cd });
    ctx.assert(!d.tags.includes('sp_dodge'), 'barrier tags gone after expiry', d.tags);
    remove(pig);
  }

  // ---------------------------------------------------------------- revoke cleans up (meteor in flight continues)
  {
    clearArea();
    await ctx.sp('cd', NAME);
    await place(-24, -10);
    const pig = ctx.spawn('minecraft:pig', -21, 0, -10);
    ctx.fill([-24, 0, -6], [-24, 0, -6], 'oak_planks');
    await ctx.wait(2);
    const mTarget = ctx.at(-24, -1, 8);
    p.lookAtLocation({ x: mTarget.x, y: mTarget.y + 0.9, z: mTarget.z });
    await ctx.wait(1);
    const m = await ctx.sp('ability', `${NAME} ${S} meteor force`);
    ctx.assert(m.fired === true, 'meteor called before revoking', m);
    r = await ctx.sp('ability', `${NAME} ${S} levitation force`);
    await ctx.sp('ability', `${NAME} ${S} barrier force`);
    p.lookAtLocation(ctx.at(-24, 0.5, -6));
    await ctx.wait(1);
    const g = await ctx.sp('hold', `${NAME} ${S} telekinesis start`);
    await ctx.wait(10);
    let s = await st();
    ctx.assert(g.started === true && s.holding === 'block' && s.levitating === 1 && s.barrier === true, 'holding a block, field and barrier active before revoke', s);
    const pigY = valid(pig) ? loc(pig).y : 0;
    r = await ctx.sp('revoke', `${NAME} ${S}`);
    ctx.assert(r.ok === true, 'revoke esper', r);
    await ctx.wait(30);
    const d = await ctx.dump(p);
    ctx.assert(!d.powers.includes(S) && !d.hold, 'power and hold removed', { powers: d.powers, hold: d.hold });
    ctx.assert(!d.tags.includes('sp_dodge') && !d.tags.includes('sp_blastproof'), 'barrier tags removed on revoke', d.tags);
    ctx.assert(ctx.entities('sp:debris', 80).length === 0, 'held block chunk released on revoke', ctx.entities('sp:debris', 80).length);
    let planks = 0;
    for (let dx = -27; dx <= -21; dx++) for (let dy = 0; dy <= 4; dy++) for (let dz = -9; dz <= -3; dz++) if (ctx.block(dx, dy, dz)?.typeId === 'minecraft:oak_planks') planks++;
    ctx.assert(planks === 1, 'the held block was put back into the world', planks);
    const pigNow = valid(pig) ? loc(pig).y : 0;
    ctx.assert(pigY > ctx.at(0, 0, 0).y + 0.3 && pigNow < ctx.at(0, 0, 0).y + 0.3, 'levitated pig drops back down after revoke', { pigY, pigNow });
    remove(pig);
    ctx.run(`fill ${Math.floor(ctx.origin.x) - 27} -60 ${Math.floor(ctx.origin.z) - 9} ${Math.floor(ctx.origin.x) - 21} -56 ${Math.floor(ctx.origin.z) - 3} air replace oak_planks`);
    // the meteor is world state: it still falls and explodes after the power is gone
    let seen = false;
    let gone = false;
    for (let t = 0; t < 120 && !gone; t++) {
      await ctx.wait(1);
      const n = ctx.entities('sp:meteor', 160).length;
      if (n) seen = true;
      else if (seen) gone = true;
    }
    await ctx.wait(3);
    let air = 0;
    for (let dx = -26; dx <= -22; dx++) for (let dz = 6; dz <= 10; dz++) if (ctx.block(dx, -1, dz)?.typeId === 'minecraft:air') air++;
    ctx.assert(seen && gone && air >= 8, 'meteor in flight still lands after revoke', { seen, gone, air });
    ctx.run(`fill ${Math.floor(ctx.origin.x) - 36} -62 ${Math.floor(ctx.origin.z) - 4} ${Math.floor(ctx.origin.x) - 12} -50 ${Math.floor(ctx.origin.z) + 20} air replace fire`);
  }
}

function V3(a, dy) {
  return { x: a.x, y: a.y + dy, z: a.z };
}
