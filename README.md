# Superpowers & Mutants

A standalone superpower system for **Minecraft Bedrock Edition 26.3** and newer.
Inject mutagens, hold up to **three powers at once**, fly at supersonic speed, melt stone
with your eyes, slow time, hurl boulders and drag meteors out of the sky — then try to
survive the Rogue Mutants roaming the night.

Every power is built from scripts, physics, custom entities, particles, sounds and player
animations. **No potion effects are used.**

---

## Installation

1. Download `dist/Superpowers_and_Mutants.mcaddon` and open it (double-click on Windows /
   mobile "open with Minecraft"). Both the behavior pack and the resource pack are imported.
   Alternatively import the two `.mcpack` files from `dist/`.
2. Create or edit a world → **Behavior Packs** → activate **Superpowers & Mutants [Behavior]**
   (the resource pack is added automatically).
3. No experimental toggles are required. Cheats are **not** required to play
   (they are only needed for the optional operator commands).

> Requirements: Minecraft Bedrock 26.3 (internal 1.26.3) or newer. The add-on uses only stable
> APIs (`@minecraft/server` 2.5.0, `@minecraft/server-ui` 2.0.0) and has no external dependencies.

### Compatibility notes
* The behavior pack overrides `minecraft:player` to add a tag-driven damage sensor (fall, kinetic,
  projectile, explosion and fire immunities, Super Strength durability). Other add-ons that also
  replace `player.json` cannot both be active at the same time; whichever pack is higher in the
  list wins.
* Powers that destroy blocks respect the **"Powers can destroy and alter blocks"** world rule
  (Codex → Settings, operators). Containers, block entities and unbreakable blocks are never touched.
* PvP damage from powers follows both the `pvp` game rule and the Codex world rule.

---

## Getting powers

| Way | How |
|---|---|
| **Mutagen Syringes** | Use a *Super Strength / Flight / Heat Vision / Speedster / Esper Mutagen*. A confirmation screen shows the power; the injection takes under a second and returns an Empty Syringe. |
| **Unstable Mutagen** | Grants a random power you don't have yet. |
| **Mutant Codex** | The catalog item. *Power Archive → Acquire* (costs 15 XP levels by default; free in Creative; operators can make it free or disable it). |
| **Loot** | Mutagen Labs (rare surface bunkers) and Rogue Mutants drop serums and Mutagen Crystals. Meteorite blocks drop crystals. |

* You can hold **3 powers simultaneously**; all of them work together.
* The **Suppressor Serum** removes **all** powers. Single powers can be removed in
  *Codex → My Powers*.

## Controls

Every power gives you an **Emblem** (locked in your inventory, kept on death).

| Input (while holding an emblem) | Effect |
|---|---|
| **Use** (right-click / long-press) | Activate the selected ability. *Hold* abilities stay active while Use is held. |
| **Sneak + Use** | Switch to the next ability of that power. |

The action bar shows the power, the selected ability, its cooldown bar and live status
(speed, heat gauge, gear, held object…). Shortcuts that don't need the emblem:

* **Flight** — double-tap **Jump** in mid-air to take off / land.
* **Super Strength** — crouch for a moment, then **Jump** for a charged leap.
* **Heat Beam** — while firing, **Jump** / **Sneak** raises / lowers intensity.
* **Telekinesis** — while holding, **Jump** / **Sneak** pushes / pulls; **sneak while releasing**
  sets the object down instead of launching it.

## Powers

### Super Strength
*Passive:* 65 % damage reduction, punches deal huge damage and launch enemies into each other.
* **Charged Jump** (hold) — charge and leap up to ~40 blocks; the landing shockwave damages,
  launches and cracks the ground (craters at full charge). No fall damage.
* **Ground Destruction** — tear a boulder of real terrain out of the ground and lift it overhead;
  use again to hurl it. It shatters on impact, crushing mobs and blasting soft blocks.
* **Supersonic Charge** — burst forward through the sound barrier, plowing through mobs,
  glass, leaves and soft blocks.
* **Thunderclap** — a cone of concussive thunder that launches everything in front of you,
  shatters glass and leaves, snuffs fires and reverses projectiles.

### Flight
*Passive:* immune to fall and kinetic damage.
* **Take Off / Land** (toggle) — free 3D flight: look to steer, forward to fly, Jump/Sneak to
  rise/descend. The longer you keep flying forward, the faster you go (up to ~250 km/h) —
  sonic boom included. At speed you smash through glass and leaves, then soft blocks.
* **Afterburner** — instantly reach top speed.
* **Grab & Throw** — grab the creature in front of you, carry it at full speed and hurl it
  like a missile.

