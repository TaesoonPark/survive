#!/usr/bin/env tsx
/**
 * Headless simulation runner (spec section 34).
 *
 * Runs the real game rules for as many ticks as you ask, with no server, no renderer and
 * no waiting on real time, then prints what happened. It is the fastest way to answer
 * "does the world still work after ten thousand ticks", and the profiler for the
 * simulation's cost per tick.
 *
 * ```bash
 * npx tsx tools/simulate.ts --ticks 10000 --players 4 --zombies 40 --generated
 * ```
 */
import { SIM_HZ, TICKS_PER_GAME_DAY, type SimEvent, type SimEventType } from '@survive/protocol';
import {
  createGeneratedTestSimulation,
  createTestSimulation,
  type TestSimulation,
} from '@survive/test-utils';

interface Options {
  ticks: number;
  players: number;
  zombies: number;
  animals: number;
  seed: number;
  generated: boolean;
  /** Print a state summary every N ticks. 0 disables it. */
  every: number;
  /** Show the N most common event types. */
  topEvents: number;
  quiet: boolean;
}

function parse(argv: readonly string[]): Options {
  const get = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    ticks: get('ticks', TICKS_PER_GAME_DAY),
    players: get('players', 1),
    zombies: get('zombies', 20),
    animals: get('animals', 10),
    seed: get('seed', 20260824),
    generated: argv.includes('--generated'),
    every: get('every', 0),
    topEvents: get('topEvents', 12),
    quiet: argv.includes('--quiet'),
  };
}

function summarise(sim: TestSimulation): Record<string, number> {
  const state = sim.sim.state;
  return {
    tick: state.tick,
    day: state.time.day,
    players: Object.keys(state.players).length,
    zombies: Object.keys(state.zombies).length,
    animals: Object.keys(state.animals).length,
    items: Object.keys(state.items).length,
    projectiles: Object.keys(state.projectiles).length,
    structures: Object.keys(state.structures).length,
    nodes: Object.keys(state.nodes).length,
    chunks: Object.keys(state.chunks).length,
  };
}

function table(rows: Record<string, string | number>): string {
  const width = Math.max(...Object.keys(rows).map((key) => key.length));
  return Object.entries(rows)
    .map(([key, value]) => `  ${key.padEnd(width)}  ${value}`)
    .join('\n');
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const log = options.quiet ? () => {} : (line: string) => process.stdout.write(`${line}\n`);

  log(`survive: headless simulation`);
  log(
    table({
      ticks: options.ticks,
      'in-game time': `${(options.ticks / SIM_HZ / 60).toFixed(1)} real minutes of simulation`,
      seed: options.seed,
      world: options.generated ? 'generated terrain' : 'flat test plain',
      players: options.players,
    }),
  );
  log('');

  const sim = options.generated
    ? createGeneratedTestSimulation({ seed: options.seed })
    : createTestSimulation({ seed: options.seed });

  for (let i = 0; i < options.players; i++) {
    sim.addPlayer({ id: `p${i + 1}`, name: `Player ${i + 1}`, withKit: true });
  }
  for (let i = 0; i < options.zombies; i++) {
    const angle = (i / Math.max(1, options.zombies)) * Math.PI * 2;
    sim.spawnZombie(
      'walker',
      sim.spawn.x + Math.cos(angle) * 320,
      sim.spawn.y + Math.sin(angle) * 320,
    );
  }
  for (let i = 0; i < options.animals; i++) {
    const angle = (i / Math.max(1, options.animals)) * Math.PI * 2;
    sim.spawnAnimal(
      'rabbit',
      sim.spawn.x + Math.cos(angle) * 480,
      sim.spawn.y + Math.sin(angle) * 480,
    );
  }

  log('initial state:');
  log(table(summarise(sim)));
  log('');

  const eventCounts = new Map<SimEventType, number>();
  // Every tick's cost, not just the worst. A single 52ms tick in three thousand is a
  // startup artefact; the same number recurring is a stutter players would feel, and a
  // lone peak cannot tell you which one you have.
  const stepTimes: number[] = [];
  let peakStepMs = 0;
  const started = process.hrtime.bigint();
  let lastReport = 0;

  for (let tick = 0; tick < options.ticks; tick++) {
    const stepStart = process.hrtime.bigint();
    const events: SimEvent[] = sim.step(1);
    const stepMs = Number(process.hrtime.bigint() - stepStart) / 1e6;
    stepTimes.push(stepMs);
    if (stepMs > peakStepMs) peakStepMs = stepMs;
    for (const event of events) {
      eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    }
    // Events accumulate in the harness forever; drop them so a long run does not grow
    // without bound.
    sim.clearEvents();

    if (options.every > 0 && tick - lastReport >= options.every) {
      lastReport = tick;
      log(`tick ${sim.sim.state.tick}: ${JSON.stringify(summarise(sim))}`);
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const perTick = elapsedMs / Math.max(1, options.ticks);
  const budgetMs = 1000 / SIM_HZ;
  const sortedSteps = [...stepTimes].sort((a, b) => a - b);
  const percentile = (q: number): number =>
    sortedSteps[Math.min(sortedSteps.length - 1, Math.floor(sortedSteps.length * q))] ?? 0;
  const overBudget = stepTimes.filter((ms) => ms > budgetMs).length;

  log('final state:');
  log(table(summarise(sim)));
  log('');

  log('performance:');
  log(
    table({
      'wall clock': `${elapsedMs.toFixed(0)} ms`,
      'per tick': `${perTick.toFixed(3)} ms`,
      'p95 tick': `${percentile(0.95).toFixed(3)} ms`,
      'p99 tick': `${percentile(0.99).toFixed(3)} ms`,
      'peak tick': `${peakStepMs.toFixed(3)} ms`,
      'over budget': `${overBudget}/${stepTimes.length} ticks over ${budgetMs.toFixed(0)}ms`,
      // The budget at 20 Hz is 50 ms; anything approaching it will not hold up with
      // players connected.
      headroom: `${((1 - perTick / (1000 / SIM_HZ)) * 100).toFixed(1)}% of the ${(
        1000 / SIM_HZ
      ).toFixed(0)}ms budget spare`,
      'real-time factor': `${(options.ticks / SIM_HZ / (elapsedMs / 1000)).toFixed(0)}x`,
    }),
  );
  log('');

  const ranked = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, options.topEvents);
  if (ranked.length > 0) {
    log(`events (top ${ranked.length}):`);
    log(table(Object.fromEntries(ranked)));
    log('');
  }

  for (const player of Object.values(sim.sim.state.players)) {
    log(
      `${player.name}: health ${player.health.toFixed(0)}, hunger ${player.hunger.toFixed(
        0,
      )}, thirst ${player.thirst.toFixed(0)}, fatigue ${player.fatigue.toFixed(0)}, ${
        player.alive ? 'alive' : `dead (${player.deathCause ?? 'unknown'})`
      }`,
    );
  }

  // A run that ends with a NaN anywhere is a failure even if nothing threw.
  const serialized = JSON.stringify(sim.sim.state);
  if (serialized.includes('null') && serialized.includes('NaN')) {
    process.stderr.write('FAIL: simulation state contains NaN\n');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
