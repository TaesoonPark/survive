/**
 * `@survive/persistence` - saving and loading, and nothing else.
 *
 * The whole package exists to satisfy Architecture Guard rule 11: game logic holds a
 * {@link WorldRepository} and never learns whether it is talking to a folder of JSON,
 * a SQLite file or a `Map`. It depends on `@survive/protocol` for the DTOs and on
 * nothing else - in particular not on `@survive/simulation`, so no game rule can leak
 * into the save path (or the other way round).
 *
 * Picking a backend:
 *
 * - {@link createMemoryStore} / {@link createMemoryRepository} - tests, and
 *   `--no-save` servers.
 * - {@link createFileSystemStore} - single-player. Human-readable, portable, atomic.
 * - {@link createSqliteStore} - dedicated servers. Transactional batch saves. Guard it
 *   with {@link isSqliteAvailable} and fall back to the filesystem store, because
 *   `node:sqlite` is an experimental builtin that not every Node ships.
 *
 * All three write the same DTOs from `@survive/protocol`, which is what makes a world
 * folder movable between a single-player game and a dedicated server (spec s.32).
 */
export * from './types';
export * from './paths';
export * from './migrate';
export * from './memory';
export * from './filesystem';
export * from './sqlite';
