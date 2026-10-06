// Test context helpers for the Superpowers & Mutants GameTest suite.
import { world, system, GameMode, ItemStack } from '@minecraft/server';
import * as gt from '@minecraft/server-gametest';

const pending = new Map(); // kind -> resolve[]

system.afterEvents.scriptEventReceive.subscribe(
  (ev) => {
    const kind = ev.id.slice('sp_test:'.length);
    const q = pending.get(kind);
    if (!q || !q.length) return;
    const resolve = q.shift();
    let payload;
    try {
      payload = JSON.parse(ev.message);
    } catch {
      payload = ev.message;
    }
    resolve(payload);
  },
  { namespaces: ['sp_test'] },
);

export const stats = { pass: 0, fail: 0, skip: 0 };

export class Ctx {
  constructor(suite, index) {
    this.suite = suite;
    this.dim = world.getDimension('overworld');
    // each suite gets its own clean area
    this.origin = { x: 200 * (index + 1) + 0.5, y: -60, z: 0.5 };
    this.players = [];
  }
  log(...a) {
    console.warn(`[SPTEST] ${this.suite}: ${a.join(' ')}`);
  }
  assert(cond, msg, detail) {
    if (cond) {
      stats.pass++;
      console.warn(`[SPTEST] PASS ${this.suite}: ${msg}`);
    } else {
      stats.fail++;
      console.warn(`[SPTEST] FAIL ${this.suite}: ${msg}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
    }
    return !!cond;
  }
  skip(msg) {
    stats.skip++;
    console.warn(`[SPTEST] SKIP ${this.suite}: ${msg}`);
  }
  wait(ticks) {
    return system.waitTicks(Math.max(1, Math.floor(ticks)));
  }
  at(dx, dy, dz) {
    return { x: this.origin.x + dx, y: this.origin.y + dy, z: this.origin.z + dz };
  }
  run(command) {
    try {
      return this.dim.runCommand(command).successCount;
    } catch (e) {
      this.log(`command failed: ${command} :: ${e}`);
      return 0;
    }
  }
  /** Send `scriptevent sp:<cmd> <args>` to the add-on and await its `sp_test:<cmd>` reply. */
  async sp(cmd, args, timeout = 40) {
    const reply = new Promise((resolve) => {
      if (!pending.has(cmd)) pending.set(cmd, []);
      pending.get(cmd).push(resolve);
      system.runTimeout(() => {
        const q = pending.get(cmd);
        const i = q ? q.indexOf(resolve) : -1;
        if (i >= 0) {
          q.splice(i, 1);
          resolve({ timeout: true });
        }
      }, timeout);
    });
    this.run(`scriptevent sp:${cmd} ${args}`);
    return reply;
  }
  dump(player) {
    return this.sp('dump', player.name);
  }
  /** Spawn a simulated player in this suite's area. */
  async player(name, dx = 0, dz = 0, mode = GameMode.Survival) {
    const loc = this.at(dx, 0, dz);
    this.run(`tickingarea add circle ${Math.floor(loc.x)} -60 ${Math.floor(loc.z)} 4 sp_${this.suite}_${name}`);
    await this.wait(10);
    const p = gt.spawnSimulatedPlayer({ dimension: this.dim, x: loc.x, y: loc.y, z: loc.z }, name, mode);
    this.players.push(p);
    await this.wait(10);
    return p;
  }
  /** Fill a box (relative to origin) with a block. */
  fill(a, b, block) {
    const A = this.at(...a), B = this.at(...b);
    return this.run(`fill ${Math.floor(A.x)} ${Math.floor(A.y)} ${Math.floor(A.z)} ${Math.floor(B.x)} ${Math.floor(B.y)} ${Math.floor(B.z)} ${block}`);
  }
  block(dx, dy, dz) {
    try {
      return this.dim.getBlock(this.at(dx, dy, dz));
    } catch {
      return undefined;
    }
  }
  spawn(type, dx, dy, dz) {
    return this.dim.spawnEntity(type, this.at(dx, dy, dz));
  }
  give(player, typeId, amount = 1) {
    player.getComponent('minecraft:inventory').container.addItem(new ItemStack(typeId, amount));
  }
  entities(type, radius = 40) {
    return this.dim.getEntities({ type, location: this.origin, maxDistance: radius });
  }
  async cleanup() {
    for (const p of this.players) {
      try {
        await this.sp('revoke', `${p.name} all`);
        p.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.players = [];
  }
}
