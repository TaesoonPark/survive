/**
 * Tile-grid A* plus the string-pulling pass that makes its output look intentional.
 *
 * Every zombie in an active horde can ask for a path, so the cost model here is as much
 * about *not allocating* as about finding a route: the open set is a binary heap over
 * typed arrays, the node table is a set of parallel typed arrays, and both live in a
 * workspace that is reused between calls and grown on demand. A search that expands a few
 * hundred nodes therefore allocates nothing but its result array.
 *
 * Determinism (Architecture Guard rules 7 and 8) is a hard requirement, so nothing here
 * may depend on iteration accidents:
 * - neighbours are always visited in the same fixed order;
 * - equal `f` scores break on the lower node index, i.e. on which tile was reached first,
 *   never on `Map` or `Set` ordering;
 * - the reused workspace is fully initialised per node as nodes are created, so a search
 *   cannot read a value left behind by an earlier one.
 *
 * Coordinates in and out: **positions are world pixels, results are tile indices.** The
 * caller steers towards tile centres, which is what {@link smoothPath} assumes too.
 */

import { TILE_SIZE, pixelToTile, tileCenter } from '@survive/protocol';
import type { CollisionGrid } from './collision';
import { CollisionFlag, SOLID_MASK } from './types';
import type { PathOptions } from './types';

/** Expanded-node budget when the caller does not set one. */
export const DEFAULT_MAX_NODES = 4096;

/**
 * Extra cost of routing through a closed door, when the caller opts in.
 *
 * Zombies path through doors and then break them: the door has to be *reachable* for the
 * attack-the-obstacle behaviour to ever fire. The cost is what keeps them preferring an
 * open window three tiles away over chewing through oak.
 */
export const DEFAULT_DOOR_COST = 8;

const SQRT2 = Math.SQRT2;

/**
 * Minimum radius, in tiles, used to nudge a goal that landed inside geometry.
 *
 * Two tiles reaches free ground from the centre of a 3x3 block - a shed, a rock cluster,
 * the middle of a wall junction - which is the shape players click on. Deeper than that the
 * goal is genuinely inside a building and failing is the honest answer.
 */
const GOAL_REPAIR_RADIUS_TILES = 2;

/**
 * Neighbour offsets: four orthogonals, then four diagonals. The split is load-bearing -
 * `direction < 4` is the orthogonal test, and the diagonal at index `d` shares its two
 * orthogonal neighbours with the corner-cutting check.
 */
const STEP_X = [1, 0, -1, 0, 1, 1, -1, -1] as const;
const STEP_Y = [0, 1, 0, -1, 1, -1, 1, -1] as const;

/**
 * Tile coordinates packed into one number, for the tile -> node lookup.
 *
 * World tiles are 0..8191, but out-of-world probes must stay distinct rather than collide,
 * hence the generous offset. The product stays far inside 2^53, so the packing is exact.
 */
const TILE_COORD_LIMIT = 1 << 24;
const TILE_KEY_STRIDE = 1 << 25;

function tileKey(tileX: number, tileY: number): number {
  return (tileX + TILE_COORD_LIMIT) * TILE_KEY_STRIDE + (tileY + TILE_COORD_LIMIT);
}

/**
 * Cost of *entering* a tile, or -1 when it cannot be entered.
 *
 * Zero for open ground. `doorCost` for a closed door - but only a door: the `Door` bit
 * next to a terrain solid or a tree trunk is meaningless, and a door frame does not make a
 * cliff climbable. Deep water is passable (entities swim, spec section 12); the swim speed
 * penalty is the movement system's business, not the router's.
 */
export function tileStepPenalty(
  grid: CollisionGrid,
  tileX: number,
  tileY: number,
  doorCost: number,
): number {
  const flags = grid.get(tileX, tileY);
  if ((flags & SOLID_MASK) === 0) return 0;
  if (
    doorCost > 0 &&
    (flags & CollisionFlag.Door) !== 0 &&
    (flags & (CollisionFlag.TerrainSolid | CollisionFlag.NodeSolid)) === 0
  ) {
    return doorCost;
  }
  return -1;
}

/**
 * Nearest enterable tile to (tileX, tileY) within `maxRadius` tiles, or null.
 *
 * Rings are scanned outwards and, inside a ring, in a fixed order, so the answer is a pure
 * function of the grid. Used to repair a goal that landed inside a wall - clicking on a
 * building, or chasing a player who is standing in a doorway - instead of failing the
 * whole request.
 */
