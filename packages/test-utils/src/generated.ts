import { createWorld } from '@survive/world';
import type { WorldService } from '@survive/world';
import { defaultWorldGenConfig, type WorldGenConfig } from '@survive/protocol';
import {
  createTestSimulation,
  findTestSpawn,
  type TestSimulation,
  type TestSimulationOptions,
} from './simulation';
import {
  createHeadlessServer,
  createLiveServer,
  type HeadlessServer,
  type HeadlessServerOptions,
  type LiveServer,
  type LiveServerOptions,
} from './server';

/**
 * The same harnesses, against *real* generated terrain.
 *
 * Use these for anything that is actually about the world - chunk streaming, spawning,
 * pathfinding through a town, foraging in a forest - and the flat-world defaults for
 * everything else.
 */

export interface GeneratedWorldOptions extends Partial<WorldGenConfig> {
  seed?: number;
}

export function createGeneratedWorld(options: GeneratedWorldOptions = {}): WorldService {
  const config = defaultWorldGenConfig(options.seed ?? 20260824);
  Object.assign(config, options);
  return createWorld(config);
}

/** {@link createTestSimulation} over generated terrain. */
export function createGeneratedTestSimulation(
  options: TestSimulationOptions & { worldGen?: GeneratedWorldOptions } = {},
): TestSimulation {
  const seed = options.seed ?? 20260824;
  const world = options.world ?? createGeneratedWorld({ seed, ...options.worldGen });
  return createTestSimulation({
    ...options,
    seed,
    world,
    // Generated terrain has trees and water in it; leave it alone unless asked.
    flattenSpawn: options.flattenSpawn ?? false,
    spawn: options.spawn ?? findTestSpawn(world, seed),
  });
}

/** {@link createHeadlessServer} over generated terrain. */
export function createGeneratedHeadlessServer(
  options: HeadlessServerOptions & { worldGen?: GeneratedWorldOptions } = {},
): Promise<HeadlessServer> {
  const seed = options.seed ?? 20260824;
  return createHeadlessServer({
    ...options,
    seed,
    world: options.world ?? createGeneratedWorld({ seed, ...options.worldGen }),
  });
}

/** {@link createLiveServer} over generated terrain. */
export function createGeneratedLiveServer(
  options: LiveServerOptions & { worldGen?: GeneratedWorldOptions } = {},
): Promise<LiveServer> {
  const seed = options.seed ?? 20260824;
  return createLiveServer({
    ...options,
    seed,
    world: options.world ?? createGeneratedWorld({ seed, ...options.worldGen }),
  });
}
