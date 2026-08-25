import type { System } from '../core/context';
import { createTimeSystem, createWeatherSystem } from './time';
import { createInputSystem, createMovementSystem } from './movement';
import { createCombatSystem, createProjectileSystem } from './combat';
import { createAnimalAiSystem, createZombieAiSystem } from './ai';
import { createSurvivalSystem } from './survival';
import { createCraftingSystem } from './crafting';
import { createFarmingSystem } from './farming';
import { createBuildingSystem } from './building';
import { createInventorySystem, createItemEntitySystem } from './inventory';
import { createChunkPopulationSystem, createGatheringSystem, createSpawnSystem } from './world';

/**
 * The whole game.
 *
 * Every rule the server enforces is one of these systems. The {@link Simulation} sorts
 * them by their `order` field (see {@link import('../core/context').SystemOrder}), so the
 * order of this list does not matter - what matters is that nothing is missing, because a
 * system that is not here simply does not exist as far as the world is concerned.
 *
 * WIRING: {@link createInputSystem} is built with no argument here, which leaves it
 * unbound. Any host that steps this list must call `bindInputSource(simulation)` once
 * after construction or no player will ever move. Both hosts in this repo do:
 * `GameServer.start()` and the test harness's `createTestSimulation`.
 */
export function createDefaultSystems(): System[] {
  return [
    // The clock first: everything downstream reads the tick's derived world time.
    createTimeSystem(),
    createWeatherSystem(),

    // Then what the players asked for, and where it puts them.
    createInputSystem(),
    createMovementSystem(),

    // Fighting resolves against post-move positions, which is what the player saw.
    createCombatSystem(),
    createProjectileSystem(),

    // Then everything else reacts.
    createZombieAiSystem(),
    createAnimalAiSystem(),

    // Attrition last among the actors: it accounts for everything that just happened.
    createSurvivalSystem(),

    // Work in progress, and the world's own slow processes.
    createCraftingSystem(),
    createFarmingSystem(),
    createBuildingSystem(),
    createGatheringSystem(),
    createInventorySystem(),
    createItemEntitySystem(),

    // Population and streaming close the tick.
    createSpawnSystem(),
    createChunkPopulationSystem(),
  ];
}

/**
 * The subset needed to make a player exist and move.
 *
 * Useful for focused tests and for tools that only need locomotion, and cheap enough to
 * step millions of ticks.
 */
export function createMinimalSystems(): System[] {
  return [createTimeSystem(), createInputSystem(), createMovementSystem()];
}

/**
 * Re-exports.
 *
 * Every system's public surface, so a consumer writes `from '@survive/simulation'` and
 * not a path into the systems tree. Deep imports still work
 * (`@survive/simulation/systems/farming/crops`) for anything that wants a single helper
 * without pulling the barrel in.
 */
export * from './time';
export * from './movement';
export * from './combat';
export * from './ai';
export * from './survival';
export * from './crafting';
export * from './farming';
export * from './building';
export * from './inventory';
export * from './world';
