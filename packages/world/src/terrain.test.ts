import { describe, expect, it } from 'vitest';
import {
  Biome,
  CHUNK_TILES,
  CHUNK_TILE_COUNT,
  Tile,
  defaultWorldGenConfig,
  tileProps,
} from '@survive/protocol';
import type { WorldGenConfig } from '@survive/protocol';
import {
  ARTERIAL_PERIOD_CHUNKS,
  ARTERIAL_PERIOD_TILES,
  RoadAxis,
  SEA_LEVEL,
  TERRAIN_VERSION,
  TOWN_FARM_RING,
  TOWN_RADIUS,
  arterialTileFor,
  createTerrainGenerator,
  elevationAt,
  townSiteFor,
} from './terrain';
import type { TerrainGenerator } from './types';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const KNOWN_TILES = new Set<number>(Object.values(Tile));
const KNOWN_BIOMES = new Set<number>(Object.values(Biome));

const ROAD_TILES = new Set<number>([Tile.RoadAsphalt, Tile.RoadDirt, Tile.Sidewalk]);
const WATER_TILES = new Set<number>([Tile.WaterShallow, Tile.WaterDeep]);
const FLOOR_TILES = new Set<number>([Tile.FloorWood, Tile.FloorConcrete, Tile.FloorTile]);
/** Biomes the terrain layer owns outright: nothing man-made has overwritten them. */
const WILDERNESS_BIOMES = new Set<number>([
  Biome.Grassland,
  Biome.Forest,
  Biome.DeepForest,
  Biome.Rocky,
  Biome.Swamp,
]);

function config(overrides: Partial<WorldGenConfig> = {}): WorldGenConfig {
  return { ...defaultWorldGenConfig(20260824), ...overrides };
}

/**
 * A rectangle of tiles assembled from whole chunks.
 *
 * Tests that need neighbours (shore rings, flood fill) must not stop at a chunk edge, so
 * they work on a region and ignore its own one-tile border instead.
 */
interface Region {
  minTileX: number;
  minTileY: number;
  span: number;
  tiles: Int16Array;
  biomes: Int16Array;
}

function sampleRegion(
  generator: TerrainGenerator,
  minTileX: number,
  minTileY: number,
  span: number,
): Region {
  const tiles = new Int16Array(span * span);
  const biomes = new Int16Array(span * span);
  const firstCx = Math.floor(minTileX / CHUNK_TILES);
  const lastCx = Math.floor((minTileX + span - 1) / CHUNK_TILES);
  const firstCy = Math.floor(minTileY / CHUNK_TILES);
  const lastCy = Math.floor((minTileY + span - 1) / CHUNK_TILES);
  for (let cy = firstCy; cy <= lastCy; cy++) {
    for (let cx = firstCx; cx <= lastCx; cx++) {
      const chunk = generator.generate(cx, cy);
      for (let localY = 0; localY < CHUNK_TILES; localY++) {
        const y = cy * CHUNK_TILES + localY - minTileY;
        if (y < 0 || y >= span) continue;
        for (let localX = 0; localX < CHUNK_TILES; localX++) {
          const x = cx * CHUNK_TILES + localX - minTileX;
          if (x < 0 || x >= span) continue;
          tiles[y * span + x] = chunk.tiles[localY * CHUNK_TILES + localX]!;
          biomes[y * span + x] = chunk.biomes[localY * CHUNK_TILES + localX]!;
        }
      }
    }
  }
  return { minTileX, minTileY, span, tiles, biomes };
}

/** Four-neighbour indices of an interior cell. */
function neighbours(index: number, span: number): [number, number, number, number] {
  return [index - 1, index + 1, index - span, index + span];
}

function scatteredChunks(): Array<[number, number]> {
  return [
    [0, 0],
    [5, 7],
    [131, 42],
    [12, 200],
    [63, 63],
    [7, 5],
    [255, 255],
    [98, 3],
    [4, 61],
    [77, 77],
    [19, 143],
    [200, 12],
  ];
}

/**
 * Coarse search for the highest or lowest ground in a band of the world.
 *
 * Deep lakes and snow caps are both meant to be rare, so the tests that assert on them
 * go and find one rather than hoping some fixed chunk happens to contain it.
 */
