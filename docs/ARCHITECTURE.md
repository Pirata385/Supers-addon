# Superpowers & Mutants — Architecture & Content Contract

Target: **Minecraft Bedrock 26.3 (internal 1.26.3) and newer**. Script modules:
`@minecraft/server` **2.5.0** and `@minecraft/server-ui` **2.0.0** (the newest stable versions
available in 26.3). Never use APIs that are not in those typings
(`node_modules/@minecraft/server/index.d.ts` at the repo root) — run `npm run typecheck`.
In particular there is **no** `world.beforeEvents.entityHurt`; damage immunity is data-driven
through tags read by `packs/SuperpowersBP/entities/player.json` (see *Immunity*).

**No potion effects** (`addEffect`) are used anywhere. Powers are built from velocity control,
movement attributes, damage sensors, custom entities, particles, sounds, animations and fog.

## Layout

```
packs/SuperpowersBP/            behavior pack
  manifest.json
  entities/player.json          vanilla 26.3 player + tag driven damage_sensor
  entities/debris.json          sp:debris  (block chunk / boulder)
  entities/meteor.json          sp:meteor
  entities/rogue_mutant.json    sp:rogue_mutant (hostile)
  items/*.json  blocks/*.json  recipes/*.json  loot_tables/  spawn_rules/
  structures/sp/*.mcstructure  features/  feature_rules/
  scripts/
    main.js                     entry (imports everything below)
    config.js                   ALL ids, ability definitions, tuning numbers
    core/math.js                vector helpers
    core/state.js               persistent + runtime player state, world settings
    core/fx.js                  particles, sounds, camera shake, FOV, fog, animations, light flashes
    core/blocks.js              block tiers, safe breaking (respects griefing setting)
    core/entities.js            velocity control, targeting (respects PvP), damage, thrown tracker
    core/powers.js              registry, grant/revoke, emblems, abilities, cooldowns, immunity tags
    core/input.js               emblem use/release, jump/sneak buttons, melee hook
    core/hud.js                 action bar HUD
    core/loop.js                tick loop, onTick(), join/leave/death/dimension lifecycle
    core/commands.js            /sp:power, /sp:codex, scriptevent debug API (tests)
    features/debris.js          shared boulder/block debris (spawn/hold/throw/shatter/liftBlock)
    features/items.js           syringe / suppressor / unstable / codex item custom components
    features/mutant.js          Rogue Mutant power AI
    features/discovery.js       catalog discovery tracking
    powers/strength.js flight.js heat_vision.js speedster.js esper.js
    ui/codex.js                 Mutant Codex catalog forms
packs/SuperpowersRP/            resource pack
tools/                          python generators (textures, sounds, structures, build)
tests/                          BDS harness + GameTest pack (simulated players)
```

## Power module contract

A power module calls `definePower(id, handlers)` from `core/powers.js` at import time.
Static data (names, abilities, cooldowns, descriptions) lives in `config.js` → `POWERS[id]`.
Handlers (all optional):

| handler | when |
|---|---|
| `onGain(p, r)` / `onLose(p, r)` | power granted / removed — `onLose` must undo *every* side effect (movement attribute, fog, FOV, poses, held entities, slowed mobs, flying state…) |
| `onJoin(p, r)` | player spawned/rejoined with the power |
| `onDeath(p, r)`, `onDimensionChange(p, r)`, `onLeave(p, r)` | reset transient state; `onLeave` runs a tick after the player left: never touch the player object there, only world state you own |
| `tick(p, r, tick)` | every tick for players having the power. Keep it cheap: no unbounded entity queries; throttle queries with `tick % n` |
| `activate(p, r, abilityId)` | instant/toggle ability. Return `false` = did not fire (no cooldown). Return a number = custom cooldown ticks. Otherwise instant abilities get `cooldown` from config automatically; **toggle abilities start their own cooldown** via `startCooldown` when appropriate (usually when turned off/expired). |
| `holdStart(p, r, abilityId)` → boolean | hold ability pressed (false = rejected) |
| `holdEnd(p, r, abilityId, {duration, sneaking, reason})` | released / interrupted (`reason`: release, interrupted, death, dimension, revoked, replaced). Config cooldown starts automatically afterwards unless the handler already started one. |
| `onButton(p, r, button, pressed, tick)` | `button` is `'Jump'` or `'Sneak'`. `r.input.doubleJump` is true when a Jump press happened ≤7 ticks after the previous one. |
| `onMelee(p, r, target)` | the player hit an entity in melee |
| `hud(p, r)` → string | live status line (prefix with the power colour), shown under the ability line |
| `isToggled(p, r, abilityId)` → boolean | HUD shows `ON` for active toggles |
| `flags(p, r)` → `{nofall?, nokinetic?, dodge?, tough?, blastproof?, firewalk?}` | desired immunity tags this tick |
| `debug(p, r)` → object | JSON-serialisable snapshot used by tests (`/scriptevent sp:dump <name>`) |

