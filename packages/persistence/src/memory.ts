import { chunkKey } from '@survive/protocol';
import type {
  ChunkDynamicPayload,
  PlayerId,
  PlayerSavePayload,
  WorldMetaPayload,
  WorldSummary,
} from '@survive/protocol';
import { migrateChunk, migrateMeta, migratePlayer } from './migrate';
import { assertSafeName } from './paths';
import {
  RepositoryClosedError,
  WorldExistsError,
  WorldNotFoundError,
  compareStrings,
  createInitialWorldMeta,
  isChunkPayloadEmpty,
  sortWorldSummaries,
  worldSummaryFrom,
} from './types';
import type { RepositoryStats, SaveStore, SaveStoreOptions, WorldRepository } from './types';

/**
 * In-memory backend. The default for every headless test.
 *
 * Records are held as **JSON strings**, not objects. That does the deep clone the
 * interface promises in both directions for free, and - the reason it is worth doing
 * this way rather than with `structuredClone` - it makes the memory backend fail on
 * exactly the same things the disk backends fail on. A `Map`, a class instance or a
 * `Date` that leaks into gameplay state (Architecture Guard rule 6) comes back mangled
 * here just as it would from a file, so the fast test catches it instead of a
 * dedicated server discovering it at 3am.
 */

/** One world's stored bytes. Survives `close()`, like a folder on disk does. */
interface MemoryWorld {
  name: string;
  meta: string | null;
  chunks: Map<string, string>;
  players: Map<PlayerId, string>;
}

function createMemoryWorld(name: string): MemoryWorld {
  return { name, meta: null, chunks: new Map(), players: new Map() };
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}

/** Bytes a record would occupy if written out. Keeps `stats()` honest-ish. */
function byteLength(json: string): number {
  return Buffer.byteLength(json, 'utf8');
}

function worldSizeBytes(world: MemoryWorld): number {
  let total = world.meta === null ? 0 : byteLength(world.meta);
  for (const json of world.chunks.values()) total += byteLength(json);
  for (const json of world.players.values()) total += byteLength(json);
  return total;
}

function repositoryFor(world: MemoryWorld): WorldRepository {
  let closed = false;

  const alive = (): MemoryWorld => {
    if (closed) throw new RepositoryClosedError(world.name);
    return world;
  };

  return {
    async open(): Promise<void> {
      // Re-opening a repository that was closed would hand out a stale view of a
      // world the store may have replaced; go back through the store instead.
      if (closed) throw new RepositoryClosedError(world.name);
    },

    async close(): Promise<void> {
      closed = true;
    },

    async loadMeta(): Promise<WorldMetaPayload | null> {
      const json = alive().meta;
      return json === null ? null : migrateMeta(decode<WorldMetaPayload>(json));
    },

    async saveMeta(meta: WorldMetaPayload): Promise<void> {
      alive().meta = encode(meta);
    },

    async loadChunk(cx: number, cy: number): Promise<ChunkDynamicPayload | null> {
      const json = alive().chunks.get(chunkKey(cx, cy));
      return json === undefined ? null : migrateChunk(decode<ChunkDynamicPayload>(json));
    },

    async saveChunk(payload: ChunkDynamicPayload): Promise<void> {
      const store = alive();
      const key = chunkKey(payload.cx, payload.cy);
      if (isChunkPayloadEmpty(payload)) {
        store.chunks.delete(key);
        return;
      }
      store.chunks.set(key, encode(payload));
    },

    async saveChunks(payloads: readonly ChunkDynamicPayload[]): Promise<void> {
      const store = alive();
      // Encode the whole batch before applying any of it. A payload that cannot be
      // serialized then leaves the store untouched, which is the all-or-nothing the
      // SQLite backend gets from its transaction and the filesystem backend from
      // encoding the sweep up front. Applying as we go would make this the one backend
      // where a failed autosave leaves a mixture of two ticks - and the one backend the
      // headless tests run on, so nothing would ever notice.
      const writes = payloads.map((payload) => ({
        key: chunkKey(payload.cx, payload.cy),
        json: isChunkPayloadEmpty(payload) ? null : encode(payload),
      }));
      for (const write of writes) {
        if (write.json === null) store.chunks.delete(write.key);
        else store.chunks.set(write.key, write.json);
      }
    },

    async loadPlayer(id: PlayerId): Promise<PlayerSavePayload | null> {
      const json = alive().players.get(assertSafeName('player', id));
      return json === undefined ? null : migratePlayer(decode<PlayerSavePayload>(json));
    },

    async savePlayer(payload: PlayerSavePayload): Promise<void> {
      const store = alive();
      store.players.set(assertSafeName('player', payload.player.id), encode(payload));
    },

    async listPlayers(): Promise<PlayerId[]> {
      return [...alive().players.keys()].sort(compareStrings);
    },

    async deletePlayer(id: PlayerId): Promise<void> {
      alive().players.delete(assertSafeName('player', id));
    },

    async flush(): Promise<void> {
      // Nothing is buffered: every save has already landed in the map.
      alive();
    },

    async stats(): Promise<RepositoryStats> {
      const store = alive();
      return {
        chunkCount: store.chunks.size,
        playerCount: store.players.size,
        sizeBytes: worldSizeBytes(store),
      };
    },
  };
}