function findExtremeElevation(
  seed: number,
  mode: 'lowest' | 'highest',
  fromTile: number,
  toTile: number,
): { tileX: number; tileY: number } {
  const step = 64;
  let bestX = fromTile;
  let bestY = fromTile;
  let best = mode === 'lowest' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let tileY = fromTile; tileY < toTile; tileY += step) {
    for (let tileX = fromTile; tileX < toTile; tileX += step) {
      const elevation = elevationAt(seed, tileX, tileY);
      if (mode === 'lowest' ? elevation < best : elevation > best) {
        best = elevation;
        bestX = tileX;
        bestY = tileY;
      }
    }
  }
  return { tileX: bestX, tileY: bestY };
}

/**
 * Coarse search for a window of the world holding both deep water and dry land.
 *
 * A fixed 128-tile window is a coin toss: it can land in the middle of a sea, or well
 * inland, and either way it never shows the land-to-deep-water transition the shore
 * rules are about.
 */
function findCoastline(seed: number, span: number): { tileX: number; tileY: number } {
  const step = 32;
  for (let tileY = 0; tileY < 4096; tileY += span / 2) {
    for (let tileX = 0; tileX < 4096; tileX += span / 2) {
      let lowest = Number.POSITIVE_INFINITY;
      let highest = Number.NEGATIVE_INFINITY;
      for (let y = tileY; y < tileY + span; y += step) {
        for (let x = tileX; x < tileX + span; x += step) {
          const elevation = elevationAt(seed, x, y);
          if (elevation < lowest) lowest = elevation;
          if (elevation > highest) highest = elevation;
        }
      }
      if (lowest < SEA_LEVEL - 0.03 && highest > SEA_LEVEL + 0.05) return { tileX, tileY };
    }
  }
  throw new Error('no coastline found');
}

/** First town whose whole built-up area is on dry land, searching outwards from an index. */
function findDryTownSite(
  generator: TerrainGenerator,
  seed: number,
  urbanization: number,
): { tileX: number; tileY: number } {
  for (let iy = 6; iy < 26; iy++) {
    for (let ix = 6; ix < 26; ix++) {
      const site = townSiteFor(seed, urbanization, ix, iy);
      if (site === null) continue;
      const radius = TOWN_RADIUS + 2;
      const region = sampleRegion(
        generator,
        site.tileX - radius,
        site.tileY - radius,
        radius * 2 + 1,
      );
      if (!region.tiles.includes(Tile.WaterDeep)) return site;
    }
  }
  throw new Error('no dry town site found');
}

// ---------------------------------------------------------------------------

describe('terrain generator contract', () => {
  it('reports its seed and version, and stamps the version on every chunk', () => {
    const generator = createTerrainGenerator(config({ seed: 4242 }));
    expect(generator.seed).toBe(4242);
    expect(generator.version).toBe(TERRAIN_VERSION);
    expect(generator.generate(3, 9).version).toBe(TERRAIN_VERSION);
  });

  it('returns exactly CHUNK_TILE_COUNT known tile and biome ids, row-major', () => {
    const generator = createTerrainGenerator(config({ urbanization: 0.5 }));
    for (const [cx, cy] of scatteredChunks()) {
      const chunk = generator.generate(cx, cy);
      expect(chunk.cx).toBe(cx);
      expect(chunk.cy).toBe(cy);
      expect(chunk.tiles).toHaveLength(CHUNK_TILE_COUNT);
      expect(chunk.biomes).toHaveLength(CHUNK_TILE_COUNT);
      for (let index = 0; index < CHUNK_TILE_COUNT; index++) {
        const tile = chunk.tiles[index];
        const biome = chunk.biomes[index];
        expect(KNOWN_TILES.has(tile as number)).toBe(true);
        expect(KNOWN_BIOMES.has(biome as number)).toBe(true);
        // Void is the "off the map" tile; generated terrain must never contain it.
        expect(tile).not.toBe(Tile.Void);
      }
    }
  });
});