Runtime: `r = rt(player)`; per-power transient bag: `pdata(player, id)` or `r.data[id]`.
Temporary immunity: `grantTemporaryFlag(player, 'nofall', ticks)`.

### Controls
Each power has an **emblem** item (given automatically, locked in inventory, kept on death).
Holding an emblem: **Use** = selected ability (hold abilities: hold Use), **Sneak+Use** = cycle
ability. Extra shortcuts: Flight — double-tap Jump mid-air toggles flight; Strength — crouch ≥0.6 s
then Jump = charged leap. Hold-ability modifiers via `onButton` while channelling (Heat Vision:
Jump/Sneak = intensity ±1; Esper Telekinesis: Jump/Sneak = push/pull).
Movement input: `moveInput(p)` from `core/input.js` returns `{x: left+/right-, y: forward+/back-}`
(supports test overrides). `buttonDown(p, 'Jump'|'Sneak')` for held state.

## Coexistence (several powers at once)
Handlers run inside an *owner context* (`core/context.js`), so shared player resources are
arbitrated automatically:
* **Poses** — `fx.pose` keeps one request per power; the highest priority wins
  (lift > charge > dash > heat beam > esper channel > carry > speed run > cruise > hover).
  `fx.stopPose(p)` inside a handler withdraws only that power's request.
* **FOV** — `fx.fov` keeps one request per power; the widest wins; `fx.resetFov` drops only the
  caller's request.
* **Motion** — `entities.lockMotion(p, ticks)` reserves the player's velocity for an ability
  (dash, leap, blitz recoil...): `setVelocity` calls from other powers are ignored meanwhile.
  `entities.launch(target, v)` (used by `knockFrom`) forces a knock and briefly locks the
  victim's own motion control, so e.g. a flying player hit by a Thunderclap really flies away.
  Continuous controllers (Flight) should check `motionLocked(p)` and simply skip that tick.

## Engine facts measured on BDS 1.26.3 (do not re-derive)

* `entities.setVelocity(e, v)` sets an exact next-tick velocity for players (knockback solve,
  `v.xz = v_now·k + 0.4·F`, `k=0.455` air / `0.273` ground; `v.y = (v_now.y−0.08)·0.49 + Vy`)
  and for mobs (`clearVelocity`+`applyImpulse`). Call it every tick for continuous control
  (flight hover is exact: vertical 0 holds altitude).
* Player ground speed ≈ `2.15 × movement attribute` blocks/tick (vanilla 0.1 → 0.215).
  `getComponent('minecraft:movement').setCurrentValue(v)` works on players; always restore 0.1.
* Emblem items are food-like (`can_always_eat`, 3600 s use): `itemUse`+`itemStartUse` fire on
  press, `itemReleaseUse`+`itemStopUse` on release — also while sneaking.
* Mob `teleport()` resets velocity; `applyImpulse` is additive.
* `player.camera.setFov({fov})`, `fog @s push <id> <slot>`, `camerashake`, `playAnimation`,
  `light_block_0..15` all work. Simulated players report movement vector `{0,0}` (use overrides).

## Immunity (player.json damage_sensor, first match wins)

| tag | effect |
|---|---|
| `sp_nofall` | fall damage cancelled |
| `sp_nokinetic` | fly_into_wall cancelled |
| `sp_dodge` | projectile damage cancelled |
| `sp_blastproof` | entity/block explosion damage cancelled |
| `sp_fireproof` | fire / fire_tick cancelled |
| `sp_tough` | all other damage × 0.35 |

## World rules
* Every block change goes through `core/blocks.js` (`breakBlock`, `breakSphere`, `transformBlock`,
  `liftBlock` in debris.js) which honour the **griefing** world setting, never touch containers,
  block-entities or unbreakables (bedrock, obsidian, portals, command blocks…).
* Every creature effect uses `canAffect(source, target)` / `creaturesNear(...)` (PvP rule,
  creative/spectator immunity, own pets).
* Explosions created by the player's own powers: give `blastproof` for ~10 ticks first.