/**
 * A standalone in-memory world, not attached to any store.
 *
 * What a simulation unit test wants: `createMemoryRepository()` and go. Pass `meta` to
 * start from a world that already has metadata; otherwise `loadMeta()` returns `null`
 * until something saves some.
 */
export function createMemoryRepository(meta: WorldMetaPayload | null = null): WorldRepository {
  const world = createMemoryWorld(meta?.name ?? 'memory');
  if (meta) world.meta = encode(meta);
  return repositoryFor(world);
}

/**
 * An in-memory {@link SaveStore}.
 *
 * Worlds persist for the lifetime of the store, so open/close/reopen round-trips
 * behave the way they do on disk - which is what makes the shared conformance suite
 * meaningful for this backend at all.
 */
export function createMemoryStore(options: SaveStoreOptions = {}): SaveStore {
  const now = options.now ?? ((): number => Date.now());
  const worlds = new Map<string, MemoryWorld>();

  const summaryFor = (world: MemoryWorld): WorldSummary | null => {
    if (world.meta === null) return null;
    const meta = migrateMeta(decode<WorldMetaPayload>(world.meta));
    return worldSummaryFrom(meta, world.players.size, worldSizeBytes(world));
  };

  return {
    async listWorlds(): Promise<WorldSummary[]> {
      const summaries: WorldSummary[] = [];
      for (const world of worlds.values()) {
        // A world whose metadata this build cannot read is skipped, matching the disk
        // backends: one unreadable world must not blank the whole load-world list.
        try {
          const summary = summaryFor(world);
          if (summary) summaries.push(summary);
        } catch {
          continue;
        }
      }
      return sortWorldSummaries(summaries);
    },

    async worldExists(name: string): Promise<boolean> {
      return worlds.has(assertSafeName('world', name));
    },

    async openWorld(name: string): Promise<WorldRepository> {
      const world = worlds.get(assertSafeName('world', name));
      if (!world) throw new WorldNotFoundError(name);
      return repositoryFor(world);
    },

    async createWorld(name: string, seed: number): Promise<WorldRepository> {
      assertSafeName('world', name);
      if (worlds.has(name)) throw new WorldExistsError(name);
      const world = createMemoryWorld(name);
      world.meta = encode(createInitialWorldMeta(name, seed, now()));
      worlds.set(name, world);
      return repositoryFor(world);
    },

    async deleteWorld(name: string): Promise<void> {
      worlds.delete(assertSafeName('world', name));
    },
  };
}
