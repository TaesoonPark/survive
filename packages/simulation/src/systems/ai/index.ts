/**
 * Creature brains.
 *
 * Two systems in adjacent slots: {@link createZombieAiSystem} at `SystemOrder.Ai` and
 * {@link createAnimalAiSystem} one after it. Both must run *after* movement and combat,
 * because both consume the noise events those systems emit during the same tick, and
 * both read the positions players have already settled on.
 *
 * The three shared modules underneath are exported too, because they are the parts a
 * test wants to pin down directly and the parts a future third brain (a raider, a
 * survivor NPC) should reuse rather than re-derive:
 *
 * - `./lod` - the scheduling budget: which tier a creature is in, how often its brain
 *   runs, and how many ticks a coarse movement step may swallow.
 * - `./senses` - sight and hearing, including the light/stance/stealth visibility
 *   budget that makes crouching in the dark worth doing.
 * - `./steering` - navigation, cheapest option first: direct steering, then a shared
 *   flow field, then a rate-limited A*, plus the separation that keeps a horde from
 *   collapsing into one pixel.
 */
export {
  ATTACK_REACH_GRACE,
  ARRIVAL_RANGE as ZOMBIE_ARRIVAL_RANGE,
  DOOR_PATH_COST,
  HORDE_CELL,
  HORDE_MIN_SIZE,
  HORDE_REGROUP_TICKS,
  MAX_ZOMBIE_PATHS_PER_TICK,
  RANGED_ATTACK_MIN_RANGE,
  SCREAM_COOLDOWN_TICKS,
  SCREAM_NOISE_THRESHOLD,
  WANDER_CHANCE as ZOMBIE_WANDER_CHANCE,
  WANDER_RADIUS as ZOMBIE_WANDER_RADIUS,
  ZOMBIE_PROJECTILE_DEF_ID,
  biteInfectionChance,
  contactRange,
  createZombieAiSystem,
  isRangedZombie,
  zombieGoal,
  zombieLod,
  zombieSightHalfAngle,
  zombieSpeed,
} from './zombieAi';

export {
  ANIMAL_WINDUP_FRACTION,
  ARRIVAL_RANGE as ANIMAL_ARRIVAL_RANGE,
  FLEE_TICKS,
  GRAZE_CHANCE,
  MAX_ANIMAL_PATHS_PER_TICK,
  PACK_MIN_DENSITY,
  PACK_RADIUS,
  WANDER_CHANCE as ANIMAL_WANDER_CHANCE,
  WANDER_RADIUS as ANIMAL_WANDER_RADIUS,
  animalGoal,
  animalLod,
  animalSpeed,
  canFightBack,
  createAnimalAiSystem,
  isAnimalActive,
  isPackHunter,
} from './animalAi';

export {
  DORMANT_DISTANCE,
  LOD_TIER_BOUNDS,
  MAX_COARSE_STEP_PX,
  SMOOTH_MOVEMENT_MAX_TIER,
  animalThinkInterval,
  coarseStepTicks,
  lodForDistance,
  nextThinkTickFor,
  zombieThinkInterval,
} from './lod';

export {
  DARK_SIGHT_FLOOR,
  HEARING_REFERENCE_RANGE,
  HEARING_THRESHOLD,
  MAX_NOISES_PER_TICK,
  MAX_VISIBILITY,
  MOVE_MODE_VISIBILITY,
  STEALTH_VISIBILITY_FLOOR,
  STEALTH_VISIBILITY_PER_LEVEL,
  canSeePlayer,
  createNoiseFeed,
  effectiveSightRange,
  findVisiblePlayer,
  hearingScale,
  lightVisibility,
  loudestHeardNoise,
  playerVisibility,
  type HeardNoise,
  type NoiseFeed,
  type NoiseSignal,
  type Viewer,
} from './senses';

export {
  DIRECT_STEER_RANGE,
  FLOW_FIELD_MAX_AGE_TICKS,
  FLOW_GOAL_QUANTUM,
  PATH_MAX_AGE_TICKS,
  PATH_MAX_NODES,
  PATH_REFRESH_TICKS,
  SEPARATION_WEIGHT,
  WAYPOINT_REACH,
  blendSteering,
  createNavBudget,
  quantiseGoal,
  separation,
  steerTowards,
  type NavBudget,
  type PathAgent,
  type SteerOptions,
} from './steering';