export function findNearestFreeTile(
  grid: CollisionGrid,
  tileX: number,
  tileY: number,
  maxRadius: number,
  doorCost = 0,
): { tileX: number; tileY: number } | null {
  if (tileStepPenalty(grid, tileX, tileY, doorCost) >= 0) return { tileX, tileY };
  const limit = Math.max(0, Math.floor(maxRadius));
  for (let radius = 1; radius <= limit; radius++) {
    let bestX = 0;
    let bestY = 0;
    let bestDistanceSq = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Only the newly reached ring: inner tiles were tested on an earlier pass.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        if (tileStepPenalty(grid, tileX + dx, tileY + dy, doorCost) < 0) continue;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestX = tileX + dx;
          bestY = tileY + dy;
        }
      }
    }
    if (bestDistanceSq < Infinity) return { tileX: bestX, tileY: bestY };
  }
  return null;
}

/**
 * Binary min-heap of node indices, over typed arrays.
 *
 * Shared by A* and by the flow-field Dijkstra. Equal scores break on the lower node
 * index, which makes the pop order a pure function of insertion order - the property that
 * keeps two identical searches returning byte-identical paths. Nodes may be pushed more
 * than once (lazy decrease-key); the consumer skips the stale copies via its closed set.
 */
export interface MinHeap {
  readonly size: number;
  clear(): void;
  push(node: number, score: number): void;
  /** Lowest-scoring node, or -1 when the heap is empty. */
  pop(): number;
}

export function createMinHeap(initialCapacity = 64): MinHeap {
  let capacity = Math.max(1, initialCapacity);
  let nodes = new Int32Array(capacity);
  let scores = new Float64Array(capacity);
  let size = 0;

  function grow(): void {
    capacity *= 2;
    const nextNodes = new Int32Array(capacity);
    nextNodes.set(nodes);
    nodes = nextNodes;
    const nextScores = new Float64Array(capacity);
    nextScores.set(scores);
    scores = nextScores;
  }

  function less(a: number, b: number): boolean {
    const scoreA = scores[a] as number;
    const scoreB = scores[b] as number;
    if (scoreA < scoreB) return true;
    if (scoreA > scoreB) return false;
    return (nodes[a] as number) < (nodes[b] as number);
  }

  function swap(a: number, b: number): void {
    const node = nodes[a] as number;
    const score = scores[a] as number;
    nodes[a] = nodes[b] as number;
    scores[a] = scores[b] as number;
    nodes[b] = node;
    scores[b] = score;
  }

  return {
    get size() {
      return size;
    },
    clear() {
      size = 0;
    },
    push(node, score) {
      if (size === capacity) grow();
      nodes[size] = node;
      scores[size] = score;
      let index = size;
      size++;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!less(index, parent)) break;
        swap(index, parent);
        index = parent;
      }
    },
    pop() {
      if (size === 0) return -1;
      const top = nodes[0] as number;
      size--;
      if (size > 0) {
        nodes[0] = nodes[size] as number;
        scores[0] = scores[size] as number;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          if (left >= size) break;
          const right = left + 1;
          let child = left;
          if (right < size && less(right, left)) child = right;
          if (!less(child, index)) break;
          swap(child, index);
          index = child;
        }
      }
      return top;
    },
  };
}

/**
 * Reused search scratch space.
 *
 * A* is called for many agents per tick; re-allocating six arrays each time is pure
 * garbage pressure. Reuse is safe for determinism because every per-node field is written
 * when the node is created and the tile lookup is cleared at the start of each search, so
 * no value from a previous call is ever read.
 */
interface PathWorkspace {
  tileToNode: Map<number, number>;
  heap: MinHeap;
  tileX: Int32Array;
  tileY: Int32Array;
  gScore: Float64Array;
  fScore: Float64Array;
  parent: Int32Array;
  closed: Uint8Array;
  capacity: number;
}

let workspace: PathWorkspace | null = null;

