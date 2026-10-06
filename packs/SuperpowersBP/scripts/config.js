// Central configuration and content contract for Superpowers & Mutants.
// Every tunable number, identifier and user-facing ability description lives here so
// balance changes never require touching gameplay code.

export const NS = 'sp';
export const MAX_POWERS = 3;
export const TPS = 20;

/** Power ids in canonical display order. */
export const POWER_IDS = ['strength', 'flight', 'heat_vision', 'speedster', 'esper'];

/** Custom font glyphs (RP: font/glyph_E7.png, 16x16 cells). */
export const GLYPH = {
  strength: '',
  flight: '',
  heat_vision: '',
  speedster: '',
  esper: '',
  cooldown: '',
  ready: '',
  active: '',
  barFull: '',
  barEmpty: '',
  barHalf: '',
  arrow: '',
  heat: '',
  syringe: '',
  mutant: '',
  lock: '',
};

/**
 * Ability modes:
 *  - instant: fires once on Use.
 *  - hold:    starts on Use press, ends on release (charge / channel).
 *  - toggle:  Use switches it on/off (the power module manages its own duration).
 * cooldown is in ticks and is started automatically after a successful instant activation
 * (toggle/hold abilities start their own cooldown through the power module).
 */
export const POWERS = {
  strength: {
    name: 'Super Strength',
    short: 'Strength',
    color: '§6',
    rgb: { red: 1.0, green: 0.62, blue: 0.16 },
    emblem: 'sp:emblem_strength',
    syringe: 'sp:syringe_strength',
    tagline: 'Titanic muscle and an unbreakable body.',
    passive: 'Takes 65% less damage, punches launch enemies, never hurt by falls after a super leap.',
    abilities: [
      { id: 'charged_jump', name: 'Charged Jump', mode: 'hold', cooldown: 20,
        desc: 'Hold Use to charge, release to leap up to 40 blocks. Landing shatters the ground. Shortcut: crouch for a second, then jump.' },
      { id: 'ground_destruction', name: 'Ground Destruction', mode: 'instant', cooldown: 30,
        desc: 'Tear a boulder out of the ground. Use again to hurl it as a crushing projectile.' },
      { id: 'supersonic_charge', name: 'Supersonic Charge', mode: 'instant', cooldown: 120,
        desc: 'Burst forward faster than sound, plowing through mobs and fragile blocks.' },
      { id: 'thunderclap', name: 'Thunderclap', mode: 'instant', cooldown: 160,
        desc: 'Clap with titanic force to unleash a cone of concussive thunder.' },
    ],
  },
  flight: {
    name: 'Flight',
    short: 'Flight',
    color: '§b',
    rgb: { red: 0.45, green: 0.82, blue: 1.0 },
    emblem: 'sp:emblem_flight',
    syringe: 'sp:syringe_flight',
    tagline: 'Gravity is merely a suggestion.',
    passive: 'Immune to fall and kinetic damage. Smash through fragile blocks at high speed.',
    abilities: [
      { id: 'take_off', name: 'Take Off / Land', mode: 'toggle', cooldown: 10,
        desc: 'Toggle flight. Look to steer, Jump/Sneak to rise/descend; keep moving forward to accelerate. Shortcut: double-tap Jump in mid-air.' },
      { id: 'afterburner', name: 'Afterburner', mode: 'instant', cooldown: 100,
        desc: 'Instantly break the sound barrier in the direction you are looking.' },
      { id: 'grab_throw', name: 'Grab & Throw', mode: 'instant', cooldown: 10,
        desc: 'Seize the creature in front of you and carry it. Use again to hurl it like a missile.' },
    ],
  },
  heat_vision: {
    name: 'Heat Vision',
    short: 'Heat Vision',
    color: '§c',
    rgb: { red: 1.0, green: 0.28, blue: 0.08 },
    emblem: 'sp:emblem_heat_vision',
    syringe: 'sp:syringe_heat_vision',
    tagline: 'Twin beams of concentrated solar fury.',
    passive: 'Eyes store heat: firing builds the heat gauge, overheating forces a cooldown.',
    abilities: [
      { id: 'heat_beam', name: 'Heat Beam', mode: 'hold', cooldown: 10,
        desc: 'Hold Use to fire. Aim freely. While firing tap Jump to raise intensity, Sneak to lower it.' },
      { id: 'focus', name: 'Focus Intensity', mode: 'instant', cooldown: 4,
        desc: 'Cycle the default beam intensity from 1 (precise) to 5 (devastating).' },
      { id: 'scorch_blast', name: 'Scorching Blast', mode: 'instant', cooldown: 120,
        desc: 'Release a single overcharged blast that detonates where it lands.' },
    ],
  },
  speedster: {
    name: 'Speedster',
    short: 'Speedster',
    color: '§e',
    rgb: { red: 1.0, green: 0.86, blue: 0.2 },
    emblem: 'sp:emblem_speedster',
    syringe: 'sp:syringe_speedster',
    tagline: 'The world is standing still. You are not.',
    passive: 'Immune to kinetic damage. At speed: run on water, dodge projectiles, bowl over mobs and fragile blocks.',
    abilities: [
      { id: 'speed_force', name: 'Speed Force', mode: 'toggle', cooldown: 10,
        desc: 'Toggle super speed. Keep sprinting to climb through the speed gears up to supersonic.' },
      { id: 'time_dilation', name: 'Time Dilation', mode: 'toggle', cooldown: 400,
        desc: 'Slow the world around you to a crawl for 10 seconds while you keep full speed.' },
      { id: 'blitz', name: 'Blitz Dash', mode: 'instant', cooldown: 80,
        desc: 'Flash-step up to 24 blocks forward, striking everything along the way.' },
    ],
  },
  esper: {
    name: 'Esper',
    short: 'Esper',
    color: '§d',
    rgb: { red: 0.78, green: 0.36, blue: 1.0 },
    emblem: 'sp:emblem_esper',
    syringe: 'sp:syringe_esper',
    tagline: 'Mind over matter, literally.',
    passive: 'Sense the weight of the world: blocks, mobs and items bend to your will.',
    abilities: [
      { id: 'telekinesis', name: 'Telekinesis', mode: 'hold', cooldown: 10,
        desc: 'Hold Use to seize a block, mob or items. Aim to move it, Jump/Sneak to push/pull. Release to launch it; sneak while releasing to set it down gently.' },
      { id: 'levitation', name: 'Levitation Field', mode: 'instant', cooldown: 240,
        desc: 'Lift every creature around you into the air. Use again while they float to slam them down.' },
      { id: 'barrier', name: 'Psionic Barrier', mode: 'toggle', cooldown: 300,
        desc: 'Raise a barrier for 10 seconds that reflects projectiles and repels attackers.' },
      { id: 'meteor', name: 'Meteor Call', mode: 'instant', cooldown: 900,
        desc: 'Drag a meteor out of the sky onto the spot you are looking at.' },
    ],
  },
};

