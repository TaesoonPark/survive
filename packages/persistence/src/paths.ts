/**
 * Names, and the on-disk layout they map to (spec section 30).
 *
 * ```
 * <root>/<world>/metadata.json          world meta (filesystem backend)
 * <root>/<world>/world.db               everything      (SQLite backend)
 * <root>/<world>/players/<id>.json
 * <root>/<world>/chunks/<cx>/chunk_<cx>_<cy>.json
 * ```
 *
 * Both disk backends share this layout so a world folder is recognisable whichever
 * one wrote it, and both share the name rules below so a world that saves on one host
 * cannot fail to save on another (section 32 portability).
 */

/** File holding {@link WorldMetaPayload} in the filesystem backend. */
export const METADATA_FILE = 'metadata.json';

/** Per-world SQLite database in the SQLite backend. */
export const WORLD_DB_FILE = 'world.db';

/** Sub-directory holding one JSON file per player. */
export const PLAYERS_DIR = 'players';

/**
 * Sub-directory holding chunk files, sharded one level deep by `cx`.
 *
 * A fully explored world has 65 536 chunks. Flat directories that size make `readdir`
 * and most filesystems' directory indexes miserable, so each `cx` column gets its own
 * directory: 256 directories of at most 256 files.
 */
export const CHUNKS_DIR = 'chunks';

/** Suffix of a half-written file. See the atomic-write note in `filesystem.ts`. */
export const TEMP_SUFFIX = '.tmp';

/** What a rejected name was going to be used for, so the error can say so. */
export type NameKind = 'world' | 'player';

/** A world or player name is not usable as a path segment. */
export class InvalidNameError extends Error {
  readonly kind: NameKind;
  readonly value: string;

  constructor(kind: NameKind, value: string, reason: string) {
    super(`Invalid ${kind} name ${JSON.stringify(value)}: ${reason}`);
    this.name = 'InvalidNameError';
    this.kind = kind;
    this.value = value;
  }
}

/** Longest name we accept. Well inside the 255-byte limit every filesystem shares. */
const MAX_NAME_LENGTH = 64;

/**
 * Characters a name may contain: letters, digits, space, and `_ - . @`.
 *
 * Deliberately narrow. It covers world names people actually type ("Bunker Hill 2")
 * and the account-id shapes the server issues (uuids, `name@host`), while excluding
 * every separator, wildcard and control character that has ever been part of a path
 * escape. Anything outside the set is rejected rather than rewritten: silently mapping
 * two different names onto one path segment would let one player's save clobber
 * another's, which is worse than a loud failure at the boundary.
 */
const ALLOWED_NAME = /^[A-Za-z0-9 ._@-]+$/;

/**
 * Windows device names, which are reserved with *any* extension and in any case.
 * `CON.json` is not a file on Windows, so a player called `con` would silently fail to
 * save there. Rejecting them everywhere keeps a world folder portable.
 */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/**
 * Validate a name and return it unchanged, or throw {@link InvalidNameError}.
 *
 * Every backend runs this, including the in-memory one: a bad id must fail in the fast
 * headless test, not later on a dedicated server.
 */
export function assertSafeName(kind: NameKind, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidNameError(kind, String(value), 'must be a non-empty string');
  }
  if (value.length > MAX_NAME_LENGTH) {
    throw new InvalidNameError(kind, value, `must be at most ${MAX_NAME_LENGTH} characters`);
  }
  if (!ALLOWED_NAME.test(value)) {
    throw new InvalidNameError(
      kind,
      value,
      'may only contain letters, digits, space, and the characters _ - . @',
    );
  }
  // Rules out `.` and `..` outright, plus the hidden-file and trailing-space-or-dot
  // shapes that Windows silently trims (turning "world." into "world").
  if (value.startsWith('.') || value.endsWith('.')) {
    throw new InvalidNameError(kind, value, 'must not start or end with a dot');
  }
  if (value.startsWith(' ') || value.endsWith(' ')) {
    throw new InvalidNameError(kind, value, 'must not start or end with a space');
  }
  if (WINDOWS_RESERVED.test(value)) {
    throw new InvalidNameError(kind, value, 'is a reserved device name on Windows');
  }
  return value;
}

/** True when {@link assertSafeName} would accept the name. */
export function isSafeName(kind: NameKind, value: string): boolean {
  try {
    assertSafeName(kind, value);
    return true;
  } catch {
    return false;
  }
}

/** `players/<id>.json` */
export function playerFileName(id: string): string {
  return `${id}.json`;
}

/** Recover a player id from a file name, or `null` if it is not a player file. */
export function parsePlayerFileName(file: string): string | null {
  if (!file.endsWith('.json')) return null;
  const id = file.slice(0, -'.json'.length);
  return isSafeName('player', id) ? id : null;
}

/** `chunks/<cx>/chunk_<cx>_<cy>.json` */
export function chunkFileName(cx: number, cy: number): string {
  return `chunk_${cx}_${cy}.json`;
}

/** Directory name of the shard holding column `cx`. */
export function chunkShardName(cx: number): string {
  return String(cx);
}

/**
 * Recover chunk coordinates from a file name, or `null` if it is not a chunk file.
 *
 * The anchored pattern is what makes leftover `chunk_1_2.json.tmp` files invisible to
 * `stats()`: a torn write is ignored rather than counted or parsed.
 */
export function parseChunkFileName(file: string): { cx: number; cy: number } | null {
  const match = /^chunk_(-?\d+)_(-?\d+)\.json$/.exec(file);
  if (!match) return null;
  const rawCx = match[1];
  const rawCy = match[2];
  if (rawCx === undefined || rawCy === undefined) return null;
  const cx = Number.parseInt(rawCx, 10);
  const cy = Number.parseInt(rawCy, 10);
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy)) return null;
  return { cx, cy };
}
