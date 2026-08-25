import { SAVE_FORMAT_VERSION } from '@survive/protocol';
import type { ChunkDynamicPayload, PlayerSavePayload, WorldMetaPayload } from '@survive/protocol';

/**
 * Save-format migration.
 *
 * Records are stamped with `version` when written and upgraded when read, one step at
 * a time, so a world saved by any past build opens in the current one. Today every
 * record is at {@link SAVE_FORMAT_VERSION} = 1 and the step tables are empty, which
 * makes these functions validating pass-throughs. The machinery exists now so that
 * adding the first real migration is a table entry rather than a redesign.
 *
 * Migration runs on **load only**. Writes store whatever version the caller stamped,
 * verbatim: the disk format is the source of truth, and rewriting a record on the way
 * in would mean a save could never be inspected or diffed against what produced it.
 *
 * A record from the *future* is a hard error. Downgrading is not something we can do
 * safely - the new build may have added fields this build would silently drop - and a
 * player who opens their world in an older client deserves "this save is newer than
 * this build" rather than a world with their base quietly missing.
 */

/** Which kind of record failed, so the message can name it. */
export type SaveRecordKind = 'meta' | 'chunk' | 'player';

/** Why a record could not be read. */
export type SaveVersionProblem =
  /** `version` was absent, fractional, negative or not a number. */
  | 'malformed'
  /** Written by a newer build than this one. */
  | 'too-new'
  /** Old enough that the migration chain no longer covers it. */
  | 'no-migration-path';

/** A stored record cannot be brought up to {@link SAVE_FORMAT_VERSION}. */
export class SaveFormatError extends Error {
  readonly kind: SaveRecordKind;
  readonly problem: SaveVersionProblem;
  /** Version found in the record. */
  readonly found: number;
  /** Version this build reads and writes. */
  readonly supported: number;

  constructor(kind: SaveRecordKind, problem: SaveVersionProblem, found: number, detail: string) {
    super(`Cannot read ${kind} save: ${detail}`);
    this.name = 'SaveFormatError';
    this.kind = kind;
    this.problem = problem;
    this.found = found;
    this.supported = SAVE_FORMAT_VERSION;
  }
}

/**
 * One upgrade step. Keyed by the version it reads; it must return the same record at
 * `version + 1`.
 */
type MigrationStep<T> = (record: T) => T;

/** Steps for one record kind, keyed by the version they upgrade *from*. */
type MigrationTable<T> = ReadonlyMap<number, MigrationStep<T>>;

/**
 * Chunk migrations.
 *
 * To add one when bumping `SAVE_FORMAT_VERSION` to 2, register the 1 -> 2 step:
 *
 * ```ts
 * const CHUNK_MIGRATIONS = new Map<number, MigrationStep<ChunkDynamicPayload>>([
 *   [1, (chunk) => ({ ...chunk, version: 2, crops: [] })],
 * ]);
 * ```
 *
 * Steps must be pure and must not consult the world seed or the clock: the same file
 * has to migrate to the same bytes on every host.
 */
const CHUNK_MIGRATIONS: MigrationTable<ChunkDynamicPayload> = new Map();

/** Player migrations. Same rules as {@link CHUNK_MIGRATIONS}. */
const PLAYER_MIGRATIONS: MigrationTable<PlayerSavePayload> = new Map();

/** World-metadata migrations. Same rules as {@link CHUNK_MIGRATIONS}. */
const META_MIGRATIONS: MigrationTable<WorldMetaPayload> = new Map();

/**
 * Walk `record` from its stored version up to the current one.
 *
 * Shared by all three kinds because the loop is the interesting part and duplicating
 * it three times is how the three drift apart.
 */
function migrate<T extends { version: number }>(
  kind: SaveRecordKind,
  record: T,
  table: MigrationTable<T>,
): T {
  // `version` is typed `number`, but this record came off a disk that anything could
  // have written, so the runtime check is real work and not a redundant assertion.
  const found = record.version;
  if (!Number.isInteger(found) || found < 1) {
    throw new SaveFormatError(
      kind,
      'malformed',
      Number(found),
      `missing or malformed version field (${String(found)})`,
    );
  }
  if (found > SAVE_FORMAT_VERSION) {
    throw new SaveFormatError(
      kind,
      'too-new',
      found,
      `written by a newer build (format ${found}, this build reads ${SAVE_FORMAT_VERSION}). ` +
        'Update the game to open this world.',
    );
  }

  let current = record;
  for (let version = found; version < SAVE_FORMAT_VERSION; version++) {
    const step = table.get(version);
    if (!step) {
      throw new SaveFormatError(
        kind,
        'no-migration-path',
        found,
        `no migration from format ${version} to ${version + 1}`,
      );
    }
    current = step(current);
    if (current.version !== version + 1) {
      // A step that forgets to stamp the new version would loop or silently
      // mis-report; fail loudly at the seam instead.
      throw new SaveFormatError(
        kind,
        'no-migration-path',
        found,
        `migration ${version} -> ${version + 1} produced version ${current.version}`,
      );
    }
  }
  return current;
}

/** Bring a stored chunk up to the current format. Throws {@link SaveFormatError}. */
export function migrateChunk(payload: ChunkDynamicPayload): ChunkDynamicPayload {
  return migrate('chunk', payload, CHUNK_MIGRATIONS);
}

/** Bring a stored player up to the current format. Throws {@link SaveFormatError}. */
export function migratePlayer(payload: PlayerSavePayload): PlayerSavePayload {
  return migrate('player', payload, PLAYER_MIGRATIONS);
}

/** Bring stored world metadata up to the current format. Throws {@link SaveFormatError}. */
export function migrateMeta(meta: WorldMetaPayload): WorldMetaPayload {
  return migrate('meta', meta, META_MIGRATIONS);
}
