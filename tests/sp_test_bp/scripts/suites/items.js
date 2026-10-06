// Test suite: items, blocks, recipes and loot tables.
// Forms cannot be answered by simulated players, so syringe/codex use is not exercised here:
// the suite checks that every item/block exists with the contract's components, that every
// recipe ingredient resolves, that block loot tables roll correctly and that a simulated
// player can receive and hold the items.
import { world, ItemStack, ItemTypes, BlockTypes, ItemLockMode } from '@minecraft/server';

const POWERS = ['strength', 'flight', 'heat_vision', 'speedster', 'esper'];

/** id -> expected max stack size */
const ITEMS = {
  'sp:syringe_strength': 16,
  'sp:syringe_flight': 16,
  'sp:syringe_heat_vision': 16,
  'sp:syringe_speedster': 16,
  'sp:syringe_esper': 16,
  'sp:syringe_unstable': 16,
  'sp:suppressor_serum': 16,
  'sp:syringe_empty': 64,
  'sp:mutagen_crystal': 64,
  'sp:mutant_codex': 1,
  'sp:emblem_strength': 1,
  'sp:emblem_flight': 1,
  'sp:emblem_heat_vision': 1,
  'sp:emblem_speedster': 1,
  'sp:emblem_esper': 1,
};

/** Recipe identifiers in packs/SuperpowersBP/recipes/*.json. */
const RECIPES = [
  'sp:syringe_empty', 'sp:mutagen_crystal', 'sp:syringe_strength', 'sp:syringe_flight', 'sp:syringe_heat_vision',
  'sp:syringe_speedster', 'sp:syringe_esper', 'sp:syringe_unstable', 'sp:suppressor_serum', 'sp:mutant_codex',
];

/** Every vanilla item used by packs/SuperpowersBP/recipes/*.json. */
const RECIPE_INGREDIENTS = [
  'minecraft:glass', 'minecraft:iron_ingot', 'minecraft:iron_nugget', 'minecraft:amethyst_shard',
  'minecraft:glowstone_dust', 'minecraft:slime_ball', 'minecraft:redstone', 'minecraft:iron_block',
  'minecraft:phantom_membrane', 'minecraft:feather', 'minecraft:blaze_rod', 'minecraft:magma_cream',
  'minecraft:sugar', 'minecraft:redstone_block', 'minecraft:ender_eye', 'minecraft:nether_wart',
  'minecraft:milk_bucket', 'minecraft:book', 'minecraft:ender_pearl',
];

function stack(id, amount = 1) {
  try {
    return { item: new ItemStack(id, amount) };
  } catch (e) {
    return { error: String(e) };
  }
}

function params(item, componentId) {
  try {
    const c = /** @type {any} */ (item.getComponent(componentId));
    return c ? (c.customComponentParameters?.params ?? {}) : undefined;
  } catch (e) {
    return { error: String(e) };
  }
}

function countItems(player) {
  const out = {};
  const inv = player.getComponent('minecraft:inventory').container;
  for (let i = 0; i < inv.size; i++) {
    const it = inv.getItem(i);
    if (it) out[it.typeId] = (out[it.typeId] ?? 0) + it.amount;
  }
  return out;
}

