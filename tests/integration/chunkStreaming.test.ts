import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, CHUNK_TILES, chunkKey, defaultWorldGenConfig } from '@survive/protocol';
import { createMemoryStore } from '@survive/persistence';
import { createWorld } from '@survive/world';
import { MAX_POPULATIONS_PER_TICK, spawnStructure } from '@survive/simulation';
import {
  createFlatWorld,
  createGeneratedHeadlessServer,
  createHeadlessServer,
  createTestSimulation,
  type HeadlessServer,
} from '@survive/test-utils';

/**
 * Chunk streaming and the dynamic-layer save path (spec sections 19, 20, 29 and 30).
 *
 * The simulation is synchronous and can never await a disk read, so it *requests* chunks
 * and the server fulfils them between ticks. These tests pin that contract down, because
 * a bug here shows up as a player falling through the world or a base vanishing.
 */

let servers: HeadlessServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.stop();
    } catch {
      // Already stopped.
    }
  }
  servers = [];
});

async function boot(store = createMemoryStore(), worldName = 'chunks') {
  const server = await createHeadlessServer({
    store,
    worldName,
    seed: 777,
    world: createFlatWorld({ seed: 777 }),
  });
  servers.push(server);
  return server;
}

describe('chunk streaming', () => {
  it('loads the chunks around a joining player before they can act', async () => {
    const server = await boot();
    const { player } = await server.server.joinPlayer('alice', 'Alice');

    const own = chunkKey(Math.floor(player.x / CHUNK_SIZE), Math.floor(player.y / CHUNK_SIZE));
    expect(server.server.loadedChunkKeys()).toContain(own);
    // The whole load radius, not just the one chunk the player stands in.
    expect(server.server.loadedChunkKeys().length).toBeGreaterThanOrEqual(9);
    // ...and the ground under them is real, not the void.
    expect(server.world.isSolidTile(Math.floor(player.x / 32), Math.floor(player.y / 32))).toBe(
      false,
    );
  });

  it('loads new chunks as a player walks and unloads the ones behind them', async () => {
    const server = await boot();
    const { player } = await server.server.joinPlayer('alice', 'Alice');
    const startKeys = new Set(server.server.loadedChunkKeys());

    // Teleport far enough that the old ring is well outside the keep radius.
    player.x += CHUNK_SIZE * 12;
    await server.server.primeChunksAround(player.x, player.y);
    await server.advance(4);

    const nowKeys = new Set(server.server.loadedChunkKeys());
    const destination = chunkKey(
      Math.floor(player.x / CHUNK_SIZE),
      Math.floor(player.y / CHUNK_SIZE),
    );
    expect(nowKeys).toContain(destination);
    // The chunks we left behind were evicted rather than accumulating forever.
    const stillLoaded = [...startKeys].filter((key) => nowKeys.has(key));
    expect(stillLoaded.length).toBeLessThan(startKeys.size);
  });

  it('persists a structure through an unload and brings it back on return', async () => {
    const store = createMemoryStore();
    const server = await boot(store);
    const { player } = await server.server.joinPlayer('alice', 'Alice');

    const tileX = Math.floor(player.x / 32) + 2;
    const tileY = Math.floor(player.y / 32);
    const built = spawnStructure(
      server.server.simulation.context,
      'wall_stone',
      tileX,
      tileY,
      0,
      'alice',
    );
    expect(built).not.toBeNull();
    const builtId = built!.id;

    // Walk away far enough for the chunk to be evicted, which triggers its save.
    player.x += CHUNK_SIZE * 12;
    await server.server.primeChunksAround(player.x, player.y);
    await server.advance(4);
    await server.server.settle();

    expect(server.server.simulation.state.structures[builtId]).toBeUndefined();
    expect(server.world.isSolidTile(tileX, tileY)).toBe(false);

    // Walk back.
    player.x -= CHUNK_SIZE * 12;
    await server.server.primeChunksAround(player.x, player.y);
    await server.advance(4);

    const restored = server.server.simulation.state.structures[builtId];
    expect(restored).toBeDefined();
    expect(restored!.defId).toBe('wall_stone');
    expect(restored!.tileX).toBe(tileX);
    // The collision grid has to be rebuilt too, or the wall is decoration.
    expect(server.world.isSolidTile(tileX, tileY)).toBe(true);
  });

  it('persists a tile override, so tilled soil stays tilled', async () => {
    const store = createMemoryStore();
    const server = await boot(store);
    const { player } = await server.server.joinPlayer('alice', 'Alice');

    const tileX = Math.floor(player.x / 32) + 1;
    const tileY = Math.floor(player.y / 32) + 1;
    // 17 is FarmlandWet.
    server.world.setTile(tileX, tileY, 17);
    const chunk = chunkKey(Math.floor(tileX / 32), Math.floor(tileY / 32));
    const runtime = server.server.simulation.state.chunks[chunk];
    expect(runtime).toBeDefined();
    runtime!.dirty = true;

    await server.server.saveAll();
    await server.server.settle();

    const repository = await store.openWorld('chunks');
    const saved = await repository.loadChunk(runtime!.cx, runtime!.cy);
    expect(saved).not.toBeNull();
    expect(saved!.overrides.some((entry) => entry.tile === 17)).toBe(true);
  });

  it('serves an empty chunk rather than failing when nothing has happened there', async () => {
    const server = await boot();
    // A chunk in the middle of nowhere has no saved dynamic layer at all.
    server.server.simulation.requestChunk(200, 200);
    await server.advance(2);
    expect(server.server.loadedChunkKeys()).toContain(chunkKey(200, 200));
  });

  it('never double-loads a chunk that is requested twice', async () => {
    const server = await boot();
    server.server.simulation.requestChunk(150, 150);
    server.server.simulation.requestChunk(150, 150);
    await server.advance(3);
    const occurrences = server.server.loadedChunkKeys().filter((key) => key === chunkKey(150, 150));
    expect(occurrences).toHaveLength(1);
  });

  it('reports loaded chunk and entity counts for the launcher', async () => {
    const server = await boot();
    await server.server.joinPlayer('alice', 'Alice');
    await server.advance(5);
    const stats = server.server.stats();
    expect(stats.players).toBe(1);
    expect(stats.loadedChunks).toBeGreaterThan(0);
    expect(stats.tick).toBeGreaterThan(0);
    expect(stats.paused).toBe(false);
  });

  it('idles instead of simulating when nobody is connected', async () => {
    const store = createMemoryStore();
    const server = await createHeadlessServer({
      store,
      worldName: 'idle',
      seed: 1,
      world: createFlatWorld({ seed: 1 }),
      config: (config) => {
        config.mode.pauseWhenEmpty = true;
      },
    });
    servers.push(server);

    const before = server.server.simulation.state.tick;
    await server.advance(50);
    // An empty dedicated server must not burn CPU simulating an unwatched world.
    expect(server.server.simulation.state.tick).toBe(before);

    await server.server.joinPlayer('alice', 'Alice');
    await server.advance(10);
    expect(server.server.simulation.state.tick).toBeGreaterThan(before);
  });
});

