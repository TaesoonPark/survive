import { access, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type {
  ChunkDynamicPayload,
  PlayerId,
  PlayerSavePayload,
  WorldMetaPayload,
  WorldSummary,
} from '@survive/protocol';
import { migrateChunk, migrateMeta, migratePlayer } from './migrate';
import {
  CHUNKS_DIR,
  METADATA_FILE,
  PLAYERS_DIR,
  TEMP_SUFFIX,
  assertSafeName,
  chunkFileName,
  chunkShardName,
  isSafeName,
  parseChunkFileName,
  parsePlayerFileName,
  playerFileName,
} from './paths';
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
 * Filesystem backend: one folder per world, pretty-printed JSON inside.
 *
 * The default for single-player, and the format a player can zip up and mail to a
 * friend or drop onto a dedicated server (spec section 32). It is deliberately the
 * dumbest possible store - a human can read it, `git diff` it, and delete one broken
 * chunk file without losing the world.
 *
 * Layout is spec section 30, described in `paths.ts`.
 */

/** Concurrency cap for batched writes. See {@link fileSystemRepository}.`saveChunks`. */
const WRITE_CONCURRENCY = 8;

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Serialize a record into the exact bytes that will land on disk.
 *
 * Split out from the write so that every caller can do it *before* its first `await`.
 * The payloads handed to this repository alias live simulation state - the simulation's
 * chunk serializer returns the real entity objects, not copies - and the server starts
 * an autosave without awaiting it, so the tick loop keeps mutating those objects while
 * the write queue drains. Capturing the bytes up front is what makes a save a snapshot
 * of one tick instead of a smear across however many ticks the queue took, and it is
 * what makes this backend agree with the in-memory and SQLite ones, which are
 * synchronous internally and therefore snapshot at call time for free.
 */
function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write pre-encoded text so that a crash can never leave a half-written file in place.
 *
 * Write to `<path>.tmp`, fsync it, then `rename` over the target. Rename is atomic
 * within a filesystem, so a reader sees either the whole old file or the whole new
 * one; the fsync is what makes the *contents* survive a power cut rather than just a
 * process kill. The directory entry the rename creates needs its own fsync, which
 * `flush()` does per directory. A `.tmp` file left behind by a crash is inert -
 * nothing reads that name (see `parseChunkFileName`) - and the next successful save
 * replaces it.
 */
async function atomicWriteText(path: string, text: string): Promise<void> {
  const tempPath = `${path}${TEMP_SUFFIX}`;
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
}

/**
 * fsync a directory so the renames inside it are durable.
 *
 * Best effort by design: Windows cannot open a directory as a file at all, and some
 * filesystems reject fsync on a directory handle. Failing here would turn a
 * durability optimisation into a save error, and the data itself was already synced
 * before the rename, so every failure path is silent on purpose.
 */
async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, 'r');
  } catch {
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Directory fsync unsupported here; nothing further to do.
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Parse a JSON file, or `null` when it does not exist. */
async function readJsonFile<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return null;
    throw error;
  }
  return JSON.parse(text) as T;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Directory entries, or `[]` when the directory is absent. */
async function readdirSafe(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) return [];
    throw error;
  }
}

