// Superpowers & Mutants - script entry point.
import { system } from '@minecraft/server';
import { registerInput } from './core/input.js';
import { startLoop } from './core/loop.js';
import { registerCommands, registerDebugEvents } from './core/commands.js';

// Shared world systems
import './features/debris.js';

// Powers (each module calls definePower on import)
import './powers/strength.js';
import './powers/flight.js';
import './powers/heat_vision.js';
import './powers/speedster.js';
import './powers/esper.js';

// Items, catalog, mobs, structures
import { registerItemComponents } from './features/items.js';
import { registerCodex } from './ui/codex.js';
import './features/mutant.js';
import './features/discovery.js';

system.beforeEvents.startup.subscribe((ev) => {
  registerItemComponents(ev.itemComponentRegistry);
  registerCommands(ev.customCommandRegistry);
});

registerInput();
registerDebugEvents();
registerCodex();
startLoop();

console.warn('[SP] Superpowers & Mutants loaded.');