### Heat Vision
*Passive:* a heat gauge — firing heats your eyes; overheating forces a cooldown.
* **Heat Beam** (hold) — twin beams with light, sparks, smoke and sound. Aim freely; adjust
  intensity 1–5 while firing. Higher intensity = longer range, more damage and more
  destruction: ignite wood, melt sand to glass and ice to water, vaporise soft blocks (3),
  melt stone into magma (4), bore tunnels (5).
* **Focus Intensity** — choose the starting intensity.
* **Scorching Blast** — one overcharged blast that detonates on impact.

### Speedster
*Passive:* immune to kinetic damage.
* **Speed Force** (toggle) — super speed through 4 gears: keep sprinting to climb.
  Gear 2+: run on water and auto-dodge incoming projectiles. Gear 3+: bowl over mobs and
  fragile blocks. Gear 4: supersonic.
* **Time Dilation** (toggle, 10 s) — the world around you slows to a crawl: mobs move in slow
  motion and arrows hang in the air (they resume at full speed afterwards); you keep your speed.
* **Blitz Dash** — flash-step up to 24 blocks, striking everything on the path.

### Esper
* **Telekinesis** (hold) — seize mobs, players, dropped items or blocks; move them with your
  gaze; release to launch them with extreme force (or sneak to set them down — blocks are
  placed back into the world).
* **Levitation Field** — everything around you floats helplessly; use again to slam them down.
* **Psionic Barrier** (toggle, 10 s) — reflects projectiles back at their shooter and repels
  attackers.
* **Meteor Call** — mark a spot; a flaming meteor streaks in from the sky and devastates the area.

## Items & recipes

| Item | Use / recipe |
|---|---|
| Empty Syringe | Iron Nugget, Glass, Iron Ingot in a diagonal line (makes 2) |
| Mutagen Crystal | Amethyst Shard + Glowstone Dust + Slime Ball + Redstone, makes 2 (also from Meteorites, mutants, labs) |
| Power Mutagens | Empty Syringe + Mutagen Crystal + key ingredient (Strength: Iron Block · Flight: Phantom Membrane + Feather · Heat Vision: Blaze Rod + Magma Cream · Speedster: Sugar + Redstone Block · Esper: Eye of Ender + Amethyst Shard) |
| Unstable Mutagen | Empty Syringe + 3 Mutagen Crystals + Nether Wart |
| Suppressor Serum | Empty Syringe + Milk Bucket + Mutagen Crystal |
| Mutant Codex | Book + Mutagen Crystal + Ender Pearl |

## The Mutant Codex

Open it with Use. Sections: **My Powers** (choose each power's active ability, recover a lost
emblem, remove a power), **Power Archive** (details, controls, acquire), **Items & Serums**
(discovered items, how to obtain them), **Structures** (Mutagen Lab, Meteor Crash Site —
operators/creative can build them in front of them), **Bestiary**, **Field Guide** and
**Settings** (HUD, hints, screen effects, injection confirmation; operators: block destruction,
PvP, Codex acquisition cost/mode, mutant powers).

## World content
* **Rogue Mutants** — hostile failed test subjects that spawn in the dark. Four variants with
  their own powers: Brute (leap slam), Scorcher (heat beam), Blur (dash), Psion (telekinetic toss).
* **Mutagen Lab** — rare surface bunker with mutagen tanks and loot chests.
* **Meteor Crash Site** — scorched crater around Meteorite blocks.

## Operator commands
* `/sp:power add|remove|clear|list [power] [players]`
* `/sp:codex [players]` — give the Mutant Codex.

---

## Development

```
packs/SuperpowersBP   behavior pack (scripts in scripts/, see docs/ARCHITECTURE.md)
packs/SuperpowersRP   resource pack
tools/                generators (art, sounds, particles, structures), validate.py, build.py
tests/                Bedrock Dedicated Server harness + GameTest suite (simulated players)
```

* `npm install` then `npm run typecheck` — type-checks all scripts against the exact 2.5.0 API.
* `python3 tools/validate.py` — cross-checks every particle / sound / animation / texture /
  item / entity / lang reference.
* `python3 tools/build.py` — rebuilds the `.mcaddon` / `.mcpack` files in `dist/`.
* `python3 tests/bds_harness.py --bds <bedrock-server-1.26.3 dir> --test-pack tests/sp_test_bp`
  — boots a real dedicated server with the packs and runs the GameTest suite (the test pack
  needs the Beta APIs experiment, which the harness enables in its throw-away test world only).
