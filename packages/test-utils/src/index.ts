/**
 * `@survive/test-utils` - harnesses, not helpers-for-their-own-sake.
 *
 * Three layers, matching the three kinds of test the architecture makes cheap:
 *
 * - {@link createTestSimulation} - headless game rules, no server, no clock. Most tests.
 * - {@link createHeadlessServer} - a real server over an in-memory save, no sockets.
 * - {@link createLiveServer} + {@link createBot} - a real server and real clients.
 */
export {
  createTestSimulation,
  findTestSpawn,
  flattenArea,
  moveFrame,
  attackFrame,
  DEFAULT_SEED,
} from './simulation';
export type { TestSimulation, TestSimulationOptions } from './simulation';

export { createFlatWorld } from './flatWorld';
export type { FlatWorld, FlatWorldOptions } from './flatWorld';

export {
  createGeneratedWorld,
  createGeneratedTestSimulation,
  createGeneratedHeadlessServer,
  createGeneratedLiveServer,
} from './generated';
export type { GeneratedWorldOptions } from './generated';

export { createHeadlessServer, createLiveServer } from './server';
export type {
  HeadlessServer,
  HeadlessServerOptions,
  LiveServer,
  LiveServerOptions,
} from './server';

export { createBot, createBots, waitForAll, sleep } from './bot';
export type { Bot, BotOptions } from './bot';
