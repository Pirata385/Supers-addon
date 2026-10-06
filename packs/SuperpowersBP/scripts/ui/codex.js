// The Mutant Codex: catalog to discover and manage powers, items, structures and mutants.
import { world, system, GameMode, ItemStack, PlayerPermissionLevel, CommandPermissionLevel } from '@minecraft/server';
import { ActionFormData, ModalFormData, MessageFormData } from '@minecraft/server-ui';
import { POWERS, POWER_IDS, MAX_POWERS, GLYPH, ITEMS } from '../config.js';
import {
  rt,
  saveSettings,
  selectAbility,
  selectedAbility,
  worldSettings,
  setWorldSetting,
  isDiscovered,
  discover,
} from '../core/state.js';
import { grantPower, revokePower, giveEmblem, hasEmblem, cooldownLeft } from '../core/powers.js';
import * as fx from '../core/fx.js';

const UI = 'textures/sp/ui/';

// --------------------------------------------------------------- catalog content
/** Item catalog entries. `icon` points to the item sprite in the resource pack. */
export const ITEM_ENTRIES = [
  ...POWER_IDS.map((id) => ({
    id: POWERS[id].syringe,
    name: `${POWERS[id].name} Mutagen`,
    color: POWERS[id].color,
    icon: `textures/items/sp_syringe_${id}`,
    desc: `Injects the ${POWERS[id].name} gene. ${POWERS[id].tagline}`,
    source: 'Crafted from an Empty Syringe, a Mutagen Crystal and a key ingredient. Rarely found in Mutagen Labs and dropped by Rogue Mutants.',
  })),
  {
    id: ITEMS.unstable,
    name: 'Unstable Mutagen',
    color: '§5',
    icon: 'textures/items/sp_syringe_unstable',
    desc: 'Grants a random power you do not have yet.',
    source: 'Empty Syringe + 3 Mutagen Crystals + Nether Wart. Found in Mutagen Labs.',
  },
  {
    id: ITEMS.suppressor,
    name: 'Suppressor Serum',
    color: '§7',
    icon: 'textures/items/sp_suppressor_serum',
    desc: 'Strips every power from your body, returning you to baseline human.',
    source: 'Empty Syringe + Milk Bucket + Mutagen Crystal.',
  },
  {
    id: ITEMS.emptySyringe,
    name: 'Empty Syringe',
    color: '§f',
    icon: 'textures/items/sp_syringe_empty',
    desc: 'Base of every serum. Returned after each injection.',
    source: 'Glass + Iron Ingot + Iron Nugget.',
  },
  {
    id: ITEMS.crystal,
    name: 'Mutagen Crystal',
    color: '§a',
    icon: 'textures/items/sp_mutagen_crystal',
    desc: 'Crystallised mutagen. Hums faintly in your hand.',
    source: 'Mined from Meteorite blocks, dropped by Rogue Mutants, or crafted from Amethyst, Glowstone, Slime and Redstone.',
  },
  {
    id: ITEMS.codex,
    name: 'Mutant Codex',
    color: '§d',
    icon: 'textures/items/sp_mutant_codex',
    desc: 'This catalog. Tracks discoveries and manages your powers.',
    source: 'Book + Mutagen Crystal + Ender Pearl.',
  },
];

export const STRUCTURES = [
  {
    id: 'sp:mutagen_lab',
    key: 'structure:mutagen_lab',
    name: 'Mutagen Lab',
    icon: UI + 'lab',
    desc: 'An abandoned research bunker. Glowing mutagen tanks line the walls and a sealed chest may hold serums, crystals and syringes.',
    where: 'Rare, on the surface of most overworld biomes.',
  },
  {
    id: 'sp:meteor_crash',
    key: 'structure:meteor_crash',
    name: 'Meteor Crash Site',
    icon: UI + 'crater',
    desc: 'A scorched crater around a fallen meteorite. Its Meteorite blocks drop Mutagen Crystals when mined.',
    where: 'Uncommon in open overworld terrain. Espers can create new ones with Meteor Call.',
  },
];

