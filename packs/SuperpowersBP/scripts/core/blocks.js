// Block classification and safe world modification used by every destructive power.
import { BlockPermutation } from '@minecraft/server';
import { griefingAllowed } from './state.js';
import { DEBRIS_TEXTURES } from '../config.js';
import * as fx from './fx.js';
import { addScaled as addScaledV } from './math.js';

const UNBREAKABLE = new Set([
  'minecraft:bedrock', 'minecraft:barrier', 'minecraft:command_block', 'minecraft:chain_command_block',
  'minecraft:repeating_command_block', 'minecraft:structure_block', 'minecraft:structure_void', 'minecraft:jigsaw',
  'minecraft:end_portal_frame', 'minecraft:end_portal', 'minecraft:end_gateway', 'minecraft:portal',
  'minecraft:reinforced_deepslate', 'minecraft:allow', 'minecraft:deny', 'minecraft:border_block',
  'minecraft:mob_spawner', 'minecraft:trial_spawner', 'minecraft:vault', 'minecraft:respawn_anchor',
  'minecraft:light_block', 'minecraft:moving_block', 'minecraft:piston_arm_collision', 'minecraft:sticky_piston_arm_collision',
  'minecraft:invisible_bedrock', 'minecraft:unknown', 'minecraft:info_update', 'minecraft:info_update2',
  'minecraft:obsidian', 'minecraft:crying_obsidian', 'minecraft:ancient_debris', 'minecraft:netherite_block',
  'minecraft:enchanting_table', 'minecraft:anvil', 'minecraft:beacon', 'minecraft:conduit', 'minecraft:bed',
]);

const CONTAINER_HINTS = [
  'chest', 'barrel', 'shulker_box', 'furnace', 'smoker', 'hopper', 'dispenser', 'dropper', 'brewing_stand',
  'lectern', 'jukebox', 'chiseled_bookshelf', 'decorated_pot', 'crafter', 'campfire', 'sign', 'banner',
  'frame', 'flower_pot', 'skull', 'head', 'cauldron', 'beehive', 'bee_nest', 'suspicious_', 'creaking_heart',
  'shelf', 'copper_golem_statue',
];

const FRAGILE_HINTS = [
  'glass', 'leaves', 'short_grass', 'tall_grass', 'fern', 'deadbush', 'flower', 'tulip', 'poppy', 'dandelion',
  'orchid', 'allium', 'bluet', 'daisy', 'cornflower', 'lily', 'rose', 'peony', 'lilac', 'sunflower', 'web',
  'vine', 'snow_layer', 'torch', 'carpet', 'sapling', 'mushroom', 'reeds', 'bamboo', 'sweet_berry', 'cactus',
  'ice', 'pointed_dripstone', 'amethyst_cluster', 'amethyst_bud', 'sea_pickle', 'kelp', 'seagrass', 'lantern',
  'bush', 'petals', 'roots', 'sprouts', 'fungus', 'azalea', 'dripleaf', 'hanging_moss', 'glow_lichen',
  'spore_blossom', 'cocoa', 'wheat', 'carrots', 'potatoes', 'beetroot', 'pumpkin_stem', 'melon_stem',
  'nether_wart', 'chorus', 'firefly_bush', 'cactus_flower', 'leaf_litter', 'wildflowers', 'pale_moss_carpet',
  'pale_hanging_moss', 'eyeblossom', 'pane', 'iron_bars', 'ladder', 'scaffolding', 'button', 'lever',
  'pressure_plate', 'rail', 'tripwire', 'string', 'redstone_wire', 'snow',
];

const SOFT_HINTS = [
  'dirt', 'grass_block', 'grass_path', 'mycelium', 'podzol', 'farmland', 'sand', 'gravel', 'clay', 'mud',
  'soul_sand', 'soul_soil', 'snow', 'powder_snow', 'planks', 'log', 'wood', 'stem', 'hyphae', 'wool', 'hay',
  'pumpkin', 'melon', 'leaves', 'moss', 'netherrack', 'sponge', 'slime', 'honey', 'bookshelf', 'fence',
  'door', 'trapdoor', 'gate', 'stairs', 'slab', 'concrete_powder', 'coarse_dirt', 'rooted_dirt', 'mangrove_roots',
  'magma', 'sculk', 'dried_kelp', 'target', 'nylium', 'wart_block', 'shroomlight', 'bone_block', 'glowstone',
  'crafting_table', 'loom', 'fletching_table', 'cartography_table', 'smithing_table', 'note_block', 'cake',
  'pale_moss', 'resin',
];