/** Tuning values. Distances in blocks, speeds in blocks/tick, times in ticks. */
export const TUNING = {
  strength: {
    damageMultiplier: 0.35, // must match player.json damage_sensor for tag sp_tough
    punchBonusDamage: 9,
    punchKnockback: 2.2,
    punchLift: 0.55,
    jumpChargeTicks: 40,
    jumpMinVertical: 1.2,
    jumpMaxVertical: 3.6,
    jumpForward: 1.6,
    sneakChargeDelay: 12,
    landingRadius: 5,
    landingDamage: 10,
    boulderMaxHoldTicks: 600,
    boulderSpeed: 2.6,
    boulderDamage: 18,
    boulderRadius: 3.2,
    chargeTicks: 22,
    chargeSpeed: 1.7,
    chargeDamage: 14,
    clapRange: 14,
    clapAngle: 70,
    clapDamage: 9,
    clapKnockback: 3.4,
  },
  flight: {
    cruiseSpeed: 0.75,
    maxSpeed: 3.6,
    accelPerTick: 0.035,
    rampDelayTicks: 15,
    verticalSpeed: 0.6,
    boomSpeed: 2.2,
    smashFragileSpeed: 1.1,
    smashSoftSpeed: 2.4,
    grabRange: 6,
    throwSpeed: 2.8,
    impactDamagePerSpeed: 7,
  },
  heat_vision: {
    range: [0, 24, 32, 40, 52, 64],
    damagePerSecond: [0, 3, 6, 10, 16, 24],
    heatPerTick: [0, 0.18, 0.3, 0.45, 0.65, 0.9],
    coolPerTick: 0.6,
    overheatCooldown: 100,
    burstDamage: 20,
    burstRadius: 3.5,
  },
  speedster: {
    // movement attribute values per gear (0.1 is vanilla walking)
    gearMovement: [0.1, 0.3, 0.55, 0.85, 1.25],
    gearUpTicks: [0, 0, 40, 90, 150],
    waterRunGear: 2,
    dodgeGear: 2,
    plowGear: 3,
    plowDamage: 8,
    dilationTicks: 200,
    dilationRadius: 48,
    dilationFactor: 0.12,
    blitzRange: 24,
    blitzDamage: 12,
  },
  esper: {
    grabRange: 32,
    holdMinDist: 2.5,
    holdMaxDist: 14,
    launchSpeed: 3.4,
    launchDamagePerSpeed: 6,
    levitateRadius: 12,
    levitateTicks: 140,
    levitateHeight: 4.5,
    slamDamage: 12,
    barrierTicks: 200,
    barrierRadius: 5.5,
    meteorRange: 96,
    meteorDelay: 50,
    meteorPower: 7,
    meteorDamage: 30,
  },
};