/** @param {import('../ctx.js').Ctx} ctx */
export async function run(ctx) {
  // ------------------------------------------------------------ item types
  for (const [id, max] of Object.entries(ITEMS)) {
    const type = ItemTypes.get(id);
    const { item, error } = stack(id);
    ctx.assert(!!type && !!item && item.typeId === id, `item ${id} exists`, error);
    if (!item) continue;
    ctx.assert(item.maxAmount === max, `item ${id} stacks to ${max}`, item.maxAmount);
  }

  for (const p of POWERS) {
    const { item } = stack(`sp:syringe_${p}`);
    if (item) ctx.assert(params(item, 'sp:syringe')?.power === p, `syringe_${p} carries sp:syringe power=${p}`, params(item, 'sp:syringe'));
  }
  {
    const { item } = stack('sp:syringe_unstable');
    if (item) ctx.assert(params(item, 'sp:syringe')?.power === 'random', 'unstable syringe power=random', params(item, 'sp:syringe'));
    const sup = stack('sp:suppressor_serum').item;
    if (sup) ctx.assert(params(sup, 'sp:suppressor') !== undefined, 'suppressor has sp:suppressor');
    const codex = stack('sp:mutant_codex').item;
    if (codex) ctx.assert(params(codex, 'sp:codex') !== undefined, 'codex has sp:codex');
  }
  for (const p of POWERS) {
    const { item } = stack(`sp:emblem_${p}`);
    if (!item) continue;
    let food;
    try {
      food = item.getComponent('minecraft:food');
    } catch {
      food = undefined;
    }
    ctx.assert(!!food && food.canAlwaysEat && food.nutrition === 0, `emblem_${p} is a food-like hold item`,
      food ? { canAlwaysEat: food.canAlwaysEat, nutrition: food.nutrition } : 'no food component');
    ctx.assert(params(item, 'sp:emblem') !== undefined && item.hasTag('sp:emblem'), `emblem_${p} has sp:emblem`);
  }

  // ------------------------------------------------------------ recipes (ingredients must resolve)
  const missing = RECIPE_INGREDIENTS.filter((id) => !ItemTypes.get(id));
  ctx.assert(missing.length === 0, 'all recipe ingredients exist', missing);

  // ------------------------------------------------------------ blocks
  // the simulated player's ticking area keeps the suite's chunks loaded
  const p = await ctx.player('sp_items', 0, -3);
  ctx.fill([-6, -1, -6], [6, 4, 6], 'air');
  ctx.fill([-6, -1, -6], [6, -1, 6], 'stone');
  // each block sits in a sealed stone pocket (no sky light) with one air cell above it;
  // the pocket at dx=0 has no emitter and is the darkness control
  const pockets = [{ id: 'sp:meteorite', dx: -3 }, { id: undefined, dx: 0 }, { id: 'sp:mutagen_tank', dx: 3 }];
  for (const { id, dx } of pockets) {
    ctx.fill([dx - 1, 0, -1], [dx + 1, 3, 1], 'stone');
    ctx.fill([dx, 1, 0], [dx, 1, 0], 'air');
    if (!id) continue;
    ctx.assert(!!BlockTypes.get(id), `block type ${id} exists`);
    const P = ctx.at(dx, 0, 0);
    ctx.run(`setblock ${Math.floor(P.x)} ${Math.floor(P.y)} ${Math.floor(P.z)} ${id}`);
  }
  await ctx.wait(10);
  ctx.assert(ctx.block(-3, 0, 0)?.typeId === 'sp:meteorite', 'meteorite placed with setblock', ctx.block(-3, 0, 0)?.typeId);
  ctx.assert(ctx.block(3, 0, 0)?.typeId === 'sp:mutagen_tank', 'mutagen tank placed with setblock', ctx.block(3, 0, 0)?.typeId);
  ctx.assert(ctx.block(-3, 0, 0)?.hasTag('stone') === true, 'meteorite is tagged stone (pickaxe mineable)');
  {
    // light in the sealed cell above each emitter (meteorite 5, tank 12; -1 per block of distance)
    const light = (dx) => ctx.block(dx, 1, 0)?.getLightLevel() ?? -1;
    const dark = light(0), nearMet = light(-3), nearTank = light(3);
    ctx.assert(dark >= 0 && dark <= 1, 'sealed control pocket is dark', dark);
    ctx.assert(nearMet >= 4 && nearMet <= 5, 'meteorite emits light ~5', nearMet);
    ctx.assert(nearTank >= 11 && nearTank <= 12, 'mutagen tank emits light ~12', nearTank);
  }

  // ------------------------------------------------------------ loot tables
  {
    const lm = world.getLootTableManager();
    let min = 99, max = 0, other = [];
    for (let i = 0; i < 40; i++) {
      const drops = lm.generateLootFromBlockType(BlockTypes.get('sp:meteorite')) ?? [];
      let n = 0;
      for (const d of drops) {
        if (d.typeId === 'sp:mutagen_crystal') n += d.amount;
        else other.push(d.typeId);
      }
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
    ctx.assert(min >= 1 && max <= 3 && max > min && other.length === 0, 'meteorite drops 1-3 mutagen crystals', { min, max, other });
    const tank = lm.generateLootFromBlockType(BlockTypes.get('sp:mutagen_tank')) ?? [];
    ctx.assert(tank.length === 1 && tank[0].typeId === 'sp:mutagen_tank' && tank[0].amount === 1, 'mutagen tank drops itself',
      tank.map((d) => `${d.typeId}x${d.amount}`));
  }

  // ------------------------------------------------------------ recipes registered (fresh player: all locked)
  ctx.run(`clear ${p.name}`);
  ctx.run(`recipe take ${p.name} *`);
  {
    ctx.assert(ctx.run(`recipe give ${p.name} sp:not_a_recipe`) < 1, 'recipe command rejects unknown ids');
    const failed = RECIPES.filter((id) => ctx.run(`recipe give ${p.name} ${id}`) < 1);
    ctx.assert(failed.length === 0, `all ${RECIPES.length} recipes are registered`, failed);
    ctx.run(`recipe take ${p.name} *`);
  }

  // ------------------------------------------------------------ simulated player
  let threw;
  try {
    for (const id of Object.keys(ITEMS)) if (!id.startsWith('sp:emblem_')) ctx.give(p, id, id === 'sp:mutant_codex' ? 1 : 2);
    p.selectedSlotIndex = 0;
  } catch (e) {
    threw = String(e);
  }
  ctx.assert(threw === undefined, 'player receives codex, syringes and materials', threw);
  await ctx.wait(20);
  {
    const inv = countItems(p);
    const missingInv = Object.keys(ITEMS).filter((id) => !id.startsWith('sp:emblem_') && !inv[id]);
    ctx.assert(missingInv.length === 0, 'items are in the inventory', { missingInv, inv });
  }
  // the unlock rules fired: holding the ingredients unlocked every recipe (take succeeds only when unlocked)
  {
    const locked = RECIPES.filter((id) => ctx.run(`recipe take ${p.name} ${id}`) < 1);
    ctx.assert(locked.length === 0, 'recipes unlock when the player holds their ingredients', locked);
  }
  // emblems prepared the way core/powers.js hands them out (lore, inventory lock, keep on death)
  for (const power of POWERS) {
    let err;
    try {
      const e = new ItemStack(`sp:emblem_${power}`, 1);
      e.lockMode = ItemLockMode.inventory;
      e.keepOnDeath = true;
      e.setLore(['§r§dtest lore', '§r§7Use: activate ability']);
      const inv = p.getComponent('minecraft:inventory').container;
      const left = inv.addItem(e);
      if (left) err = 'inventory full';
    } catch (ex) {
      err = String(ex);
    }
    ctx.assert(err === undefined, `emblem_${power} accepts lock/lore/keepOnDeath`, err);
  }
  await ctx.wait(2);
  {
    const inv = p.getComponent('minecraft:inventory').container;
    let emblem;
    for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === 'sp:emblem_esper') emblem = inv.getItem(i);
    ctx.assert(!!emblem && emblem.keepOnDeath && emblem.lockMode === ItemLockMode.inventory && emblem.getLore().length === 2,
      'emblem keeps lock, lore and keepOnDeath in the inventory', emblem ? emblem.getLore() : 'missing');
    ctx.run(`clear ${p.name}`);
  }

  // tidy up the area
  ctx.fill([-6, 0, -6], [6, 4, 6], 'air');
}
