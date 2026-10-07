// Rogue Mutant AI: each variant is spawned next to a survival player and must land its
// signature power (Brute leap slam, Scorcher eye beam, Blur flash-step, Psion telekinetic toss).
// Also checks that the world rule "mutant powers" switches the attacks off.
import { world, GameMode } from '@minecraft/server';

const MUTANT = 'sp:rogue_mutant';

/** Record everything that happens to `player` and `mutant` until `done()` is true or timeout. */
async function observe(ctx, player, mutant, ticks, done) {
  const log = { hurt: [], mutantMaxRise: 0, mutantMaxStep: 0, playerMaxRise: 0, ticks: 0 };
  const groundY = mutant.location.y;
  const playerY = player.location.y;
  let last = mutant.location;
  const sub = world.afterEvents.entityHurt.subscribe((ev) => {
    if (ev.hurtEntity.id !== player.id) return;
    log.hurt.push({
      cause: ev.damageSource.cause,
      byMutant: ev.damageSource.damagingEntity?.typeId === MUTANT,
      damage: Math.round(ev.damage * 10) / 10,
      tick: log.ticks,
    });
  });
  try {
    for (let t = 0; t < ticks; t++) {
      await ctx.wait(1);
      log.ticks = t;
      // (SimulatedPlayer.isValid reads false on BDS even while the player is alive)
      if (!mutant.isValid) {
        log.ended = { tick: t };
        break;
      }
      // keep the test player alive and in place: only the mutant's power should move it
      try {
        player.getComponent('minecraft:health').resetToMaxValue();
      } catch {
        /* ignore */
      }
      const m = mutant.location;
      log.mutantMaxRise = Math.max(log.mutantMaxRise, m.y - groundY);
      log.mutantMaxStep = Math.max(log.mutantMaxStep, Math.hypot(m.x - last.x, m.z - last.z));
      last = m;
      log.playerMaxRise = Math.max(log.playerMaxRise, player.location.y - playerY);
      if (done(log)) break;
    }
  } finally {
    world.afterEvents.entityHurt.unsubscribe(sub);
  }
  return log;
}

function variantOf(e) {
  try {
    return e.getComponent('minecraft:variant')?.value;
  } catch {
    return undefined;
  }
}

/** Clear a lane at `dz`, move the test player to its west end and face east. */
async function arena(ctx, p, dz) {
  ctx.fill([-6, -1, dz - 6], [16, -1, dz + 6], 'stone');
  ctx.fill([-6, 0, dz - 6], [16, 8, dz + 6], 'air');
  p.teleport(ctx.at(0, 0, dz), { facingLocation: ctx.at(8, 1.6, dz) });
  p.extinguishFire();
  await ctx.wait(10);
}

/**
 * Spawn a mutant of the given variant. It is pinned with Slowness so the vanilla walk/melee
 * goals cannot close the gap: everything that reaches the player must come from its power.
 */
async function spawnMutant(ctx, variant, dx, dz) {
  const m = ctx.dim.spawnEntity(MUTANT, ctx.at(dx, 0, dz), { spawnEvent: `sp:become_${variant}` });
  await ctx.wait(4);
  const speed = m.getComponent('minecraft:movement')?.currentValue ?? 0;
  m.addEffect('slowness', 2000, { amplifier: 255, showParticles: false });
  return { m, speed };
}