describe('determinism', () => {
  it('produces identical chunks for the same (seed, cx, cy)', () => {
    const generator = createTerrainGenerator(config());
    const first = generator.generate(5, 7);
    const second = generator.generate(5, 7);
    expect(second.tiles).toEqual(first.tiles);
    expect(second.biomes).toEqual(first.biomes);

    const other = createTerrainGenerator(config());
    const third = other.generate(5, 7);
    expect(third.tiles).toEqual(first.tiles);
    expect(third.biomes).toEqual(first.biomes);
  });

  it('does not depend on the order chunks are generated in', () => {
    const forward = createTerrainGenerator(config({ urbanization: 0.6 }));
    const backward = createTerrainGenerator(config({ urbanization: 0.6 }));
    const coordinates = scatteredChunks();

    const seenForward = new Map<string, number[]>();
    for (const [cx, cy] of coordinates) {
      seenForward.set(`${cx},${cy}`, forward.generate(cx, cy).tiles);
    }

    // Reversed, and with unrelated chunks interleaved, so any hidden state or cache
    // priming would have to survive being fed a different history.
    const reversed = [...coordinates].reverse();
    for (const [cx, cy] of reversed) {
      backward.generate(cx + 1, cy + 1);
      const tiles = backward.generate(cx, cy).tiles;
      expect(tiles).toEqual(seenForward.get(`${cx},${cy}`));
    }
  });

  it('gives different seeds visibly different worlds', () => {
    const a = createTerrainGenerator(config({ seed: 1 })).generate(9, 9);
    const b = createTerrainGenerator(config({ seed: 2 })).generate(9, 9);
    let different = 0;
    for (let index = 0; index < CHUNK_TILE_COUNT; index++) {
      if (a.tiles[index] !== b.tiles[index]) different++;
    }
    expect(different).toBeGreaterThan(CHUNK_TILE_COUNT * 0.5);
  });

  it('answers biomeAt with exactly what generate wrote', () => {
    const generator = createTerrainGenerator(config({ seed: 88, urbanization: 0.6 }));
    for (const [cx, cy] of [
      [12, 19],
      [96, 96],
      [0, 0],
      [200, 143],
    ] as const) {
      const chunk = generator.generate(cx, cy);
      for (let localY = 0; localY < CHUNK_TILES; localY += 3) {
        for (let localX = 0; localX < CHUNK_TILES; localX += 3) {
          const expected = chunk.biomes[localY * CHUNK_TILES + localX];
          expect(generator.biomeAt(cx * CHUNK_TILES + localX, cy * CHUNK_TILES + localY)).toBe(
            expected,
          );
        }
      }
    }
  });
});

describe('water', () => {
  it('rings deep water with shallow water and shallow water with sand', () => {
    const seed = 7;
    const generator = createTerrainGenerator(config({ seed, urbanization: 0.3 }));
    const span = CHUNK_TILES * 6;
    // Deep water may only touch water, or a road bridging the shallows beside it.
    const allowedByDeep = new Set<number>([...WATER_TILES, ...ROAD_TILES]);
    let deepSeen = 0;
    let shallowSeen = 0;
    let sandSeen = 0;

    // A real coastline, plus a few fixed windows elsewhere so the invariants are also
    // checked over inland ground, rivers and town shorefronts.
    const coast = findCoastline(seed, span);
    for (const [originX, originY] of [
      [coast.tileX, coast.tileY],
      [1024, 512],
      [2048, 3072],
      [3072, 1024],
    ]) {
      const region = sampleRegion(generator, originX!, originY!, span);
      for (let y = 1; y < span - 1; y++) {
        for (let x = 1; x < span - 1; x++) {
          const index = y * span + x;
          const tile = region.tiles[index]!;
          if (tile === Tile.Sand) sandSeen++;
          if (tile === Tile.WaterShallow) shallowSeen++;
          if (tile === Tile.WaterDeep) {
            deepSeen++;
            for (const neighbour of neighbours(index, span)) {
              expect(allowedByDeep.has(region.tiles[neighbour]!)).toBe(true);
            }
          }
          // The shore rule is stronger than "no deep water on grass": no *untouched*
          // wilderness tile may sit next to any water at all - it would have been
          // turned into shore sand first.
          if (WILDERNESS_BIOMES.has(region.biomes[index]!)) {
            for (const neighbour of neighbours(index, span)) {
              expect(WATER_TILES.has(region.tiles[neighbour]!)).toBe(false);
            }
          }
        }
      }
    }

    expect(deepSeen).toBeGreaterThan(100);
    expect(shallowSeen).toBeGreaterThan(100);
    expect(sandSeen).toBeGreaterThan(100);
  });

  it('carves thin rivers above the waterline as well as lakes below it', () => {
    const generator = createTerrainGenerator(config({ seed: 31, urbanization: 0 }));
    const span = CHUNK_TILES * 8;
    const region = sampleRegion(generator, 1024, 2048, span);
    let river = 0;
    let runs = 0;
    for (let y = 0; y < span; y++) {
      let inRun = false;
      for (let x = 0; x < span; x++) {
        // Standing water on ground that is *above* sea level can only be a river.
        const wet = WATER_TILES.has(region.tiles[y * span + x]!);
        const uphill = elevationAt(31, region.minTileX + x, region.minTileY + y) > SEA_LEVEL + 0.02;
        if (wet && uphill) {
          river++;
          if (!inRun) runs++;
          inRun = true;
        } else {
          inRun = false;
        }
      }
    }
    expect(river).toBeGreaterThan(0);
    // Thin: rivers are channels, not floods.
    expect(river / (span * span)).toBeLessThan(0.08);
    expect(river / runs).toBeLessThan(25);
  });
});

