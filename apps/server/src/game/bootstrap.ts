import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SimulationConfig } from '@survive/protocol';
import { createGameData } from '@survive/game-data';
import { createWorld } from '@survive/world';
import { createConsoleLogger, type Logger } from '@survive/simulation';
import {
  createFileSystemStore,
  createMemoryStore,
  createSqliteStore,
  isSqliteAvailable,
  type SaveStore,
  type WorldRepository,
} from '@survive/persistence';
import type { RuntimeOptions, StorageBackend } from '../config/args';
import { GameServer } from './gameServer';

/**
 * Wiring.
 *
 * The only place that decides which concrete world generator, content tables and
 * storage backend a run uses. Everything downstream takes them as parameters, which is
 * what lets a test swap in an in-memory repository without the game noticing
 * (Architecture Guard rule 11).
 */

export interface BootstrapResult {
  server: GameServer;
  store: SaveStore;
  repository: WorldRepository;
  logger: Logger;
  /** The backend actually used, which may differ from the one requested. */
  backend: StorageBackend;
}

/** Build a save store for the requested backend, falling back when one is unavailable. */
export async function createStore(
  runtime: RuntimeOptions,
  logger: Logger,
): Promise<{ store: SaveStore; backend: StorageBackend }> {
  const root = resolve(runtime.saveDir);
  if (runtime.backend === 'memory') {
    return { store: createMemoryStore(), backend: 'memory' };
  }
  if (runtime.backend === 'sqlite') {
    if (await isSqliteAvailable()) return { store: createSqliteStore(root), backend: 'sqlite' };
    logger.warn('node:sqlite is unavailable in this runtime; using the filesystem backend');
    return { store: createFileSystemStore(root), backend: 'fs' };
  }
  return { store: createFileSystemStore(root), backend: 'fs' };
}

/**
 * Create a fully wired, started {@link GameServer}.
 *
 * `--reset` deletes the world first, which the end-to-end suite relies on to get a
 * clean map every run.
 */
export async function bootstrap(
  config: SimulationConfig,
  runtime: RuntimeOptions,
): Promise<BootstrapResult> {
  const logger = createConsoleLogger('server', runtime.logLevel);
  const { store, backend } = await createStore(runtime, logger);

  if (runtime.reset) {
    if (await store.worldExists(config.saveName)) {
      logger.warn('resetting world', { name: config.saveName });
      await store.deleteWorld(config.saveName);
    } else if (runtime.backend === 'fs') {
      // Also clear a stale folder that failed to parse as a world.
      await rm(resolve(runtime.saveDir, config.saveName), { recursive: true, force: true });
    }
  }

  const existed = await store.worldExists(config.saveName);
  const repository = existed
    ? await store.openWorld(config.saveName)
    : await store.createWorld(config.saveName, config.world.seed);

  const data = createGameData();
  const world = createWorld(config.world);

  const server = new GameServer({
    config,
    data,
    world,
    repository,
    logger,
    // Deleting a world is the store's business, not the server's - the server only ever
    // holds the one repository it was handed. Handing it the means to get another is what
    // makes an in-process reset possible at all.
    recreateWorld: async () => {
      logger.warn('resetting world', { name: config.saveName });
      await store.deleteWorld(config.saveName);
      return store.createWorld(config.saveName, config.world.seed);
    },
  });
  await server.start();

  return { server, store, repository, logger, backend };
}