const MUTANT_VARIANTS = [
  { power: 'strength', name: 'Brute', desc: 'Leaps at its prey and slams the ground with a shockwave.' },
  { power: 'heat_vision', name: 'Scorcher', desc: 'Burns targets with short bursts of heat vision.' },
  { power: 'speedster', name: 'Blur', desc: 'Moves in a blur, dashing in and out of melee range.' },
  { power: 'esper', name: 'Psion', desc: 'Telekinetically hurls its victims into the air.' },
];

// --------------------------------------------------------------- helpers
function isCreative(player) {
  try {
    return player.getGameMode() === GameMode.Creative;
  } catch {
    return false;
  }
}

function isOperator(player) {
  try {
    if (player.playerPermissionLevel === PlayerPermissionLevel.Operator) return true;
  } catch {
    /* ignore */
  }
  try {
    return player.commandPermissionLevel >= CommandPermissionLevel.GameDirectors;
  } catch {
    return false;
  }
}

async function show(form, player) {
  try {
    const res = await form.show(player);
    if (res.canceled) return undefined;
    return res;
  } catch {
    return undefined;
  }
}

function click(player) {
  fx.soundTo(player, 'sp.ui.click', 1, 0.6);
}

function slotsLine(player) {
  const r = rt(player);
  const parts = [];
  for (let i = 0; i < MAX_POWERS; i++) {
    const id = r.powers[i];
    parts.push(id ? `§f${GLYPH[id]} ${POWERS[id].color}${POWERS[id].short}` : '§8[ empty slot ]');
  }
  return parts.join('§7  |  ');
}

function abilityLines(player, id) {
  const def = POWERS[id];
  const sel = rt(player).powers.includes(id) ? selectedAbility(player, id) : null;
  return def.abilities
    .map((a) => {
      const mode = a.mode === 'hold' ? 'hold' : a.mode === 'toggle' ? 'toggle' : 'tap';
      const cd = a.cooldown ? ` §8(${(a.cooldown / 20).toFixed(a.cooldown % 20 ? 1 : 0)}s)` : '';
      const marker = sel && sel.id === a.id ? `§f${GLYPH.arrow} ` : '§8- ';
      return `${marker}${def.color}${a.name} §7[${mode}]${cd}\n   §7${a.desc}`;
    })
    .join('\n');
}

// --------------------------------------------------------------- pages
export async function openCodex(player) {
  const r = rt(player);
  const ws = worldSettings();
  const form = new ActionFormData()
    .title('§5§lMUTANT CODEX')
    .header(`§fSubject: §d${player.name}`)
    .label(`§7Power slots §f${r.powers.length}/${MAX_POWERS}\n${slotsLine(player)}`)
    .divider()
    .button('§lMy Powers\n§r§8Abilities, emblems, removal', UI + 'cat_mypowers')
    .button('§lPower Archive\n§r§8Discover and acquire powers', UI + 'cat_powers')
    .button('§lItems & Serums\n§r§8Syringes, crystals, recipes', UI + 'cat_items')
    .button('§lStructures\n§r§8Labs and crash sites', UI + 'cat_structures')
    .button('§lBestiary\n§r§8Rogue Mutants', UI + 'cat_mobs')
    .button('§lField Guide\n§r§8Controls and tips', UI + 'cat_guide')
    .button('§lSettings\n§r§8HUD, effects' + (isOperator(player) ? ', world rules' : ''), UI + 'cat_settings');
  if (ws.codexMode === 'off') form.label('§8Acquiring powers from the Codex is disabled on this world.');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  switch (res.selection) {
    case 0:
      return myPowers(player);
    case 1:
      return archive(player);
    case 2:
      return items(player);
    case 3:
      return structures(player);
    case 4:
      return bestiary(player);
    case 5:
      return guide(player);
    case 6:
      return settings(player);
  }
}