describe('roads', () => {
  it('lays arterials at the expected chunk period, jittered per line', () => {
    const seed = 555;
    const generator = createTerrainGenerator(config({ seed, urbanization: 0 }));
    const centres: number[] = [];
    for (let index = 2; index < 10; index++) {
      const centre = arterialTileFor(seed, RoadAxis.Vertical, index);
      centres.push(centre);

      // The centre line of the arterial is asphalt for the whole height of a chunk,
      // except where it has to give way to deep water.
      const cx = Math.floor(centre / CHUNK_TILES);
      const chunk = generator.generate(cx, 40);
      const localX = centre - cx * CHUNK_TILES;
      let asphalt = 0;
      for (let localY = 0; localY < CHUNK_TILES; localY++) {
        const tile = chunk.tiles[localY * CHUNK_TILES + localX]!;
        expect(tile === Tile.RoadAsphalt || tile === Tile.WaterDeep).toBe(true);
        if (tile === Tile.RoadAsphalt) asphalt++;
      }
      expect(asphalt).toBeGreaterThan(0);
    }

    for (let i = 1; i < centres.length; i++) {
      const gap = centres[i]! - centres[i - 1]!;
      // Exactly one arterial per period, but never a perfect lattice.
      expect(gap).toBeGreaterThan(ARTERIAL_PERIOD_TILES * 0.5);
      expect(gap).toBeLessThan(ARTERIAL_PERIOD_TILES * 1.5);
    }
    expect(new Set(centres.map((c) => c % ARTERIAL_PERIOD_TILES)).size).toBeGreaterThan(1);
    expect(ARTERIAL_PERIOD_TILES).toBe(ARTERIAL_PERIOD_CHUNKS * CHUNK_TILES);
  });

  it('leaves the country between arterials empty of road', () => {
    const seed = 555;
    const generator = createTerrainGenerator(config({ seed, urbanization: 0 }));
    // A chunk whose whole tile range sits clear of every nearby arterial corridor.
    const midX = Math.round(
      (arterialTileFor(seed, RoadAxis.Vertical, 4) + arterialTileFor(seed, RoadAxis.Vertical, 5)) /
        2,
    );
    const midY = Math.round(
      (arterialTileFor(seed, RoadAxis.Horizontal, 4) +
        arterialTileFor(seed, RoadAxis.Horizontal, 5)) /
        2,
    );
    const chunk = generator.generate(
      Math.floor(midX / CHUNK_TILES),
      Math.floor(midY / CHUNK_TILES),
    );
    expect(chunk.biomes).not.toContain(Biome.Road);
  });

  it('never marks an unwalkable tile as road', () => {
    const generator = createTerrainGenerator(config({ seed: 12, urbanization: 0.7 }));
    let roadTiles = 0;
    for (let cy = 20; cy < 26; cy++) {
      for (let cx = 20; cx < 26; cx++) {
        const chunk = generator.generate(cx, cy);
        for (let index = 0; index < CHUNK_TILE_COUNT; index++) {
          if (chunk.biomes[index] !== Biome.Road) continue;
          roadTiles++;
          const tile = chunk.tiles[index]!;
          expect(ROAD_TILES.has(tile)).toBe(true);
          expect(tileProps(tile).solid).toBe(false);
          expect(tileProps(tile).deep).toBe(false);
        }
      }
    }
    expect(roadTiles).toBeGreaterThan(1000);
  });
});

