import type { ChunkKey, ChunkTerrain, TileOverride } from '@survive/protocol';

/**
 * Collision layer bits kept per tile.
 *
 * The grid is the single authority for "can something stand here". Static terrain
 * contributes {@link CollisionFlag.TerrainSolid}; placed structures contribute the
 * structure bits and remove them again when destroyed, so no consumer needs to walk
 * the structure list to answer a movement query.
 */
export const CollisionFlag = {
  None: 0,
  /** Static terrain blocks movement (wall tile, cliff). */
  TerrainSolid: 1 << 0,
  /** Static terrain blocks sight. */
  TerrainOpaque: 1 << 1,
  /** A structure blocks movement (wall, closed door, crate). */
  StructureSolid: 1 << 2,
  /** A structure blocks sight. */
  StructureOpaque: 1 << 3,
  /** A door occupies this tile: passable while open, solid while closed. */
  Door: 1 << 4,
  /** Deep water: swimmable, not walkable. */
  Deep: 1 << 5,
  /** A farm plot occupies this tile. */
  Plot: 1 << 6,
  /** A resource node occupies this tile (trees block, bushes do not). */
  NodeSolid: 1 << 7,
  /**
   * A resource node blocks sight (a dense tree, not a berry bush).
   *
   * Its own bit rather than a borrowed `StructureOpaque`. A node used to raise the
   * structure bit, so felling a tree standing on the same tile as a wall cleared the
   * *wall's* sight-blocking too - the wall stayed solid but you could see straight
   * through it. A bit has to be owned by whatever contributes it, or removing one
   * contributor takes the other's with it.
   */
  NodeOpaque: 1 << 8,
} as const;

export type CollisionFlags = number;

export const SOLID_MASK =
  CollisionFlag.TerrainSolid | CollisionFlag.StructureSolid | CollisionFlag.NodeSolid;

export const OPAQUE_MASK =
  CollisionFlag.TerrainOpaque | CollisionFlag.StructureOpaque | CollisionFlag.NodeOpaque;

/** Result of a swept circle move. */
export interface MoveResult {
  /** Resolved position. */
  x: number;
  y: number;
  /** True when the X component of the requested motion was blocked. */
  blockedX: boolean;
  /** True when the Y component was blocked. */
  blockedY: boolean;
}

/** Where a ray stopped. */
export interface RaycastHit {
  /** Impact point in world pixels. */
  x: number;
  y: number;
  /** Tile that blocked the ray. */
  tileX: number;
  tileY: number;
  /** Distance travelled before impact. */
  distance: number;
  /** Collision bits of the blocking tile. */
  flags: CollisionFlags;
}

export interface PathOptions {
  /** Give up after expanding this many nodes. Keeps a bad request cheap. */
  maxNodes?: number;
  /** Treat closed doors as passable at this extra cost (zombies break them down). */
  doorCost?: number;
  /** Stop when within this many tiles of the goal. */
  goalTolerance?: number;
  /** Allow diagonal steps. Diagonals still require both orthogonal tiles to be free. */
  allowDiagonal?: boolean;
}

/**
 * A cached direction field pointing towards one goal.
 *
 * Hordes share one field instead of each zombie running its own A* (spec section 23).
 */
export interface FlowField {
  /** Goal tile. */
  goalTileX: number;
  goalTileY: number;
  /** Inclusive tile bounds covered by the field. */
  minTileX: number;
  minTileY: number;
  width: number;
  height: number;
  /** Integrated cost per tile; Infinity where unreachable. */
  cost: Float32Array;
  /** Packed direction index per tile (0..7, or 255 for "no direction"). */
  dir: Uint8Array;
  /** Tick the field was built, so stale fields can be rebuilt. */
  builtTick: number;
}

/** Terrain generator: a pure function of seed and chunk coordinate. */
export interface TerrainGenerator {
  readonly seed: number;
  readonly version: number;
  generate(cx: number, cy: number): ChunkTerrain;
  /** Biome id at a tile, cheap enough to call without generating a whole chunk. */
  biomeAt(tileX: number, tileY: number): number;
  /** Whether this chunk is inside a town, used by the spawn and loot systems. */
  isUrban(cx: number, cy: number): boolean;
}