/** Total bytes of every regular file under `dir`, leftover temp files included. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdirSafe(dir)) {
    const child = join(dir, entry.name);
    if (entry.isDir) {
      total += await directorySize(child);
      continue;
    }
    try {
      total += (await stat(child)).size;
    } catch (error) {
      // A file that vanished under us (another process's rename) contributes zero.
      if (!isErrnoCode(error, 'ENOENT')) throw error;
    }
  }
  return total;
}

/** Run `task` over `items`, at most `limit` in flight, preserving failure. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers: Array<Promise<void>> = [];
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      await task(item);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(runWorker());
  await Promise.all(workers);
}

function fileSystemRepository(worldDir: string, worldName: string): WorldRepository {
  const metaPath = join(worldDir, METADATA_FILE);
  const playersDir = join(worldDir, PLAYERS_DIR);
  const chunksDir = join(worldDir, CHUNKS_DIR);
  let closed = false;

  const alive = (): void => {
    if (closed) throw new RepositoryClosedError(worldName);
  };

  /**
   * In-flight write per target path.
   *
   * Two overlapping saves of the same record - an autosave sweep and a player
   * disconnect writing the same `players/alice.json`, say - would both open the one
   * `.tmp` name, interleave their bytes and then rename the mixture into place. The
   * atomic write protects against crashes, not against itself; chaining writes to the
   * same path is what makes concurrent callers safe. Different paths still run in
   * parallel, which is where the throughput is.
   */
  const inFlight = new Map<string, Promise<void>>();

  /**
   * Whole operations still outstanding, one entry per call rather than per file.
   *
   * `flush()` needs both this and `inFlight`. A `saveChunks` sweep of 300 chunks only
   * ever has {@link WRITE_CONCURRENCY} files in `inFlight` at once; the other 292 are
   * queued inside `forEachLimited` where nothing else can see them, so a flush that
   * waited only on `inFlight` would return - and let the caller exit - with most of
   * the batch unwritten.
   */
  const pending = new Set<Promise<void>>();

  /**
   * Directories whose entries changed since the last flush.
   *
   * A rename is atomic but its directory entry is only durable once the directory
   * itself is fsynced. Collected and synced once per directory in `flush()` rather
   * than after every write: an autosave sweep touches a few hundred shard directories
   * but thousands of files.
   */
  const dirtyDirs = new Set<string>();

  const track = (work: Promise<void>): Promise<void> => {
    // The tracked copy never rejects. `flush()` must not turn one failed save into an
    // unhandled rejection, and the failure still reaches the caller that started the
    // write through the promise returned here.
    const settled = work.then(
      () => {},
      () => {},
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return work;
  };

  const serializeByPath = async (path: string, task: () => Promise<void>): Promise<void> => {
    const previous = inFlight.get(path);
    const run = (async (): Promise<void> => {
      // A failed predecessor must not cancel this write, only order it.
      if (previous) await previous.catch(() => {});
      await task();
    })();
    // The link stored for the next writer never rejects, so one failure cannot poison
    // the chain or produce an unhandled rejection.
    const link = run.catch(() => {});
    inFlight.set(path, link);
    try {
      await run;
    } finally {
      if (inFlight.get(path) === link) inFlight.delete(path);
    }
  };

  const chunkPath = (cx: number, cy: number): string =>
    join(chunksDir, chunkShardName(cx), chunkFileName(cx, cy));

  const playerPath = (id: PlayerId): string =>
    join(playersDir, playerFileName(assertSafeName('player', id)));

  const listPlayerIds = async (): Promise<PlayerId[]> => {
    const ids: PlayerId[] = [];
    for (const entry of await readdirSafe(playersDir)) {
      if (entry.isDir) continue;
      const id = parsePlayerFileName(entry.name);
      if (id !== null) ids.push(id);
    }
    return ids.sort(compareStrings);
  };

  /** A chunk write whose bytes are already captured. `json === null` means "delete". */
  interface ChunkWrite {
    path: string;
    shard: string;
    json: string | null;
  }

  /**
   * Decide and serialize a chunk write, synchronously.
   *
   * Both halves have to happen before the first `await`: the empty-chunk decision
   * reads the payload's arrays and the JSON reads everything else, so sampling either
   * one later would record a payload the simulation has already moved on from.
   */
  const prepareChunk = (payload: ChunkDynamicPayload): ChunkWrite => ({
    path: chunkPath(payload.cx, payload.cy),
    shard: join(chunksDir, chunkShardName(payload.cx)),
    json: isChunkPayloadEmpty(payload) ? null : encodeJson(payload),
  });

  const runChunkWrite = (write: ChunkWrite): Promise<void> =>
    serializeByPath(write.path, async () => {
      dirtyDirs.add(write.shard);
      if (write.json === null) {
        // Nothing to store. Drop any file we already had, so a chunk that has genuinely
        // been reset does not come back from a stale save on the next load.
        await rm(write.path, { force: true });
        return;
      }
      await mkdir(write.shard, { recursive: true });
      await atomicWriteText(write.path, write.json);
    });

  return {
    async open(): Promise<void> {
      alive();
      await mkdir(worldDir, { recursive: true });
      await mkdir(playersDir, { recursive: true });
      await mkdir(chunksDir, { recursive: true });
    },

    async close(): Promise<void> {
      // There are no handles to release: every awaited write was fsynced and renamed
      // before it resolved, and the flag exists only to catch use-after-close. Closing
      // does *not* wait for work a caller started without awaiting - `flush()` is what
      // does that, which is why a clean shutdown flushes first.
      closed = true;
    },

    async loadMeta(): Promise<WorldMetaPayload | null> {
      alive();
      const raw = await readJsonFile<WorldMetaPayload>(metaPath);
      return raw === null ? null : migrateMeta(raw);
    },

    async saveMeta(meta: WorldMetaPayload): Promise<void> {
      alive();
      const json = encodeJson(meta);
      await track(
        serializeByPath(metaPath, async () => {
          dirtyDirs.add(worldDir);
          await mkdir(worldDir, { recursive: true });
          await atomicWriteText(metaPath, json);
        }),
      );
    },

    async loadChunk(cx: number, cy: number): Promise<ChunkDynamicPayload | null> {
      alive();
      const raw = await readJsonFile<ChunkDynamicPayload>(chunkPath(cx, cy));
      return raw === null ? null : migrateChunk(raw);
    },

    async saveChunk(payload: ChunkDynamicPayload): Promise<void> {
      alive();
      await track(runChunkWrite(prepareChunk(payload)));
    },

    async saveChunks(payloads: readonly ChunkDynamicPayload[]): Promise<void> {
      alive();
      // Encode the whole batch in one synchronous pass before any of it is written, so
      // the sweep records a single tick even though draining it takes many, and so a
      // payload that cannot be serialized at all fails before a file has been touched.
      const writes = payloads.map((payload) => prepareChunk(payload));
      // An autosave sweep can hand over hundreds of chunks. Unbounded `Promise.all`
      // would open a file descriptor per chunk and hit EMFILE on the platforms with
      // the tightest limits; a small pool is faster than serial and never does.
      await track(forEachLimited(writes, WRITE_CONCURRENCY, runChunkWrite));
    },

    async loadPlayer(id: PlayerId): Promise<PlayerSavePayload | null> {
      alive();
      const raw = await readJsonFile<PlayerSavePayload>(playerPath(id));
      return raw === null ? null : migratePlayer(raw);
    },

    async savePlayer(payload: PlayerSavePayload): Promise<void> {
      alive();
      const path = playerPath(payload.player.id);
      const json = encodeJson(payload);
      await track(
        serializeByPath(path, async () => {
          dirtyDirs.add(playersDir);
          await mkdir(playersDir, { recursive: true });
          await atomicWriteText(path, json);
        }),
      );
    },

    async listPlayers(): Promise<PlayerId[]> {
      alive();
      return listPlayerIds();
    },

    async deletePlayer(id: PlayerId): Promise<void> {
      alive();
      const path = playerPath(id);
      await track(
        serializeByPath(path, async () => {
          dirtyDirs.add(playersDir);
          await rm(path, { force: true });
        }),
      );
    },

    async flush(): Promise<void> {
      alive();
      // Each write is fsynced before the rename that publishes it, so an awaited save
      // is already durable in content. What is left is any write a caller started
      // without awaiting - draining those is what makes `flush()` meaningful before a
      // shutdown - and the directory entries the renames created.
      //
      // Both sets are drained: `pending` for whole operations (a batch queued behind
      // the write pool is invisible to `inFlight`), `inFlight` for the per-path chains.
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...inFlight.values()]);
      const dirs = [...dirtyDirs];
      dirtyDirs.clear();
      await Promise.all(dirs.map((dir) => syncDirectory(dir)));
    },

    async stats(): Promise<RepositoryStats> {
      alive();
      let chunkCount = 0;
      for (const shard of await readdirSafe(chunksDir)) {
        if (!shard.isDir) continue;
        for (const file of await readdirSafe(join(chunksDir, shard.name))) {
          if (!file.isDir && parseChunkFileName(file.name) !== null) chunkCount++;
        }
      }
      const players = await listPlayerIds();
      return {
        chunkCount,
        playerCount: players.length,
        sizeBytes: await directorySize(worldDir),
      };
    },
  };
}

