import { TILE_SIZE, hashString, tileCenter, type EntityId, type Vec2 } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import type { SpatialEntry, SpatialKind } from '../../core/spatial';

/**
 * Getting a crowd of creatures to walk somewhere without running A* per creature per
 * tick (spec section 23).
 *
 * The ladder, cheapest first:
 *
 * 1. **Close to the goal** - steer straight at it. Wall sliding in `moveCircle` handles
 *    the last few pixels, and walking face-first into a player's wall is exactly the
 *    behaviour that makes base defence matter, so it is not something to path around.
 * 2. **A shared flow field** - one Dijkstra integration for a whole horde, sampled with
 *    an array lookup each. Goals are quantised so a jogging player does not invalidate
 *    the field every tile.
 * 3. **A private A\*** - rate-limited per creature *and* capped per tick, because this
 *    is the only step here whose cost scales with the size of the map.
 * 4. **Straight at it anyway** - better a zombie that presses hopelessly against a wall
 *    than a zombie that stands still looking stupid.
 */

/** Inside this distance a creature ignores navigation and just walks at the goal. */
export const DIRECT_STEER_RANGE = TILE_SIZE * 4;

/**
 * Flow-field goals are snapped to this grid.
 *
 * Bigger than the world's own quantum so a shared field survives a player walking a
 * couple of tiles, and comfortably larger than {@link DIRECT_STEER_RANGE} is small, so
 * the aim-off the snapping introduces is always inside the direct-steering bubble.
 */
export const FLOW_GOAL_QUANTUM = TILE_SIZE * 4;

/** Flow fields older than this are rebuilt rather than reused. */
export const FLOW_FIELD_MAX_AGE_TICKS = 60;

/** Minimum ticks between two A* calls for the same creature. */
export const PATH_REFRESH_TICKS = 40;

/** A stored path older than this is stale: the world may have changed under it. */
export const PATH_MAX_AGE_TICKS = 120;

/** How close counts as having reached a waypoint. */
export const WAYPOINT_REACH = TILE_SIZE * 0.7;

/** Node budget for one AI A* call. Deliberately small: this is a hint, not a promise. */
export const PATH_MAX_NODES = 1200;

/** How hard separation pushes compared with the desire to reach the goal. */
export const SEPARATION_WEIGHT = 0.6;

/** The bits of a creature that navigation reads and writes. */
export interface PathAgent {
  id: EntityId;
  x: number;
  y: number;
  /** Flattened tile path `[tx0, ty0, tx1, ty1, ...]`. */
  path: number[];
  pathIndex: number;
  pathTick: number;
}

/**
 * Per-tick allowance of navigation work, shared by every creature.
 *
 * Without it, one badly placed wall turns a horde into a few hundred searches on the
 * same tick. Creatures are iterated in sorted id order, so which ones get the budget is
 * deterministic.
 *
 * `fields` bounds flow-field *builds*, which is a separate and larger cost than A*. The
 * cache is keyed on the quantised goal, so a horde converging on one player shares a
 * single integration - but zombies pursuing independently each have their own goal, and a
 * profile of a dense seed put `buildFlowField` at 30% of total server CPU, comfortably
 * the most expensive thing in the simulation. Capping builds per tick bounds that by
 * construction: a creature that cannot get a field this tick falls back to A* or to
 * direct steering, which is a slightly worse route for one tick and invisible in play.
 */
export interface NavBudget {
  paths: number;
  fields: number;
}

export function createNavBudget(): NavBudget {
  return { paths: 0, fields: 0 };
}

/**
 * Flow-field builds allowed per tick across every creature.
 *
 * Four builds of a 49x49 window is about 10k tile relaxations, which measures in the
 * low single-digit milliseconds - affordable against a 50ms budget, and enough to keep
 * every horde and a handful of lone pursuers on a shared field within a tick or two.
 */
export const DEFAULT_MAX_FIELDS_PER_TICK = 4;

/** Snap a world coordinate to the flow-field goal grid, returning the cell centre. */
export function quantiseGoal(value: number): number {
  const cell = Math.floor(value / FLOW_GOAL_QUANTUM);
  return cell * FLOW_GOAL_QUANTUM + FLOW_GOAL_QUANTUM / 2;
}