describe('towns', () => {
  it('places no towns at urbanization 0 and more as it rises', () => {
    const seed = 909;
    const counts = [0, 0.3, 1].map((urbanization) => {
      const generator = createTerrainGenerator(config({ seed, urbanization }));
      let urban = 0;
      for (let cy = 0; cy < 110; cy++) {
        for (let cx = 0; cx < 110; cx++) {
          if (generator.isUrban(cx, cy)) urban++;
        }
      }
      return urban;
    });
    expect(counts[0]).toBe(0);
    expect(counts[1]!).toBeGreaterThan(0);
    expect(counts[2]!).toBeGreaterThan(counts[1]!);
  });

  it('writes no town tiles at all at urbanization 0', () => {
    const generator = createTerrainGenerator(config({ seed: 909, urbanization: 0 }));
    for (let cy = 6; cy < 14; cy++) {
      for (let cx = 6; cx < 14; cx++) {
        const chunk = generator.generate(cx, cy);
        expect(chunk.biomes).not.toContain(Biome.Town);
        expect(chunk.biomes).not.toContain(Biome.Farmland);
      }
    }
  });

  it('agrees between isUrban and the tiles it generates', () => {
    const urbanization = 1;
    const generator = createTerrainGenerator(config({ seed: 4242, urbanization }));
    const site = findDryTownSite(generator, 4242, urbanization);
    const cx = Math.floor(site.tileX / CHUNK_TILES);
    const cy = Math.floor(site.tileY / CHUNK_TILES);
    expect(generator.isUrban(cx, cy)).toBe(true);
    expect(generator.generate(cx, cy).biomes).toContain(Biome.Town);

    // Far enough out to be past the fields as well as the buildings.
    const outsideCx = cx + Math.ceil((TOWN_RADIUS + TOWN_FARM_RING + CHUNK_TILES) / CHUNK_TILES);
    expect(generator.isUrban(outsideCx, cy)).toBe(false);
  });

  it('builds houses with walls, windows, floors and fields', () => {
    const urbanization = 1;
    const generator = createTerrainGenerator(config({ seed: 4242, urbanization }));
    const site = findDryTownSite(generator, 4242, urbanization);
    const radius = TOWN_RADIUS + TOWN_FARM_RING;
    const region = sampleRegion(
      generator,
      site.tileX - radius,
      site.tileY - radius,
      radius * 2 + 1,
    );
    const counts = new Map<number, number>();
    for (const tile of region.tiles) counts.set(tile, (counts.get(tile) ?? 0) + 1);

    const walls =
      (counts.get(Tile.WallBrick) ?? 0) +
      (counts.get(Tile.WallConcrete) ?? 0) +
      (counts.get(Tile.WallWood) ?? 0);
    const floors = (counts.get(Tile.FloorWood) ?? 0) + (counts.get(Tile.FloorConcrete) ?? 0);
    const fields = (counts.get(Tile.FarmlandDry) ?? 0) + (counts.get(Tile.FarmlandWet) ?? 0);
    expect(walls).toBeGreaterThan(100);
    expect(floors).toBeGreaterThan(100);
    expect(counts.get(Tile.WindowStatic) ?? 0).toBeGreaterThan(10);
    expect(counts.get(Tile.RoadDirt) ?? 0).toBeGreaterThan(100);
    expect(fields).toBeGreaterThan(100);
  });

  it('leaves every building interior reachable from outside the town', () => {
    for (const seed of [4242, 31337, 20260824]) {
      const urbanization = 1;
      const generator = createTerrainGenerator(config({ seed, urbanization }));
      const site = findDryTownSite(generator, seed, urbanization);
      const radius = TOWN_RADIUS + TOWN_FARM_RING;
      const span = radius * 2 + 1;
      const region = sampleRegion(generator, site.tileX - radius, site.tileY - radius, span);
      const { tiles, biomes } = region;

      const enterable = (index: number): boolean => {
        const props = tileProps(tiles[index]!);
        return !props.solid && !props.deep;
      };

      // Start outside the built-up area, in the fields that wrap around it, and walk in.
      const reached = new Uint8Array(span * span);
      const queue: number[] = [];
      for (let index = 0; index < tiles.length; index++) {
        if (biomes[index] === Biome.Farmland && enterable(index)) {
          reached[index] = 1;
          queue.push(index);
        }
      }
      expect(queue.length).toBeGreaterThan(500);

      const visit = (next: number): void => {
        if (reached[next] || !enterable(next)) return;
        reached[next] = 1;
        queue.push(next);
      };
      for (let head = 0; head < queue.length; head++) {
        const index = queue[head]!;
        const x = index % span;
        const y = (index - x) / span;
        if (x > 0) visit(index - 1);
        if (x < span - 1) visit(index + 1);
        if (y > 0) visit(index - span);
        if (y < span - 1) visit(index + span);
      }

      let interiors = 0;
      const unreachable: string[] = [];
      for (let index = 0; index < tiles.length; index++) {
        if (!FLOOR_TILES.has(tiles[index]!)) continue;
        interiors++;
        if (!reached[index]) {
          unreachable.push(
            `${(index % span) + region.minTileX},${Math.floor(index / span) + region.minTileY}`,
          );
        }
      }
      expect(interiors).toBeGreaterThan(100);
      expect(unreachable).toEqual([]);
    }
  });
});