describe('tick budget while exploring', () => {
  it('stays inside the 50ms budget standing still and sprinting through new terrain', async () => {
    // The number that matters is not the average over ten thousand ticks - it is the
    // worst tick while a player crosses chunk borders, because that is where chunk
    // streaming and one-time chunk population land. A hitch there is a visible stutter.
    const server = await createGeneratedHeadlessServer({ seed: 4242 });
    servers.push(server as unknown as HeadlessServer);
    const { player } = await server.server.joinPlayer('profiler', 'Profiler');

    const tick = (): number => {
      const start = process.hrtime.bigint();
      server.server.tick();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    // Let the spawn ring settle so startup cost is not counted as steady state.
    for (let i = 0; i < 60; i++) tick();

    const still: number[] = [];
    for (let i = 0; i < 200; i++) still.push(tick());

    const moving: number[] = [];
    for (let i = 0; i < 400; i++) {
      // Nine pixels a tick is a sprinting player: 180 px/s, a chunk border every ~6s.
      player.x += 9;
      moving.push(tick());
      if (i % 120 === 0) await server.server.settle();
    }

    const percentile = (samples: number[], q: number) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    };
    const mean = (samples: number[]) =>
      samples.reduce((sum, value) => sum + value, 0) / samples.length;

    // Wall-clock ceilings, deliberately on p95 rather than the single worst tick.
    //
    // Measured standalone across seven seeds: worst tick ~35ms, worst mean ~16ms. But this
    // suite shares a machine with everything else, and one descheduled tick under load
    // produced a 59ms sample - a flake, not a regression. p95 with a generous bound still
    // fails loudly if a real unbounded cost comes back, without turning CPU contention
    // into a red build. The *deterministic* guards below are the ones that cannot flake.
    expect(mean(still)).toBeLessThan(30);
    expect(mean(moving)).toBeLessThan(35);
    expect(percentile(still, 0.95)).toBeLessThan(50);
    expect(percentile(moving, 0.95)).toBeLessThan(50);

    // Eviction actually happens: walking 100+ tiles must not accumulate the world.
    const stats = server.server.stats();
    expect(stats.loadedChunks).toBeLessThan(80);
  });
});

