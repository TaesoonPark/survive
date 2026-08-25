#!/usr/bin/env tsx
/**
 * Terrain preview.
 *
 * Prints a region of generated world as coloured text, so a change to generation can be
 * eyeballed in a second without starting a server or a client.
 *
 * ```bash
 * npx tsx tools/worldgen.ts --seed 1337 --cx 128 --cy 128 --chunks 3
 * npx tsx tools/worldgen.ts --urbanization 0.6 --chunks 4   # go looking for a town
 * ```
 */
import { CHUNK_TILES, Tile, defaultWorldGenConfig, tileProps } from '@survive/protocol';
import { createTerrainGenerator } from '@survive/world';

/** One character and one ANSI colour per tile, chosen so the shapes read at a glance. */
const GLYPH: Record<number, [string, number]> = {
  [Tile.Void]: [' ', 0],
  [Tile.Grass]: ['.', 32],
  [Tile.GrassTall]: [',', 92],
  [Tile.Dirt]: ['-', 33],
  [Tile.Mud]: ['~', 33],
  [Tile.Sand]: [':', 93],
  [Tile.Gravel]: ['%', 37],
  [Tile.StoneGround]: ['+', 90],
  [Tile.WaterShallow]: ['w', 36],
  [Tile.WaterDeep]: ['W', 34],
  [Tile.RoadAsphalt]: ['=', 90],
  [Tile.RoadDirt]: ['_', 33],
  [Tile.Sidewalk]: [';', 37],
  [Tile.FloorWood]: ['f', 33],
  [Tile.FloorTile]: ['f', 37],
  [Tile.FloorConcrete]: ['f', 90],
  [Tile.FarmlandDry]: ['a', 33],
  [Tile.FarmlandWet]: ['A', 33],
  [Tile.Snow]: ['*', 97],
  [Tile.Ice]: ['i', 96],
  [Tile.Ash]: ['^', 90],
  [Tile.Rubble]: ['x', 90],
  [Tile.WallBrick]: ['#', 31],
  [Tile.WallConcrete]: ['#', 37],
  [Tile.WallWood]: ['#', 33],
  [Tile.Cliff]: ['@', 90],
  [Tile.TreeTrunkStatic]: ['T', 32],
  [Tile.WindowStatic]: ['o', 96],
};

const ESC = String.fromCharCode(27);

function colourise(glyph: string, colour: number): string {
  return colour === 0 ? glyph : `${ESC}[${colour}m${glyph}${ESC}[0m`;
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const seed = arg('seed', 20260824);
const centreCx = arg('cx', 128);
const centreCy = arg('cy', 128);
const chunks = Math.max(1, Math.min(8, arg('chunks', 2)));
const urbanization = arg('urbanization', -1);

const config = defaultWorldGenConfig(seed);
if (urbanization >= 0) config.urbanization = urbanization;
const generator = createTerrainGenerator(config);

const half = Math.floor(chunks / 2);
const minCx = centreCx - half;
const minCy = centreCy - half;

const started = process.hrtime.bigint();
const grid: number[][] = [];
for (let cy = minCy; cy < minCy + chunks; cy++) {
  const rows: number[][] = Array.from({ length: CHUNK_TILES }, () => []);
  for (let cx = minCx; cx < minCx + chunks; cx++) {
    const terrain = generator.generate(cx, cy);
    for (let localY = 0; localY < CHUNK_TILES; localY++) {
      for (let localX = 0; localX < CHUNK_TILES; localX++) {
        rows[localY]!.push(terrain.tiles[localY * CHUNK_TILES + localX] ?? Tile.Void);
      }
    }
  }
  grid.push(...rows);
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

const counts = new Map<number, number>();
for (const row of grid) {
  let line = '';
  for (const tile of row) {
    counts.set(tile, (counts.get(tile) ?? 0) + 1);
    const entry = GLYPH[tile] ?? ['?', 35];
    line += colourise(entry[0], entry[1]);
  }
  process.stdout.write(`${line}\n`);
}

const total = grid.length * (grid[0]?.length ?? 0);
process.stdout.write(
  `\nseed ${seed}  chunks (${minCx},${minCy})..(${minCx + chunks - 1},${minCy + chunks - 1})  ` +
    `${total} tiles in ${elapsedMs.toFixed(0)}ms  urbanization ${config.urbanization}\n`,
);
const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [tile, count] of ranked) {
  const name = Object.entries(Tile).find(([, value]) => value === tile)?.[0] ?? String(tile);
  const props = tileProps(tile);
  process.stdout.write(
    `  ${name.padEnd(18)} ${String(count).padStart(6)}  ${((count / total) * 100).toFixed(1)}%` +
      `${props.solid ? '  solid' : ''}${props.water ? '  water' : ''}\n`,
  );
}
