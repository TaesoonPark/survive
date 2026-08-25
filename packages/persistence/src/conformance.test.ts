import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAVE_FORMAT_VERSION, WORLD_START_TICK, createRngState } from '@survive/protocol';
import type { ChunkDynamicPayload, WorldMetaPayload } from '@survive/protocol';
import { makeChunk, makePlayerSave } from './fixtures';
import { createFileSystemStore } from './filesystem';
import { createMemoryRepository, createMemoryStore } from './memory';
import { SaveFormatError } from './migrate';
import { CHUNKS_DIR, InvalidNameError, METADATA_FILE, PLAYERS_DIR, TEMP_SUFFIX } from './paths';
import { createSqliteStore, isSqliteAvailable } from './sqlite';
import { RepositoryClosedError, WorldExistsError, WorldNotFoundError } from './types';
import type { SaveStore, WorldRepository } from './types';

/**
 * One conformance suite, run against every backend.
 *
 * This is the load-bearing test in the package. The whole point of
 * {@link WorldRepository} is that the simulation cannot tell which backend it has, so
 * a behaviour that differs between two of them is a bug even when each one looks
 * reasonable alone - and it is exactly the class of bug that ships, because tests run
 * on memory and players run on disk. Anything asserted below is part of the contract.
 */

const WORLD = 'Test World';
const SEED = 20250824;
/** Fixed clock so world summaries are comparable across backends. */
const NOW = 1_700_000_000_000;

interface BackendFixture {
  store: SaveStore;
  /**
   * Leave the debris a crash mid-save would leave: a `.tmp` file where a chunk lives.
   * A no-op for backends that do not store chunks as files.
   */
  plantTempArtifact: (world: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

interface BackendCase {
  label: string;
  create: () => Promise<BackendFixture>;
}

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'survive-persistence-'));
}

const memoryCase: BackendCase = {
  label: 'memory',
  create: async () => ({
    store: createMemoryStore({ now: () => NOW }),
    // No files, so nothing to plant. The assertions still run, and still have to hold.
    plantTempArtifact: async () => {},
    cleanup: async () => {},
  }),
};

const fileSystemCase: BackendCase = {
  label: 'filesystem',
  create: async () => {
    const root = await makeTempRoot();
    return {
      store: createFileSystemStore(root, { now: () => NOW }),
      plantTempArtifact: async (world: string) => {
        // A torn write of chunk (7, 7): correct-looking content, `.tmp` name.
        const shard = join(root, world, CHUNKS_DIR, '7');
        await mkdir(shard, { recursive: true });
        await writeFile(
          join(shard, `chunk_7_7.json${TEMP_SUFFIX}`),
          JSON.stringify(makeChunk(7, 7)),
          'utf8',
        );
      },
      cleanup: async () => rm(root, { recursive: true, force: true }),
    };
  },
};

const sqliteCase: BackendCase = {
  label: 'sqlite',
  create: async () => {
    const root = await makeTempRoot();
    return {
      store: createSqliteStore(root, { now: () => NOW }),
      plantTempArtifact: async (world: string) => {
        // The SQLite backend never writes chunk files, but a world folder that once
        // held them (or that a filesystem save crashed in) must not confuse it.
        const shard = join(root, world, CHUNKS_DIR, '7');
        await mkdir(shard, { recursive: true });
        await writeFile(
          join(shard, `chunk_7_7.json${TEMP_SUFFIX}`),
          JSON.stringify(makeChunk(7, 7)),
          'utf8',
        );
      },
      cleanup: async () => rm(root, { recursive: true, force: true }),
    };
  },
};

const sqliteReady = await isSqliteAvailable();
const backends: BackendCase[] = [memoryCase, fileSystemCase, ...(sqliteReady ? [sqliteCase] : [])];