function ensureWorkspace(minCapacity: number): PathWorkspace {
  if (workspace === null) {
    workspace = {
      tileToNode: new Map<number, number>(),
      heap: createMinHeap(256),
      tileX: new Int32Array(0),
      tileY: new Int32Array(0),
      gScore: new Float64Array(0),
      fScore: new Float64Array(0),
      parent: new Int32Array(0),
      closed: new Uint8Array(0),
      capacity: 0,
    };
  }
  const ws = workspace;
  if (ws.capacity >= minCapacity) return ws;
  let capacity = Math.max(256, ws.capacity);
  while (capacity < minCapacity) capacity *= 2;
  // Copy the live prefix: a grow can happen part-way through a search.
  const tileX = new Int32Array(capacity);
  tileX.set(ws.tileX);
  const tileY = new Int32Array(capacity);
  tileY.set(ws.tileY);
  const gScore = new Float64Array(capacity);
  gScore.set(ws.gScore);
  const fScore = new Float64Array(capacity);
  fScore.set(ws.fScore);
  const parent = new Int32Array(capacity);
  parent.set(ws.parent);
  const closed = new Uint8Array(capacity);
  closed.set(ws.closed);
  ws.tileX = tileX;
  ws.tileY = tileY;
  ws.gScore = gScore;
  ws.fScore = fScore;
  ws.parent = parent;
  ws.closed = closed;
  ws.capacity = capacity;
  return ws;
}

/** Octile distance: the exact cost of an unobstructed 8-way walk. */
function octileDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

function reconstruct(ws: PathWorkspace, node: number): number[] {
  let count = 0;
  for (let n = node; n >= 0; n = ws.parent[n] as number) count++;
  const path = new Array<number>(count * 2);
  let write = count * 2;
  for (let n = node; n >= 0; n = ws.parent[n] as number) {
    write -= 2;
    path[write] = ws.tileX[n] as number;
    path[write + 1] = ws.tileY[n] as number;
  }
  return path;
}

/**
 * A* from a world position to a world position, returning `[tx0, ty0, tx1, ty1, ...]`.
 *
 * The first waypoint is always the tile the search started in, so a caller can compare the
 * path against the agent's current tile without special-casing; an agent already at the
 * goal gets a single waypoint. An empty array means "no route" - unreachable, or not
 * reachable inside `maxNodes` expansions.
 *
 * A goal tile that is itself blocked is repaired to the nearest enterable tile rather than
 * failing: chasing a player who ducked behind a wall, or a click on a building, should
 * still walk you over there.
 */
export function findPath(
  grid: CollisionGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  options?: PathOptions,
): number[] {
  if (!Number.isFinite(fromX) || !Number.isFinite(fromY)) return [];
  if (!Number.isFinite(toX) || !Number.isFinite(toY)) return [];

  const maxNodes = Math.max(1, Math.floor(options?.maxNodes ?? DEFAULT_MAX_NODES));
  const doorCost = Math.max(0, options?.doorCost ?? 0);
  const tolerance = Math.max(0, Math.floor(options?.goalTolerance ?? 0));
  const allowDiagonal = options?.allowDiagonal ?? true;
  const directions = allowDiagonal ? 8 : 4;

  const startTileX = pixelToTile(fromX);
  const startTileY = pixelToTile(fromY);
  let goalTileX = pixelToTile(toX);
  let goalTileY = pixelToTile(toY);

  if (tileStepPenalty(grid, goalTileX, goalTileY, doorCost) < 0) {
    // Repaired even at tolerance 0: a solid goal is a near miss, not a refusal.
    const repaired = findNearestFreeTile(
      grid,
      goalTileX,
      goalTileY,
      Math.max(tolerance, GOAL_REPAIR_RADIUS_TILES),
      doorCost,
    );
    if (repaired === null) return [];
    goalTileX = repaired.tileX;
    goalTileY = repaired.tileY;
  }

  // Each expansion can create at most 8 nodes, plus the start.
  const ws = ensureWorkspace(maxNodes * 8 + 1);
  ws.tileToNode.clear();
  ws.heap.clear();
  let nodeCount = 0;

  function addNode(tileX: number, tileY: number, gScore: number, parent: number): number {
    const node = nodeCount++;
    ws.tileX[node] = tileX;
    ws.tileY[node] = tileY;
    ws.gScore[node] = gScore;
    // Subtracting the tolerance keeps the heuristic admissible for the *relaxed* goal:
    // without it A* would happily overshoot a tolerated near-goal tile.
    const heuristic = allowDiagonal
      ? octileDistance(tileX, tileY, goalTileX, goalTileY)
      : Math.abs(tileX - goalTileX) + Math.abs(tileY - goalTileY);
    ws.fScore[node] = gScore + Math.max(0, heuristic - tolerance);
    ws.parent[node] = parent;
    ws.closed[node] = 0;
    ws.tileToNode.set(tileKey(tileX, tileY), node);
    return node;
  }

  const start = addNode(startTileX, startTileY, 0, -1);
  ws.heap.push(start, ws.fScore[start] as number);

  let expansions = 0;

  while (ws.heap.size > 0) {
    const current = ws.heap.pop();
    if (current < 0) break;
    if (ws.closed[current] === 1) continue;
    ws.closed[current] = 1;

    const currentX = ws.tileX[current] as number;
    const currentY = ws.tileY[current] as number;

    // Tolerance is a tile radius, so Chebyshev distance is the natural measure of "close
    // enough": every tile within it is reachable in `tolerance` 8-way steps.
    if (Math.max(Math.abs(currentX - goalTileX), Math.abs(currentY - goalTileY)) <= tolerance) {
      return reconstruct(ws, current);
    }

    expansions++;
    if (expansions > maxNodes) return [];

    const currentG = ws.gScore[current] as number;

    for (let direction = 0; direction < directions; direction++) {
      const stepX = STEP_X[direction] as number;
      const stepY = STEP_Y[direction] as number;
      const nextX = currentX + stepX;
      const nextY = currentY + stepY;

      if (direction >= 4) {
        // No corner cutting: both shared orthogonals must be genuinely open. A door frame
        // does not count - squeezing diagonally past a closed door is not a thing.
        if ((grid.get(currentX + stepX, currentY) & SOLID_MASK) !== 0) continue;
        if ((grid.get(currentX, currentY + stepY) & SOLID_MASK) !== 0) continue;
      }

      const penalty = tileStepPenalty(grid, nextX, nextY, doorCost);
      if (penalty < 0) continue;

      const tentative = currentG + (direction < 4 ? 1 : SQRT2) + penalty;
      const key = tileKey(nextX, nextY);
      const existing = ws.tileToNode.get(key);
      if (existing === undefined) {
        const node = addNode(nextX, nextY, tentative, current);
        ws.heap.push(node, ws.fScore[node] as number);
      } else if (tentative < (ws.gScore[existing] as number)) {
        const heuristic = (ws.fScore[existing] as number) - (ws.gScore[existing] as number);
        ws.gScore[existing] = tentative;
        ws.fScore[existing] = tentative + heuristic;
        ws.parent[existing] = current;
        ws.closed[existing] = 0;
        ws.heap.push(existing, tentative + heuristic);
      }
    }
  }

  return [];
}

