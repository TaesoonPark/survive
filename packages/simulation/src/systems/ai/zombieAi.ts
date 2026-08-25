import {
  TILE_SIZE,
  angleBetween,
  clamp,
  defaultSurvivalTuning,
  distance,
  legMobilityMultiplier,
  pixelToTile,
  type EntityId,
  type LodTier,
  type PlayerState,
  type Rng,
  type StructureState,
  type ZombieState,
} from '@survive/protocol';
import type { ZombieDef } from '@survive/game-data';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import type { DamageSpec } from '../../core/damage';
import { PLAYER_RADIUS, stepMovement, type MovementIntent } from '../../core/movement';
import { NoiseRadius, emitNoise } from '../../core/noise';
import {
  bump,
  distanceToNearestPlayer,
  markStructureDirty,
  structureAtTile,
} from '../../core/queries';
import type { HordeState } from '../../core/state';
import type { SpatialEntry } from '../../core/spatial';
import { refreshStructureCollision, structureCenter } from '../../core/structures';
import { hitStructure } from '../combat/impact';
import { resolveIncomingAttack } from '../combat/blocking';
import { spawnProjectile } from '../combat/projectiles';
import {
  DORMANT_DISTANCE,
  SMOOTH_MOVEMENT_MAX_TIER,
  coarseStepTicks,
  lodForDistance,
  nextThinkTickFor,
  zombieThinkInterval,
} from './lod';
import { createNoiseFeed, findVisiblePlayer, loudestHeardNoise, type NoiseSignal } from './senses';
import {
  createNavBudget,
  blendSteering,
  separation,
  steerTowards,
  FLOW_FIELD_MAX_AGE_TICKS,
} from './steering';

/**
 * Zombie brains.
 *
 * The state machine is deliberately small - dormant, idle, wander, alerted,
 * investigate, pursue, attack, stagger, dead - because a zombie is not supposed to be
 * clever. What it is supposed to be is *consistent*: it notices you for a reason you
 * can name (it saw you, or it heard you), it forgets you for a reason you can predict
 * (it lost sight and its patience ran out), and it goes through the wall you were
 * hiding behind rather than politely pathing around your base.
 *
 * Everything expensive is on a leash. Senses and transitions run on the LOD schedule in
 * `./lod`; navigation prefers a shared flow field over per-zombie A* (`./steering`);
 * and a zombie with no player inside three chunks goes dormant and costs a distance
 * check per tick. That is what makes a horde affordable (spec sections 22 and 23).
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Most A* searches every zombie put together may run in one tick. */
export const MAX_ZOMBIE_PATHS_PER_TICK = 4;

/** Extra pathing cost of a closed door for a zombie that can open (or break) one. */
export const DOOR_PATH_COST = 6;

/** How far past `attackRange` a wind-up may still land, so a step does not cancel it. */
export const ATTACK_REACH_GRACE = TILE_SIZE * 0.35;

/** Radius, in pixels, a zombie wanders within of its home anchor. */
export const WANDER_RADIUS = TILE_SIZE * 6;

/** Chance an idle zombie decides to shuffle somewhere on a given brain tick. */
export const WANDER_CHANCE = 0.25;

/** Counts as having arrived at a wander or investigation point. */
export const ARRIVAL_RANGE = TILE_SIZE * 0.75;

/**
 * How long `alerted` lasts before it becomes `investigate`.
 *
 * A zombie that heard something turns its head towards it and stands there for a beat
 * before it starts walking. Without the pause the state would be transitional only -
 * entered and left inside one tick - which robs the client of the "it noticed" moment
 * and, more importantly, robs the player of the fraction of a second in which they can
 * still get out of the way.
 */
export const ALERT_TICKS = 6;

/**
 * Fraction of walking speed an attacking zombie may shuffle at.
 *
 * A zombie mid-swing is planted, but a *crowd* of them still has to spread out, or six
 * attackers converge onto the same pixel and read as one. Slow enough that it never
 * carries anyone out of their own reach.
 */
export const ATTACK_SHUFFLE_SPEED = 0.35;

/**
 * A `ZombieDef.noise` at or above this makes the zombie a screamer: its aggro is
 * contagious, and it drags in everything within that radius rather than merely leaving
 * a noise event for whoever happens to be listening.
 */
export const SCREAM_NOISE_THRESHOLD = 1000;

/** Minimum ticks between two screams from the same throat. */
export const SCREAM_COOLDOWN_TICKS = 60;

/**
 * `attackRange` at or above which a zombie is treated as ranged.
 *
 * Every melee definition tops out at the brute's 46 px, so the threshold only has to
 * sit above arm's reach; three tiles is unambiguous without hard-coding a def id.
 */