## Asset contract

### Particles (`packs/SuperpowersRP/particles/*.json`, format 1.10.0, atlas `textures/sp/particles`)
Molang inputs come from `fx.molang`: `color` → `variable.color.r/g/b`, `dir` → `variable.dir.x/y/z`,
other numbers → `variable.<name>`. All particles must have sane defaults when a variable is 0/absent.

| id | inputs | look |
|---|---|---|
| `sp:beam` | `dir`, `len`, `width`, `color` | single additive quad of length `len` centred on the spawn point, aligned to `dir`, facing camera (lookat_direction), life 0.1 s |
| `sp:beam_core` | same | thinner white-hot core of the beam |
| `sp:glow` | `color`, `size` | soft additive glow orb, life 0.15 s (eye glow, impact glow) |
| `sp:spark` | `color` | burst of ~10 fast sparks, gravity, collision, life 0.4–0.7 s |
| `sp:ember` | – | 3 floating orange embers rising, life 1 s |
| `sp:smoke` | – | 2 dark smoke puffs rising and expanding, life 1.5 s |
| `sp:melt` | – | glowing orange droplets falling (molten block) |
| `sp:dust` | `color` | burst of ~14 block-coloured dust motes, gravity, collision (block broken) |
| `sp:dust_fall` | `color` | 2 small dust grains falling (trail of carried/thrown chunks) |
| `sp:debris_chunks` | `color`, `size` | ~16 square rock chunks flung outward with gravity & collision |
| `sp:shockwave` | `radius`, `color` | flat ground ring expanding 0→`radius` in 0.4 s, fading |
| `sp:shockwave_air` | `radius`, `color` | camera-facing ring expanding 0→`radius` |
| `sp:sonic_boom` | `dir` | white vapour ring perpendicular to `dir`, expanding (sonic boom) |
| `sp:wind_streak` | `dir`, `len` | 4–6 thin white streaks along `dir` (speed lines) |
| `sp:cloud_puff` | – | white vapour puff |
| `sp:lightning` | `color` | 2–3 jagged electric bolt sprites flickering, life 0.2 s |
| `sp:afterimage` | `color` | translucent humanoid silhouette (rotate_y), fades over 0.4 s |
| `sp:water_splash` | – | spray of droplets + foam |
| `sp:psi_aura` | `color` | motes orbiting the point, life 0.6 s |
| `sp:psi_link` | `dir`, `len`, `color` | wavy translucent beam (telekinesis link) |
| `sp:psi_shield` | `radius` | sparkles on a sphere surface of `radius` |
| `sp:reflect` | – | bright violet flash burst (projectile reflected) |
| `sp:meteor_trail` | `size` | fire + smoke trail puffs |
| `sp:meteor_marker` | `radius` | red pulsing ring on ground |
| `sp:explosion_flash` | `size` | huge bright flash billboard, life 0.2 s |
| `sp:fireball` | `size` | billowing fire plumes + smoke column (meteor impact) |
| `sp:charge_aura` | `color` | motes converging inward to the point |
| `sp:crack` | `size` | flat ground crack decal fading over 2 s |
| `sp:power_gain` | `color` | rising helix of sparkles around a player, 2 s |
| `sp:power_purge` | – | grey smoke and falling ash |
| `sp:inject` | `color` | small bubbles burst |
| `sp:time_motes` | – | slow drifting blue dust motes (time dilation) |
| `sp:levitate` | `color` | violet motes rising from feet (levitating mob) |

### Sounds (`sounds/sound_definitions.json` + `sounds/sp/*.ogg`)
`sp.power.gain`, `sp.power.lose`, `sp.power.purge`, `sp.syringe.inject`, `sp.ui.open`, `sp.ui.click`,
`sp.ui.select`, `sp.ui.deny`, `sp.impact.heavy`, `sp.impact.light`, `sp.debris.rip`, `sp.debris.place`,
`sp.whoosh`,
`sp.strength.punch`, `sp.strength.charge` (rising rumble, ~1 s), `sp.strength.leap`, `sp.strength.land`,
`sp.strength.throw`, `sp.strength.dash`, `sp.strength.clap`,
`sp.flight.takeoff`, `sp.flight.land`, `sp.flight.wind` (≈1 s wind chunk, re-triggered with pitch by speed),
`sp.flight.boom`, `sp.flight.grab`, `sp.flight.throw`,
`sp.heat.start`, `sp.heat.loop` (≈0.5 s sizzling hum chunk), `sp.heat.stop`, `sp.heat.sizzle`, `sp.heat.burst`,
`sp.heat.overheat`, `sp.heat.focus`,
`sp.speed.start`, `sp.speed.stop`, `sp.speed.zap`, `sp.speed.boom`, `sp.speed.gear`, `sp.speed.dodge`,
`sp.speed.slow_in`, `sp.speed.slow_out`, `sp.speed.blitz`,
`sp.esper.grab`, `sp.esper.hold` (≈1 s hum chunk), `sp.esper.launch`, `sp.esper.drop`, `sp.esper.levitate`,
`sp.esper.slam`, `sp.esper.barrier_up`, `sp.esper.barrier_down`, `sp.esper.reflect`, `sp.esper.meteor_call`,
`sp.esper.meteor_fall`, `sp.esper.meteor_impact`,
`sp.mutant.ambient`, `sp.mutant.hurt`, `sp.mutant.death`, `sp.mutant.power`.