const HARD_HINTS = ['stone', 'cobble', 'deepslate', 'brick', 'ore', 'tuff', 'basalt', 'blackstone', 'andesite',
  'diorite', 'granite', 'calcite', 'dripstone', 'terracotta', 'concrete', 'prismarine', 'quartz', 'purpur',
  'end_stone', 'sandstone', 'amethyst_block', 'copper', 'iron', 'gold', 'diamond', 'emerald', 'lapis', 'coal',
  'redstone_block', 'tiles', 'polished', 'smooth', 'chiseled', 'cut_', 'meteorite'];

function hasAny(id, hints) {
  for (const h of hints) if (id.includes(h)) return true;
  return false;
}

/** @param {string} id */
export function isUnbreakable(id) {
  if (UNBREAKABLE.has(id)) return true;
  if (id.startsWith('minecraft:light_block')) return true;
  if (id.includes('command_block') || id.includes('structure_')) return true;
  return false;
}

/** Blocks holding inventories / block-entity data: never destroyed or moved by powers. */
export function isContainer(id) {
  return hasAny(id, CONTAINER_HINTS);
}

export function isAirOrLiquid(block) {
  return !block || block.isAir || block.isLiquid;
}

/**
 * Destruction tier of a block type:
 *  0 = air/liquid (nothing to break), 1 = fragile, 2 = soft, 3 = hard, 4 = protected.
 * @param {import('@minecraft/server').Block | undefined} block
 */
export function tierOf(block) {
  if (!block) return 4;
  if (block.isAir || block.isLiquid) return 0;
  const id = block.typeId;
  if (isUnbreakable(id) || isContainer(id) || id === 'sp:water_step') return 4;
  if (id.startsWith('sp:') && id !== 'sp:meteorite') return 4;
  if (hasAny(id, FRAGILE_HINTS) && !id.includes('_block') && !id.includes('packed') && !id.includes('blue_ice')) return 1;
  if (id.endsWith('glass')) return 1;
  if (hasAny(id, SOFT_HINTS)) return 2;
  if (hasAny(id, HARD_HINTS)) return 3;
  return 3;
}

/** Whether a creature can pass through / a projectile ignores it. */
export function isPassable(block) {
  const t = tierOf(block);
  if (t === 0) return true;
  if (t !== 1 || !block) return false;
  const id = block.typeId;
  return !id.includes('glass') && !id.includes('ice') && !id.includes('pane') && !id.includes('bars') && !id.includes('cactus');
}

export function getBlockSafe(dim, loc) {
  try {
    return dim.getBlock({ x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) });
  } catch {
    return undefined;
  }
}

/** Average display color of a block (from its map color), for tinted dust/debris particles. */
export function blockColor(block) {
  try {
    const mc = block?.getComponent('minecraft:map_color');
    const c = mc?.tintedColor ?? mc?.color;
    if (c && (c.red + c.green + c.blue) > 0.02) return { red: c.red, green: c.green, blue: c.blue };
  } catch {
    /* ignore */
  }
  return { red: 0.5, green: 0.48, blue: 0.45 };
}

/**
 * Break a block if griefing is allowed and its tier is <= maxTier.
 * @param {import('@minecraft/server').Block} block
 * @param {{maxTier?:number, drop?:boolean, effects?:boolean, replaceWith?:string}} [opts]
 * @returns {boolean} true if the block was removed
 */
export function breakBlock(block, opts = {}) {
  const { maxTier = 2, drop = false, effects = true, replaceWith = 'minecraft:air' } = opts;
  if (!block || !griefingAllowed()) return false;
  const tier = tierOf(block);
  if (tier === 0 || tier > maxTier) return false;
  const dim = block.dimension;
  const center = { x: block.x + 0.5, y: block.y + 0.5, z: block.z + 0.5 };
  try {
    if (drop) {
      dim.runCommand(`setblock ${block.x} ${block.y} ${block.z} air destroy`);
      if (replaceWith !== 'minecraft:air') block.setType(replaceWith);
    } else {
      const color = effects ? blockColor(block) : null;
      block.setType(replaceWith);
      if (effects) fx.particle(dim, 'sp:dust', center, { color });
    }
  } catch {
    return false;
  }
  return true;
}

