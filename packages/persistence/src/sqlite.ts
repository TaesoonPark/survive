import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
/**
 * Types only. `import type` is erased entirely, so naming `node:sqlite` here costs
 * nothing at runtime and cannot be what makes a SQLite-less Node fail to load this
 * module: the actual load is the guarded dynamic import in `loadSqliteModule`.
 */
import type * as NodeSqlite from 'node:sqlite';
import type {
  ChunkDynamicPayload,
  PlayerId,
  PlayerSavePayload,
  WorldMetaPayload,
  WorldSummary,
} from '@survive/protocol';
import { migrateChunk, migrateMeta, migratePlayer } from './migrate';
import { WORLD_DB_FILE, assertSafeName, isSafeName } from './paths';
import {
  RepositoryClosedError,
  WorldExistsError,
  WorldNotFoundError,
  createInitialWorldMeta,
  isChunkPayloadEmpty,
  sortWorldSummaries,
  worldSummaryFrom,
} from './types';
import type { RepositoryStats, SaveStore, SaveStoreOptions, WorldRepository } from './types';

/**
 * SQLite backend: one `world.db` per world, inside the same world folder the
 * filesystem backend uses.
 *
 * The default for dedicated servers, where a single autosave can touch hundreds of
 * chunks and the transaction is worth more than the human-readable files. The stored
 * *payloads* are byte-for-byte the same JSON the filesystem backend writes, so a world
 * is portable between the two at the DTO level (spec section 32) even though the
 * container differs.
 *
 * `node:sqlite` is an experimental Node builtin. It is therefore loaded lazily and
 * defensively: {@link isSqliteAvailable} tells the server whether it can use this
 * backend at all, so a Node build without SQLite compiled in degrades to the
 * filesystem backend with a warning instead of failing to boot.
 */

type SqliteModule = typeof NodeSqlite;
type Database = NodeSqlite.DatabaseSync;

