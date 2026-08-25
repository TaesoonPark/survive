import {
  SAVE_FORMAT_VERSION,
  TICKS_PER_GAME_DAY,
  WORLD_START_TICK,
  createRngState,
} from '@survive/protocol';
import type {
  ChunkDynamicPayload,
  PlayerId,
  PlayerSavePayload,
  WeatherState,
  WorldMetaPayload,
  WorldSummary,
} from '@survive/protocol';

/**
 * The persistence contract (spec section 31).
 *
 * Game logic never sees a database, a file path or a connection string: it holds a
 * {@link WorldRepository} and passes DTOs from `@survive/protocol` through it. That is
 * what lets the same `GameServer` run single-player against a folder of JSON and a
 * dedicated server against SQLite, and what lets every headless test run against the
 * in-memory backend at full speed (Architecture Guard rule 11).
 *
 * Nothing in this file may mention a backend. If a type here would have to change to
 * add a fourth backend, it is in the wrong file.
 */

/** Cheap size/occupancy report, for the world list and for save-time logging. */
export interface RepositoryStats {
  chunkCount: number;
  playerCount: number;
  /** Bytes the world occupies in its backing store. Best-effort, display only. */
  sizeBytes: number;
}

/**
 * Read/write access to exactly one world.
 *
 * Every method is async even where a backend could answer synchronously, so that
 * callers are written against the slowest plausible backend and swapping one in never
 * changes call sites.
 *
 * Static terrain is deliberately absent: it is a pure function of the seed and is
 * regenerated on load (spec section 29). Only the dynamic layer round-trips.
 */
export interface WorldRepository {
  /**
   * Prepare the backing store (create directories, open the database, run schema
   * setup). Idempotent: calling it on an already-open repository is a no-op, so a
   * repository handed back by {@link SaveStore.openWorld} can be opened again
   * harmlessly.
   */
  open(): Promise<void>;
  /** Release handles. Further calls throw; re-open through the store instead. */
  close(): Promise<void>;

  loadMeta(): Promise<WorldMetaPayload | null>;
  saveMeta(meta: WorldMetaPayload): Promise<void>;

  loadChunk(cx: number, cy: number): Promise<ChunkDynamicPayload | null>;
  saveChunk(payload: ChunkDynamicPayload): Promise<void>;
  /**
   * Save many chunks as one unit of work. Backends that can batch (a transaction, a
   * bounded write pool) do; the result is identical to calling {@link saveChunk} for
   * each payload in order, which is what an autosave sweep wants.
   */
  saveChunks(payloads: readonly ChunkDynamicPayload[]): Promise<void>;

  loadPlayer(id: PlayerId): Promise<PlayerSavePayload | null>;
  savePlayer(payload: PlayerSavePayload): Promise<void>;
  /** Ids of every persisted player, ascending. Stable order so callers can diff. */
  listPlayers(): Promise<PlayerId[]>;
  /** Remove a player. Deleting an unknown id succeeds; the end state is the same. */
  deletePlayer(id: PlayerId): Promise<void>;

  /**
   * Push anything still buffered all the way down to durable storage. Call it at the
   * end of an autosave and before a clean shutdown.
   */
  flush(): Promise<void>;

  stats(): Promise<RepositoryStats>;
}

/**
 * The set of worlds a host knows about: a saves directory, or a test's memory.
 *
 * The single-player launcher and the dedicated server talk to this identically, which
 * is the mechanism behind spec section 32 world portability.
 */
export interface SaveStore {
  /** Summaries for the "load world" list, newest save first. */
  listWorlds(): Promise<WorldSummary[]>;
  /** Open an existing world. Rejects if it does not exist. */
  openWorld(name: string): Promise<WorldRepository>;
  /** Create and open a new world, writing its initial metadata. Rejects if it exists. */
  createWorld(name: string, seed: number): Promise<WorldRepository>;
  /** Delete a world and everything in it. Deleting a missing world succeeds. */
  deleteWorld(name: string): Promise<void>;
  worldExists(name: string): Promise<boolean>;
}

/** Options every backend accepts. */
export interface SaveStoreOptions {
  /**
   * Wall-clock source for the display-only `createdAtMs`/`savedAtMs` stamps. Injected
   * so tests can produce stable summaries; the simulation itself never reads it, and
   * no gameplay decision may depend on it.
   */
  now?: () => number;
}

/** A world was asked for that the store does not have. */
export class WorldNotFoundError extends Error {
  readonly worldName: string;

  constructor(worldName: string) {
    super(`World not found: ${worldName}`);
    this.name = 'WorldNotFoundError';
    this.worldName = worldName;
  }
}