/**
 * The world as the simulation sees it.
 *
 * Every method is synchronous and deterministic: terrain is regenerated from the seed
 * on demand, never awaited. Persistence of the *dynamic* layer is the server's job
 * (spec sections 29-31).
 */
export interface WorldService {
  readonly seed: number;
  readonly generator: TerrainGenerator;

  // --- chunk lifecycle ---------------------------------------------------
  /** Generate (or fetch from cache) the terrain for a chunk. */
  ensureChunk(cx: number, cy: number): ChunkTerrain;
  isChunkLoaded(key: ChunkKey): boolean;
  loadedChunkKeys(): ChunkKey[];
  /** Drop terrain and collision for a chunk. Overrides are handed back for saving. */
  unloadChunk(key: ChunkKey): void;

  // --- tiles -------------------------------------------------------------
  /** Tile id at a tile coordinate. Out-of-bounds returns `Tile.Void`. */
  getTile(tileX: number, tileY: number): number;
  /** Tile id at a world pixel position. */
  getTileAt(x: number, y: number): number;
  /** Biome id at a tile coordinate. */
  getBiome(tileX: number, tileY: number): number;
  /** Change a tile away from its generated value. Recorded as a dynamic override. */
  setTile(tileX: number, tileY: number, tile: number): void;
  /** Overrides recorded for a chunk, for persistence. */
  getOverrides(cx: number, cy: number): TileOverride[];
  /** Reapply overrides loaded from disk. */
  applyOverrides(cx: number, cy: number, overrides: readonly TileOverride[]): void;

  // --- collision ---------------------------------------------------------
  /** Add structure/node collision bits to a tile. */
  addCollision(tileX: number, tileY: number, flags: CollisionFlags): void;
  /** Remove specific collision bits from a tile. */
  removeCollision(tileX: number, tileY: number, flags: CollisionFlags): void;
  /** Raw collision bits for a tile. */
  getCollision(tileX: number, tileY: number): CollisionFlags;
  isSolidTile(tileX: number, tileY: number): boolean;
  isSolidAt(x: number, y: number): boolean;
  isOpaqueTile(tileX: number, tileY: number): boolean;
  /** Movement speed multiplier from the tile under a position. */
  speedAt(x: number, y: number): number;
  /** True when a circle at (x, y) would overlap anything solid. */
  circleBlocked(x: number, y: number, radius: number): boolean;
  /**
   * Move a circle by (dx, dy), sliding along walls. Axis-separated so a player
   * pressing into a corner still slides instead of sticking.
   */
  moveCircle(x: number, y: number, dx: number, dy: number, radius: number): MoveResult;
  /** First blocking tile along a ray, or null when the ray reaches its end. */
  raycast(x0: number, y0: number, x1: number, y1: number): RaycastHit | null;
  /** Sight test that ignores non-opaque solids such as fences and windows. */
  hasLineOfSight(x0: number, y0: number, x1: number, y1: number): boolean;

  // --- navigation --------------------------------------------------------
  /**
   * A* over the tile grid. Returns a flattened `[tx0, ty0, tx1, ty1, ...]` path, or
   * an empty array when no path exists inside the node budget.
   */
  findPath(fromX: number, fromY: number, toX: number, toY: number, options?: PathOptions): number[];
  /** Build or reuse a cached flow field towards a goal. */
  getFlowField(goalX: number, goalY: number, tick: number): FlowField | null;
  /** Unit direction from a flow field at a world position, or null if unreachable. */
  sampleFlow(field: FlowField, x: number, y: number): { x: number; y: number } | null;
  /** Drop cached flow fields older than `maxAgeTicks`. */
  pruneFlowFields(tick: number, maxAgeTicks: number): void;
  /**
   * Flow-field integrations performed so far, monotonically increasing.
   *
   * Read before and after {@link WorldService.getFlowField} to tell a cache hit from a
   * build. Steering uses this to charge its per-tick field budget to whichever agent
   * actually paid for the integration.
   */
  readonly flowFieldBuilds: number;

  // --- queries used by spawning ------------------------------------------
  /**
   * Find a walkable position near (x, y) within `radius` px, using `roll` for
   * deterministic candidate order. Returns null when nothing suitable is found.
   */
  findSpawnPosition(
    x: number,
    y: number,
    radius: number,
    entityRadius: number,
    roll: () => number,
    attempts?: number,
  ): { x: number; y: number } | null;
}