export const RANGED_ATTACK_MIN_RANGE = TILE_SIZE * 3;

/**
 * Projectile a ranged zombie spits.
 *
 * `ZombieDef` carries no projectile field, so `@survive/game-data` pins this id and
 * makes resolving it the AI's job. Firing a real projectile rather than applying damage
 * at 300 px is what leaves the player counterplay: the bile takes time to arrive, and
 * anything solid stops it.
 */
export const ZOMBIE_PROJECTILE_DEF_ID = 'spitter_bile';

/** Ticks between horde regroups. Also how often a horde's shared goal is refreshed. */
export const HORDE_REGROUP_TICKS = 20;

/** Grid cell, in pixels, used to cluster pursuers into hordes. */
export const HORDE_CELL = TILE_SIZE * 16;

/** Fewest pursuers that count as a horde rather than as three separate problems. */
export const HORDE_MIN_SIZE = 3;

/** Ticks between flow-field cache sweeps. */
const FLOW_PRUNE_TICKS = 100;

/**
 * Infection chance a `ZombieDef` is authored against.
 *
 * The def field is the strain's virulence at default tuning; `tuning.infectionChance`
 * is the global dial. Scaling one by the other means a server that sets the dial to 0
 * really has no infection, and one that sets it to 1 has every bite land, without
 * either number losing its meaning.
 */
const REFERENCE_INFECTION_CHANCE = defaultSurvivalTuning().infectionChance;

const HOLD_STILL: MovementIntent = { moveX: 0, moveY: 0, sprint: false, crouch: false };

const ZOMBIE_KINDS = ['zombie'] as const;

/**
 * A swing that has been announced and is waiting out its wind-up.
 *
 * Transient on purpose: a swing in flight is animation state, not world state, so it
 * lives in the system rather than in `ZombieState`. Reloading a save mid-swing simply
 * means the zombie starts that swing again.
 */
interface PendingSwing {
  resolveTick: number;
  targetId: EntityId;
}

// ---------------------------------------------------------------------------
// Pure helpers, exported for tests and for the animal system
// ---------------------------------------------------------------------------

/** Movement speed in px/second, after stance, injury and crawling. */
export function zombieSpeed(zombie: ZombieState, def: ZombieDef): number {
  const chasing = zombie.ai === 'pursue' || zombie.ai === 'attack';
  const base = chasing ? def.speedChase : def.speedWalk;
  // Crawling already *is* the "legs are gone" penalty; applying leg mobility on top
  // would charge for the same injury twice.
  const injury = zombie.crawling ? def.crawlSpeedMultiplier : legMobilityMultiplier(zombie.body);
  return base * injury;
}

/** Vision cone half-angle, widened while chasing: a zombie in a chase is fixated. */
export function zombieSightHalfAngle(zombie: ZombieState, def: ZombieDef): number {
  const chasing = zombie.ai === 'pursue' || zombie.ai === 'attack';
  return chasing ? Math.min(Math.PI, def.sightHalfAngle * 1.6) : def.sightHalfAngle;
}

/** Distance at which a zombie notices a player it has walked into, cone or no cone. */
export function contactRange(def: ZombieDef): number {
  return def.radius + PLAYER_RADIUS + 8;
}

/** Whether this definition spits at range instead of swinging. */
export function isRangedZombie(def: ZombieDef): boolean {
  return def.attackRange >= RANGED_ATTACK_MIN_RANGE;
}

/** Infection chance for one bite, after the server's tuning dial. */
export function biteInfectionChance(ctx: SimContext, def: ZombieDef): number {
  if (REFERENCE_INFECTION_CHANCE <= 0) return def.infectionChance;
  const scale = ctx.config.tuning.infectionChance / REFERENCE_INFECTION_CHANCE;
  return clamp(def.infectionChance * scale, 0, 1);
}

/** LOD tier for a zombie: distance-derived, then floored by how busy it is. */
export function zombieLod(ai: ZombieState['ai'], distanceToPlayer: number): LodTier {
  const tier = lodForDistance(distanceToPlayer);
  if (ai === 'pursue' || ai === 'attack') return Math.min(tier, 1) as LodTier;
  if (ai === 'alerted' || ai === 'investigate' || ai === 'stagger') {
    return Math.min(tier, 2) as LodTier;
  }
  return tier;
}

