import {
  TILE_SIZE,
  angleBetween,
  distance,
  type AnimalAiState,
  type AnimalState,
  type EntityId,
  type LodTier,
  type PlayerState,
  type Rng,
} from '@survive/protocol';
import type { AnimalDef } from '@survive/game-data';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import type { DamageSpec } from '../../core/damage';
import { stepMovement, type MovementIntent } from '../../core/movement';
import { bump, distanceToNearestPlayer, nearestPlayer } from '../../core/queries';
import type { SpatialEntry } from '../../core/spatial';
import { resolveIncomingAttack } from '../combat/blocking';
import {
  DORMANT_DISTANCE,
  SMOOTH_MOVEMENT_MAX_TIER,
  animalThinkInterval,
  coarseStepTicks,
  lodForDistance,
  nextThinkTickFor,
} from './lod';
import { MAX_VISIBILITY, effectiveSightRange } from './senses';
import {
  blendSteering,
  createNavBudget,
  separation,
  steerTowards,
  type PathAgent,
} from './steering';

/**
 * Animal brains.
 *
 * Wildlife is the only renewable food source that does not need a farm, so the four
 * `AnimalDef.behavior` values are the difficulty dial on eating, and each one has to
 * read unmistakably from across a field:
 *
 * - `passive` stands there and keeps eating. It looks up when you get close, and that
 *   is all it ever does about you.
 * - `skittish` bolts at `fleeRange` and outruns a sprinting player, so hunting it is a
 *   bow-and-patience problem rather than a melee one.
 * - `territorial` holds its ground until you crowd it - `fleeRange` doubles as "how
 *   close is too close" - and then charges.
 * - `aggressive` comes to you from `sightRange`.
 *
 * The scheduling discipline is the same one the zombies use (`./lod`): the brain runs at
 * a rate set by state and distance, movement integrates every tick only for the tiers a
 * client can actually see, and an animal with no player inside three chunks stops
 * costing anything at all. Runs one slot after the zombies so that an animal reacting to
 * a player reacts to the position the player's own systems already settled on.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Most A* searches every animal put together may run in one tick. */
export const MAX_ANIMAL_PATHS_PER_TICK = 2;

/** How long a spooked animal keeps running once nothing is chasing it any more. */
export const FLEE_TICKS = 90;

/** Radius, in pixels, an animal wanders within of its home anchor. */
export const WANDER_RADIUS = TILE_SIZE * 8;

/** Chance a grazing animal decides to move on, per brain tick. */
export const WANDER_CHANCE = 0.2;

/** Chance a wandering animal stops to graze on arrival is 1; this is the reverse trip. */
export const GRAZE_CHANCE = 0.55;

/** Counts as having arrived at a wander point. */
export const ARRIVAL_RANGE = TILE_SIZE * 0.8;

/** Fraction of `attackTicks` an animal spends winding up, so a charge is telegraphed. */
export const ANIMAL_WINDUP_FRACTION = 0.3;

/** How far apart pack-mates can be and still coordinate. */
export const PACK_RADIUS = TILE_SIZE * 20;

/**
 * Population density at which a species is treated as a pack hunter.
 *
 * Wolves generate at 0.7 per chunk and so routinely meet their own kind; a bear at 0.25
 * effectively never does. Reading the behaviour off the density keeps it in the data
 * table rather than in a hard-coded list of def ids.
 */
export const PACK_MIN_DENSITY = 0.5;

/** Ticks between sweeps of the transient per-animal bookkeeping. */
const CLEANUP_TICKS = 120;

const HOLD_STILL: MovementIntent = { moveX: 0, moveY: 0, sprint: false, crouch: false };

const ANIMAL_KINDS = ['animal'] as const;

/** A charge that has been announced and is waiting out its wind-up. */
interface PendingBite {
  resolveTick: number;
  targetId: EntityId;
}

// ---------------------------------------------------------------------------
// Pure helpers, exported for tests
// ---------------------------------------------------------------------------

/** LOD tier for an animal: distance-derived, then floored by how busy it is. */
export function animalLod(ai: AnimalAiState, distanceToPlayer: number): LodTier {
  const tier = lodForDistance(distanceToPlayer);
  if (ai === 'flee' || ai === 'attack' || ai === 'stalk') return Math.min(tier, 1) as LodTier;
  if (ai === 'alert') return Math.min(tier, 2) as LodTier;
  return tier;
}