### Player animations (RP `animations/sp_player.animation.json`)
Played with `fx.pose(player, name)` (controller `sp_pose`, loops until replaced/`fx.stopPose`) or
`fx.anim(player, name)` (controller `sp_action`, one-shot). Bone names: `root`, `waist`, `body`,
`head`, `rightArm`, `leftArm`, `rightLeg`, `leftLeg` (geometry.humanoid.custom). Must be neutral
in first person (multiply by `(1 - (variable.is_first_person ?? 0))` where the pose would break the view).

`animation.sp.reset` (empty, 0.05 s), `animation.sp.flight.hover`, `animation.sp.flight.cruise`
(superman pose: `root` pitched forward following `query.target_x_rotation`, like vanilla swim),
`animation.sp.flight.carry`, `animation.sp.strength.charge`, `animation.sp.strength.leap`,
`animation.sp.strength.lift`, `animation.sp.strength.throw`, `animation.sp.strength.clap`,
`animation.sp.strength.dash`, `animation.sp.heat.beam`, `animation.sp.speed.run`,
`animation.sp.speed.blitz`, `animation.sp.esper.channel`, `animation.sp.esper.cast`,
`animation.sp.esper.barrier`, `animation.sp.inject`.

### Entities
* `sp:debris` — properties `sp:tex` (int 0..31, client_sync) selects `DEBRIS_TEXTURES[i]`
  (vanilla block textures referenced from the RP), `sp:size` (float 0.25..4, client_sync) scales
  the cube. Physics + gravity, no AI, immune to damage, not pushable.
* `sp:meteor` — no gravity/collision (script-driven), property `sp:size`, emissive molten rock.
* `sp:rogue_mutant` — hostile humanoid; `minecraft:variant` 0..3 = strength / heat_vision /
  speedster / esper (glowing eye colour per variant).

### Items (BP `items/`, format_version `1.21.90`, custom components V2 written directly in `components`)
| item | key components |
|---|---|
| `sp:syringe_<power>` ×5 | `"sp:syringe": {"power": "<power id>"}`, stack 16 — instant use, script shows a confirm form then a 0.8 s injection sequence and returns `sp:syringe_empty` |
| `sp:syringe_unstable` | `"sp:syringe": {"power": "random"}` |
| `sp:suppressor_serum` | `"sp:suppressor": {}` — removes all powers |
| `sp:syringe_empty`, `sp:mutagen_crystal` | crafting materials |
| `sp:mutant_codex` | `"sp:codex": {}`, stack 1, glint — opens the catalog |
| `sp:emblem_<power>` ×5 | `"sp:emblem": {}`, stack 1, glint, **food-like hold item**: `minecraft:food {nutrition:0, saturation_modifier:0, can_always_eat:true}`, `minecraft:use_modifiers {use_duration:3600, movement_modifier:1.0}`, `minecraft:use_animation "none"` (never completes, so it is never eaten) |

Blocks: `sp:meteorite` (ore-like, glows, drops 1–3 `sp:mutagen_crystal`), `sp:mutagen_tank` (decorative glowing glass tank).

### HUD glyphs
`font/glyph_E7.png` (256×256, 16 px cells). Code points listed in `config.js` `GLYPH`.

## Testing
`python3 tests/bds_harness.py --bds <bedrock-server dir> --test-pack tests/sp_test_bp` boots a
dedicated server, loads both packs plus the GameTest pack, drives simulated players through every
ability via the `scriptevent sp:*` debug API and fails on content-log errors or failed assertions.