function normalise(x: number, y: number): Vec2 {
  const length = Math.hypot(x, y);
  if (length <= 1e-6) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

export interface SteerOptions {
  /** Ticks between A* retries for this creature. */
  budget: NavBudget;
  /** Most A* calls the whole tick may make. */
  maxPathsPerTick: number;
  /**
   * Most flow-field builds the whole tick may make. Cached hits are free and do not
   * count; only a build spends the budget.
   */
  maxFieldsPerTick?: number;
  /** Route through closed doors at this surcharge. 0 leaves them impassable. */
  doorCost: number;
  /**
   * Goal the shared flow field should aim at, when it differs from the creature's own
   * goal. Horde members pass their horde's goal so they all sample one integration.
   */
  flowGoalX?: number;
  flowGoalY?: number;
}

/**
 * Unit direction this creature should walk in to get to (goalX, goalY).
 *
 * Mutates `agent.path` / `pathIndex` / `pathTick` as it follows and refreshes paths.
 * Returns a zero vector only when the creature is already there.
 */
export function steerTowards(
  ctx: SimContext,
  agent: PathAgent,
  goalX: number,
  goalY: number,
  options: SteerOptions,
): Vec2 {
  const dx = goalX - agent.x;
  const dy = goalY - agent.y;
  const straight = Math.hypot(dx, dy);
  if (straight <= 1) {
    clearPath(agent);
    return { x: 0, y: 0 };
  }

  if (straight <= DIRECT_STEER_RANGE) {
    clearPath(agent);
    return { x: dx / straight, y: dy / straight };
  }

  const flowX = quantiseGoal(options.flowGoalX ?? goalX);
  const flowY = quantiseGoal(options.flowGoalY ?? goalY);
  const maxFields = options.maxFieldsPerTick ?? DEFAULT_MAX_FIELDS_PER_TICK;
  // A cached field is free, so ask for one first and only spend budget on a build. The
  // world's build counter says whether *this* call had to integrate; `builtTick` cannot,
  // because every member of a horde sharing one field matches the tick it was built on.
  if (options.budget.fields < maxFields) {
    const buildsBefore = ctx.world.flowFieldBuilds;
    const field = ctx.world.getFlowField(flowX, flowY, ctx.state.tick);
    if (field) {
      if (ctx.world.flowFieldBuilds !== buildsBefore) options.budget.fields++;
      const flow = ctx.world.sampleFlow(field, agent.x, agent.y);
      if (flow) {
        clearPath(agent);
        return normalise(flow.x, flow.y);
      }
    }
  }

  const followed = followPath(ctx, agent);
  if (followed) return followed;

  const tick = ctx.state.tick;
  if (
    options.budget.paths < options.maxPathsPerTick &&
    tick - agent.pathTick >= PATH_REFRESH_TICKS
  ) {
    options.budget.paths++;
    agent.pathTick = tick;
    agent.pathIndex = 0;
    agent.path = ctx.world.findPath(agent.x, agent.y, goalX, goalY, {
      maxNodes: PATH_MAX_NODES,
      doorCost: options.doorCost,
      goalTolerance: 1,
      allowDiagonal: true,
    });
    const fresh = followPath(ctx, agent);
    if (fresh) return fresh;
  }

  return { x: dx / straight, y: dy / straight };
}

function clearPath(agent: PathAgent): void {
  if (agent.path.length > 0) {
    agent.path = [];
    agent.pathIndex = 0;
  }
}

/**
 * Advance along a stored path and return the direction of the current waypoint, or null
 * when there is no usable path left.
 */
function followPath(ctx: SimContext, agent: PathAgent): Vec2 | null {
  if (agent.path.length < 2) return null;
  if (ctx.state.tick - agent.pathTick > PATH_MAX_AGE_TICKS) {
    clearPath(agent);
    return null;
  }
  const waypoints = agent.path.length / 2;
  while (agent.pathIndex < waypoints) {
    const tileX = agent.path[agent.pathIndex * 2];
    const tileY = agent.path[agent.pathIndex * 2 + 1];
    if (tileX === undefined || tileY === undefined) break;
    const targetX = tileCenter(tileX);
    const targetY = tileCenter(tileY);
    const dx = targetX - agent.x;
    const dy = targetY - agent.y;
    const d = Math.hypot(dx, dy);
    if (d <= WAYPOINT_REACH) {
      agent.pathIndex++;
      continue;
    }
    return { x: dx / d, y: dy / d };
  }
  clearPath(agent);
  return null;
}

/**
 * Push away from crowding neighbours.
 *
 * Without this a horde converges to a single pixel and reads as one very confused
 * zombie. The push is deliberately weak: shoving each other around must not stop the
 * front rank from reaching the player.
 */
export function separation(
  ctx: SimContext,
  selfId: EntityId,
  x: number,
  y: number,
  radius: number,
  kinds: readonly SpatialKind[],
  scratch: SpatialEntry[],
): Vec2 {
  const candidates = ctx.spatial.query(x, y, radius * 2, scratch);
  let pushX = 0;
  let pushY = 0;
  for (const entry of candidates) {
    if (entry.id === selfId) continue;
    if (!kinds.includes(entry.kind)) continue;
    const gap = radius + entry.radius;
    const dx = x - entry.x;
    const dy = y - entry.y;
    const d = Math.hypot(dx, dy);
    if (d >= gap) continue;
    if (d <= 1e-4) {
      // Exactly stacked: pick a fixed direction from the neighbour's id so the pair
      // always separates the same way instead of sitting in a stable tie.
      const angle = (hashString(entry.id) % 628) / 100 - Math.PI;
      pushX += Math.cos(angle);
      pushY += Math.sin(angle);
      continue;
    }
    const strength = (gap - d) / gap;
    pushX += (dx / d) * strength;
    pushY += (dy / d) * strength;
  }
  return { x: pushX, y: pushY };
}

/** Combine a goal direction with a separation push into one unit heading. */
export function blendSteering(desired: Vec2, push: Vec2, weight = SEPARATION_WEIGHT): Vec2 {
  return normalise(desired.x + push.x * weight, desired.y + push.y * weight);
}
