import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAVE_FORMAT_VERSION } from '@survive/protocol';
import type {
  ChunkDynamicPayload,
  PlayerSavePayload,
  WorldMetaPayload,
  WorldSummary,
} from '@survive/protocol';
import { makeChunk, makePlayerSave } from './fixtures';
import { createFileSystemStore } from './filesystem';
import { createMemoryStore } from './memory';
import { CHUNKS_DIR, METADATA_FILE, PLAYERS_DIR, chunkFileName, chunkShardName } from './paths';
import { createSqliteStore, isSqliteAvailable } from './sqlite';
import type { SaveStore, WorldRepository } from './types';

/**
 * Spec section 32: single-player and dedicated servers use the identical format.
 *
 * "Identical" is a claim about the DTOs, not about the container - one backend puts
 * them in files and the other in a database. This proves the claim at the level that
 * matters: the same writes produce the same objects on the way back out, whichever
 * backend performed them, so moving a world between a single-player game and a server
 * cannot change what the simulation loads.
 */

const WORLD = 'Portable World';
const SEED = 31337;
const NOW = 1_700_000_000_000;

const sqliteReady = await isSqliteAvailable();

describe.skipIf(!sqliteReady)('world portability across backends', () => {
  const roots: string[] = [];
  const openRepositories: WorldRepository[] = [];

  let fsRoot: string;
  let sqliteRoot: string;
  let stores: Array<{ label: string; store: SaveStore; repository: WorldRepository }>;

  const meta: WorldMetaPayload = {
    version: SAVE_FORMAT_VERSION,
    name: WORLD,
    seed: SEED,
    tick: 123_456,
    weather: {
      type: 'rain',
      intensity: 0.55,
      temperature: 11.25,
      windAngle: 1.75,
      windSpeed: 42,
      nextChangeTick: 130_000,
      lightning: false,
    },
    rng: { a: 11, b: 22, c: 33, d: 44 },
    nextId: 5150,
    createdAtMs: NOW - 86_400_000,
    savedAtMs: NOW,
    totalTicks: 200_000,
  };
  const chunks: ChunkDynamicPayload[] = [makeChunk(0, 0), makeChunk(-7, 12)];
  const player: PlayerSavePayload = makePlayerSave('alice', NOW);

  beforeEach(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'survive-portable-fs-'));
    sqliteRoot = await mkdtemp(join(tmpdir(), 'survive-portable-sqlite-'));
    roots.push(fsRoot, sqliteRoot);

    const candidates: Array<{ label: string; store: SaveStore }> = [
      { label: 'memory', store: createMemoryStore({ now: () => NOW }) },
      { label: 'filesystem', store: createFileSystemStore(fsRoot, { now: () => NOW }) },
      { label: 'sqlite', store: createSqliteStore(sqliteRoot, { now: () => NOW }) },
    ];

    stores = [];
    for (const candidate of candidates) {
      const repository = await candidate.store.createWorld(WORLD, SEED);
      openRepositories.push(repository);
      // Byte-for-byte the same writes, in the same order, through every backend.
      await repository.saveMeta(meta);
      await repository.saveChunks(chunks);
      await repository.savePlayer(player);
      await repository.flush();
      stores.push({ ...candidate, repository });
    }
  });

  afterEach(async () => {
    for (const repository of openRepositories.splice(0)) {
      await repository.close().catch(() => {});
    }
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns the same metadata from every backend', async () => {
    for (const { label, repository } of stores) {
      expect(await repository.loadMeta(), label).toEqual(meta);
    }
  });

  it('returns the same chunks from every backend', async () => {
    for (const { label, repository } of stores) {
      for (const chunk of chunks) {
        expect(await repository.loadChunk(chunk.cx, chunk.cy), label).toEqual(chunk);
      }
    }
  });

  it('returns the same player record from every backend', async () => {
    for (const { label, repository } of stores) {
      expect(await repository.loadPlayer('alice'), label).toEqual(player);
      expect(await repository.listPlayers(), label).toEqual(['alice']);
    }
  });

  it('reports the same occupancy from every backend', async () => {
    for (const { label, repository } of stores) {
      const stats = await repository.stats();
      expect({ label, chunkCount: stats.chunkCount, playerCount: stats.playerCount }).toEqual({
        label,
        chunkCount: chunks.length,
        playerCount: 1,
      });
    }
  });

  it('summarises a world identically, size aside', async () => {
    const summaries: WorldSummary[] = [];
    for (const { store } of stores) {
      const listed = await store.listWorlds();
      expect(listed).toHaveLength(1);
      const only = listed[0];
      if (!only) throw new Error('listWorlds returned nothing');
      // Size legitimately differs: JSON files, a paged database and a Map do not
      // occupy the same number of bytes. Everything a player is shown must match.
      summaries.push({ ...only, sizeBytes: 0 });
    }
    const first = summaries[0];
    for (const summary of summaries) expect(summary).toEqual(first);
    expect(first).toEqual({
      name: WORLD,
      seed: SEED,
      tick: 123_456,
      // 123 456 ticks / 28 800 ticks per in-game day, 1-based.
      day: 5,
      savedAtMs: NOW,
      playerCount: 1,
      sizeBytes: 0,
    });
  });

  it('stores the same JSON the SQLite backend hands back', async () => {
    const sqliteEntry = stores.find((entry) => entry.label === 'sqlite');
    expect(sqliteEntry).toBeDefined();
    const sqliteRepository = sqliteEntry?.repository;
    if (!sqliteRepository) return;

    const worldDir = join(fsRoot, WORLD);

    // Parse the raw bytes the filesystem backend wrote, with no repository involved,
    // and compare them to what the database returns. Equal parsed objects here is what
    // "identical format" means in practice: a converter between the two backends would
    // be a straight copy.
    const rawMeta = JSON.parse(await readFile(join(worldDir, METADATA_FILE), 'utf8')) as unknown;
    expect(rawMeta).toEqual(await sqliteRepository.loadMeta());

    const rawPlayer = JSON.parse(
      await readFile(join(worldDir, PLAYERS_DIR, 'alice.json'), 'utf8'),
    ) as unknown;
    expect(rawPlayer).toEqual(await sqliteRepository.loadPlayer('alice'));

    for (const chunk of chunks) {
      const path = join(
        worldDir,
        CHUNKS_DIR,
        chunkShardName(chunk.cx),
        chunkFileName(chunk.cx, chunk.cy),
      );
      const rawChunk = JSON.parse(await readFile(path, 'utf8')) as unknown;
      expect(rawChunk).toEqual(await sqliteRepository.loadChunk(chunk.cx, chunk.cy));
    }
  });

  it('reopens a world written by one backend with the same backend after a move', async () => {
    // A world folder is self-describing: closing every handle and reopening from the
    // root alone must produce the same world, which is the prerequisite for zipping it
    // up and handing it to a dedicated server.
    for (const { label, store, repository } of stores) {
      await repository.close();
      const reopened = await store.openWorld(WORLD);
      openRepositories.push(reopened);
      expect(await reopened.loadMeta(), label).toEqual(meta);
      expect(await reopened.loadChunk(-7, 12), label).toEqual(makeChunk(-7, 12));
      expect(await reopened.loadPlayer('alice'), label).toEqual(player);
    }
  });
});