/** Item identifiers. */
export const ITEMS = {
  codex: 'sp:mutant_codex',
  suppressor: 'sp:suppressor_serum',
  unstable: 'sp:syringe_unstable',
  emptySyringe: 'sp:syringe_empty',
  crystal: 'sp:mutagen_crystal',
};

export const ENTITIES = {
  debris: 'sp:debris',
  meteor: 'sp:meteor',
  mutant: 'sp:rogue_mutant',
};

export const BLOCKS = {
  meteorite: 'sp:meteorite',
  tank: 'sp:mutagen_tank',
};

/** Tags read by player.json damage_sensor. Keep in sync with entities/player.json. */
export const IMMUNITY_TAGS = {
  nofall: 'sp_nofall',
  nokinetic: 'sp_nokinetic',
  dodge: 'sp_dodge',
  tough: 'sp_tough',
  blastproof: 'sp_blastproof',
  firewalk: 'sp_fireproof',
};

export const DEFAULT_WORLD_SETTINGS = {
  griefing: true, // powers may destroy / alter blocks
  pvp: true, // powers may hurt other players (also requires the pvp game rule)
  codexMode: 'xp', // 'free' | 'xp' | 'off' : acquiring powers from the codex
  codexXpCost: 15,
  mutantPowers: true, // rogue mutants use powers
};

export const DEFAULT_PLAYER_SETTINGS = {
  hud: true,
  hints: true,
  screenFx: true, // camera shake, FOV warp, fog tints
};

/** Debris entity texture slots (RP entity/debris.entity.json textures, same order). */
export const DEBRIS_TEXTURES = [
  'stone', 'dirt', 'grass', 'cobblestone', 'sand', 'gravel', 'deepslate', 'oak_log',
  'oak_planks', 'leaves', 'netherrack', 'end_stone', 'snow', 'ice', 'obsidian', 'sandstone',
  'stone_bricks', 'clay', 'mud', 'blackstone', 'basalt', 'tuff', 'red_sand', 'terracotta',
  'glass', 'iron_block', 'magma', 'meteorite',
];
