/**
 * Combat: melee arcs, projectiles, blocking, reloading.
 *
 * `createCombatSystem` reads the input frame and resolves attacks;
 * `createProjectileSystem` flies whatever those attacks put in the air. Both are
 * registered by `systems/index.ts`.
 *
 * Three of the exports here are load-bearing outside combat, and are the reason this
 * barrel exists at all rather than everything being private:
 *
 * - `resolveIncomingAttack` is the single door every attack in the game walks through,
 *   so that "I had my guard up" means the same thing whether the blow came from a
 *   player's machete, a zombie's claw or a bullet. The AI system calls it directly.
 * - `hitStructure` and `spawnProjectile` are shared with the AI for the same reason: a
 *   brute breaking a door and a spitter's bile must behave like the player's versions.
 * - `applyNodeHit` goes the other way, delegating a swing that landed on a tree to the
 *   gathering system's `harvestNode`, which owns every node yield in the game.
 */
export {
  createCombatSystem,
  spreadRadians,
  DRY_FIRE_TICKS,
  EXHAUSTED_RETRY_TICKS,
  type CombatSystemOptions,
} from './combat';

export {
  BLOCK_ARC_DEGREES,
  BLOCK_DURABILITY_PER_HIT,
  BLOCK_STAMINA_PER_DAMAGE,
  MAX_BLOCK_REDUCTION,
  blockReductionFor,
  blockingGear,
  blowIsGuarded,
  isGuarding,
  resolveIncomingAttack,
  type BlockingGear,
} from './blocking';

export { hitStructure } from './impact';

export { applyNodeHit, type MeleeSwing, type NodeHitResolver } from './nodes';

export {
  createProjectileSystem,
  damageAtRange,
  spawnProjectile,
  PROJECTILE_MAX_LIFETIME_TICKS,
  type ProjectileSpawn,
} from './projectiles';

export {
  AUTO_FIRE_MAX_TICKS,
  UNARMED,
  arcHalfAngle,
  attackCooldownTicks,
  countAmmo,
  effectiveCritChance,
  isAutoFire,
  resolveWeapon,
  staminaCostFor,
  swingDamage,
  wearEquipped,
  weaponConditionMultiplier,
  weaponSkillMultiplier,
  type ResolvedWeapon,
} from './weapons';