/** A world was created that the store already has. */
export class WorldExistsError extends Error {
  readonly worldName: string;

  constructor(worldName: string) {
    super(`World already exists: ${worldName}`);
    this.name = 'WorldExistsError';
    this.worldName = worldName;
  }
}

/** A repository method was called after {@link WorldRepository.close}. */
export class RepositoryClosedError extends Error {
  constructor(worldName: string) {
    super(`World repository for "${worldName}" is closed`);
    this.name = 'RepositoryClosedError';
  }
}

/**
 * True when a chunk holds nothing worth a write: no dynamic content and no record of
 * one-time population having run.
 *
 * Backends skip storing these (and drop any record they already had). A 256x256-chunk
 * world is 65 536 chunks; writing an empty file for every chunk a player ever walked
 * past would dwarf the actual save. `populated` is the important half of the test: a
 * chunk whose trees have all been chopped down is *empty* but must still be stored, or
 * reloading it would regrow the forest.
 */
export function isChunkPayloadEmpty(payload: ChunkDynamicPayload): boolean {
  return (
    !payload.populated &&
    payload.overrides.length === 0 &&
    payload.structures.length === 0 &&
    payload.nodes.length === 0 &&
    payload.items.length === 0 &&
    payload.zombies.length === 0 &&
    payload.animals.length === 0
  );
}

/**
 * Day number (1-based) that `tick` falls in: whole in-game days elapsed, plus one.
 *
 * Derived from `tick` alone because that is all {@link WorldMetaPayload} carries about
 * time, and it is display-only - the load screen's "Day 4". It is deliberately *not*
 * claimed to equal `WorldTimeState.day`: a new world starts at 08:00, so the
 * simulation's day rolls over eight in-game hours before this one does and the two
 * disagree for the last third of every day. Fixing that properly means the clock owner
 * either putting the day on the save payload or exposing the start-of-day offset as a
 * protocol constant; duplicating the offset here would silently rot the first time the
 * clock changed.
 */
export function dayFromTick(tick: number): number {
  return Math.floor(Math.max(0, tick) / TICKS_PER_GAME_DAY) + 1;
}

/**
 * Metadata for a brand-new world.
 *
 * Lives here rather than in a backend because "what a new world looks like" is part of
 * the store contract: all three backends must create byte-identical starting worlds,
 * or a world created single-player would not open the same way on a dedicated server.
 *
 * The weather is a placeholder the weather system overwrites on its first tick; it is
 * present only so the payload is complete and `nextChangeTick: 0` forces that first
 * roll to happen immediately.
 */
export function createInitialWorldMeta(
  name: string,
  seed: number,
  nowMs: number = Date.now(),
): WorldMetaPayload {
  const weather: WeatherState = {
    type: 'clear',
    intensity: 0,
    temperature: 15,
    windAngle: 0,
    windSpeed: 0,
    nextChangeTick: 0,
    lightning: false,
  };
  return {
    version: SAVE_FORMAT_VERSION,
    name,
    seed,
    // A brand-new world begins on the morning of day 1, not at midnight: the world clock
    // is derived from the tick, so tick 0 would drop a fresh player into the dark. This
    // is the one definition of "when a world starts", shared by the server, the launcher
    // and the tests - a stub meta stamped 0 here would silently rewind the clock the
    // first time the server loaded it.
    tick: WORLD_START_TICK,
    weather,
    rng: createRngState(seed),
    // Entity ids start at 1 so that 0 can never be mistaken for a real id.
    nextId: 1,
    createdAtMs: nowMs,
    savedAtMs: nowMs,
    totalTicks: 0,
  };
}

/** Build the world-list entry for a world from its metadata plus measured sizes. */
export function worldSummaryFrom(
  meta: WorldMetaPayload,
  playerCount: number,
  sizeBytes: number,
): WorldSummary {
  return {
    name: meta.name,
    seed: meta.seed,
    tick: meta.tick,
    day: dayFromTick(meta.tick),
    savedAtMs: meta.savedAtMs,
    playerCount,
    sizeBytes,
  };
}

/** Code-unit string order. Locale-independent, so two hosts always agree. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort worlds the way the load screen wants them: most recently played first, ties
 * broken by name so the order never depends on directory iteration order.
 */
export function sortWorldSummaries(summaries: WorldSummary[]): WorldSummary[] {
  return summaries.sort((a, b) =>
    b.savedAtMs !== a.savedAtMs ? b.savedAtMs - a.savedAtMs : compareStrings(a.name, b.name),
  );
}
