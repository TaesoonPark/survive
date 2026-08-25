/**
 * The world systems: what the world gives you, and what it puts in your way.
 *
 * `./gathering` owns every hit that lands on a resource node - the `gather` command, the
 * `interact` key, and (through combat's `applyNodeHit`) a melee swing that connects with a
 * tree. `./chunkPopulation` generates a chunk's one-time contents from `(seed, cx, cy)`
 * and keeps the streaming ring fed. `./spawn` applies the ongoing pressure: zombie
 * budgets, night hordes, culling and wildlife regrowth. `./creatures` is the shared
 * constructor both of the latter two use, so a creature generated at chunk load and one
 * topped up an hour later are indistinguishable in a save file.
 */
export {
  DIRTY_WATER_DEF_ID,
  GATHER_BASE_DAMAGE,
  GATHER_COOLDOWN_TICKS,
  GATHER_REACH,
  INTERACT_REACH,
  canFillWith,
  createGatheringSystem,
  depleteNode,
  fillFromWater,
  findFillableContainer,
  harvestNode,
  harvestRange,
  hasHarvestSight,
  selectGatherTool,
  toolEffectiveness,
  type HarvestResult,
} from './gathering';

export {
  ANIMAL_SALT,
  BUDGET_SAMPLE_STEP,
  CONTAINER_SALT,
  NODE_SALT,
  activityForDistance,
  animalBudgetForChunk,
  animalTargets,
  chunkBiomeFractions,
  MAX_POPULATIONS_PER_TICK,
  createChunkPopulationSystem,
  findRooms,
  nodeTargets,
  populateChunk,
  requestChunkLoad,
  surveyChunk,
  type ChunkTileSurvey,
  type Room,
} from './chunkPopulation';

export {
  BASE_ZOMBIES_PER_CHUNK,
  HORDE_SALT,
  MAX_SPAWNS_PER_ROLL,
  MIN_SPAWN_DISTANCE,
  SPAWN_ROLL_INTERVAL_TICKS,
  ZOMBIE_DESPAWN_DISTANCE,
  createSpawnSystem,
  cullZombies,
  hordeChance,
  hordeSize,
  isConcealedSpawn,
  isFarFromPlayers,
  zombieBudgetForChunk,
} from './spawn';

export { spawnAnimalAt, spawnZombieAt } from './creatures';