/**
 * True when a circle of `radius` can slide along the straight segment without hitting
 * anything solid.
 *
 * Sample spacing is tied to the radius so the samples overlap: any point the segment
 * passes through is within `radius / 2` of some sample, so every tile the centre line
 * crosses is detected. A fixed 8 px step would let a small entity clip the corner of a
 * wall between two samples.
 */
export function isWalkableLine(
  grid: CollisionGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const distance = Math.hypot(dx, dy);
  const spacing = Math.min(TILE_SIZE / 2, Math.max(1, radius));
  const steps = Math.max(1, Math.ceil(distance / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (grid.circleBlocked(x0 + dx * t, y0 + dy * t, radius)) return false;
  }
  return true;
}

/**
 * String-pulling: drop waypoints a straight walk can skip.
 *
 * A* on a grid produces staircases, and an agent that follows one visibly zig-zags. From
 * each anchor this takes the *farthest* later waypoint still reachable in a straight line
 * for a circle of `radius`, which collapses a staircase across open ground to its two
 * endpoints while leaving a route that hugs a wall untouched.
 *
 * Input and output are both flattened tile pairs; waypoints are treated as tile centres,
 * and the first and last are always kept.
 */
export function smoothPath(grid: CollisionGrid, path: readonly number[], radius: number): number[] {
  const count = path.length >> 1;
  if (count <= 2) return path.slice(0, count * 2);

  const centerX = (index: number) => tileCenter(path[index * 2] as number);
  const centerY = (index: number) => tileCenter(path[index * 2 + 1] as number);

  const out: number[] = [path[0] as number, path[1] as number];
  let anchor = 0;
  while (anchor < count - 1) {
    // Probe from the far end so the first success is the longest shortcut.
    let next = anchor + 1;
    for (let probe = count - 1; probe > anchor + 1; probe--) {
      if (
        isWalkableLine(
          grid,
          centerX(anchor),
          centerY(anchor),
          centerX(probe),
          centerY(probe),
          radius,
        )
      ) {
        next = probe;
        break;
      }
    }
    out.push(path[next * 2] as number, path[next * 2 + 1] as number);
    anchor = next;
  }
  return out;
}