/** @param {import('../ctx.js').Ctx} ctx */
export async function run(ctx) {
  ctx.run('difficulty normal');
  const p = await ctx.player('Mutie', 0, 0, GameMode.Survival);
  let r = await ctx.sp('world', 'mutantPowers true');
  ctx.assert(r.settings?.mutantPowers === true, 'mutant powers world rule on', r);

  // --- Brute: leaps at the target and slams the ground -------------------------------
  {
    await arena(ctx, p, -56);
    const { m } = await spawnMutant(ctx, 'strength', 9, -56);
    ctx.assert(variantOf(m) === 0, 'sp:become_strength gives variant 0 (Brute)', variantOf(m));
    const log = await observe(ctx, p, m, 400, (l) => l.mutantMaxRise > 1.5 && l.hurt.some((h) => h.byMutant));
    ctx.assert(log.mutantMaxRise > 1.5, 'Brute leaps into the air', { rise: log.mutantMaxRise, ended: log.ended });
    ctx.assert(log.hurt.some((h) => h.byMutant && h.cause === 'entityAttack'), 'Brute slam hurts the player', log.hurt);
    m.remove();
  }

  // --- Scorcher: burns the player with an eye beam from range -------------------------
  {
    await arena(ctx, p, -28);
    const { m } = await spawnMutant(ctx, 'heat_vision', 10, -28);
    ctx.assert(variantOf(m) === 1, 'sp:become_heat_vision gives variant 1 (Scorcher)', variantOf(m));
    const log = await observe(ctx, p, m, 400, (l) => l.hurt.some((h) => h.byMutant && h.cause === 'fire'));
    const beam = log.hurt.filter((h) => h.byMutant && h.cause === 'fire');
    ctx.assert(beam.length > 0, 'Scorcher beam deals fire damage from range', log.hurt);
    await ctx.wait(3);
    ctx.assert(p.getComponent('minecraft:onfire') !== undefined, 'Scorcher beam sets the player on fire');
    m.remove();
    p.extinguishFire();
  }

  // --- Blur: flash-steps across the gap in a single tick --------------------------------
  {
    await arena(ctx, p, 0);
    const { m, speed } = await spawnMutant(ctx, 'speedster', 10, 0);
    ctx.assert(variantOf(m) === 2, 'sp:become_speedster gives variant 2 (Blur)', variantOf(m));
    ctx.assert(speed > 0.3, 'Blur is permanently fast', { speed });
    const log = await observe(ctx, p, m, 400, (l) => l.mutantMaxStep > 3 && l.hurt.some((h) => h.byMutant));
    ctx.assert(log.mutantMaxStep > 3, 'Blur covers >3 blocks in one tick (flash-step)', { step: log.mutantMaxStep });
    ctx.assert(log.hurt.some((h) => h.byMutant), 'Blur strike hurts the player', log.hurt);
    m.remove();
  }

  // --- Psion: lifts the player telekinetically and hurls it ------------------------------
  {
    await arena(ctx, p, 28);
    const { m } = await spawnMutant(ctx, 'esper', 8, 28);
    ctx.assert(variantOf(m) === 3, 'sp:become_esper gives variant 3 (Psion)', variantOf(m));
    const log = await observe(ctx, p, m, 400, (l) => l.hurt.some((h) => h.byMutant && h.cause === 'magic'));
    ctx.assert(log.playerMaxRise > 2, 'Psion levitates the player', { rise: log.playerMaxRise });
    ctx.assert(log.hurt.some((h) => h.byMutant && h.cause === 'magic'), 'Psion toss deals psionic (magic) damage', log.hurt);
    m.remove();
  }

  // --- world rule: mutant powers off --------------------------------------------------
  {
    r = await ctx.sp('world', 'mutantPowers false');
    ctx.assert(r.settings?.mutantPowers === false, 'mutant powers world rule off', r);
    await arena(ctx, p, 56);
    const { m } = await spawnMutant(ctx, 'heat_vision', 12, 56);
    // with powers on, a pinned Scorcher fires within ~8 s
    const log = await observe(ctx, p, m, 240, () => false);
    ctx.assert(log.hurt.length === 0, 'no power attacks while mutant powers are off', log.hurt);
    m.remove();
    r = await ctx.sp('world', 'mutantPowers true');
    ctx.assert(r.settings?.mutantPowers === true, 'mutant powers restored', r);
  }
  // all mutants removed
  await ctx.wait(2);
  ctx.assert(ctx.entities(MUTANT, 200).length === 0, 'no stray mutants left');
}