async function myPowers(player) {
  const r = rt(player);
  const form = new ActionFormData().title('§5My Powers');
  if (!r.powers.length) {
    form.body('§7You have no powers yet.\n\nInject a §fMutagen Syringe§7 or acquire a power from the §dPower Archive§7.');
  } else {
    form.body(`§7Slots used: §f${r.powers.length}/${MAX_POWERS}\n§7Select a power to choose its active ability, recover its emblem or remove it.`);
  }
  for (const id of r.powers) {
    const ab = selectedAbility(player, id);
    form.button(`${POWERS[id].color}§l${POWERS[id].name}\n§r§8Active: ${ab.name}`, UI + `power_${id}`);
  }
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (res.selection === r.powers.length) return openCodex(player);
  return powerManage(player, r.powers[res.selection]);
}

async function powerManage(player, id) {
  const r = rt(player);
  if (!r.powers.includes(id)) return myPowers(player);
  const def = POWERS[id];
  const form = new ActionFormData()
    .title(`${def.color}${def.name}`)
    .body(`§f${GLYPH[id]} §7${def.tagline}\n\n§fPassive: §7${def.passive}\n\n${abilityLines(player, id)}`);
  for (const a of def.abilities) {
    const left = cooldownLeft(player, id, a.id);
    form.button(`Use: ${def.color}${a.name}${left ? `\n§r§c${(left / 20).toFixed(1)}s` : '\n§r§8Set as active ability'}`);
  }
  const emblemMissing = !hasEmblem(player, id);
  form.button(emblemMissing ? '§2Recover Emblem\n§r§8Your emblem is missing' : '§8Emblem in inventory', UI + `power_${id}`);
  form.button('§4Remove Power\n§r§8Frees a slot', UI + 'remove');
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  const n = def.abilities.length;
  if (res.selection < n) {
    const ab = selectAbility(player, id, res.selection);
    fx.soundTo(player, 'sp.ui.select');
    player.sendMessage(`${def.color}${def.short}§7 active ability: §f${ab.name}`);
    return powerManage(player, id);
  }
  if (res.selection === n) {
    if (emblemMissing) {
      giveEmblem(player, id);
      fx.soundTo(player, 'sp.ui.select');
    }
    return powerManage(player, id);
  }
  if (res.selection === n + 1) {
    const confirm = await show(
      new MessageFormData()
        .title('§4Remove Power')
        .body(`Remove ${def.color}${def.name}§r? Its emblem will crumble and the slot becomes free.\n\n§7You can gain it again later with a syringe.`)
        .button1('§4Remove')
        .button2('Keep'),
      player,
    );
    if (confirm && confirm.selection === 0) {
      revokePower(player, id);
      fx.particle(player.dimension, 'sp:power_purge', player.location);
      player.sendMessage(`§7${def.name} has faded from your cells.`);
      return myPowers(player);
    }
    return powerManage(player, id);
  }
  return myPowers(player);
}

function acquireInfo(player) {
  const ws = worldSettings();
  if (isCreative(player)) return { allowed: true, cost: 0, text: '§aFree in Creative mode' };
  if (ws.codexMode === 'off') return { allowed: false, cost: 0, text: '§cDisabled on this world (use syringes)' };
  if (ws.codexMode === 'free') return { allowed: true, cost: 0, text: '§aFree on this world' };
  const cost = Math.max(0, Math.floor(ws.codexXpCost ?? 15));
  return { allowed: true, cost, text: `§eCost: ${cost} XP levels §7(you have ${player.level})` };
}

async function archive(player) {
  const r = rt(player);
  const form = new ActionFormData()
    .title('§5Power Archive')
    .body(`§7Every known mutation. Acquire powers here or with syringes.\n${acquireInfo(player).text}`);
  for (const id of POWER_IDS) {
    const owned = r.powers.includes(id);
    form.button(`${POWERS[id].color}§l${POWERS[id].name}\n§r${owned ? '§2Owned' : '§8' + POWERS[id].tagline.slice(0, 34)}`, UI + `power_${id}`);
  }
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (res.selection === POWER_IDS.length) return openCodex(player);
  return powerDetail(player, POWER_IDS[res.selection]);
}