/** Names that must never reach a filesystem, whatever the backend. */
const UNSAFE_NAMES = [
  '',
  '.',
  '..',
  '../evil',
  '../../etc/passwd',
  'chunks/../..',
  '/absolute',
  'back\\slash',
  `nul${String.fromCharCode(0)}byte`,
  'newline\nname',
  'trailing.',
  '.hidden',
  ' leading',
  'trailing ',
  'CON',
  'lpt1.json',
  'wild*card',
  'colon:name',
  'x'.repeat(65),
];

function describeBackend({ label, create }: BackendCase): void {
  describe(`WorldRepository conformance: ${label}`, () => {
    let fixture: BackendFixture;
    let store: SaveStore;
    let repository: WorldRepository;

    beforeEach(async () => {
      fixture = await create();
      store = fixture.store;
      repository = await store.createWorld(WORLD, SEED);
    });

    afterEach(async () => {
      try {
        await repository.close();
      } catch {
        // Tests that close the repository themselves are expected to land here.
      }
      await fixture.cleanup();
    });

    // -- metadata -----------------------------------------------------------

    it('creates a world with complete, deterministic initial metadata', async () => {
      const meta = await repository.loadMeta();
      expect(meta).not.toBeNull();
      expect(meta).toEqual({
        version: SAVE_FORMAT_VERSION,
        name: WORLD,
        seed: SEED,
        // A brand-new world starts on the morning of day 1, not at midnight - the world
        // clock is derived from the tick, so 0 would mean darkness.
        tick: WORLD_START_TICK,
        weather: {
          type: 'clear',
          intensity: 0,
          temperature: 15,
          windAngle: 0,
          windSpeed: 0,
          nextChangeTick: 0,
          lightning: false,
        },
        // Same seed, same starting RNG state, on every backend and every host.
        rng: createRngState(SEED),
        nextId: 1,
        createdAtMs: NOW,
        savedAtMs: NOW,
        totalTicks: 0,
      });
    });

    it('round-trips world metadata', async () => {
      const original = await repository.loadMeta();
      expect(original).not.toBeNull();
      const updated: WorldMetaPayload = {
        ...(original as WorldMetaPayload),
        tick: 123_456,
        totalTicks: 987_654,
        nextId: 4021,
        savedAtMs: NOW + 60_000,
        weather: {
          type: 'storm',
          intensity: 0.8,
          temperature: 4.5,
          windAngle: 2.25,
          windSpeed: 130,
          nextChangeTick: 130_000,
          lightning: true,
        },
        rng: { a: 1, b: 2, c: 3, d: 4 },
      };
      await repository.saveMeta(updated);
      expect(await repository.loadMeta()).toEqual(updated);
    });

    // -- chunks -------------------------------------------------------------

    it('round-trips a chunk, including negative coordinates', async () => {
      const chunk = makeChunk(3, -4);
      await repository.saveChunk(chunk);
      expect(await repository.loadChunk(3, -4)).toEqual(chunk);
    });

    it('returns null for records that were never written', async () => {
      expect(await repository.loadChunk(99, 99)).toBeNull();
      expect(await repository.loadPlayer('nobody')).toBeNull();
    });

    it('shares no mutable state with the caller', async () => {
      const chunk = makeChunk(1, 1);
      await repository.saveChunk(chunk);

      // Mutating the payload after the save must not reach the store...
      chunk.zombies.length = 0;
      chunk.nextSpawnTick = -1;
      const loaded = await repository.loadChunk(1, 1);
      expect(loaded?.zombies).toHaveLength(1);
      expect(loaded?.nextSpawnTick).toBe(2000);

      // ...and mutating what came out must not reach it either.
      loaded?.structures.pop();
      expect((await repository.loadChunk(1, 1))?.structures).toHaveLength(1);
    });

    it('saves a batch of chunks', async () => {
      const batch = [makeChunk(0, 0), makeChunk(1, 0), makeChunk(-1, 2), makeChunk(5, -5)];
      await repository.saveChunks(batch);
      for (const chunk of batch) {
        expect(await repository.loadChunk(chunk.cx, chunk.cy)).toEqual(chunk);
      }
      expect((await repository.stats()).chunkCount).toBe(batch.length);
    });

    it('skips chunks that are empty and unpopulated', async () => {
      const empty = makeChunk(2, 2);
      empty.populated = false;
      empty.overrides = [];
      empty.structures = [];
      empty.nodes = [];
      empty.items = [];
      empty.zombies = [];
      empty.animals = [];

      await repository.saveChunks([makeChunk(0, 0), empty]);
      expect(await repository.loadChunk(2, 2)).toBeNull();
      expect((await repository.stats()).chunkCount).toBe(1);
    });

    it('still stores a populated chunk that has been stripped bare', async () => {
      // Every tree chopped down: nothing left in the chunk, but `populated` means the
      // forest must not come back on load.
      const cleared = makeChunk(4, 4);
      cleared.overrides = [];
      cleared.structures = [];
      cleared.nodes = [];
      cleared.items = [];
      cleared.zombies = [];
      cleared.animals = [];
      expect(cleared.populated).toBe(true);

      await repository.saveChunk(cleared);
      expect(await repository.loadChunk(4, 4)).toEqual(cleared);
    });

    it('drops a stored chunk that becomes empty and unpopulated', async () => {
      await repository.saveChunk(makeChunk(6, 6));
      expect((await repository.stats()).chunkCount).toBe(1);

      const reset = makeChunk(6, 6);
      reset.populated = false;
      reset.overrides = [];
      reset.structures = [];
      reset.nodes = [];
      reset.items = [];
      reset.zombies = [];
      reset.animals = [];
      await repository.saveChunk(reset);

      expect(await repository.loadChunk(6, 6)).toBeNull();
      expect((await repository.stats()).chunkCount).toBe(0);
    });

    it('overwrites a chunk in place', async () => {
      await repository.saveChunk(makeChunk(8, 8));
      const updated = makeChunk(8, 8);
      updated.nextSpawnTick = 5555;
      updated.zombies = [];
      await repository.saveChunk(updated);

      expect(await repository.loadChunk(8, 8)).toEqual(updated);
      expect((await repository.stats()).chunkCount).toBe(1);
    });

    it('ignores a leftover temp file from a torn write', async () => {
      await fixture.plantTempArtifact(WORLD);
      expect(await repository.loadChunk(7, 7)).toBeNull();
      expect((await repository.stats()).chunkCount).toBe(0);
    });

    // -- players ------------------------------------------------------------

    it('round-trips a player', async () => {
      const save = makePlayerSave('alice');
      await repository.savePlayer(save);
      expect(await repository.loadPlayer('alice')).toEqual(save);
    });

    it('lists players in ascending order', async () => {
      expect(await repository.listPlayers()).toEqual([]);
      for (const id of ['charlie', 'alice', 'bob']) {
        await repository.savePlayer(makePlayerSave(id));
      }
      expect(await repository.listPlayers()).toEqual(['alice', 'bob', 'charlie']);
    });

    it('deletes one player without touching the others', async () => {
      await repository.savePlayer(makePlayerSave('alice'));
      await repository.savePlayer(makePlayerSave('bob'));

      await repository.deletePlayer('alice');
      expect(await repository.loadPlayer('alice')).toBeNull();
      expect(await repository.loadPlayer('bob')).not.toBeNull();
      expect(await repository.listPlayers()).toEqual(['bob']);
    });

    it('treats deleting an unknown player as a no-op', async () => {
      await expect(repository.deletePlayer('ghost')).resolves.toBeUndefined();
      expect(await repository.listPlayers()).toEqual([]);
    });

    // -- stats, flush, lifecycle -------------------------------------------

    it('reports counts and a plausible size', async () => {
      const fresh = await repository.stats();
      expect(fresh.chunkCount).toBe(0);
      expect(fresh.playerCount).toBe(0);
      expect(fresh.sizeBytes).toBeGreaterThan(0);

      await repository.saveChunks([makeChunk(0, 0), makeChunk(0, 1)]);
      await repository.savePlayer(makePlayerSave('alice'));
      await repository.flush();

      const used = await repository.stats();
      expect(used.chunkCount).toBe(2);
      expect(used.playerCount).toBe(1);
      expect(used.sizeBytes).toBeGreaterThanOrEqual(fresh.sizeBytes);
    });

    it('accepts an empty batch and repeated flushes', async () => {
      await expect(repository.saveChunks([])).resolves.toBeUndefined();
      await expect(repository.flush()).resolves.toBeUndefined();
      await expect(repository.flush()).resolves.toBeUndefined();
    });

    // -- snapshot semantics -------------------------------------------------
    //
    // The server autosaves without awaiting it (`track(this.saveAll())`) and keeps
    // ticking, and `Simulation.serializeChunk` puts the *live* entity objects into the
    // payload rather than copies. A save therefore has to record the state as it was
    // when the call was made. A backend that reads the payload later writes whatever
    // tick it happens to reach it at, which is how one item ends up saved twice (in a
    // player's inventory and in the container they moved it to) or not at all.

    it('records a chunk as it was when the save was called', async () => {
      const chunk = makeChunk(1, 1);
      const zombie = chunk.zombies[0];
      expect(zombie).toBeDefined();
      const write = repository.saveChunk(chunk);
      // The tick loop carries on while the write is in flight.
      chunk.nextSpawnTick = 999_999;
      chunk.zombies.length = 0;
      if (zombie) zombie.x = -1;
      await write;

      const loaded = await repository.loadChunk(1, 1);
      expect(loaded?.nextSpawnTick).toBe(2000);
      expect(loaded?.zombies).toHaveLength(1);
      // makeChunk(1, 1) puts its zombie at cx * 1024 + 300.
      expect(loaded?.zombies[0]?.x).toBe(1324);
    });

    it('records a player as it was when the save was called', async () => {
      const save = makePlayerSave('alice');
      const write = repository.savePlayer(save);
      save.player.x = -1;
      save.player.health = 1;
      save.player.inventory.slots[0] = null;
      await write;

      const loaded = await repository.loadPlayer('alice');
      expect(loaded?.player.x).toBe(1024.5);
      expect(loaded?.player.health).toBe(72);
      expect(loaded?.player.inventory.slots[0]).not.toBeNull();
    });

    it('takes one consistent snapshot of a whole autosave sweep', async () => {
      const meta = (await repository.loadMeta()) as WorldMetaPayload;
      const atTick: WorldMetaPayload = { ...meta, tick: 100 };
      const chunks = [makeChunk(0, 0), makeChunk(1, 0), makeChunk(2, 0), makeChunk(3, 0)];
      const player = makePlayerSave('alice');

      // Exactly what `GameServer.saveAll` does, and it is not awaited.
      const sweep = Promise.all([
        repository.saveMeta(atTick),
        repository.saveChunks(chunks),
        repository.savePlayer(player),
      ]);
      // ...and then ten more ticks run before any of it reaches storage.
      atTick.tick = 110;
      for (const chunk of chunks) chunk.nextSpawnTick = 111;
      player.player.x = 4096;
      await sweep;
      await repository.flush();

      expect((await repository.loadMeta())?.tick).toBe(100);
      for (const chunk of chunks) {
        expect((await repository.loadChunk(chunk.cx, chunk.cy))?.nextSpawnTick).toBe(2000);
      }
      expect((await repository.loadPlayer('alice'))?.player.x).toBe(1024.5);
    });

    it('writes nothing when a chunk in a batch cannot be serialized', async () => {
      // A payload with a cycle stands in for any mid-sweep failure. All three backends
      // promise all-or-nothing for a batch: a half-applied autosave is a world at no
      // tick at all, and the in-memory backend has to fail the same way or the
      // headless suite is testing a store the players never use.
      const poison = makeChunk(1, 1) as unknown as Record<string, unknown>;
      poison['self'] = poison;
      await expect(
        repository.saveChunks([
          makeChunk(0, 0),
          poison as unknown as ChunkDynamicPayload,
          makeChunk(2, 2),
        ]),
      ).rejects.toThrow(TypeError);

      expect((await repository.stats()).chunkCount).toBe(0);
      expect(await repository.loadChunk(0, 0)).toBeNull();
      expect(await repository.loadChunk(2, 2)).toBeNull();
    });

    it('flushes a batch the caller never awaited', async () => {
      // A backend that writes a batch through a bounded pool has most of it queued
      // somewhere `flush()` cannot see unless it tracks the whole operation. Getting
      // this wrong loses everything past the pool's width on shutdown.
      const batch = Array.from({ length: 40 }, (_, index) => makeChunk(index, 3));
      void repository.saveChunks(batch).catch(() => {});
      await repository.flush();
      expect((await repository.stats()).chunkCount).toBe(40);
    });

    it('keeps everything across close and reopen', async () => {
      const chunk = makeChunk(-2, 9);
      const save = makePlayerSave('alice');
      await repository.saveChunk(chunk);
      await repository.savePlayer(save);
      await repository.flush();
      await repository.close();

      repository = await store.openWorld(WORLD);
      await repository.open();
      expect(await repository.loadChunk(-2, 9)).toEqual(chunk);
      expect(await repository.loadPlayer('alice')).toEqual(save);
      expect((await repository.loadMeta())?.seed).toBe(SEED);
    });

    it('refuses to be used after close', async () => {
      await repository.close();
      await expect(repository.loadMeta()).rejects.toThrow(RepositoryClosedError);
      await expect(repository.saveChunk(makeChunk(0, 0))).rejects.toThrow(RepositoryClosedError);
      await expect(repository.listPlayers()).rejects.toThrow(RepositoryClosedError);
      await expect(repository.open()).rejects.toThrow(RepositoryClosedError);
    });

    // -- format version ----------------------------------------------------

    it('rejects a chunk written by a newer build', async () => {
      const future: ChunkDynamicPayload = { ...makeChunk(1, 2), version: SAVE_FORMAT_VERSION + 1 };
      await repository.saveChunk(future);
      await expect(repository.loadChunk(1, 2)).rejects.toThrow(SaveFormatError);
      await expect(repository.loadChunk(1, 2)).rejects.toMatchObject({
        kind: 'chunk',
        problem: 'too-new',
        found: SAVE_FORMAT_VERSION + 1,
      });
    });

    it('rejects a player written by a newer build', async () => {
      await repository.savePlayer({
        ...makePlayerSave('alice'),
        version: SAVE_FORMAT_VERSION + 1,
      });
      await expect(repository.loadPlayer('alice')).rejects.toMatchObject({
        kind: 'player',
        problem: 'too-new',
      });
    });

    it('rejects metadata written by a newer build', async () => {
      const meta = await repository.loadMeta();
      await repository.saveMeta({
        ...(meta as WorldMetaPayload),
        version: SAVE_FORMAT_VERSION + 1,
      });
      await expect(repository.loadMeta()).rejects.toMatchObject({
        kind: 'meta',
        problem: 'too-new',
      });
    });

    it('rejects a chunk with a missing version', async () => {
      const broken = makeChunk(1, 3) as unknown as Record<string, unknown>;
      delete broken['version'];
      await repository.saveChunk(broken as unknown as ChunkDynamicPayload);
      await expect(repository.loadChunk(1, 3)).rejects.toMatchObject({ problem: 'malformed' });
    });

    // -- name safety -------------------------------------------------------

    it('rejects unsafe world names everywhere they can be passed', async () => {
      for (const name of UNSAFE_NAMES) {
        await expect(store.createWorld(name, SEED)).rejects.toThrow(InvalidNameError);
        await expect(store.openWorld(name)).rejects.toThrow(InvalidNameError);
        await expect(store.deleteWorld(name)).rejects.toThrow(InvalidNameError);
        await expect(store.worldExists(name)).rejects.toThrow(InvalidNameError);
      }
    });

    it('rejects unsafe player ids everywhere they can be passed', async () => {
      for (const id of UNSAFE_NAMES) {
        await expect(repository.savePlayer(makePlayerSave(id))).rejects.toThrow(InvalidNameError);
        await expect(repository.loadPlayer(id)).rejects.toThrow(InvalidNameError);
        await expect(repository.deletePlayer(id)).rejects.toThrow(InvalidNameError);
      }
      expect(await repository.listPlayers()).toEqual([]);
    });

    // -- the store ---------------------------------------------------------

    it('reports world existence', async () => {
      expect(await store.worldExists(WORLD)).toBe(true);
      expect(await store.worldExists('Nowhere')).toBe(false);
    });

    it('refuses to open a world that does not exist', async () => {
      await expect(store.openWorld('Nowhere')).rejects.toThrow(WorldNotFoundError);
    });

    it('refuses to create a world twice', async () => {
      await expect(store.createWorld(WORLD, SEED)).rejects.toThrow(WorldExistsError);
    });

    it('deletes a world, and tolerates deleting a missing one', async () => {
      await repository.saveChunk(makeChunk(0, 0));
      await repository.savePlayer(makePlayerSave('alice'));
      await repository.close();

      await store.deleteWorld(WORLD);
      expect(await store.worldExists(WORLD)).toBe(false);
      expect(await store.listWorlds()).toEqual([]);
      await expect(store.deleteWorld(WORLD)).resolves.toBeUndefined();
    });

    it('summarises every world for the load screen', async () => {
      const meta = await repository.loadMeta();
      await repository.saveMeta({ ...(meta as WorldMetaPayload), tick: 28_800 * 3 + 17 });
      await repository.savePlayer(makePlayerSave('alice'));
      await repository.savePlayer(makePlayerSave('bob'));
      await repository.flush();

      const second = await store.createWorld('Second', 99);
      await second.close();

      const worlds = await store.listWorlds();
      expect(worlds.map((world) => world.name).sort()).toEqual(['Second', WORLD]);

      const summary = worlds.find((world) => world.name === WORLD);
      expect(summary).toBeDefined();
      expect(summary?.seed).toBe(SEED);
      expect(summary?.tick).toBe(28_800 * 3 + 17);
      // 28 800 ticks per in-game day, day numbering starts at 1.
      expect(summary?.day).toBe(4);
      expect(summary?.playerCount).toBe(2);
      expect(summary?.sizeBytes).toBeGreaterThan(0);
    });

    it('lists worlds newest save first, ties broken by name', async () => {
      // The load screen's order. Ties have to break on something stable or the list
      // reshuffles between launches, since it would otherwise fall back to whatever
      // order `readdir` (or a `Map`) happened to produce.
      const older = await store.createWorld('Zulu', 1);
      const newer = await store.createWorld('Alpha', 2);
      const newerMeta = (await newer.loadMeta()) as WorldMetaPayload;
      await newer.saveMeta({ ...newerMeta, savedAtMs: NOW + 10_000 });
      await Promise.all([older.flush(), newer.flush(), repository.flush()]);
      await Promise.all([older.close(), newer.close()]);

      // 'Alpha' has the newest save; 'Test World' and 'Zulu' tie on NOW.
      expect((await store.listWorlds()).map((world) => world.name)).toEqual([
        'Alpha',
        WORLD,
        'Zulu',
      ]);
    });

    it('skips a world whose metadata this build cannot read', async () => {
      const meta = await repository.loadMeta();
      await repository.saveMeta({
        ...(meta as WorldMetaPayload),
        version: SAVE_FORMAT_VERSION + 99,
      });
      await repository.flush();
      await repository.close();

      // Still on disk, still counted as existing - just not listed as playable.
      expect(await store.worldExists(WORLD)).toBe(true);
      expect(await store.listWorlds()).toEqual([]);
    });
  });
}