const META_ROW_KEY = 'world';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  cx   INTEGER NOT NULL,
  cy   INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (cx, cy)
);
CREATE TABLE IF NOT EXISTS players (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

let modulePromise: Promise<SqliteModule | null> | null = null;

/**
 * Load `node:sqlite` once, resolving to `null` if this Node cannot provide it.
 *
 * The import is inside a `try`/`catch` because on a Node built without SQLite (or an
 * older one where the module is behind a flag) the *import itself* throws, and that
 * must not be a fatal error for a server that has a perfectly good fallback.
 */
async function loadSqliteModule(): Promise<SqliteModule | null> {
  if (!modulePromise) {
    modulePromise = (async (): Promise<SqliteModule | null> => {
      try {
        return await import('node:sqlite');
      } catch {
        return null;
      }
    })();
  }
  return modulePromise;
}

/**
 * Whether the SQLite backend can be used in this process.
 *
 * Async because the lazy import is: check it once at startup, before choosing a
 * backend, and log a warning on the fallback path.
 */
export async function isSqliteAvailable(): Promise<boolean> {
  return (await loadSqliteModule()) !== null;
}

async function requireSqliteModule(): Promise<SqliteModule> {
  const loaded = await loadSqliteModule();
  if (!loaded) {
    throw new Error(
      'node:sqlite is not available in this Node build. ' +
        'Check isSqliteAvailable() and fall back to createFileSystemStore().',
    );
  }
  return loaded;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read a single TEXT column out of a row, tolerating a missing row. */
function textColumn(row: Record<string, unknown> | undefined, column: string): string | null {
  if (!row) return null;
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/** Read a single INTEGER column, which `node:sqlite` may hand back as a bigint. */
function intColumn(row: Record<string, unknown> | undefined, column: string): number {
  if (!row) return 0;
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function sqliteRepository(db: Database, worldName: string): WorldRepository {
  let open = true;

  const handle = (): Database => {
    if (!open) throw new RepositoryClosedError(worldName);
    return db;
  };

  /** Insert-or-replace, expressed as an upsert so the primary keys do the work. */
  const upsertChunk = (payload: ChunkDynamicPayload): void => {
    handle()
      .prepare(
        'INSERT INTO chunks (cx, cy, data) VALUES (?, ?, ?) ' +
          'ON CONFLICT(cx, cy) DO UPDATE SET data = excluded.data',
      )
      .run(payload.cx, payload.cy, JSON.stringify(payload));
  };

  const deleteChunk = (cx: number, cy: number): void => {
    handle().prepare('DELETE FROM chunks WHERE cx = ? AND cy = ?').run(cx, cy);
  };

  const writeChunk = (payload: ChunkDynamicPayload): void => {
    // Same rule as the filesystem backend: an empty, unpopulated chunk is not stored,
    // and any row it used to have goes away with it.
    if (isChunkPayloadEmpty(payload)) deleteChunk(payload.cx, payload.cy);
    else upsertChunk(payload);
  };

  return {
    async open(): Promise<void> {
      // The database is opened by the store; this only rejects a reopen after close.
      if (!open) throw new RepositoryClosedError(worldName);
    },

    async close(): Promise<void> {
      if (!open) return;
      open = false;
      // Closing checkpoints and removes the WAL, which is what makes the world folder
      // safe to move or zip up immediately afterwards.
      db.close();
    },

    async loadMeta(): Promise<WorldMetaPayload | null> {
      const row = handle().prepare('SELECT value FROM meta WHERE key = ?').get(META_ROW_KEY);
      const json = textColumn(row, 'value');
      return json === null ? null : migrateMeta(JSON.parse(json) as WorldMetaPayload);
    },

    async saveMeta(meta: WorldMetaPayload): Promise<void> {
      handle()
        .prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(META_ROW_KEY, JSON.stringify(meta));
    },

    async loadChunk(cx: number, cy: number): Promise<ChunkDynamicPayload | null> {
      const row = handle().prepare('SELECT data FROM chunks WHERE cx = ? AND cy = ?').get(cx, cy);
      const json = textColumn(row, 'data');
      return json === null ? null : migrateChunk(JSON.parse(json) as ChunkDynamicPayload);
    },

    async saveChunk(payload: ChunkDynamicPayload): Promise<void> {
      writeChunk(payload);
    },

    async saveChunks(payloads: readonly ChunkDynamicPayload[]): Promise<void> {
      const database = handle();
      if (payloads.length === 0) return;
      // One transaction for the whole sweep: an autosave that dies half way through
      // leaves the world at the previous tick rather than at a mixture of two, and it
      // is roughly an order of magnitude faster than one commit per chunk.
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const payload of payloads) writeChunk(payload);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    async loadPlayer(id: PlayerId): Promise<PlayerSavePayload | null> {
      const row = handle()
        .prepare('SELECT data FROM players WHERE id = ?')
        .get(assertSafeName('player', id));
      const json = textColumn(row, 'data');
      return json === null ? null : migratePlayer(JSON.parse(json) as PlayerSavePayload);
    },

    async savePlayer(payload: PlayerSavePayload): Promise<void> {
      handle()
        .prepare(
          'INSERT INTO players (id, data) VALUES (?, ?) ' +
            'ON CONFLICT(id) DO UPDATE SET data = excluded.data',
        )
        .run(assertSafeName('player', payload.player.id), JSON.stringify(payload));
    },

    async listPlayers(): Promise<PlayerId[]> {
      // ORDER BY on the TEXT primary key gives the same code-unit order the other
      // backends sort into, so callers can diff the two lists.
      const rows = handle().prepare('SELECT id FROM players ORDER BY id ASC').all();
      const ids: PlayerId[] = [];
      for (const row of rows) {
        const id = textColumn(row, 'id');
        if (id !== null) ids.push(id);
      }
      return ids;
    },

    async deletePlayer(id: PlayerId): Promise<void> {
      handle().prepare('DELETE FROM players WHERE id = ?').run(assertSafeName('player', id));
    },

    async flush(): Promise<void> {
      // In WAL mode a committed transaction lives in `world.db-wal` until a
      // checkpoint folds it back into the main file. Autosave calls this so that the
      // world folder on disk is a complete world at that moment, not a base file plus
      // a log a different tool would have to know about.
      handle().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    },

    async stats(): Promise<RepositoryStats> {
      const database = handle();
      const chunkCount = intColumn(database.prepare('SELECT COUNT(*) AS n FROM chunks').get(), 'n');
      const playerCount = intColumn(
        database.prepare('SELECT COUNT(*) AS n FROM players').get(),
        'n',
      );
      const pageCount = intColumn(database.prepare('PRAGMA page_count').get(), 'page_count');
      const pageSize = intColumn(database.prepare('PRAGMA page_size').get(), 'page_size');
      return {
        chunkCount,
        playerCount,
        // Pages rather than a `stat` of the file: it counts the pending WAL too, so the
        // number does not jump around depending on when the last checkpoint ran.
        sizeBytes: pageCount * pageSize,
      };
    },
  };
}

/** Open (creating if needed) the database for a world folder and apply the schema. */
async function openDatabase(worldDir: string): Promise<Database> {
  const sqlite = await requireSqliteModule();
  await mkdir(worldDir, { recursive: true });
  const dbPath = join(worldDir, WORLD_DB_FILE);
  const db = new sqlite.DatabaseSync(dbPath);
  // WAL survives a crash without the torn-page risk of the rollback journal, and lets
  // a read (the world list) run while an autosave writes. NORMAL sync is the standard
  // pairing: durable across a process crash, and a lost power cut costs at most the
  // last transaction - a fraction of a second of gameplay.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  // Schema is (re)applied on every open so a world created by an older build gains
  // any table added since without a separate migration step.
  db.exec(SCHEMA);
  return db;
}

/**
 * A {@link SaveStore} backed by one SQLite database per world.
 *
 * Uses the same `<root>/<world>/` folder layout as {@link createFileSystemStore}, so
 * the two can share a saves directory and a world stays identifiable either way.
 */
export function createSqliteStore(rootDir: string, options: SaveStoreOptions = {}): SaveStore {
  const root = resolve(rootDir);
  const now = options.now ?? ((): number => Date.now());

  /** Same containment double-check as the filesystem store; `deleteWorld` is an rm. */
  const worldDirFor = (name: string): string => {
    assertSafeName('world', name);
    const dir = resolve(join(root, name));
    if (dir !== join(root, name) || !dir.startsWith(root + sep)) {
      throw new Error(`Refusing to use world path outside the saves root: ${name}`);
    }
    return dir;
  };

  const dbPathFor = (name: string): string => join(worldDirFor(name), WORLD_DB_FILE);

  const openExisting = async (name: string): Promise<WorldRepository> => {
    const dir = worldDirFor(name);
    if (!(await pathExists(join(dir, WORLD_DB_FILE)))) throw new WorldNotFoundError(name);
    return sqliteRepository(await openDatabase(dir), name);
  };

  return {
    async listWorlds(): Promise<WorldSummary[]> {
      let entries: Array<{ name: string; isDir: boolean }>;
      try {
        entries = (await readdir(root, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDir: entry.isDirectory(),
        }));
      } catch {
        return [];
      }
      const summaries: WorldSummary[] = [];
      for (const entry of entries) {
        if (!entry.isDir || !isSafeName('world', entry.name)) continue;
        if (!(await pathExists(join(root, entry.name, WORLD_DB_FILE)))) continue;
        // A world with an unreadable or future-format database is skipped, not thrown
        // on: one bad world must not blank the whole list.
        try {
          const repository = await openExisting(entry.name);
          try {
            const meta = await repository.loadMeta();
            if (!meta) continue;
            const stats = await repository.stats();
            summaries.push(worldSummaryFrom(meta, stats.playerCount, stats.sizeBytes));
          } finally {
            await repository.close();
          }
        } catch {
          continue;
        }
      }
      return sortWorldSummaries(summaries);
    },

    async worldExists(name: string): Promise<boolean> {
      return pathExists(dbPathFor(name));
    },

    async openWorld(name: string): Promise<WorldRepository> {
      return openExisting(name);
    },

    async createWorld(name: string, seed: number): Promise<WorldRepository> {
      const dir = worldDirFor(name);
      if (await pathExists(join(dir, WORLD_DB_FILE))) throw new WorldExistsError(name);
      const repository = sqliteRepository(await openDatabase(dir), name);
      await repository.saveMeta(createInitialWorldMeta(name, seed, now()));
      return repository;
    },

    async deleteWorld(name: string): Promise<void> {
      // Removes the folder, and with it `world.db` plus any `-wal`/`-shm` sidecars.
      await rm(worldDirFor(name), { recursive: true, force: true });
    },
  };
}