describe('bounded per-tick work', () => {
  /**
   * The load-bearing guards.
   *
   * Wall-clock assertions flake under CPU contention; these count *work* instead, so they
   * are deterministic and still fail if either cap is removed. Both bound the two costs a
   * profile identified as dominant: chunk population and flow-field integration.
   */
  it('never populates more than the cap says, however many chunks arrive at once', async () => {
    const server = await createGeneratedHeadlessServer({ seed: 31337 });
    servers.push(server as unknown as HeadlessServer);
    const { player } = await server.server.joinPlayer('walker', 'Walker');

    let worstInOneTick = 0;
    for (let i = 0; i < 500; i++) {
      // Teleport a chunk at a time so a whole new ring arrives every few ticks - the
      // worst case the cap exists for.
      if (i % 5 === 0) player.x += CHUNK_SIZE;
      // Counted by identity, not by tally. A teleport evicts whole rings, so the *count*
      // of unpopulated chunks drops by dozens in a tick without anything being populated
      // - and a tally would read that eviction as work and fail a cap that is holding.
      // Only a chunk that was unpopulated, is still resident, and is now populated counts.
      const pending = Object.entries(server.server.simulation.state.chunks)
        .filter(([, chunk]) => !chunk.populated)
        .map(([key]) => key);
      server.server.tick();
      const chunks = server.server.simulation.state.chunks;
      const populatedThisTick = pending.filter((key) => chunks[key]?.populated === true).length;
      worstInOneTick = Math.max(worstInOneTick, populatedThisTick);
      if (i % 100 === 0) await server.server.settle();
    }

    expect(worstInOneTick).toBeGreaterThan(0);
    expect(worstInOneTick).toBeLessThanOrEqual(MAX_POPULATIONS_PER_TICK);
  });
});

/**
 * A structure belongs to the chunk holding its origin tile, and that is the chunk whose
 * payload carries it. A multi-tile piece across a boundary therefore has half its footprint
 * in a chunk that knows nothing about it.
 *
 * Run against the **real** world, not `createFlatWorld`. The double does not reproduce this
 * at all - it keeps the far half solid throughout - which is exactly the sort of divergence
 * that makes a harness result worthless for a question about eviction. Third time this
 * distinction has mattered; see the note in AGENTS.md.
 */
describe('structures across a chunk boundary', () => {
  it('keeps the far half solid through an eviction and reload of the neighbour', () => {
    const config = defaultWorldGenConfig();
    config.seed = 987654;
    const world = createWorld(config);
    const sim = createTestSimulation({ systems: [], world, flattenRadius: 40 });

    // A 2x1 gate whose origin is the last tile of chunk 128 and whose far half is the
    // first tile of chunk 129.
    const boundaryTile = 129 * CHUNK_TILES;
    const originTileX = boundaryTile - 1;
    const tileY = 129 * CHUNK_TILES + 4;

    const gate = sim.placeStructure('gate_wood', originTileX, tileY, 0);
    expect(gate, 'could not place the gate').not.toBeNull();
    gate!.progress = 1;
    if (gate!.door) gate!.door.open = false;
    sim.step(1);

    const farSolid = () => sim.world.isSolidTile(boundaryTile, tileY);
    const nearSolid = () => sim.world.isSolidTile(originTileX, tileY);
    expect(nearSolid()).toBe(true);
    expect(farSolid()).toBe(true);

    // Evict the *neighbour*: it holds the far half's tiles but not the structure record, so
    // nothing detaches the structure and nothing used to put its collision back.
    const farKey = chunkKey(129, 129);
    expect(sim.sim.state.chunks[farKey], 'far chunk should be resident').toBeDefined();
    const payloads = sim.sim.unloadChunks([farKey]);
    expect(payloads).toHaveLength(1);

    for (const payload of payloads) sim.sim.installChunk(payload);

    // The gate is intact in state, so it had better be intact in the world too - otherwise
    // a player walks through half of any boundary-straddling wall, having triggered it just
    // by walking away far enough to evict the neighbour and coming back.
    expect(sim.sim.state.structures[gate!.id]).toBeDefined();
    expect(nearSolid()).toBe(true);
    expect(farSolid()).toBe(true);
  });
});