for (const backend of backends) describeBackend(backend);

if (!sqliteReady) {
  describe('WorldRepository conformance: sqlite', () => {
    it.skip('node:sqlite is unavailable in this Node build', () => {});
  });
}

// ---------------------------------------------------------------------------
// Backend-specific behaviour the shared suite cannot express
// ---------------------------------------------------------------------------

describe.skipIf(!sqliteReady)('sqlite backend', () => {
  let root: string;
  let store: SaveStore;
  let repository: WorldRepository;

  beforeEach(async () => {
    root = await makeTempRoot();
    store = createSqliteStore(root, { now: () => NOW });
    repository = await store.createWorld(WORLD, SEED);
  });

  afterEach(async () => {
    await repository.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('is reported as available in this build', async () => {
    await expect(isSqliteAvailable()).resolves.toBe(true);
  });

  it('rolls a failed batch back entirely', async () => {
    // A chunk that cannot be serialised stands in for any mid-sweep failure. Only the
    // SQLite backend promises all-or-nothing here, which is the reason it is the
    // dedicated-server default: a half-written autosave is a world at no tick at all.
    const poison = makeChunk(1, 1) as unknown as Record<string, unknown>;
    poison['self'] = poison;

    await expect(
      repository.saveChunks([makeChunk(0, 0), poison as unknown as ChunkDynamicPayload]),
    ).rejects.toThrow(TypeError);

    expect(await repository.loadChunk(0, 0)).toBeNull();
    expect(await repository.loadChunk(1, 1)).toBeNull();
    expect((await repository.stats()).chunkCount).toBe(0);
  });

  it('keeps accepting writes after a rolled-back batch', async () => {
    const poison = makeChunk(1, 1) as unknown as Record<string, unknown>;
    poison['self'] = poison;
    await expect(repository.saveChunks([poison as unknown as ChunkDynamicPayload])).rejects.toThrow(
      TypeError,
    );

    const good = makeChunk(2, 2);
    await repository.saveChunks([good]);
    expect(await repository.loadChunk(2, 2)).toEqual(good);
  });

  it('puts world.db inside the shared world folder layout', async () => {
    await repository.flush();
    const entries = await readdir(join(root, WORLD));
    expect(entries).toContain('world.db');
  });
});

describe('memory backend', () => {
  it('starts with no metadata when created standalone', async () => {
    const repository = createMemoryRepository();
    await repository.open();
    expect(await repository.loadMeta()).toBeNull();
    expect(await repository.listPlayers()).toEqual([]);
    expect(await repository.stats()).toEqual({ chunkCount: 0, playerCount: 0, sizeBytes: 0 });
  });

  it('starts from supplied metadata, cloned', async () => {
    const meta: WorldMetaPayload = {
      version: SAVE_FORMAT_VERSION,
      name: 'seeded',
      seed: 7,
      tick: 42,
      weather: {
        type: 'fog',
        intensity: 0.3,
        temperature: 9,
        windAngle: 0,
        windSpeed: 1,
        nextChangeTick: 100,
        lightning: false,
      },
      rng: createRngState(7),
      nextId: 12,
      createdAtMs: NOW,
      savedAtMs: NOW,
      totalTicks: 42,
    };
    const repository = createMemoryRepository(meta);
    meta.tick = -1;
    expect((await repository.loadMeta())?.tick).toBe(42);
  });

  it('keeps worlds separate', async () => {
    const store = createMemoryStore({ now: () => NOW });
    const first = await store.createWorld('One', 1);
    const second = await store.createWorld('Two', 2);
    await first.saveChunk(makeChunk(0, 0));

    expect((await first.stats()).chunkCount).toBe(1);
    expect((await second.stats()).chunkCount).toBe(0);
  });
});

describe('filesystem backend layout', () => {
  let root: string;
  let store: SaveStore;
  let repository: WorldRepository;

  beforeEach(async () => {
    root = await makeTempRoot();
    store = createFileSystemStore(root, { now: () => NOW });
    repository = await store.createWorld(WORLD, SEED);
  });

  afterEach(async () => {
    await repository.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('writes the layout from spec section 30', async () => {
    await repository.saveChunk(makeChunk(3, -4));
    await repository.savePlayer(makePlayerSave('alice'));

    const worldDir = join(root, WORLD);
    const meta = JSON.parse(
      await readFile(join(worldDir, METADATA_FILE), 'utf8'),
    ) as WorldMetaPayload;
    expect(meta.seed).toBe(SEED);

    const players = await readdir(join(worldDir, PLAYERS_DIR));
    expect(players).toEqual(['alice.json']);

    // Sharded by cx: chunks/3/chunk_3_-4.json
    const shards = await readdir(join(worldDir, CHUNKS_DIR));
    expect(shards).toEqual(['3']);
    expect(await readdir(join(worldDir, CHUNKS_DIR, '3'))).toEqual(['chunk_3_-4.json']);
  });

  it('leaves no temp files behind once a save completes', async () => {
    await repository.saveChunks([makeChunk(0, 0), makeChunk(0, 1), makeChunk(-1, -1)]);
    await repository.savePlayer(makePlayerSave('alice'));
    await repository.flush();

    const leftovers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.name.endsWith(TEMP_SUFFIX)) leftovers.push(child);
      }
    };
    await walk(join(root, WORLD));
    expect(leftovers).toEqual([]);
  });

  it('leaves nothing queued behind the write pool after a flush', async () => {
    // The shared suite asserts the outcome; this pins the mechanism. Only
    // WRITE_CONCURRENCY of a batch's files are ever open at once, so the flush has to
    // wait on the whole `saveChunks` call rather than on the writes currently running.
    const batch = Array.from({ length: 64 }, (_, index) => makeChunk(index, 9));
    void repository.saveChunks(batch).catch(() => {});
    await repository.flush();

    const shard = join(root, WORLD, CHUNKS_DIR, '63');
    expect(await readdir(shard)).toEqual(['chunk_63_9.json']);
  });

  it('writes human-readable JSON', async () => {
    await repository.saveChunk(makeChunk(0, 0));
    const text = await readFile(join(root, WORLD, CHUNKS_DIR, '0', 'chunk_0_0.json'), 'utf8');
    expect(text).toContain('\n  "cx": 0');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('never interleaves two concurrent writes of the same record', async () => {
    // Both writers use the same `.tmp` name. Without serialisation their bytes mix and
    // the rename publishes the mixture, which is unparseable JSON rather than either
    // version - the one corruption an atomic write alone cannot prevent.
    const writes: Array<Promise<void>> = [];
    for (let tick = 0; tick < 12; tick++) {
      const chunk = makeChunk(0, 0);
      chunk.nextSpawnTick = tick;
      writes.push(repository.saveChunk(chunk));

      const save = makePlayerSave('alice');
      save.player.lastInputSeq = tick;
      writes.push(repository.savePlayer(save));
    }
    await Promise.all(writes);
    await repository.flush();

    // Whichever write won, the file must be a complete, valid record.
    const chunk = await repository.loadChunk(0, 0);
    expect(chunk?.zombies).toHaveLength(1);
    expect(chunk?.nextSpawnTick).toBeGreaterThanOrEqual(0);
    const player = await repository.loadPlayer('alice');
    expect(player?.player.inventory.slots).toHaveLength(24);
  });

  it('ignores stray files and unreadable folders when listing worlds', async () => {
    await writeFile(join(root, 'not-a-world.txt'), 'hello', 'utf8');
    await mkdir(join(root, 'Empty Folder'), { recursive: true });
    await mkdir(join(root, '..hidden'), { recursive: true });
    // A torn metadata write must not be mistaken for a second world.
    await writeFile(join(root, WORLD, `${METADATA_FILE}${TEMP_SUFFIX}`), '{', 'utf8');

    const worlds = await store.listWorlds();
    expect(worlds.map((world) => world.name)).toEqual([WORLD]);
  });

  it('survives a corrupt metadata file without hiding the rest', async () => {
    const second = await store.createWorld('Second', 99);
    await second.close();
    await writeFile(join(root, WORLD, METADATA_FILE), '{ not json', 'utf8');

    const worlds = await store.listWorlds();
    expect(worlds.map((world) => world.name)).toEqual(['Second']);
  });
});