/**
 * Whether this species is up and about right now.
 *
 * Nocturnal animals are the reason night is worth staying in for: a wolf pack that only
 * hunts after dark is a schedule the player can learn, and an inactive animal keeps
 * grazing where it stands instead of roaming, which also makes it easier to find.
 */
export function isAnimalActive(ctx: SimContext, def: AnimalDef): boolean {
  return def.nocturnal ? ctx.state.time.isNight : !ctx.state.time.isNight;
}

/** Whether this species hunts as a group. */
export function isPackHunter(def: AnimalDef): boolean {
  return def.behavior === 'aggressive' && def.densityPerChunk >= PACK_MIN_DENSITY;
}

/** Movement speed in px/second for the animal's current state. */
export function animalSpeed(animal: AnimalState, def: AnimalDef): number {
  switch (animal.ai) {
    case 'flee':
    case 'attack':
    case 'stalk':
      return def.speedRun;
    case 'wander':
      return def.speedWalk;
    default:
      return 0;
  }
}

/** Whether this animal is armed at all. A rabbit is not going to fight back. */
export function canFightBack(def: AnimalDef): boolean {
  return def.damage > 0 && def.attackRange > 0;
}

/** Where this animal currently wants to be, or null when it should stand still. */
export function animalGoal(ctx: SimContext, animal: AnimalState): { x: number; y: number } | null {
  switch (animal.ai) {
    case 'attack':
    case 'stalk': {
      const target = animal.targetId ? ctx.state.players[animal.targetId] : undefined;
      return target?.alive ? { x: target.x, y: target.y } : null;
    }
    case 'wander':
      return { x: animal.wanderX, y: animal.wanderY };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

export function createAnimalAiSystem(): System {
  const budget = createNavBudget();
  const bites = new Map<EntityId, PendingBite>();
  /**
   * Per-animal navigation scratch.
   *
   * `AnimalState` carries no path fields - wildlife crosses open ground, so the flow
   * field and direct steering answer nearly every query - but `steerTowards` wants
   * somewhere to keep a fallback path between ticks. Holding it here rather than in
   * replicated state keeps the wire format honest: a reloaded save simply re-paths.
   */
  const navs = new Map<EntityId, PathAgent>();
  const sightScratch: SpatialEntry[] = [];
  const crowdScratch: SpatialEntry[] = [];
  const packScratch: SpatialEntry[] = [];

  let rng: Rng | null = null;
  let rngTick = -1;

  /** One RNG stream per tick for the whole subsystem. See the zombie system's `roll`. */
  function roll(ctx: SimContext): Rng {
    if (rngTick !== ctx.state.tick || rng === null) {
      rng = ctx.rng.fork('animalAi');
      rngTick = ctx.state.tick;
    }
    return rng;
  }

  function navFor(animal: AnimalState): PathAgent {
    let agent = navs.get(animal.id);
    if (!agent) {
      agent = { id: animal.id, x: animal.x, y: animal.y, path: [], pathIndex: 0, pathTick: -1000 };
      navs.set(animal.id, agent);
    }
    agent.x = animal.x;
    agent.y = animal.y;
    return agent;
  }

  // -------------------------------------------------------------------------
  // Senses
  // -------------------------------------------------------------------------

  /**
   * Nearest player this animal has noticed within `range`, or null.
   *
   * No vision cone: an animal's ears, nose and near-panoramic eyes all point at once,
   * and pretending otherwise would make sneaking up on a deer trivially easy. What does
   * apply is the same visibility budget zombies pay - light level, stance and the
   * stealth skill - so crouching in the dark is what gets you into bow range.
   */
  function spottedPlayer(ctx: SimContext, animal: AnimalState, range: number): PlayerState | null {
    if (range <= 0) return null;
    // Culled at the widest range the fine check below could possibly admit, not at the base
    // range. `effectiveSightRange` multiplies by stance, and a sprinting player is visible
    // at 1.3x - so culling at `range` threw away players the check would have accepted.
    // Worse, the broadphase returns whole 128 px cells, so *whether* it threw them away
    // depended on where the player sat inside its cell: the same 250 px gap either alerted
    // the animal or did not, according to grid alignment. `senses.ts` exports
    // `MAX_VISIBILITY` for exactly this cull and the zombie path already uses it.
    const cull = range * MAX_VISIBILITY;
    const candidates = ctx.spatial.query(animal.x, animal.y, cull, sightScratch);
    let best: PlayerState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of candidates) {
      if (entry.kind !== 'player') continue;
      const player = ctx.state.players[entry.id];
      if (!player || !player.alive) continue;
      const d = distance(animal.x, animal.y, player.x, player.y);
      // Ties break on id so an animal standing exactly between two players is not at
      // the mercy of hash iteration order.
      if (d > bestDistance || (d === bestDistance && best !== null && player.id >= best.id)) {
        continue;
      }
      if (d > effectiveSightRange(ctx, range, player)) continue;
      if (!ctx.world.hasLineOfSight(animal.x, animal.y, player.x, player.y)) continue;
      bestDistance = d;
      best = player;
    }
    return best;
  }

  /**
   * Whatever the rest of the pack is already chasing.
   *
   * Deliberately loose: a wolf joins a hunt its neighbours have started even when it has
   * not seen the prey itself, which is what turns three wolves into one problem instead
   * of three. It still has to be a player the wolf could plausibly reach, hence the
   * `sightRange` bound on the shared target.
   */
  function packTarget(ctx: SimContext, animal: AnimalState, def: AnimalDef): PlayerState | null {
    const candidates = ctx.spatial.query(animal.x, animal.y, PACK_RADIUS, packScratch);
    let best: PlayerState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of candidates) {
      if (entry.kind !== 'animal' || entry.id === animal.id) continue;
      const mate = ctx.state.animals[entry.id];
      if (!mate || mate.ai === 'dead' || mate.defId !== animal.defId) continue;
      if (!mate.targetId) continue;
      const prey = ctx.state.players[mate.targetId];
      if (!prey || !prey.alive) continue;
      const d = distance(animal.x, animal.y, prey.x, prey.y);
      if (d > def.sightRange) continue;
      if (d > bestDistance || (d === bestDistance && best !== null && prey.id >= best.id)) continue;
      bestDistance = d;
      best = prey;
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // The brain
  // -------------------------------------------------------------------------

  function startFleeing(ctx: SimContext, animal: AnimalState, threat: PlayerState | null): void {
    if (threat) {
      animal.targetId = threat.id;
      animal.facing = angleBetween(threat.x, threat.y, animal.x, animal.y);
    }
    animal.ai = 'flee';
    animal.fleeUntilTick = ctx.state.tick + FLEE_TICKS;
    clearPath(animal);
    bump(animal);
  }

  function settle(ctx: SimContext, animal: AnimalState, def: AnimalDef): void {
    delete animal.targetId;
    animal.ai = isAnimalActive(ctx, def) ? 'wander' : 'graze';
    if (animal.ai === 'wander') pickWanderPoint(ctx, animal, def);
    bump(animal);
  }

  function pickWanderPoint(ctx: SimContext, animal: AnimalState, def: AnimalDef): void {
    const rolls = roll(ctx);
    const angle = rolls.angle();
    const reach = rolls.float(TILE_SIZE, WANDER_RADIUS);
    const x = animal.homeX + Math.cos(angle) * reach;
    const y = animal.homeY + Math.sin(angle) * reach;
    if (ctx.world.circleBlocked(x, y, def.radius)) return;
    animal.wanderX = x;
    animal.wanderY = y;
  }

  function clearPath(animal: AnimalState): void {
    const agent = navs.get(animal.id);
    if (agent && agent.path.length > 0) {
      agent.path = [];
      agent.pathIndex = 0;
    }
  }

  function think(
    ctx: SimContext,
    animal: AnimalState,
    def: AnimalDef,
    distanceToPlayer: number,
  ): void {
    const tick = ctx.state.tick;

    // Nothing within three chunks: stand still and cost nothing. Animals have no
    // dormant state of their own, so `graze` is the resting pose.
    if (distanceToPlayer > DORMANT_DISTANCE) {
      if (animal.ai !== 'graze' || animal.targetId !== undefined) {
        animal.ai = 'graze';
        delete animal.targetId;
        animal.vx = 0;
        animal.vy = 0;
        clearPath(animal);
        bump(animal);
      }
      return;
    }

    // A bolting animal commits: it does not stop to reconsider halfway across the field.
    if (animal.ai === 'flee') {
      const threat = spottedPlayer(ctx, animal, def.fleeRange);
      if (threat) {
        startFleeing(ctx, animal, threat);
        return;
      }
      if (tick < animal.fleeUntilTick) return;
      settle(ctx, animal, def);
      return;
    }

    switch (def.behavior) {
      case 'skittish': {
        const threat = spottedPlayer(ctx, animal, def.fleeRange);
        if (threat) {
          startFleeing(ctx, animal, threat);
          return;
        }
        break;
      }
      case 'passive': {
        // It notices you and stops chewing. That is the whole reaction.
        const watched = spottedPlayer(ctx, animal, def.fleeRange);
        if (watched) {
          animal.ai = 'alert';
          animal.targetId = watched.id;
          animal.facing = angleBetween(animal.x, animal.y, watched.x, watched.y);
          bump(animal);
          return;
        }
        break;
      }
      case 'territorial': {
        // `fleeRange` reads as "how close is too close" for something that holds ground.
        const crowding = canFightBack(def) ? spottedPlayer(ctx, animal, def.fleeRange) : null;
        if (crowding) {
          animal.ai = 'attack';
          animal.targetId = crowding.id;
          bump(animal);
          return;
        }
        const watched = spottedPlayer(ctx, animal, def.sightRange);
        if (watched) {
          animal.ai = 'alert';
          animal.targetId = watched.id;
          animal.facing = angleBetween(animal.x, animal.y, watched.x, watched.y);
          bump(animal);
          return;
        }
        break;
      }
      case 'aggressive': {
        if (canFightBack(def)) {
          const seen = spottedPlayer(ctx, animal, def.sightRange);
          const prey = isPackHunter(def) ? (packTarget(ctx, animal, def) ?? seen) : seen;
          if (prey) {
            animal.targetId = prey.id;
            animal.ai =
              distance(animal.x, animal.y, prey.x, prey.y) <= def.attackRange ? 'attack' : 'stalk';
            bump(animal);
            return;
          }
        }
        break;
      }
    }

    // Nothing to react to: graze, or move on to somewhere with more grass.
    if (animal.targetId !== undefined) {
      delete animal.targetId;
      bump(animal);
    }
    if (animal.ai === 'attack' || animal.ai === 'stalk' || animal.ai === 'alert') {
      settle(ctx, animal, def);
      return;
    }
    if (!isAnimalActive(ctx, def)) {
      if (animal.ai !== 'graze') {
        animal.ai = 'graze';
        bump(animal);
      }
      return;
    }
    if (animal.ai === 'wander') {
      if (distance(animal.x, animal.y, animal.wanderX, animal.wanderY) <= ARRIVAL_RANGE) {
        animal.ai = roll(ctx).chance(GRAZE_CHANCE) ? 'graze' : 'wander';
        if (animal.ai === 'wander') pickWanderPoint(ctx, animal, def);
        bump(animal);
      }
      return;
    }
    if (roll(ctx).chance(WANDER_CHANCE)) {
      animal.ai = 'wander';
      pickWanderPoint(ctx, animal, def);
      bump(animal);
    }
  }

  // -------------------------------------------------------------------------
  // Attacking
  // -------------------------------------------------------------------------

  function startBite(
    ctx: SimContext,
    animal: AnimalState,
    def: AnimalDef,
    target: PlayerState,
  ): void {
    animal.facing = angleBetween(animal.x, animal.y, target.x, target.y);
    animal.attackReadyTick = ctx.state.tick + Math.max(1, def.attackTicks);
    bump(animal);
    const windup = Math.floor(def.attackTicks * ANIMAL_WINDUP_FRACTION);
    if (windup <= 0) {
      resolveBite(ctx, animal, def, target.id);
      return;
    }
    bites.set(animal.id, { resolveTick: ctx.state.tick + windup, targetId: target.id });
  }

  function resolveBite(
    ctx: SimContext,
    animal: AnimalState,
    def: AnimalDef,
    targetId: EntityId,
  ): void {
    const target = ctx.state.players[targetId];
    const angle = target ? angleBetween(animal.x, animal.y, target.x, target.y) : animal.facing;
    const miss = () => {
      ctx.events.emit({
        type: 'attackSwing',
        attackerId: animal.id,
        angle,
        x: animal.x,
        y: animal.y,
        hit: false,
      });
    };
    if (!target || !target.alive) {
      miss();
      return;
    }
    // Re-checked at resolve time so backing out of the charge works.
    if (distance(animal.x, animal.y, target.x, target.y) > def.attackRange + TILE_SIZE * 0.35) {
      miss();
      return;
    }
    if (!ctx.world.hasLineOfSight(animal.x, animal.y, target.x, target.y)) {
      miss();
      return;
    }

    const spec: DamageSpec = {
      amount: def.damage,
      type: def.damageType,
      attackerId: animal.id,
      knockback: def.damage * 2,
      angle,
      cause: def.name,
    };
    // Through the combat system, so a raised guard and worn armour mean the same thing
    // against a bear as they do against a zombie.
    const result = resolveIncomingAttack(ctx, target.id, spec);

    animal.facing = angle;
    bump(animal);
    ctx.events.emit({
      type: 'attackSwing',
      attackerId: animal.id,
      angle,
      x: animal.x,
      y: animal.y,
      hit: result.applied > 0 || result.blocked > 0,
    });
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  function act(ctx: SimContext, animal: AnimalState, def: AnimalDef, ticks: number): void {
    const dt = ctx.clock.dt * ticks;

    const pending = bites.get(animal.id);
    if (pending && ctx.state.tick >= pending.resolveTick) {
      bites.delete(animal.id);
      resolveBite(ctx, animal, def, pending.targetId);
    }

    if (animal.ai === 'flee') {
      fleeStep(ctx, animal, def, dt);
      return;
    }

    const target = animal.targetId ? ctx.state.players[animal.targetId] : undefined;
    if ((animal.ai === 'attack' || animal.ai === 'stalk') && target?.alive && canFightBack(def)) {
      const reach = distance(animal.x, animal.y, target.x, target.y);
      if (
        reach <= def.attackRange &&
        ctx.world.hasLineOfSight(animal.x, animal.y, target.x, target.y)
      ) {
        animal.ai = 'attack';
        animal.facing = angleBetween(animal.x, animal.y, target.x, target.y);
        if (ctx.state.tick >= animal.attackReadyTick && !bites.has(animal.id)) {
          startBite(ctx, animal, def, target);
        }
        stepMovement(ctx.world, animal, HOLD_STILL, 0, dt, def.radius);
        bump(animal);
        return;
      }
    }

    const goal = animalGoal(ctx, animal);
    if (!goal) {
      stepMovement(ctx.world, animal, HOLD_STILL, 0, dt, def.radius);
      bump(animal);
      return;
    }

    const desired = steerTowards(ctx, navFor(animal), goal.x, goal.y, {
      budget,
      maxPathsPerTick: MAX_ANIMAL_PATHS_PER_TICK,
      // Wildlife does not open or break doors, so a closed one is simply a wall.
      doorCost: 0,
    });
    const push = separation(
      ctx,
      animal.id,
      animal.x,
      animal.y,
      def.radius,
      ANIMAL_KINDS,
      crowdScratch,
    );
    const heading = blendSteering(desired, push);
    stepMovement(
      ctx.world,
      animal,
      { moveX: heading.x, moveY: heading.y, sprint: false, crouch: false },
      animalSpeed(animal, def),
      dt,
      def.radius,
    );
    bump(animal);
  }

  /**
   * Whatever this animal is running from.
   *
   * `damageAnimal` drops an animal into `flee` from anywhere - a rifle round from six
   * hundred pixels away, well outside every sense it has - and leaves it no target to
   * run from. Falling back to the nearest player is the only signal available and it is
   * the right one: the alternative is bolting along whatever heading it happened to be
   * grazing on, which every so often means charging straight at the shooter.
   */
  function fleeThreat(ctx: SimContext, animal: AnimalState): PlayerState | null {
    if (animal.targetId) {
      const known = ctx.state.players[animal.targetId];
      if (known?.alive) return known;
    }
    return nearestPlayer(ctx.state, animal.x, animal.y, DORMANT_DISTANCE);
  }

  /**
   * Run directly away from the threat.
   *
   * No pathfinding: a panicking animal does not plan, it points itself at open ground
   * and goes, and `moveCircle` sliding along whatever it clips is exactly the right
   * amount of cleverness. When the threat is gone the animal keeps its heading until
   * `fleeUntilTick`, which is what stops it from turning round the instant it breaks
   * line of sight and running back into the player.
   */
  function fleeStep(ctx: SimContext, animal: AnimalState, def: AnimalDef, dt: number): void {
    const threat = fleeThreat(ctx, animal);
    let dirX = Math.cos(animal.facing);
    let dirY = Math.sin(animal.facing);
    if (threat) {
      const dx = animal.x - threat.x;
      const dy = animal.y - threat.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-3) {
        dirX = dx / d;
        dirY = dy / d;
      }
    }
    const push = separation(
      ctx,
      animal.id,
      animal.x,
      animal.y,
      def.radius,
      ANIMAL_KINDS,
      crowdScratch,
    );
    const heading = blendSteering({ x: dirX, y: dirY }, push);
    stepMovement(
      ctx.world,
      animal,
      { moveX: heading.x, moveY: heading.y, sprint: false, crouch: false },
      def.speedRun,
      dt,
      def.radius,
    );
    bump(animal);
  }

  // -------------------------------------------------------------------------

  return {
    id: 'animalAi',
    // One slot after the zombies: both read player positions, and running them in a
    // fixed order is part of what keeps a replay identical.
    order: SystemOrder.Ai + 1,

    update(ctx) {
      const tick = ctx.state.tick;
      budget.paths = 0;
      budget.fields = 0;

      for (const id of Object.keys(ctx.state.animals).sort()) {
        const animal = ctx.state.animals[id];
        if (!animal || animal.ai === 'dead') continue;
        const def = ctx.data.animals.get(animal.defId);
        if (!def) continue;

        const toPlayer = distanceToNearestPlayer(ctx.state, animal.x, animal.y);
        const lod = animalLod(animal.ai, toPlayer);
        if (animal.lod !== lod) {
          animal.lod = lod;
          bump(animal);
        }

        const thinking = tick >= animal.nextThinkTick;
        if (thinking) {
          think(ctx, animal, def, toPlayer);
          animal.nextThinkTick = nextThinkTickFor(
            id,
            tick,
            animalThinkInterval(animal.ai, animal.lod),
          );
        }

        // A queued bite belongs to the attack that started it. Drop it the moment the
        // animal is doing something else - the expiry inside `act` is the only other place
        // that touches it, and `act` is skipped for the three states below, so a bite
        // queued and then disengaged from used to *freeze*: it thawed on the tick the
        // animal next entered 'attack' and resolved instantly with no wind-up, and because
        // the map was empty again by then a second bite started in the same tick. Backing
        // out of a wind-up has to work, exactly as it does for zombies.
        if (animal.ai !== 'attack' && animal.ai !== 'stalk') bites.delete(animal.id);

        // A grazing animal is the cheap case: it is standing still, so there is nothing
        // for a movement step to integrate.
        if (animal.ai === 'graze' || animal.ai === 'idle' || animal.ai === 'alert') continue;

        if (animal.lod <= SMOOTH_MOVEMENT_MAX_TIER) {
          act(ctx, animal, def, 1);
        } else if (thinking) {
          const interval = animalThinkInterval(animal.ai, animal.lod);
          act(ctx, animal, def, coarseStepTicks(interval, animalSpeed(animal, def), ctx.clock.dt));
        }
      }

      if (tick % CLEANUP_TICKS === 0) {
        for (const id of [...bites.keys()]) {
          if (!ctx.state.animals[id]) bites.delete(id);
        }
        for (const id of [...navs.keys()]) {
          if (!ctx.state.animals[id]) navs.delete(id);
        }
      }
    },
  };
}