/** Transform a block into another type (e.g. sand -> glass) respecting griefing rules. */
export function transformBlock(block, newType) {
  if (!block || !griefingAllowed()) return false;
  if (tierOf(block) >= 4) return false;
  try {
    block.setPermutation(BlockPermutation.resolve(newType));
    return true;
  } catch {
    return false;
  }
}

/**
 * Break blocks in a sphere up to maxTier. Returns number broken.
 * Limits work per call so a single ability can never stall the server.
 */
export function breakSphere(dim, center, radius, maxTier, opts = {}) {
  if (!griefingAllowed()) return 0;
  const r = Math.ceil(radius);
  const limit = opts.limit ?? 160;
  const dropChance = opts.dropChance ?? 0;
  let broken = 0;
  for (let dx = -r; dx <= r && broken < limit; dx++) {
    for (let dy = -r; dy <= r && broken < limit; dy++) {
      for (let dz = -r; dz <= r && broken < limit; dz++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > radius * radius) continue;
        // ragged edges look more natural
        if (d2 > (radius - 1) * (radius - 1) && Math.random() < 0.45) continue;
        const b = getBlockSafe(dim, { x: center.x + dx, y: center.y + dy, z: center.z + dz });
        if (!b || b.isAir) continue;
        if (breakBlock(b, { maxTier, drop: Math.random() < dropChance, effects: Math.random() < 0.35 })) broken++;
      }
    }
  }
  return broken;
}

/** Picks the debris texture slot that best matches a block id. */
export function debrisTextureFor(id) {
  const plain = id.replace('minecraft:', '').replace('sp:', '');
  const direct = DEBRIS_TEXTURES.indexOf(plain);
  if (direct >= 0) return direct;
  const pairs = [
    ['grass', 'grass'], ['mycelium', 'dirt'], ['podzol', 'dirt'], ['farmland', 'dirt'], ['dirt', 'dirt'],
    ['red_sand', 'red_sand'], ['sandstone', 'sandstone'], ['sand', 'sand'], ['gravel', 'gravel'],
    ['cobbled_deepslate', 'deepslate'], ['deepslate', 'deepslate'], ['cobble', 'cobblestone'],
    ['stone_brick', 'stone_bricks'], ['brick', 'stone_bricks'], ['leaves', 'leaves'], ['log', 'oak_log'],
    ['wood', 'oak_log'], ['stem', 'oak_log'], ['planks', 'oak_planks'], ['netherrack', 'netherrack'],
    ['nylium', 'netherrack'], ['end_stone', 'end_stone'], ['snow', 'snow'], ['ice', 'ice'], ['obsidian', 'obsidian'],
    ['clay', 'clay'], ['mud', 'mud'], ['blackstone', 'blackstone'], ['basalt', 'basalt'], ['tuff', 'tuff'],
    ['terracotta', 'terracotta'], ['glass', 'glass'], ['iron', 'iron_block'], ['magma', 'magma'],
    ['meteorite', 'meteorite'], ['ore', 'stone'], ['andesite', 'stone'], ['diorite', 'stone'], ['granite', 'terracotta'],
  ];
  for (const [hint, tex] of pairs) if (plain.includes(hint)) return DEBRIS_TEXTURES.indexOf(tex);
  return 0;
}

/**
 * Exact point where a ray enters the unit cube of a hit block (slab method). The raycast's
 * faceLocation is not reliable on BDS 1.26.3, so hit points are recomputed from the ray.
 * @param {import('./math.js').Vec3} origin @param {import('./math.js').Vec3} dir unit direction
 * @param {{x:number,y:number,z:number}} blockLoc
 * @returns {import('./math.js').Vec3}
 */
export function rayBlockPoint(origin, dir, blockLoc) {
  let tmin = 0;
  let tmax = Infinity;
  for (const k of ['x', 'y', 'z']) {
    const lo = blockLoc[k];
    const hi = lo + 1;
    if (Math.abs(dir[k]) < 1e-9) {
      if (origin[k] < lo || origin[k] > hi) tmin = Infinity;
      continue;
    }
    let t1 = (lo - origin[k]) / dir[k];
    let t2 = (hi - origin[k]) / dir[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (!Number.isFinite(tmin) || tmin > tmax) return { x: blockLoc.x + 0.5, y: blockLoc.y + 1, z: blockLoc.z + 0.5 };
  return addScaledV(origin, dir, tmin);
}

