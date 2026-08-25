import { describe, expect, it } from 'vitest';
import {
  Biome,
  CHUNK_TILES,
  Tile,
  chunkKey,
  pixelToChunk,
  type ChunkRuntimeState,
} from '@survive/protocol';
import type { WorldService } from '@survive/world';
import { createFlatWorld, createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { ensureChunkRuntime } from '../../core/queries';
import {
  activityForDistance,
  animalTargets,
  chunkBiomeFractions,
  createChunkPopulationSystem,
  findRooms,
  nodeTargets,
  populateChunk,
  requestChunkLoad,
  surveyChunk,
} from './chunkPopulation';

/**
 * Chunk population.
 *
 * The property that matters most here is not "how many trees" but "the same trees":
 * a chunk's generated contents must be a pure function of `(seed, cx, cy)`, so two
 * fresh worlds on one seed agree tile for tile, and the order the player wandered
 * around in cannot change what they find. Most of what follows is that claim, poked
 * from several directions.
 *
 * Tests populate chunks a long way from spawn on purpose: the harness pre-installs the
 * ring around the player, and it flattens the ground under their feet, so a chunk out
 * at (200, 200) is the only place to watch generation happen from a clean start.
 */

/** A chunk nowhere near the spawn ring, so nothing has touched it. */
const FAR = { cx: 200, cy: 200 } as const;
const OTHER = { cx: 201, cy: 200 } as const;

interface Placed {
  defId: string;
  tileX: number;
  tileY: number;
  variant: number;
}

function nodesIn(sim: TestSimulation, cx: number, cy: number): Placed[] {
  return Object.values(sim.sim.state.nodes)
    .filter(
      (node) =>
        Math.floor(node.tileX / CHUNK_TILES) === cx && Math.floor(node.tileY / CHUNK_TILES) === cy,
    )
    .map((node) => ({
      defId: node.defId,
      tileX: node.tileX,
      tileY: node.tileY,
      variant: node.variant,
    }))
    .sort((a, b) => a.tileY - b.tileY || a.tileX - b.tileX || (a.defId < b.defId ? -1 : 1));
}

function animalsIn(sim: TestSimulation, cx: number, cy: number): string[] {
  return Object.values(sim.sim.state.animals)
    .filter((animal) => animal.homeChunk === chunkKey(cx, cy))
    .map((animal) => `${animal.defId}@${animal.x.toFixed(3)},${animal.y.toFixed(3)}`)
    .sort();
}

function structuresIn(sim: TestSimulation, cx: number, cy: number) {
  return Object.values(sim.sim.state.structures).filter(
    (structure) =>
      Math.floor(structure.tileX / CHUNK_TILES) === cx &&
      Math.floor(structure.tileY / CHUNK_TILES) === cy,
  );
}

interface Fixture {
  sim: TestSimulation;
  populate(cx: number, cy: number): ChunkRuntimeState;
}

function fixture(
  options: {
    seed?: number;
    resourceDensity?: number;
    animalDensity?: number;
    world?: WorldService;
    withSystem?: boolean;
  } = {},
): Fixture {
  const sim = createTestSimulation({
    seed: options.seed ?? 4242,
    world: options.world,
    // Real generation is the subject; flattening would delete the very nodes under test.
    flattenSpawn: false,
    systems: options.withSystem ? [createChunkPopulationSystem()] : [],
    config: (config) => {
      if (options.resourceDensity !== undefined) {
        config.world.resourceDensity = options.resourceDensity;
      }
      if (options.animalDensity !== undefined) config.world.animalDensity = options.animalDensity;
    },
  });
  return {
    sim,
    populate(cx, cy) {
      const runtime = ensureChunkRuntime(sim.sim.state, cx, cy);
      populateChunk(sim.ctx, runtime);
      return runtime;
    },
  };
}

/** A flat world that claims to be a town, for the urban-only loot profiles. */
function urbanFlatWorld(seed: number): WorldService {
  const world = createFlatWorld({ seed });
  return { ...world, generator: { ...world.generator, isUrban: () => true } };
}

describe('generating a chunk', () => {
  it('places resource nodes appropriate to the biome', () => {
    const fix = fixture();
    fix.populate(FAR.cx, FAR.cy);

    const placed = nodesIn(fix.sim, FAR.cx, FAR.cy);
    expect(placed.length).toBeGreaterThan(0);
    // The flat test world is entirely grassland; nothing that only grows in a town or
    // a lake has any business here.
    for (const node of placed) {
      const def = fix.sim.data.nodes.require(node.defId);
      expect(def.spawnBiomes[Biome.Grassland] ?? 0).toBeGreaterThan(0);
    }
  });

  it('marks the chunk populated and dirty, and is idempotent', () => {
    const fix = fixture();
    const runtime = fix.populate(FAR.cx, FAR.cy);
    expect(runtime.populated).toBe(true);
    expect(runtime.dirty).toBe(true);

    const once = nodesIn(fix.sim, FAR.cx, FAR.cy);
    // A second pass over an already-populated chunk must add nothing: this is the
    // guard that stops a chunk doubling its forest every time it is re-simulated.
    populateChunk(fix.sim.ctx, runtime);
    expect(nodesIn(fix.sim, FAR.cx, FAR.cy)).toEqual(once);
  });

  it('keeps every node inside the chunk it belongs to', () => {
    const fix = fixture();
    fix.populate(FAR.cx, FAR.cy);
    for (const node of nodesIn(fix.sim, FAR.cx, FAR.cy)) {
      expect(node.tileX).toBeGreaterThanOrEqual(FAR.cx * CHUNK_TILES);
      expect(node.tileX).toBeLessThan((FAR.cx + 1) * CHUNK_TILES);
      expect(node.tileY).toBeGreaterThanOrEqual(FAR.cy * CHUNK_TILES);
      expect(node.tileY).toBeLessThan((FAR.cy + 1) * CHUNK_TILES);
    }
  });

  it('never stacks two nodes on one tile', () => {
    const fix = fixture({ resourceDensity: 4 });
    fix.populate(FAR.cx, FAR.cy);

    const tiles = nodesIn(fix.sim, FAR.cx, FAR.cy).map((node) => `${node.tileX},${node.tileY}`);
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it('never places a node on solid ground', () => {
    const fix = fixture({ resourceDensity: 3 });
    // A river of concrete straight through the chunk.
    for (let ly = 0; ly < CHUNK_TILES; ly++) {
      fix.sim.world.setTile(
        FAR.cx * CHUNK_TILES + 10,
        FAR.cy * CHUNK_TILES + ly,
        Tile.WallConcrete,
      );
    }
    fix.populate(FAR.cx, FAR.cy);

    for (const node of nodesIn(fix.sim, FAR.cx, FAR.cy)) {
      expect(node.tileX).not.toBe(FAR.cx * CHUNK_TILES + 10);
    }
  });

  it('leaves a tile that already carries a structure alone', () => {
    const fix = fixture({ resourceDensity: 4 });
    const tileX = FAR.cx * CHUNK_TILES + 5;
    const tileY = FAR.cy * CHUNK_TILES + 5;
    fix.sim.placeStructure('storage_box', tileX, tileY);

    fix.populate(FAR.cx, FAR.cy);
    for (const node of nodesIn(fix.sim, FAR.cx, FAR.cy)) {
      expect(`${node.tileX},${node.tileY}`).not.toBe(`${tileX},${tileY}`);
    }
  });

  it('leaves a tile that already carries a node alone', () => {
    const fix = fixture({ resourceDensity: 4 });
    const tileX = FAR.cx * CHUNK_TILES + 7;
    const tileY = FAR.cy * CHUNK_TILES + 7;
    fix.sim.placeNode('tree_oak', tileX, tileY);

    fix.populate(FAR.cx, FAR.cy);
    const here = nodesIn(fix.sim, FAR.cx, FAR.cy).filter(
      (node) => node.tileX === tileX && node.tileY === tileY,
    );
    expect(here).toHaveLength(1);
  });

  it('places the initial animal population', () => {
    const fix = fixture();
    fix.populate(FAR.cx, FAR.cy);

    expect(animalsIn(fix.sim, FAR.cx, FAR.cy).length).toBeGreaterThan(0);
    expect(fix.sim.eventsOf('animalSpawned').length).toBeGreaterThan(0);
  });

  it('gives every generated animal a full-health, thinking body', () => {
    const fix = fixture();
    fix.populate(FAR.cx, FAR.cy);
    const animals = Object.values(fix.sim.sim.state.animals);
    expect(animals.length).toBeGreaterThan(0);
    for (const animal of animals) {
      const def = fix.sim.data.animals.require(animal.defId);
      expect(animal.health).toBe(def.maxHealth);
      expect(animal.ai).toBe('idle');
      expect(animal.wanderX).toBe(animal.x);
      expect(animal.homeChunk).toBe(chunkKey(FAR.cx, FAR.cy));
    }
  });
});

describe('determinism', () => {
  it('gives two fresh worlds on one seed identical nodes', () => {
    const a = fixture({ seed: 31337 });
    const b = fixture({ seed: 31337 });
    a.populate(FAR.cx, FAR.cy);
    b.populate(FAR.cx, FAR.cy);

    expect(nodesIn(a.sim, FAR.cx, FAR.cy)).toEqual(nodesIn(b.sim, FAR.cx, FAR.cy));
    expect(nodesIn(a.sim, FAR.cx, FAR.cy).length).toBeGreaterThan(0);
  });

  it('gives two fresh worlds on one seed identical animals', () => {
    const a = fixture({ seed: 31337 });
    const b = fixture({ seed: 31337 });
    a.populate(FAR.cx, FAR.cy);
    b.populate(FAR.cx, FAR.cy);

    expect(animalsIn(a.sim, FAR.cx, FAR.cy)).toEqual(animalsIn(b.sim, FAR.cx, FAR.cy));
  });

  it('does not depend on the order the chunks were first visited', () => {
    const forwards = fixture({ seed: 99 });
    forwards.populate(FAR.cx, FAR.cy);
    forwards.populate(OTHER.cx, OTHER.cy);

    const backwards = fixture({ seed: 99 });
    backwards.populate(OTHER.cx, OTHER.cy);
    backwards.populate(FAR.cx, FAR.cy);

    expect(nodesIn(forwards.sim, FAR.cx, FAR.cy)).toEqual(nodesIn(backwards.sim, FAR.cx, FAR.cy));
    expect(nodesIn(forwards.sim, OTHER.cx, OTHER.cy)).toEqual(
      nodesIn(backwards.sim, OTHER.cx, OTHER.cy),
    );
  });

  it('does not depend on how much of the world was walked first', () => {
    const alone = fixture({ seed: 555 });
    alone.populate(FAR.cx, FAR.cy);

    const busy = fixture({ seed: 555 });
    // A long detour that draws plenty from the master RNG before arriving.
    for (let i = 1; i <= 6; i++) busy.populate(FAR.cx - i, FAR.cy + i);
    busy.populate(FAR.cx, FAR.cy);

    expect(nodesIn(busy.sim, FAR.cx, FAR.cy)).toEqual(nodesIn(alone.sim, FAR.cx, FAR.cy));
  });

  it('gives neighbouring chunks different contents, so the salt is doing work', () => {
    const fix = fixture({ seed: 8 });
    fix.populate(FAR.cx, FAR.cy);
    fix.populate(OTHER.cx, OTHER.cy);

    const here = nodesIn(fix.sim, FAR.cx, FAR.cy).map((node) => `${node.defId}@${node.tileX % 32}`);
    const there = nodesIn(fix.sim, OTHER.cx, OTHER.cy).map(
      (node) => `${node.defId}@${node.tileX % 32}`,
    );
    expect(here).not.toEqual(there);
  });

  it('gives different seeds different worlds', () => {
    const a = fixture({ seed: 1 });
    const b = fixture({ seed: 2 });
    a.populate(FAR.cx, FAR.cy);
    b.populate(FAR.cx, FAR.cy);
    expect(nodesIn(a.sim, FAR.cx, FAR.cy)).not.toEqual(nodesIn(b.sim, FAR.cx, FAR.cy));
  });
});

describe('density knobs', () => {
  it('generates nothing at all at resourceDensity 0', () => {
    const fix = fixture({ resourceDensity: 0 });
    fix.populate(FAR.cx, FAR.cy);
    expect(nodesIn(fix.sim, FAR.cx, FAR.cy)).toEqual([]);
  });

  it('scales node counts with resourceDensity', () => {
    const countAt = (density: number): number => {
      const fix = fixture({ seed: 2024, resourceDensity: density });
      fix.populate(FAR.cx, FAR.cy);
      return nodesIn(fix.sim, FAR.cx, FAR.cy).length;
    };
    const plain = countAt(1);
    expect(plain).toBeGreaterThan(0);
    expect(countAt(3)).toBeGreaterThan(plain);
    expect(countAt(0.25)).toBeLessThan(plain);
  });

  it('scales animal counts with animalDensity', () => {
    const countAt = (density: number): number => {
      const fix = fixture({ seed: 2024, animalDensity: density });
      fix.populate(FAR.cx, FAR.cy);
      return animalsIn(fix.sim, FAR.cx, FAR.cy).length;
    };
    expect(countAt(0)).toBe(0);
    expect(countAt(5)).toBeGreaterThan(countAt(1));
  });

  it('reports node targets that follow the biome weights', () => {
    const fix = fixture();
    const grassland = nodeTargets(fix.sim.ctx, new Map([[Biome.Grassland, 1]]));
    const forest = nodeTargets(fix.sim.ctx, new Map([[Biome.Forest, 1]]));

    const pineIn = (list: ReturnType<typeof nodeTargets>) =>
      list.find((entry) => entry.def.id === 'tree_pine')?.target ?? 0;
    // Pines are incidental in a meadow and the point of a forest.
    expect(pineIn(forest)).toBeGreaterThan(pineIn(grassland));
  });

  it('reports animal targets that follow the biome weights', () => {
    const fix = fixture();
    const targets = animalTargets(fix.sim.ctx, new Map([[Biome.Grassland, 1]]));
    expect(targets.length).toBeGreaterThan(0);
    for (const entry of targets) expect(entry.target).toBeGreaterThan(0);
  });

  it('samples a chunk s biome mix cheaply and correctly', () => {
    const fix = fixture();
    const fractions = chunkBiomeFractions(fix.sim.world, FAR.cx, FAR.cy);
    expect(fractions.get(Biome.Grassland)).toBe(1);
    let total = 0;
    for (const fraction of fractions.values()) total += fraction;
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('lootable containers in buildings', () => {
  /** Paint a room of interior floor inside the far chunk. */
  function paintRoom(fix: Fixture, tile: number, size = 5, originX = 4, originY = 4): void {
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        fix.sim.world.setTile(
          FAR.cx * CHUNK_TILES + originX + dx,
          FAR.cy * CHUNK_TILES + originY + dy,
          tile,
        );
      }
    }
  }

  it('furnishes a room with lootable storage', () => {
    const fix = fixture();
    paintRoom(fix, Tile.FloorWood);
    fix.populate(FAR.cx, FAR.cy);

    const containers = structuresIn(fix.sim, FAR.cx, FAR.cy).filter(
      (structure) => structure.container?.lootTableId !== undefined,
    );
    expect(containers.length).toBeGreaterThan(0);
    for (const structure of containers) {
      expect(fix.sim.data.structures.require(structure.defId).container).toBeDefined();
      expect(fix.sim.data.lootTables.has(structure.container?.lootTableId ?? '')).toBe(true);
    }
  });

  it('leaves the loot unrolled for the inventory system to roll on first open', () => {
    const fix = fixture();
    paintRoom(fix, Tile.FloorTile);
    fix.populate(FAR.cx, FAR.cy);

    const containers = structuresIn(fix.sim, FAR.cx, FAR.cy).filter(
      (structure) => structure.container?.lootTableId !== undefined,
    );
    expect(containers.length).toBeGreaterThan(0);
    for (const structure of containers) {
      expect(structure.container?.rolled).toBe(false);
      // Nothing inside yet: `lootAbundance` should apply when it is opened, not now.
      expect(structure.container?.slots.every((slot) => slot === null)).toBe(true);
    }
  });

  it('chooses the loot table from what the floor says the room is', () => {
    const tablesFor = (tile: number): Set<string> => {
      const fix = fixture({ seed: 616 });
      // Several rooms, so the weighted pick gets a fair sample.
      for (let i = 0; i < 4; i++) {
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            fix.sim.world.setTile(
              FAR.cx * CHUNK_TILES + 2 + i * 6 + dx,
              FAR.cy * CHUNK_TILES + 2 + dy,
              tile,
            );
          }
        }
      }
      fix.populate(FAR.cx, FAR.cy);
      return new Set(
        structuresIn(fix.sim, FAR.cx, FAR.cy)
          .map((structure) => structure.container?.lootTableId)
          .filter((id): id is string => id !== undefined),
      );
    };

    // A garage floor never yields a bathroom cabinet, and vice versa.
    expect([...tablesFor(Tile.FloorConcrete)]).not.toContain('house_bathroom');
    expect([...tablesFor(Tile.FloorTile)]).not.toContain('house_garage');
  });

  it('keeps shops and police stations out of the countryside', () => {
    const fix = fixture({ seed: 7 });
    for (let room = 0; room < 5; room++) {
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          fix.sim.world.setTile(
            FAR.cx * CHUNK_TILES + 1 + room * 6 + dx,
            FAR.cy * CHUNK_TILES + 1 + dy,
            Tile.FloorConcrete,
          );
        }
      }
    }
    fix.populate(FAR.cx, FAR.cy);

    const tables = structuresIn(fix.sim, FAR.cx, FAR.cy).map(
      (structure) => structure.container?.lootTableId,
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables).not.toContain('police_station');
    expect(tables).not.toContain('store_hardware');
  });

  it('lets shops appear once the chunk is a town', () => {
    const seen = new Set<string>();
    // The urban profiles are the rare end of a weighted pick, so sample a few chunks.
    for (let cx = 190; cx < 200; cx++) {
      const fix = fixture({ seed: 4242, world: urbanFlatWorld(4242) });
      for (let room = 0; room < 4; room++) {
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            fix.sim.world.setTile(
              cx * CHUNK_TILES + 1 + room * 6 + dx,
              FAR.cy * CHUNK_TILES + 1 + dy,
              Tile.FloorConcrete,
            );
          }
        }
      }
      fix.populate(cx, FAR.cy);
      for (const structure of structuresIn(fix.sim, cx, FAR.cy)) {
        const table = structure.container?.lootTableId;
        if (table) seen.add(table);
      }
    }
    expect(
      [...seen].some((table) => table.startsWith('store_') || table === 'police_station'),
    ).toBe(true);
  });

  it('ignores a scrap of floor too small to be a room', () => {
    const fix = fixture();
    // Two tiles is a doorway, not a pantry.
    fix.sim.world.setTile(FAR.cx * CHUNK_TILES + 4, FAR.cy * CHUNK_TILES + 4, Tile.FloorWood);
    fix.sim.world.setTile(FAR.cx * CHUNK_TILES + 5, FAR.cy * CHUNK_TILES + 4, Tile.FloorWood);
    fix.populate(FAR.cx, FAR.cy);

    expect(structuresIn(fix.sim, FAR.cx, FAR.cy)).toEqual([]);
  });

  it('never grows a tree indoors', () => {
    const fix = fixture({ resourceDensity: 4 });
    paintRoom(fix, Tile.FloorWood, 12, 2, 2);
    fix.populate(FAR.cx, FAR.cy);

    for (const node of nodesIn(fix.sim, FAR.cx, FAR.cy)) {
      const localX = node.tileX - FAR.cx * CHUNK_TILES;
      const localY = node.tileY - FAR.cy * CHUNK_TILES;
      const indoors = localX >= 2 && localX < 14 && localY >= 2 && localY < 14;
      expect(indoors).toBe(false);
    }
  });

  it('finds contiguous rooms and separates them', () => {
    const floors = new Map<number, number>();
    // Two 2x2 blocks with a gap between them.
    for (const [lx, ly] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
      [10, 10],
      [11, 10],
    ] as const) {
      floors.set(ly * CHUNK_TILES + lx, Tile.FloorWood);
    }
    const rooms = findRooms(floors);
    expect(rooms).toHaveLength(2);
    expect(rooms.map((room) => room.tiles.length).sort()).toEqual([2, 4]);
    // The anchor is the lowest index, which makes it position-derived and stable.
    expect(rooms[0]?.anchor).toBe(CHUNK_TILES + 1);
  });
});