/**
 * A {@link SaveStore} over a saves directory.
 *
 * `rootDir` is created on demand, so pointing this at a fresh `~/.survive/saves` just
 * works.
 */
export function createFileSystemStore(rootDir: string, options: SaveStoreOptions = {}): SaveStore {
  const root = resolve(rootDir);
  const now = options.now ?? ((): number => Date.now());

  /**
   * Resolve a world folder, re-checking containment after normalisation.
   *
   * `assertSafeName` already rejects every traversal shape, so this is a second lock
   * on the same door - worth it because the caller of `deleteWorld` is an `rm -rf`
   * and a bug there deletes a player's whole saves directory.
   */
  const worldDirFor = (name: string): string => {
    assertSafeName('world', name);
    const dir = resolve(join(root, name));
    if (dir !== join(root, name) || !dir.startsWith(root + sep)) {
      throw new Error(`Refusing to use world path outside the saves root: ${name}`);
    }
    return dir;
  };

  const metaOf = async (name: string): Promise<WorldMetaPayload | null> => {
    const raw = await readJsonFile<WorldMetaPayload>(join(root, name, METADATA_FILE));
    return raw === null ? null : migrateMeta(raw);
  };

  return {
    async listWorlds(): Promise<WorldSummary[]> {
      const summaries: WorldSummary[] = [];
      for (const entry of await readdirSafe(root)) {
        // Unreadable names and stray files are skipped rather than thrown on: one bad
        // directory in the saves folder must not blank the whole world list.
        if (!entry.isDir || !isSafeName('world', entry.name)) continue;
        let meta: WorldMetaPayload | null;
        try {
          meta = await metaOf(entry.name);
        } catch {
          continue;
        }
        if (!meta) continue;
        const dir = join(root, entry.name);
        const players = await readdirSafe(join(dir, PLAYERS_DIR));
        const playerCount = players.filter(
          (file) => !file.isDir && parsePlayerFileName(file.name) !== null,
        ).length;
        summaries.push(worldSummaryFrom(meta, playerCount, await directorySize(dir)));
      }
      return sortWorldSummaries(summaries);
    },

    async worldExists(name: string): Promise<boolean> {
      // Presence of metadata, not of the directory: an empty folder someone made by
      // hand is not a world, and neither is a half-deleted one.
      return pathExists(join(worldDirFor(name), METADATA_FILE));
    },

    async openWorld(name: string): Promise<WorldRepository> {
      const dir = worldDirFor(name);
      if (!(await pathExists(join(dir, METADATA_FILE)))) throw new WorldNotFoundError(name);
      const repository = fileSystemRepository(dir, name);
      await repository.open();
      return repository;
    },

    async createWorld(name: string, seed: number): Promise<WorldRepository> {
      const dir = worldDirFor(name);
      if (await pathExists(join(dir, METADATA_FILE))) throw new WorldExistsError(name);
      const repository = fileSystemRepository(dir, name);
      await repository.open();
      await repository.saveMeta(createInitialWorldMeta(name, seed, now()));
      return repository;
    },

    async deleteWorld(name: string): Promise<void> {
      await rm(worldDirFor(name), { recursive: true, force: true });
    },
  };
}