describe('biomes', () => {
  it('grows forests in patches rather than per-tile speckle', () => {
    const generator = createTerrainGenerator(config({ seed: 99, urbanization: 0 }));
    const span = CHUNK_TILES * 6;
    const region = sampleRegion(generator, 960, 960, span);
    const isForest = (biome: number): boolean =>
      biome === Biome.Forest || biome === Biome.DeepForest;
    let forest = 0;
    let sameNeighbours = 0;
    for (let y = 1; y < span - 1; y++) {
      for (let x = 1; x < span - 1; x++) {
        const index = y * span + x;
        if (!isForest(region.biomes[index]!)) continue;
        forest++;
        for (const neighbour of neighbours(index, span)) {
          if (isForest(region.biomes[neighbour]!)) sameNeighbours++;
        }
      }
    }
    expect(forest).toBeGreaterThan(2000);
    // Uncorrelated per-tile noise at this density would sit near the forest fraction
    // itself (well under 0.5); real patches keep almost every neighbour in the wood.
    expect(sameNeighbours / (forest * 4)).toBeGreaterThan(0.85);
  });

  it('covers the whole biome range across the world', () => {
    const generator = createTerrainGenerator(config({ seed: 20260824, urbanization: 0.4 }));
    const seen = new Set<number>();
    for (let cy = 4; cy < 250; cy += 23) {
      for (let cx = 4; cx < 250; cx += 23) {
        for (const biome of generator.generate(cx, cy).biomes) seen.add(biome);
      }
    }
    for (const biome of KNOWN_BIOMES) {
      expect(seen.has(biome)).toBe(true);
    }
  });

  it('caps the highest northern ground with snow, and only ever high ground', () => {
    const seed = 3;
    const generator = createTerrainGenerator(config({ seed, urbanization: 0 }));
    // The north is colder, so its snow line is the lowest in the world.
    const peak = findExtremeElevation(seed, 'highest', 0, 2048);
    const peakCx = Math.floor(peak.tileX / CHUNK_TILES);
    const peakCy = Math.floor(peak.tileY / CHUNK_TILES);

    let snow = 0;
    for (let cy = peakCy - 1; cy <= peakCy + 1; cy++) {
      for (let cx = peakCx - 1; cx <= peakCx + 1; cx++) {
        const chunk = generator.generate(cx, cy);
        for (let index = 0; index < CHUNK_TILE_COUNT; index++) {
          if (chunk.tiles[index] !== Tile.Snow) continue;
          snow++;
          const tileX = cx * CHUNK_TILES + (index % CHUNK_TILES);
          const tileY = cy * CHUNK_TILES + Math.floor(index / CHUNK_TILES);
          expect(elevationAt(seed, tileX, tileY)).toBeGreaterThan(0.6);
          expect(chunk.biomes[index]).toBe(Biome.Rocky);
        }
      }
    }
    expect(snow).toBeGreaterThan(0);
  });
});

describe('cost', () => {
  it('generates 200 distinct chunks well inside 3 seconds', () => {
    const generator = createTerrainGenerator(config({ urbanization: 0.35 }));
    const started = performance.now();
    let tiles = 0;
    for (let index = 0; index < 200; index++) {
      const chunk = generator.generate(40 + (index % 20), 60 + Math.floor(index / 20));
      tiles += chunk.tiles.length;
    }
    const elapsed = performance.now() - started;
    expect(tiles).toBe(200 * CHUNK_TILE_COUNT);
    expect(elapsed).toBeLessThan(3000);
  });

  it('answers point queries without generating a chunk', () => {
    const generator = createTerrainGenerator(config({ urbanization: 0.35 }));
    // 500 chunks' worth of generation would be several seconds; these budgets are only
    // reachable if biomeAt and isUrban really do sample the fields directly.
    const biomeStart = performance.now();
    for (let index = 0; index < 500; index++) generator.biomeAt(index * 37, index * 53);
    expect(performance.now() - biomeStart).toBeLessThan(500);

    const urbanStart = performance.now();
    for (let index = 0; index < 5000; index++) generator.isUrban(index % 300, (index * 7) % 300);
    expect(performance.now() - urbanStart).toBeLessThan(500);
  });
});