describe('surveying', () => {
  it('separates land, shallow water and interior floor', () => {
    const fix = fixture();
    const base = { x: FAR.cx * CHUNK_TILES, y: FAR.cy * CHUNK_TILES };
    fix.sim.world.setTile(base.x + 1, base.y + 1, Tile.WaterShallow);
    fix.sim.world.setTile(base.x + 2, base.y + 1, Tile.WaterDeep);
    fix.sim.world.setTile(base.x + 3, base.y + 1, Tile.FloorTile);
    fix.sim.world.setTile(base.x + 4, base.y + 1, Tile.WallConcrete);

    const survey = surveyChunk(fix.sim.ctx, FAR.cx, FAR.cy);
    const local = (lx: number, ly: number) => ly * CHUNK_TILES + lx;

    expect(survey.water.get(Biome.Grassland)).toContain(local(1, 1));
    // Deep water and walls belong to no placement pool at all.
    expect(survey.water.get(Biome.Grassland)).not.toContain(local(2, 1));
    expect(survey.land.get(Biome.Grassland)).not.toContain(local(2, 1));
    expect(survey.land.get(Biome.Grassland)).not.toContain(local(4, 1));
    expect(survey.floors.get(local(3, 1))).toBe(Tile.FloorTile);
    expect(survey.fractions.get(Biome.Grassland)).toBe(1);
  });

  it('puts water nodes on water and nothing else', () => {
    const fix = fixture({ resourceDensity: 3 });
    // A pond in one corner.
    for (let dy = 0; dy < 8; dy++) {
      for (let dx = 0; dx < 8; dx++) {
        fix.sim.world.setTile(
          FAR.cx * CHUNK_TILES + 20 + dx,
          FAR.cy * CHUNK_TILES + 20 + dy,
          Tile.WaterShallow,
        );
      }
    }
    fix.populate(FAR.cx, FAR.cy);

    for (const node of nodesIn(fix.sim, FAR.cx, FAR.cy)) {
      const def = fix.sim.data.nodes.require(node.defId);
      const onWater = fix.sim.world.getTile(node.tileX, node.tileY) === Tile.WaterShallow;
      expect(onWater).toBe(def.category === 'water');
    }
  });
});