/** Where this zombie currently wants to be, or null when it should stand still. */
export function zombieGoal(ctx: SimContext, zombie: ZombieState): { x: number; y: number } | null {
  switch (zombie.ai) {
    case 'attack':
    case 'pursue': {
      const target = zombie.targetId ? ctx.state.players[zombie.targetId] : undefined;
      if (target?.alive) return { x: target.x, y: target.y };
      if (zombie.lastSeenX !== undefined && zombie.lastSeenY !== undefined) {
        return { x: zombie.lastSeenX, y: zombie.lastSeenY };
      }
      return null;
    }
    case 'investigate': {
      if (zombie.investigateX !== undefined && zombie.investigateY !== undefined) {
        return { x: zombie.investigateX, y: zombie.investigateY };
      }
      if (zombie.lastSeenX !== undefined && zombie.lastSeenY !== undefined) {
        return { x: zombie.lastSeenX, y: zombie.lastSeenY };
      }
      return null;
    }
    // `alerted` is the beat where its head comes up and it has not moved yet, so it
    // deliberately has no goal.
    case 'alerted':
      return null;
    case 'wander': {
      if (zombie.investigateX !== undefined && zombie.investigateY !== undefined) {
        return { x: zombie.investigateX, y: zombie.investigateY };
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export function createZombieAiSystem(): System {
  const noises = createNoiseFeed();
  const budget = createNavBudget();
  const swings = new Map<EntityId, PendingSwing>();
  const lastScreamTick = new Map<EntityId, number>();
  const sightScratch: SpatialEntry[] = [];
  const crowdScratch: SpatialEntry[] = [];
  const recruitScratch: SpatialEntry[] = [];

  let rng: Rng | null = null;
  let rngTick = -1;

  /**
   * One RNG stream per tick for the whole subsystem.
   *
   * Forking per zombie per tick would allocate hundreds of generators a second, and
   * forking off the master mid-loop is only deterministic because zombies are iterated
   * in sorted id order - which they are, everywhere below.
   */
  function roll(ctx: SimContext): Rng {
    if (rngTick !== ctx.state.tick || rng === null) {
      rng = ctx.rng.fork('zombieAi');
      rngTick = ctx.state.tick;
    }
    return rng;
  }

  function sortedZombieIds(ctx: SimContext): string[] {
    return Object.keys(ctx.state.zombies).sort();
  }

  // -------------------------------------------------------------------------
  // Senses
  // -------------------------------------------------------------------------

  /**
   * React to what this zombie can hear.
   *
   * Only creatures that are not already chasing something bother to listen: a zombie
   * with a player in its teeth is not going to be talked out of it, and skipping the
   * pass for pursuers is what keeps a besieged base - where every zombie is emitting a
   * noise every swing - from costing O(horde squared) line-of-sight tests.
   */
  function listen(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    heard: readonly NoiseSignal[],
  ): void {
    const best = loudestHeardNoise(ctx, zombie, heard, def.hearingRange, zombie.id);
    if (!best) return;
    zombie.investigateX = best.noise.x;
    zombie.investigateY = best.noise.y;
    zombie.loseInterestTick = ctx.state.tick + def.loseInterestTicks;
    if (zombie.ai === 'dormant' || zombie.ai === 'idle' || zombie.ai === 'wander') {
      zombie.ai = 'alerted';
      zombie.facing = angleBetween(zombie.x, zombie.y, best.noise.x, best.noise.y);
      // Commit to investigating in a beat's time, rather than whenever its own slow
      // schedule next came round - and rather than this instant, which would make
      // `alerted` a state no client ever sees.
      zombie.nextThinkTick = ctx.state.tick + ALERT_TICKS;
      ctx.events.emit({
        type: 'zombieAlerted',
        zombieId: zombie.id,
        x: best.noise.x,
        y: best.noise.y,
      });
    }
    bump(zombie);
  }

  /**
   * A screamer's aggro is contagious.
   *
   * The noise event alone would work, but only for whoever happens to be listening on
   * the following tick; pulling neighbours in directly is what makes the archetype read
   * as "it called the others" instead of "some of them wandered over".
   */
  function scream(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    atX: number,
    atY: number,
  ): void {
    const last = lastScreamTick.get(zombie.id);
    if (last !== undefined && ctx.state.tick - last < SCREAM_COOLDOWN_TICKS) return;
    lastScreamTick.set(zombie.id, ctx.state.tick);
    emitNoise(ctx, zombie.x, zombie.y, def.noise, 1, zombie.id);

    const nearby = ctx.spatial.query(zombie.x, zombie.y, def.noise, recruitScratch);
    for (const entry of nearby) {
      if (entry.kind !== 'zombie' || entry.id === zombie.id) continue;
      const other = ctx.state.zombies[entry.id];
      if (!other || other.ai === 'dead') continue;
      if (other.ai === 'pursue' || other.ai === 'attack') continue;
      const otherDef = ctx.data.zombies.get(other.defId);
      other.investigateX = atX;
      other.investigateY = atY;
      other.loseInterestTick = ctx.state.tick + (otherDef?.loseInterestTicks ?? 200);
      other.ai = 'alerted';
      other.facing = angleBetween(other.x, other.y, atX, atY);
      other.nextThinkTick = ctx.state.tick + ALERT_TICKS;
      bump(other);
      ctx.events.emit({ type: 'zombieAlerted', zombieId: other.id, x: atX, y: atY });
    }
  }

  // -------------------------------------------------------------------------
  // The brain
  // -------------------------------------------------------------------------

  function think(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    distanceToPlayer: number,
  ): void {
    const tick = ctx.state.tick;

    // Nothing within three chunks and nothing left to check on: switch off.
    if (distanceToPlayer > DORMANT_DISTANCE && tick >= zombie.loseInterestTick) {
      if (zombie.ai !== 'dormant') {
        zombie.ai = 'dormant';
        delete zombie.targetId;
        delete zombie.lastSeenX;
        delete zombie.lastSeenY;
        delete zombie.investigateX;
        delete zombie.investigateY;
        zombie.path = [];
        zombie.pathIndex = 0;
        zombie.vx = 0;
        zombie.vy = 0;
        bump(zombie);
      }
      return;
    }

    if (zombie.staggerUntilTick > tick) {
      if (zombie.ai !== 'stagger') {
        zombie.ai = 'stagger';
        bump(zombie);
      }
      return;
    }

    // Waking up and shaking off a stagger both change a replicated field, so they are
    // bumped here rather than relying on a later branch to do it.
    if (zombie.ai === 'dormant') {
      zombie.ai = 'idle';
      bump(zombie);
    } else if (zombie.ai === 'stagger') {
      // Back to whatever it was doing before it got hit.
      zombie.ai = zombie.targetId ? 'pursue' : 'alerted';
      bump(zombie);
    }

    const seen = findVisiblePlayer(
      ctx,
      zombie,
      def.sightRange,
      zombieSightHalfAngle(zombie, def),
      contactRange(def),
      sightScratch,
    );

    if (seen) {
      const wasChasing = zombie.ai === 'pursue' || zombie.ai === 'attack';
      zombie.targetId = seen.id;
      zombie.lastSeenX = seen.x;
      zombie.lastSeenY = seen.y;
      delete zombie.investigateX;
      delete zombie.investigateY;
      zombie.loseInterestTick = tick + def.loseInterestTicks;
      zombie.ai =
        distance(zombie.x, zombie.y, seen.x, seen.y) <= def.attackRange ? 'attack' : 'pursue';
      if (!wasChasing) {
        ctx.events.emit({
          type: 'zombieAlerted',
          zombieId: zombie.id,
          targetId: seen.id,
          x: zombie.x,
          y: zombie.y,
        });
        if (def.noise >= SCREAM_NOISE_THRESHOLD) scream(ctx, zombie, def, seen.x, seen.y);
      }
      bump(zombie);
      return;
    }

    switch (zombie.ai) {
      case 'attack':
      case 'pursue': {
        // Lost it. Walk to where it was and hope.
        zombie.ai = 'investigate';
        if (zombie.lastSeenX !== undefined && zombie.lastSeenY !== undefined) {
          zombie.investigateX = zombie.lastSeenX;
          zombie.investigateY = zombie.lastSeenY;
        }
        bump(zombie);
        return;
      }
      case 'alerted': {
        zombie.ai = 'investigate';
        bump(zombie);
        return;
      }
      case 'investigate': {
        if (tick >= zombie.loseInterestTick) {
          zombie.ai = 'wander';
          delete zombie.targetId;
          delete zombie.lastSeenX;
          delete zombie.lastSeenY;
          delete zombie.investigateX;
          delete zombie.investigateY;
          bump(zombie);
          return;
        }
        const goal = zombieGoal(ctx, zombie);
        if (!goal || distance(zombie.x, zombie.y, goal.x, goal.y) <= ARRIVAL_RANGE) {
          // Arrived and found nothing: cast about nearby until patience runs out.
          pickWanderPoint(ctx, zombie, def, goal ?? zombie, TILE_SIZE * 3);
          bump(zombie);
        }
        return;
      }
      case 'idle': {
        if (roll(ctx).chance(WANDER_CHANCE)) {
          zombie.ai = 'wander';
          pickWanderPoint(ctx, zombie, def, { x: zombie.homeX, y: zombie.homeY }, WANDER_RADIUS);
          bump(zombie);
        }
        return;
      }
      case 'wander': {
        const goal = zombieGoal(ctx, zombie);
        if (!goal || distance(zombie.x, zombie.y, goal.x, goal.y) <= ARRIVAL_RANGE) {
          zombie.ai = 'idle';
          delete zombie.investigateX;
          delete zombie.investigateY;
          bump(zombie);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Choose somewhere to shuffle to. Silently gives up if the spot is not walkable. */
  function pickWanderPoint(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    around: { x: number; y: number },
    radius: number,
  ): void {
    const rolls = roll(ctx);
    const angle = rolls.angle();
    const reach = rolls.float(TILE_SIZE, radius);
    const x = around.x + Math.cos(angle) * reach;
    const y = around.y + Math.sin(angle) * reach;
    if (ctx.world.circleBlocked(x, y, def.radius)) return;
    zombie.investigateX = x;
    zombie.investigateY = y;
  }

  // -------------------------------------------------------------------------
  // Attacking
  // -------------------------------------------------------------------------

  /**
   * Whether the zombie has an unobstructed line to its target.
   *
   * A claw that lands through a wall would make base defence pointless, and a spitter
   * has to be denied its shot by the same cover that stops a bullet. Checked both when
   * the swing is announced and when it resolves, so stepping behind cover during the
   * wind-up actually saves you.
   */
  function hasClearLine(ctx: SimContext, zombie: ZombieState, target: PlayerState): boolean {
    return ctx.world.hasLineOfSight(zombie.x, zombie.y, target.x, target.y);
  }

  /** A swing that resolved into nothing. The client still plays the miss. */
  function emitMiss(ctx: SimContext, zombie: ZombieState, angle: number): void {
    ctx.events.emit({
      type: 'attackSwing',
      attackerId: zombie.id,
      angle,
      x: zombie.x,
      y: zombie.y,
      hit: false,
    });
  }

  function startSwing(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    target: PlayerState,
  ): void {
    const angle = angleBetween(zombie.x, zombie.y, target.x, target.y);
    zombie.facing = angle;
    // The client derives the wind-up window from `attackReadyTick` and the def's own
    // `attackTicks`, so the telegraph needs no extra replicated field.
    zombie.attackReadyTick = ctx.state.tick + Math.max(1, def.attackTicks);
    bump(zombie);
    if (def.windupTicks <= 0) {
      resolveSwing(ctx, zombie, def, target.id);
      return;
    }
    swings.set(zombie.id, {
      resolveTick: ctx.state.tick + def.windupTicks,
      targetId: target.id,
    });
  }

  function resolveSwing(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    targetId: EntityId,
  ): void {
    const target = ctx.state.players[targetId];
    const angle = target ? angleBetween(zombie.x, zombie.y, target.x, target.y) : zombie.facing;
    if (!target || !target.alive) {
      emitMiss(ctx, zombie, angle);
      return;
    }

    // Re-check the reach and the line at resolve time: backing out of a wind-up has to
    // work, or wind-up is just a delay with no counterplay.
    if (distance(zombie.x, zombie.y, target.x, target.y) > def.attackRange + ATTACK_REACH_GRACE) {
      emitMiss(ctx, zombie, angle);
      return;
    }
    if (!hasClearLine(ctx, zombie, target)) {
      emitMiss(ctx, zombie, angle);
      return;
    }

    if (isRangedZombie(def)) {
      // The projectile carries the attack from here: `SystemOrder.Projectile` runs
      // before the AI, so the bile leaves this tick and lands on the next one.
      spawnProjectile(ctx, {
        ownerId: zombie.id,
        defId: ZOMBIE_PROJECTILE_DEF_ID,
        x: zombie.x,
        y: zombie.y,
        angle,
        damage: def.damage,
        armorPen: 0,
        // A little past the aiming range, so a target that steps back still gets hit.
        maxRange: def.attackRange * 1.25,
      });
      zombie.facing = angle;
      bump(zombie);
      emitNoise(ctx, zombie.x, zombie.y, NoiseRadius.MeleeSwing, 0.6, zombie.id);
      return;
    }

    const bite = roll(ctx).chance(def.biteChance);
    const spec: DamageSpec = {
      amount: def.damage,
      type: bite ? 'zombieBite' : def.damageType,
      attackerId: zombie.id,
      knockback: def.knockback,
      angle,
      cause: def.name,
      ...(bite ? { bite: true, infectionChance: biteInfectionChance(ctx, def) } : {}),
    };
    // Through the combat system so armour, blocking and death are handled exactly the
    // same way they are for a player-versus-player hit.
    const result = resolveIncomingAttack(ctx, target.id, spec);

    zombie.facing = angle;
    bump(zombie);
    ctx.events.emit({
      type: 'attackSwing',
      attackerId: zombie.id,
      angle,
      x: zombie.x,
      y: zombie.y,
      hit: result.applied > 0 || result.blocked > 0,
    });
    emitNoise(ctx, zombie.x, zombie.y, NoiseRadius.MeleeHit, 0.7, zombie.id);
  }

  // -------------------------------------------------------------------------
  // Obstacles
  // -------------------------------------------------------------------------

  /** The structure blocking a tile, or undefined when nothing there is in the way. */
  function blockingStructureAt(ctx: SimContext, x: number, y: number): StructureState | undefined {
    const structure = structureAtTile(ctx.state, pixelToTile(x), pixelToTile(y));
    if (!structure) return undefined;
    if (structure.door?.open) return undefined;
    const def = ctx.data.structures.get(structure.defId);
    if (!def?.blocksMovement) return undefined;
    return structure;
  }

  /** Whatever the zombie just walked into, probing the blocked axes first. */
  function obstacleAhead(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    dirX: number,
    dirY: number,
    blockedX: boolean,
    blockedY: boolean,
  ): StructureState | undefined {
    const reach = def.radius + TILE_SIZE * 0.55;
    if (blockedX && dirX !== 0) {
      const hit = blockingStructureAt(ctx, zombie.x + Math.sign(dirX) * reach, zombie.y);
      if (hit) return hit;
    }
    if (blockedY && dirY !== 0) {
      const hit = blockingStructureAt(ctx, zombie.x, zombie.y + Math.sign(dirY) * reach);
      if (hit) return hit;
    }
    return blockingStructureAt(ctx, zombie.x + dirX * reach, zombie.y + dirY * reach);
  }

  /**
   * Deal with a structure in the way: open it if you have hands, break it if you do not.
   *
   * This is the whole reason walls are worth building. A zombie that cannot reach its
   * target through a player's wall attacks the wall on its normal attack cadence, so a
   * base buys exactly as much time as its material tier says it should.
   */
  function handleObstacle(
    ctx: SimContext,
    zombie: ZombieState,
    def: ZombieDef,
    structure: StructureState,
  ): void {
    const structureDef = ctx.data.structures.get(structure.defId);
    if (!structureDef) return;

    if (structure.door && def.canOpenDoors && !structure.door.locked) {
      if (!structure.door.open) {
        structure.door.open = true;
        refreshStructureCollision(ctx, structure);
        bump(structure);
        markStructureDirty(ctx.state, structure);
        const centre = structureCenter(structure, structureDef);
        ctx.events.emit({
          type: 'doorToggled',
          structureId: structure.id,
          open: true,
          byId: zombie.id,
        });
        emitNoise(ctx, centre.x, centre.y, NoiseRadius.DoorOpen, 0.5, zombie.id);
      }
      return;
    }

    if (!def.attacksStructures || def.structureDamage <= 0) return;
    if (!structureDef.destructible) return;
    if (ctx.state.tick < zombie.attackReadyTick) return;

    const centre = structureCenter(structure, structureDef);
    const angle = angleBetween(zombie.x, zombie.y, centre.x, centre.y);
    zombie.attackReadyTick = ctx.state.tick + Math.max(1, def.attackTicks);
    zombie.facing = angle;
    bump(zombie);

    const result = hitStructure(ctx, structure, {
      amount: def.structureDamage,
      type: 'blunt',
      attackerId: zombie.id,
      angle,
    });
    ctx.events.emit({
      type: 'attackSwing',
      attackerId: zombie.id,
      angle,
      x: zombie.x,
      y: zombie.y,
      hit: result.applied > 0,
    });
    if (!result.killed) emitNoise(ctx, zombie.x, zombie.y, NoiseRadius.MeleeHit, 0.8, zombie.id);
  }

  // -------------------------------------------------------------------------
  // Acting: movement, attacks, obstacles
  // -------------------------------------------------------------------------

  function act(ctx: SimContext, zombie: ZombieState, def: ZombieDef, ticks: number): void {
    const dt = ctx.clock.dt * ticks;

    // Knockback keeps pushing even through a stagger; that is what makes a heavy hit
    // feel like it landed.
    if (zombie.staggerUntilTick > ctx.state.tick) {
      stepMovement(ctx.world, zombie, HOLD_STILL, 0, dt, def.radius);
      bump(zombie);
      return;
    }

    const pending = swings.get(zombie.id);
    if (pending && ctx.state.tick >= pending.resolveTick) {
      swings.delete(zombie.id);
      resolveSwing(ctx, zombie, def, pending.targetId);
    }

    const target = zombie.targetId ? ctx.state.players[zombie.targetId] : undefined;
    if ((zombie.ai === 'attack' || zombie.ai === 'pursue') && target?.alive) {
      const reach = distance(zombie.x, zombie.y, target.x, target.y);
      // No line, no attack: the zombie keeps closing and takes its frustration out on
      // whatever is in the way instead.
      if (reach <= def.attackRange && hasClearLine(ctx, zombie, target)) {
        zombie.ai = 'attack';
        if (ctx.state.tick >= zombie.attackReadyTick && !swings.has(zombie.id)) {
          startSwing(ctx, zombie, def, target);
        }
        // Planted with respect to the target - no shuffling in and out of reach
        // mid-wind-up - but still shoved apart by whoever else is crowding the kill.
        const push = separation(
          ctx,
          zombie.id,
          zombie.x,
          zombie.y,
          def.radius,
          ZOMBIE_KINDS,
          crowdScratch,
        );
        const shuffle = blendSteering({ x: 0, y: 0 }, push);
        stepMovement(
          ctx.world,
          zombie,
          { moveX: shuffle.x, moveY: shuffle.y, sprint: false, crouch: false },
          def.speedWalk * ATTACK_SHUFFLE_SPEED,
          dt,
          def.radius,
        );
        // Facing last: the shuffle must not turn its head away from what it is hitting.
        zombie.facing = angleBetween(zombie.x, zombie.y, target.x, target.y);
        bump(zombie);
        return;
      }
    }

    const goal = zombieGoal(ctx, zombie);
    if (!goal) {
      stepMovement(ctx.world, zombie, HOLD_STILL, 0, dt, def.radius);
      bump(zombie);
      return;
    }

    const horde = zombie.hordeId ? ctx.state.hordes[zombie.hordeId] : undefined;
    const desired = steerTowards(ctx, zombie, goal.x, goal.y, {
      budget,
      maxPathsPerTick: MAX_ZOMBIE_PATHS_PER_TICK,
      doorCost: def.canOpenDoors || def.attacksStructures ? DOOR_PATH_COST : 0,
      ...(horde ? { flowGoalX: horde.goalX, flowGoalY: horde.goalY } : {}),
    });
    const push = separation(
      ctx,
      zombie.id,
      zombie.x,
      zombie.y,
      def.radius,
      ZOMBIE_KINDS,
      crowdScratch,
    );
    const heading = blendSteering(desired, push);

    const speed = zombieSpeed(zombie, def);
    const result = stepMovement(
      ctx.world,
      zombie,
      { moveX: heading.x, moveY: heading.y, sprint: false, crouch: false },
      speed,
      dt,
      def.radius,
    );
    bump(zombie);

    if (result.blockedX || result.blockedY) {
      const obstacle = obstacleAhead(
        ctx,
        zombie,
        def,
        desired.x,
        desired.y,
        result.blockedX,
        result.blockedY,
      );
      if (obstacle) handleObstacle(ctx, zombie, def, obstacle);
    }
  }

  // -------------------------------------------------------------------------
  // Hordes
  // -------------------------------------------------------------------------

  /**
   * Cluster pursuers that share a target into hordes.
   *
   * A horde is not a behaviour, it is a *budget*: members share one goal, and therefore
   * one flow-field integration, instead of each paying for their own. Rebuilt from
   * scratch on a timer because membership churns constantly and reconciling it
   * incrementally would cost more than the rebuild.
   */
  function regroupHordes(ctx: SimContext): void {
    const groups = new Map<string, EntityId[]>();
    for (const id of sortedZombieIds(ctx)) {
      const zombie = ctx.state.zombies[id];
      if (!zombie) continue;
      const chasing =
        (zombie.ai === 'pursue' || zombie.ai === 'attack') && zombie.targetId !== undefined;
      if (!chasing) {
        if (zombie.hordeId !== undefined) {
          delete zombie.hordeId;
          bump(zombie);
        }
        continue;
      }
      const key = `${zombie.targetId}|${Math.floor(zombie.x / HORDE_CELL)},${Math.floor(
        zombie.y / HORDE_CELL,
      )}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(id);
      else groups.set(key, [id]);
    }

    const hordes: Record<string, HordeState> = {};
    for (const key of [...groups.keys()].sort()) {
      const members = groups.get(key) ?? [];
      if (members.length < HORDE_MIN_SIZE) {
        for (const id of members) {
          const zombie = ctx.state.zombies[id];
          if (zombie?.hordeId !== undefined) {
            delete zombie.hordeId;
            bump(zombie);
          }
        }
        continue;
      }

      // Keep an existing horde's identity when most of it is still together, so a
      // long chase does not re-announce itself every regroup.
      const votes = new Map<string, number>();
      for (const id of members) {
        const existing = ctx.state.zombies[id]?.hordeId;
        if (existing !== undefined) votes.set(existing, (votes.get(existing) ?? 0) + 1);
      }
      let hordeId: string | undefined;
      let bestVotes = 0;
      for (const [candidate, count] of [...votes.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      )) {
        if (count > bestVotes && hordes[candidate] === undefined) {
          bestVotes = count;
          hordeId = candidate;
        }
      }
      let formed = false;
      if (hordeId === undefined) {
        hordeId = ctx.ids.horde();
        formed = true;
      }

      const lead = ctx.state.zombies[members[0] as string];
      const target = lead?.targetId ? ctx.state.players[lead.targetId] : undefined;
      const goalX = target?.x ?? lead?.x ?? 0;
      const goalY = target?.y ?? lead?.y ?? 0;
      hordes[hordeId] = {
        id: hordeId,
        memberIds: [...members],
        goalX,
        goalY,
        pathTick: ctx.state.tick,
      };
      for (const id of members) {
        const zombie = ctx.state.zombies[id];
        if (zombie && zombie.hordeId !== hordeId) {
          zombie.hordeId = hordeId;
          bump(zombie);
        }
      }
      if (formed) {
        ctx.events.emit({
          type: 'hordeFormed',
          hordeId,
          size: members.length,
          x: goalX,
          y: goalY,
        });
      }
    }
    ctx.state.hordes = hordes;

    // The transient maps are keyed by entity id; drop entries for the departed.
    for (const id of [...swings.keys()]) {
      if (!ctx.state.zombies[id]) swings.delete(id);
    }
    for (const id of [...lastScreamTick.keys()]) {
      if (!ctx.state.zombies[id]) lastScreamTick.delete(id);
    }
  }

  // -------------------------------------------------------------------------

  return {
    id: 'zombieAi',
    order: SystemOrder.Ai,

    update(ctx) {
      const tick = ctx.state.tick;
      const heard = noises.take(ctx);
      budget.paths = 0;
      budget.fields = 0;

      for (const id of sortedZombieIds(ctx)) {
        const zombie = ctx.state.zombies[id];
        if (!zombie || zombie.ai === 'dead') continue;
        const def = ctx.data.zombies.get(zombie.defId);
        if (!def) continue;

        const toPlayer = distanceToNearestPlayer(ctx.state, zombie.x, zombie.y);
        const lod = zombieLod(zombie.ai, toPlayer);
        if (zombie.lod !== lod) {
          zombie.lod = lod;
          bump(zombie);
        }

        // Hearing runs every tick: a gunshot must not wait on a 5-second schedule.
        if (heard.length > 0 && zombie.ai !== 'pursue' && zombie.ai !== 'attack') {
          listen(ctx, zombie, def, heard);
        }

        const thinking = tick >= zombie.nextThinkTick;
        if (thinking) {
          think(ctx, zombie, def, toPlayer);
          zombie.nextThinkTick = nextThinkTickFor(
            id,
            tick,
            zombieThinkInterval(zombie.ai, zombie.lod),
          );
        }

        // A dormant zombie is the cheap case and has to stay cheap: no senses, no
        // steering, no movement integration at all.
        if (zombie.ai === 'dormant') continue;

        if (zombie.lod <= SMOOTH_MOVEMENT_MAX_TIER) {
          act(ctx, zombie, def, 1);
        } else if (thinking) {
          const interval = zombieThinkInterval(zombie.ai, zombie.lod);
          act(ctx, zombie, def, coarseStepTicks(interval, zombieSpeed(zombie, def), ctx.clock.dt));
        }
      }

      if (tick % HORDE_REGROUP_TICKS === 0) regroupHordes(ctx);
      if (tick % FLOW_PRUNE_TICKS === 0) {
        ctx.world.pruneFlowFields(tick, FLOW_FIELD_MAX_AGE_TICKS);
      }

      // Everything this pass made a sound about - a scream, a fist on a door, a wall
      // coming down - is claimed here so it reaches the rest of the horde next tick.
      // Reading it now rather than next tick is what makes the behaviour independent of
      // whether the host drains the event sink between ticks.
      noises.carryOver(ctx);
    },
  };
}
