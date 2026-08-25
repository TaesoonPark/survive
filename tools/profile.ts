/**
 * Server tick profiler.
 *
 * Answers the question `tools/simulate.ts` cannot: what does a tick cost *in the shipping
 * server*, standing still versus sprinting into unexplored terrain? The distinction
 * matters because chunk streaming and one-time chunk population only happen while a
 * player moves, and a 200 ms hitch every time someone crosses a chunk border is a
 * shipping bug that an average-over-ten-thousand-ticks number hides completely.
 *
 * Takes `--players` because cost does not scale from one: every extra player is another
 * area of interest to diff, another streaming front loading its own chunks, and another
 * horde with its own navigation goal. A single-player profile is the *floor*, not the
 * answer - `tools/simulate.ts` at four players peaks over budget where one player never
 * comes close.
 *
 * ```bash
 * npx tsx tools/profile.ts --ticks 600 --speed 9
 * npx tsx tools/profile.ts --players 4                # the load that actually hurts
 * ```
 */
import { createGeneratedHeadlessServer } from '@survive/test-utils';

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const BUDGET_MS = 50;

function summarise(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const over = samples.filter((value) => value > BUDGET_MS).length;
  process.stdout.write(
    `${label.padEnd(16)} mean ${mean.toFixed(2).padStart(7)}ms   p50 ${at(0.5)
      .toFixed(2)
      .padStart(7)}ms   p95 ${at(0.95).toFixed(2).padStart(7)}ms   worst ${at(1)
      .toFixed(1)
      .padStart(7)}ms   over budget ${over}/${samples.length}\n`,
  );
}

async function main(): Promise<void> {
  const ticks = arg('ticks', 600);
  const speed = arg('speed', 9);
  const seed = arg('seed', 4242);
  const playerCount = Math.max(1, Math.floor(arg('players', 1)));

  const live = await createGeneratedHeadlessServer({ seed });

  // Spread out rather than stacked: players sharing one spot share one area of interest
  // and one set of chunks, which measures a crowd instead of a populated world.
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const joined = await live.server.joinPlayer(`profiler${i}`, `Profiler ${i}`);
    const angle = (i / playerCount) * Math.PI * 2;
    const spread = i === 0 ? 0 : 24 * 32;
    joined.player.x += Math.cos(angle) * spread;
    joined.player.y += Math.sin(angle) * spread;
    players.push(joined.player);
  }
  // Creatures come from the world's own spawn system as chunks populate, which is what a
  // real server's load looks like. Hand-placing a horde would measure a scenario the game
  // never actually produces.

  const tick = (): number => {
    const start = process.hrtime.bigint();
    live.server.tick();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  // Warm up: let the spawn ring settle so the first measurements are not startup cost.
  for (let i = 0; i < 60; i++) tick();

  const still: number[] = [];
  for (let i = 0; i < ticks; i++) still.push(tick());

  const moving: number[] = [];
  for (let i = 0; i < ticks; i++) {
    // Every player moves: one walker streaming chunks while three stand still is the
    // cheap case, and the expensive one is what needs measuring.
    for (const walker of players) walker.x += speed;
    moving.push(tick());
    if (i % 120 === 0) await live.server.settle();
  }

  process.stdout.write(
    `\nseed ${seed}, ${ticks} ticks each, ${speed}px/tick while moving, ` +
      `${playerCount} player(s)\n\n`,
  );
  summarise('standing still', still);
  summarise('sprinting', moving);

  const stats = live.server.stats();
  process.stdout.write(
    `\nchunks loaded ${stats.loadedChunks}   entities ${stats.entities}   ` +
      `travelled ${((ticks * speed) / 32).toFixed(0)} tiles\n`,
  );
  await live.stop();
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