describe('activity tiers and streaming', () => {
  it('maps chunk distance onto the three tiers', () => {
    expect(activityForDistance(0)).toBe('active');
    expect(activityForDistance(2)).toBe('active');
    expect(activityForDistance(3)).toBe('low');
    expect(activityForDistance(4)).toBe('low');
    expect(activityForDistance(9)).toBe('dormant');
  });

  it('tiers loaded chunks by their distance to the nearest player', () => {
    const fix = fixture({ withSystem: true });
    const player = fix.sim.addPlayer();
    const cx = pixelToChunk(player.x);
    const cy = pixelToChunk(player.y);
    ensureChunkRuntime(fix.sim.sim.state, cx + 3, cy);
    ensureChunkRuntime(fix.sim.sim.state, cx + 9, cy);

    fix.sim.step(1);
    expect(fix.sim.sim.state.chunks[chunkKey(cx, cy)]?.activity).toBe('active');
    expect(fix.sim.sim.state.chunks[chunkKey(cx + 3, cy)]?.activity).toBe('low');
    expect(fix.sim.sim.state.chunks[chunkKey(cx + 9, cy)]?.activity).toBe('dormant');
  });

  it('goes dormant when the last player dies', () => {
    const fix = fixture({ withSystem: true });
    const player = fix.sim.addPlayer();
    fix.sim.step(1);
    const key = chunkKey(pixelToChunk(player.x), pixelToChunk(player.y));
    expect(fix.sim.sim.state.chunks[key]?.activity).toBe('active');

    player.alive = false;
    fix.sim.step(1);
    expect(fix.sim.sim.state.chunks[key]?.activity).toBe('dormant');
  });

  it('stamps the simulated tick on anything not dormant', () => {
    const fix = fixture({ withSystem: true });
    const player = fix.sim.addPlayer();
    const key = chunkKey(pixelToChunk(player.x), pixelToChunk(player.y));
    fix.sim.step(5);
    expect(fix.sim.sim.state.chunks[key]?.lastSimulatedTick).toBe(fix.sim.sim.state.tick);
    expect(fix.sim.sim.state.chunks[key]?.lastTouchedTick).toBe(fix.sim.sim.state.tick);
  });

  it('requests the ring of chunks around each player', () => {
    const fix = fixture({ withSystem: true });
    fix.sim.addPlayer({ x: 100 * 1024 + 512, y: 100 * 1024 + 512 });
    fix.sim.step(1);

    const radius = fix.sim.config.chunkLoadRadius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        expect(fix.sim.sim.state.chunks[chunkKey(100 + dx, 100 + dy)]).toBeDefined();
      }
    }
  });

  it('pre-fetches ahead of a player who is actually moving', () => {
    const still = fixture({ withSystem: true });
    still.sim.addPlayer({ x: 100 * 1024 + 512, y: 100 * 1024 + 512 });
    still.sim.step(2);
    expect(still.sim.sim.state.chunks[chunkKey(105, 100)]).toBeUndefined();

    const running = fixture({ withSystem: true });
    const player = running.sim.addPlayer({ x: 100 * 1024 + 512, y: 100 * 1024 + 512 });
    // Three seconds of lookahead at this speed lands three chunks east.
    player.vx = 1200;
    running.sim.step(2);
    expect(running.sim.sim.state.chunks[chunkKey(105, 100)]).toBeDefined();
  });

  it('populates a chunk the moment it streams in', () => {
    const fix = fixture({ withSystem: true });
    fix.sim.addPlayer({ x: 100 * 1024 + 512, y: 100 * 1024 + 512 });
    fix.sim.step(1);

    const runtime = fix.sim.sim.state.chunks[chunkKey(100, 100)];
    expect(runtime?.populated).toBe(true);
    expect(nodesIn(fix.sim, 100, 100).length).toBeGreaterThan(0);
  });

  it('refuses to request a chunk twice, or one outside the world', () => {
    const fix = fixture();
    expect(requestChunkLoad(fix.sim.ctx, 150, 150)).toBe(true);
    // Already queued.
    expect(requestChunkLoad(fix.sim.ctx, 150, 150)).toBe(false);
    expect(fix.sim.sim.state.pendingChunkLoads).toEqual([chunkKey(150, 150)]);

    // Off the edge of the map, in both directions.
    expect(requestChunkLoad(fix.sim.ctx, -1, 0)).toBe(false);
    expect(requestChunkLoad(fix.sim.ctx, 100000, 0)).toBe(false);
  });

  it('refuses to request a chunk that is already loaded', () => {
    const fix = fixture();
    ensureChunkRuntime(fix.sim.sim.state, 151, 151);
    expect(requestChunkLoad(fix.sim.ctx, 151, 151)).toBe(false);
  });

  it('does not let the request list grow without bound', () => {
    const fix = fixture({ withSystem: true });
    fix.sim.addPlayer({ x: 100 * 1024 + 512, y: 100 * 1024 + 512 });
    // The harness drains and installs requests every tick; a system that re-queued a
    // loaded chunk would leave a tail behind.
    fix.sim.step(20);
    expect(fix.sim.sim.state.pendingChunkLoads).toEqual([]);
  });
});