async function powerDetail(player, id) {
  const r = rt(player);
  const def = POWERS[id];
  discover(player, `power:${id}`);
  const owned = r.powers.includes(id);
  const info = acquireInfo(player);
  const form = new ActionFormData()
    .title(`${def.color}${def.name}`)
    .body(
      `§f${GLYPH[id]} §7${def.tagline}\n\n§fPassive: §7${def.passive}\n\n§fAbilities:\n${abilityLines(player, id)}\n\n§fObtain: §7${def.name} Mutagen syringe, or acquire below.`,
    );
  let acquireIdx = -1;
  if (!owned) {
    acquireIdx = 0;
    form.button(`§2§lAcquire\n§r${info.text}`, UI + `power_${id}`);
  } else {
    form.label('§2You already have this power.');
  }
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (res.selection === acquireIdx) return acquire(player, id);
  return archive(player);
}

async function acquire(player, id) {
  const r = rt(player);
  const def = POWERS[id];
  const info = acquireInfo(player);
  if (!info.allowed) {
    fx.soundTo(player, 'sp.ui.deny');
    player.sendMessage('§cAcquiring powers from the Codex is disabled on this world.');
    return;
  }
  if (r.powers.length >= MAX_POWERS) {
    fx.soundTo(player, 'sp.ui.deny');
    player.sendMessage(`§cAll ${MAX_POWERS} power slots are full. Remove a power in §fMy Powers§c first.`);
    return myPowers(player);
  }
  if (info.cost > 0 && player.level < info.cost) {
    fx.soundTo(player, 'sp.ui.deny');
    player.sendMessage(`§cYou need ${info.cost} XP levels (you have ${player.level}).`);
    return powerDetail(player, id);
  }
  const confirm = await show(
    new MessageFormData()
      .title(`${def.color}Acquire ${def.name}`)
      .body(`Rewrite your DNA with ${def.color}${def.name}§r?\n\n${info.text}\n§7Slots after: ${r.powers.length + 1}/${MAX_POWERS}`)
      .button1('§2Acquire')
      .button2('Cancel'),
    player,
  );
  if (!confirm || confirm.selection !== 0 || !player.isValid) return;
  if (info.cost > 0) {
    if (player.level < info.cost) return;
    player.addLevels(-info.cost);
  }
  fx.anim(player, 'animation.sp.inject');
  fx.sound(player.dimension, 'sp.syringe.inject', player.location);
  system.runTimeout(() => {
    if (!player.isValid) return;
    const res = grantPower(player, id);
    if (!res.ok && info.cost > 0) player.addLevels(info.cost); // refund
  }, 12);
}

async function items(player) {
  const form = new ActionFormData().title('§5Items & Serums').body('§7Items you have held are marked as discovered.');
  for (const e of ITEM_ENTRIES) {
    const known = isDiscovered(player, e.id) || isCreative(player);
    form.button(known ? `${e.color}§l${e.name}` : '§8§l??? Undiscovered', known ? e.icon : UI + 'cat_items');
  }
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (res.selection === ITEM_ENTRIES.length) return openCodex(player);
  return itemDetail(player, ITEM_ENTRIES[res.selection]);
}

async function itemDetail(player, e) {
  const known = isDiscovered(player, e.id) || isCreative(player);
  const form = new ActionFormData()
    .title(known ? `${e.color}${e.name}` : '§8Undiscovered')
    .body(known ? `§7${e.desc}\n\n§fHow to obtain:\n§7${e.source}` : `§7You have not found this item yet.\n\n§fHint: §7${e.source}`);
  const canTake = isCreative(player) || isOperator(player);
  if (canTake) form.button('§2Take one\n§r§8Creative / operator', e.icon);
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (canTake && res.selection === 0) {
    try {
      player.getComponent('minecraft:inventory')?.container?.addItem(new ItemStack(e.id, 1));
      fx.soundTo(player, 'sp.ui.select');
    } catch {
      /* ignore */
    }
    return itemDetail(player, e);
  }
  return items(player);
}

