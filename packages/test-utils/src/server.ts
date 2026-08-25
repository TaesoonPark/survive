import {
  GAME_ROOM_NAME,
  PROTOCOL_VERSION,
  dedicatedConfig,
  type SimulationConfig,
} from '@survive/protocol';
import { createGameData, type GameData } from '@survive/game-data';
import type { WorldService } from '@survive/world';
import { createMemoryStore, type SaveStore, type WorldRepository } from '@survive/persistence';
import { createFlatWorld } from './flatWorld';
import { nullLogger, type Logger, type System } from '@survive/simulation';
import { GameServer, listen, type ListeningServer } from '@survive/server';

/**
 * Server harnesses for integration and multiplayer tests.
 *
 * Two flavours:
 *
 * - {@link createHeadlessServer} - a real {@link GameServer} over an in-memory
 *   repository, with no sockets at all. Use it for save/restart tests (spec section 36)
 *   and anything about chunk streaming or persistence.
 * - {@link createLiveServer} - the same thing plus a real Colyseus listener on an
 *   ephemeral port, for bot-client tests (spec section 35).
 */

export interface HeadlessServerOptions {
  /** Reuse a store across a restart, which is the whole point of a restart test. */
  store?: SaveStore;
  worldName?: string;
  seed?: number;
  config?: (config: SimulationConfig) => void;
  data?: GameData;
  world?: WorldService;
  systems?: System[];
  logger?: Logger;
  /** Fixed wall clock, so save timestamps are deterministic. */
  now?: () => number;
}

export interface HeadlessServer {
  readonly server: GameServer;
  readonly store: SaveStore;
  readonly repository: WorldRepository;
  readonly config: SimulationConfig;
  readonly data: GameData;
  readonly world: WorldService;
  /** Step the simulation and flush any background I/O it kicked off. */
  advance(ticks: number): Promise<void>;
  stop(): Promise<void>;
}

export async function createHeadlessServer(
  options: HeadlessServerOptions = {},
): Promise<HeadlessServer> {
  const worldName = options.worldName ?? 'test-world';
  // Started from the *dedicated* config, not from the single-player one with the
  // multiplayer bits patched in. Patching field by field is how `pauseWhenClientPaused`
  // was once left at its single-player `true`, which quietly turned "a dedicated server
  // refuses a client's pause" into a test of a server that was happy to be paused.
  const config = dedicatedConfig(worldName);
  config.mode.maxPlayers = 8;
  config.mode.pauseWhenEmpty = false;
  // Tests reach for debug commands to set up state; a real dedicated server would not.
  config.mode.cheatsEnabled = true;
  // Loopback and an OS-chosen port, overriding the dedicated default of every interface
  // on a fixed one. A headless server never calls `listen`, so nothing binds today - this
  // is so that the day someone gives one a socket, it is not the whole network's socket.
  config.network.host = '127.0.0.1';
  config.network.port = 0;
  config.world.seed = options.seed ?? 20260824;
  options.config?.(config);

  const store = options.store ?? createMemoryStore();
  const repository = (await store.worldExists(worldName))
    ? await store.openWorld(worldName)
    : await store.createWorld(worldName, config.world.seed);

  const data = options.data ?? createGameData();
  const world = options.world ?? createFlatWorld({ seed: config.world.seed });

  const server = new GameServer({
    config,
    data,
    world,
    repository,
    logger: options.logger ?? nullLogger,
    ...(options.systems ? { systems: options.systems } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await server.start();

  return {
    server,
    store,
    repository,
    config,
    data,
    world,
    async advance(ticks: number) {
      server.advance(ticks);
      await server.settle();
    },
    async stop() {
      await server.stop();
    },
  };
}

export interface LiveServerOptions extends HeadlessServerOptions {
  /** Require this password from joining clients. */
  password?: string;
  /** Require this token from joining clients. */
  token?: string;
  maxPlayers?: number;
}

export interface LiveServer extends HeadlessServer {
  readonly net: ListeningServer;
  /** HTTP base URL for matchmaking, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  readonly roomName: string;
  /** Join options a bot client can pass straight through. */
  joinOptions(name: string, playerId?: string): Record<string, unknown>;
}

/**
 * Start a real server on an ephemeral port.
 *
 * The port is chosen by the OS so several tests can run without colliding, and the
 * caller gets the URL back rather than having to guess it.
 */
export async function createLiveServer(options: LiveServerOptions = {}): Promise<LiveServer> {
  const headless = await createHeadlessServer({
    ...options,
    config: (config) => {
      config.network.host = '127.0.0.1';
      config.network.port = 0;
      if (options.password) config.network.password = options.password;
      if (options.token) config.network.token = options.token;
      if (options.maxPlayers) config.mode.maxPlayers = options.maxPlayers;
      options.config?.(config);
    },
  });

  const net = await listen({
    game: headless.server,
    logger: options.logger ?? nullLogger,
  });

  return {
    ...headless,
    net,
    url: net.matchmakeUrl,
    roomName: GAME_ROOM_NAME,
    joinOptions(name: string, playerId?: string) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        name,
        ...(playerId ? { playerId } : {}),
        ...(options.password ? { password: options.password } : {}),
        ...(options.token ? { token: options.token } : {}),
      };
    },
    async stop() {
      await net.close();
      await headless.stop();
    },
  };
}