async function structures(player) {
  const form = new ActionFormData().title('§5Structures').body('§7Places of interest. Explore them to record them in the Codex.');
  for (const s of STRUCTURES) {
    const known = isDiscovered(player, s.key);
    form.button(`${known ? '§f§l' : '§7§l'}${s.name}\n§r${known ? '§2Discovered' : '§8Not yet found'}`, s.icon);
  }
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (res.selection === STRUCTURES.length) return openCodex(player);
  return structureDetail(player, STRUCTURES[res.selection]);
}

async function structureDetail(player, s) {
  const known = isDiscovered(player, s.key);
  const canBuild = isCreative(player) || isOperator(player);
  const form = new ActionFormData()
    .title(s.name)
    .body(`§7${s.desc}\n\n§fWhere: §7${s.where}\n\n${known ? '§2Discovered' : '§8Not yet discovered'}`);
  if (canBuild) form.button('§2Build here\n§r§8Creative / operator', s.icon);
  form.button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (!res) return;
  click(player);
  if (canBuild && res.selection === 0) {
    placeStructure(player, s);
    return;
  }
  return structures(player);
}

/** Place a structure template a few blocks in front of the player. */
export function placeStructure(player, s) {
  const dir = player.getViewDirection();
  const h = Math.hypot(dir.x, dir.z) || 1;
  const loc = player.location;
  const x = Math.floor(loc.x + (dir.x / h) * 4);
  const z = Math.floor(loc.z + (dir.z / h) * 4);
  let y = Math.floor(loc.y);
  if (s.id === 'sp:meteor_crash') y -= 3;
  try {
    world.structureManager.place(s.id, player.dimension, { x: x - 5, y, z: z - 5 });
    discover(player, s.key);
    fx.sound(player.dimension, 'sp.impact.heavy', { x, y, z }, 0.7, 1);
    player.sendMessage(`§2${s.name} built.`);
  } catch (e) {
    player.sendMessage(`§cCould not place ${s.name}: ${e}`);
  }
}

async function bestiary(player) {
  const known = isDiscovered(player, 'mob:rogue_mutant') || isCreative(player);
  const body = known
    ? `§fRogue Mutants§7 are failed test subjects who absorbed too much mutagen. They roam at night and in dark places, and each wields a twisted power:\n\n${MUTANT_VARIANTS.map(
        (v) => `§f${GLYPH[v.power]} ${POWERS[v.power].color}${v.name}§7 - ${v.desc}`,
      ).join('\n')}\n\n§fDrops: §7Mutagen Crystals, rarely a mutagen syringe.`
    : '§7Something prowls the night. Encounter it to learn more.';
  const form = new ActionFormData().title('§5Bestiary').body(body).button('§lBack', UI + 'back');
  const res = await show(form, player);
  if (res) {
    click(player);
    return openCodex(player);
  }
}

const GUIDE_PAGES = [
  {
    title: 'Getting powers',
    body: `§7Inject a §fMutagen Syringe§7 (use the item) or acquire a power in the §dPower Archive§7. You can hold up to §f${MAX_POWERS}§7 powers at once and they all work together. A §7Suppressor Serum§7 removes every power; single powers can be removed in §fMy Powers§7.`,
  },
  {
    title: 'Emblems & controls',
    body: '§7Each power gives you an §fEmblem§7. Hold it and press §fUse§7 to activate the selected ability; §fSneak + Use§7 switches ability. Hold-type abilities (Charged Jump, Heat Beam, Telekinesis) stay active while you hold Use.\n\n§fShortcuts:§7\n- Flight: double-tap Jump in mid-air.\n- Strength: crouch for a moment, then Jump for a charged leap.\n- Heat Beam: Jump / Sneak while firing changes intensity.\n- Telekinesis: Jump / Sneak while holding pushes / pulls; sneak while releasing sets the object down.',
  },
  {
    title: 'Flight',
    body: '§7Look where you want to go and hold forward: you accelerate the longer you fly. Jump rises, Sneak descends. Past ~150 km/h you break the sound barrier and smash through glass and leaves; even faster, through soft blocks. Use Afterburner for instant top speed. Grab a mob, carry it and hurl it.',
  },
  {
    title: 'Speedster',
    body: '§7Turn on Speed Force and sprint: the longer you sprint, the higher the gear. From gear 2 you run on water and auto-dodge projectiles; gear 3 bowls over mobs; gear 4 is supersonic. Time Dilation slows everything around you, including arrows in flight.',
  },
  {
    title: 'Heat Vision',
    body: '§7Intensity 1-2 burns creatures and ignites wood. 3 vaporises soft blocks. 4 melts stone into magma. 5 bores tunnels. Your eyes store heat: when the gauge fills you overheat and must cool down.',
  },
  {
    title: 'Esper',
    body: '§7Telekinesis lifts mobs, players, dropped items and blocks. Levitation Field lifts everything around you; use it again to slam them down. Psionic Barrier reflects projectiles back at their shooter. Meteor Call drags a meteor onto your target - stand back!',
  },
  {
    title: 'Super Strength',
    body: '§7Your body shrugs off most damage and your punches launch enemies. Rip boulders out of the ground and throw them, charge through walls of glass and leaves, and Thunderclap to blast everything in front of you.',
  },
];

async function guide(player, page = -1) {
  if (page < 0) {
    const form = new ActionFormData().title('§5Field Guide');
    for (const p of GUIDE_PAGES) form.button(`§l${p.title}`, UI + 'cat_guide');
    form.button('§lBack', UI + 'back');
    const res = await show(form, player);
    if (!res) return;
    click(player);
    if (res.selection === GUIDE_PAGES.length) return openCodex(player);
    return guide(player, res.selection);
  }
  const p = GUIDE_PAGES[page];
  const res = await show(new ActionFormData().title(`§5${p.title}`).body(p.body).button('§lBack', UI + 'back'), player);
  if (res) {
    click(player);
    return guide(player);
  }
}

async function settings(player) {
  const r = rt(player);
  const op = isOperator(player);
  const ws = worldSettings();
  const modes = ['xp', 'free', 'off'];
  const form = new ModalFormData()
    .title('§5Codex Settings')
    .header('Personal')
    .toggle('Power HUD on the action bar', { defaultValue: r.settings.hud !== false })
    .toggle('Control hints', { defaultValue: r.settings.hints !== false })
    .toggle('Screen effects (shake, FOV, fog)', { defaultValue: r.settings.screenFx !== false })
    .toggle('Confirm before injecting serums', { defaultValue: r.settings.confirmInjections !== false });
  if (op) {
    form
      .divider()
      .header('World rules (operators)')
      .toggle('Powers can destroy and alter blocks', { defaultValue: ws.griefing !== false })
      .toggle('Powers can hurt other players (also needs the pvp game rule)', { defaultValue: ws.pvp !== false })
      .dropdown('Acquiring powers from the Codex', ['Costs XP levels', 'Free', 'Disabled'], {
        defaultValueIndex: Math.max(0, modes.indexOf(ws.codexMode)),
      })
      .slider('XP level cost', 0, 50, { defaultValue: ws.codexXpCost ?? 15, valueStep: 1 })
      .toggle('Rogue Mutants use their powers', { defaultValue: ws.mutantPowers !== false });
  }
  const res = await show(form, player);
  if (!res || !res.formValues) return;
  const v = res.formValues.filter((x) => x !== undefined);
  r.settings.hud = !!v[0];
  r.settings.hints = !!v[1];
  r.settings.screenFx = !!v[2];
  r.settings.confirmInjections = !!v[3];
  saveSettings(player);
  if (!r.settings.screenFx) fx.resetFov(player);
  if (op && v.length >= 9) {
    setWorldSetting('griefing', !!v[4]);
    setWorldSetting('pvp', !!v[5]);
    setWorldSetting('codexMode', modes[Number(v[6])] ?? 'xp');
    setWorldSetting('codexXpCost', Number(v[7]));
    setWorldSetting('mutantPowers', !!v[8]);
  }
  fx.soundTo(player, 'sp.ui.select');
  player.sendMessage('§dCodex settings saved.');
}

export function registerCodex() {
  // Codex pages record discoveries when viewed; nothing else to wire at startup.
}
