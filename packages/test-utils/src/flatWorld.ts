import {
  CHUNK_TILES,
  Tile,
  chunkKey,
  circleOverlapsAabb,
  pixelToTile,
  tileProps,
  type ChunkTerrain,
  type TileOverride,
} from '@survive/protocol';
import {
  CollisionFlag,
  DEFAULT_FLOW_FIELD_MAX_AGE_TICKS,
  MAX_SWEEP_SUBSTEPS,
  OPAQUE_MASK,
  SOLID_MASK,
  type CollisionFlags,
  type FlowField,
  type MoveResult,
  type PathOptions,
  type RaycastHit,
  type TerrainGenerator,
  type WorldService,
} from '@survive/world';

/**
 * A flat, fully deterministic world for tests.
 *
 * Generated terrain is the right thing to test the *world* against, but it is the wrong
 * thing to test a *mechanic* against: a combat test should not fail because the seed
 * dropped a boulder where the test wanted to stand. This is a complete, correct
 * `WorldService` over a blank grass plain that a test can carve walls into.
 *
 * It is a real implementation, not a stub: collision slides, rays use DDA, paths use A*,
 * and the flow field integrates costs. A system that works here works against generated
 * terrain too.
 */

export interface FlatWorldOptions {
  /** Tile the whole plain is made of. */
  tile?: number;
  seed?: number;
}

export interface FlatWorld extends WorldService {
  /** Paint a rectangle of tiles, inclusive of both corners. */
  fill(fromTileX: number, fromTileY: number, toTileX: number, toTileY: number, tile: number): void;
  /** Draw a one-tile-thick wall of the given tile. */
  wall(fromTileX: number, fromTileY: number, toTileX: number, toTileY: number, tile?: number): void;
  /** Every tile explicitly set so far, for assertions. */
  paintedTiles(): Array<{ tileX: number; tileY: number; tile: number }>;
}

export function createFlatWorld(options: FlatWorldOptions = {}): FlatWorld {
  const baseTile = options.tile ?? Tile.Grass;
  const seed = options.seed ?? 1;

  const tiles = new Map<string, number>();
  const collision = new Map<string, CollisionFlags>();
  const loaded = new Set<string>();
  const overrides = new Map<string, TileOverride[]>();
  const flowFields = new Map<string, FlowField>();
  let flowFieldBuilds = 0;

  const key = (tileX: number, tileY: number) => `${tileX},${tileY}`;

  const generator: TerrainGenerator = {
    seed,
    version: 1,
    generate: (cx, cy) => makeTerrain(cx, cy, baseTile),
    biomeAt: () => 0,
    isUrban: () => false,
  };

  function getTile(tileX: number, tileY: number): number {
    return tiles.get(key(tileX, tileY)) ?? baseTile;
  }

  /** Terrain-derived collision bits for a tile, ignoring anything a structure added. */
  function terrainFlags(tileX: number, tileY: number): CollisionFlags {
    const props = tileProps(getTile(tileX, tileY));
    let flags: CollisionFlags = CollisionFlag.None;
    if (props.solid) flags |= CollisionFlag.TerrainSolid;
    if (props.opaque) flags |= CollisionFlag.TerrainOpaque;
    if (props.deep) flags |= CollisionFlag.Deep;
    return flags;
  }

  function getCollision(tileX: number, tileY: number): CollisionFlags {
    const extra = collision.get(key(tileX, tileY)) ?? CollisionFlag.None;
    return terrainFlags(tileX, tileY) | extra;
  }

  function isSolidTile(tileX: number, tileY: number): boolean {
    return (getCollision(tileX, tileY) & SOLID_MASK) !== 0;
  }

  function isOpaqueTile(tileX: number, tileY: number): boolean {
    return (getCollision(tileX, tileY) & OPAQUE_MASK) !== 0;
  }

  function circleBlocked(x: number, y: number, radius: number): boolean {
    const minX = pixelToTile(x - radius);
    const maxX = pixelToTile(x + radius);
    const minY = pixelToTile(y - radius);
    const maxY = pixelToTile(y + radius);
    for (let tileY = minY; tileY <= maxY; tileY++) {
      for (let tileX = minX; tileX <= maxX; tileX++) {
        if (!isSolidTile(tileX, tileY)) continue;
        if (circleOverlapsAabb(x, y, radius, { x: tileX * 32, y: tileY * 32, w: 32, h: 32 })) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Axis-separated slide, sub-stepped so nothing tunnels.
   *
   * A single big step can jump clean over a one-tile wall, which shows up as
   * "sometimes the zombie walks through the door frame" - so cap each sub-step at half
   * a tile.
   *
   * The two guards below are not belt-and-braces, they are the contract: this double
   * stands in for `collision.ts`, and a double that survives less than the real thing
   * turns a test of the real guard into a hung process. A non-finite delta returns the
   * body where it stood (there is no meaningful destination), and the sub-step count is
   * capped so a huge-but-finite delta goes coarse instead of spinning.
   */
  function moveCircle(x: number, y: number, dx: number, dy: number, radius: number): MoveResult {
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return { x, y, blockedX: false, blockedY: false };
    }
    // Already inside geometry - spawned in a wall, a wall built on top, a teleport. Every
    // candidate position would be rejected and the body would be stuck for good, so let it
    // move freely until it is out. The real grid does exactly this; without it the double
    // freezes an entity the shipping code frees, which is a difference a test would read as
    // a bug in the entity rather than in the harness.
    const stuck = circleBlocked(x, y, radius);
    const steps = stuck
      ? 1
      : Math.min(
          MAX_SWEEP_SUBSTEPS,
          Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 16)),
        );
    let currentX = x;
    let currentY = y;
    let blockedX = false;
    let blockedY = false;
    const stepX = dx / steps;
    const stepY = dy / steps;

    for (let i = 0; i < steps; i++) {
      if (stepX !== 0) {
        if (!stuck && circleBlocked(currentX + stepX, currentY, radius)) blockedX = true;
        else currentX += stepX;
      }
      if (stepY !== 0) {
        if (!stuck && circleBlocked(currentX, currentY + stepY, radius)) blockedY = true;
        else currentY += stepY;
      }
    }
    return { x: currentX, y: currentY, blockedX, blockedY };
  }

  /**
   * Amanatides-Woo tile traversal. Stops on whichever mask the caller asked for.
   *
   * Both guards below exist in `raycast.ts` and have to exist here too. A non-finite
   * endpoint makes `dirX` NaN, which makes `travelled` NaN, which makes the `> length`
   * break permanently false - an infinite loop that Vitest's timeout cannot interrupt,
   * because the event loop never gets a turn. And the step bound is what stops float noise
   * doing the same thing on finite input; the real implementation says so in as many words.
   */
  function traverse(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    mask: CollisionFlags,
  ): RaycastHit | null {
    if (
      !Number.isFinite(x0) ||
      !Number.isFinite(y0) ||
      !Number.isFinite(x1) ||
      !Number.isFinite(y1)
    ) {
      return null;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      const tileX = pixelToTile(x0);
      const tileY = pixelToTile(y0);
      const flags = getCollision(tileX, tileY);
      if ((flags & mask) !== 0) return { x: x0, y: y0, tileX, tileY, distance: 0, flags };
      return null;
    }

    const dirX = dx / length;
    const dirY = dy / length;
    let tileX = pixelToTile(x0);
    let tileY = pixelToTile(y0);

    const stepX = dirX > 0 ? 1 : dirX < 0 ? -1 : 0;
    const stepY = dirY > 0 ? 1 : dirY < 0 ? -1 : 0;
    // Guard the axis-aligned case, where one of these would divide by zero.
    const deltaX = dirX === 0 ? Number.POSITIVE_INFINITY : Math.abs(32 / dirX);
    const deltaY = dirY === 0 ? Number.POSITIVE_INFINITY : Math.abs(32 / dirY);

    const nextBoundaryX = stepX > 0 ? (tileX + 1) * 32 : tileX * 32;
    const nextBoundaryY = stepY > 0 ? (tileY + 1) * 32 : tileY * 32;
    let maxX = dirX === 0 ? Number.POSITIVE_INFINITY : (nextBoundaryX - x0) / dirX;
    let maxY = dirY === 0 ? Number.POSITIVE_INFINITY : (nextBoundaryY - y0) / dirY;

    const startFlags = getCollision(tileX, tileY);
    if ((startFlags & mask) !== 0) {
      return { x: x0, y: y0, tileX, tileY, distance: 0, flags: startFlags };
    }

    // The walk cannot need more steps than the tile span plus a slack step.
    const maxSteps = Math.abs(pixelToTile(x1) - tileX) + Math.abs(pixelToTile(y1) - tileY) + 2;
    let travelled = 0;
    for (let step = 0; step < maxSteps && travelled <= length; step++) {
      if (maxX < maxY) {
        travelled = maxX;
        tileX += stepX;
        maxX += deltaX;
      } else {
        travelled = maxY;
        tileY += stepY;
        maxY += deltaY;
      }
      if (travelled > length) break;
      const flags = getCollision(tileX, tileY);
      if ((flags & mask) !== 0) {
        return {
          x: x0 + dirX * travelled,
          y: y0 + dirY * travelled,
          tileX,
          tileY,
          distance: travelled,
          flags,
        };
      }
    }
    return null;
  }

  /** A* with an octile heuristic and deterministic tie-breaking. */
  function findPath(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    pathOptions: PathOptions = {},
  ): number[] {
    const maxNodes = pathOptions.maxNodes ?? 4000;
    const allowDiagonal = pathOptions.allowDiagonal ?? true;
    const doorCost = pathOptions.doorCost ?? 0;
    const tolerance = pathOptions.goalTolerance ?? 0;

    const startX = pixelToTile(fromX);
    const startY = pixelToTile(fromY);
    const goalX = pixelToTile(toX);
    const goalY = pixelToTile(toY);

    const passable = (tileX: number, tileY: number): number | null => {
      const flags = getCollision(tileX, tileY);
      if ((flags & SOLID_MASK) === 0) return 1;
      // A closed door is passable at a price when the caller allows it, which is what
      // makes zombies converge on doors instead of milling about outside.
      if (doorCost > 0 && (flags & CollisionFlag.Door) !== 0) return 1 + doorCost;
      return null;
    };

    const heuristic = (tileX: number, tileY: number): number => {
      const ax = Math.abs(tileX - goalX);
      const ay = Math.abs(tileY - goalY);
      return allowDiagonal ? Math.max(ax, ay) + (Math.SQRT2 - 1) * Math.min(ax, ay) : ax + ay;
    };

    interface Node {
      tileX: number;
      tileY: number;
      g: number;
      f: number;
      parent: Node | null;
      order: number;
    }

    const open: Node[] = [];
    const best = new Map<string, number>();
    let order = 0;
    const start: Node = {
      tileX: startX,
      tileY: startY,
      g: 0,
      f: heuristic(startX, startY),
      parent: null,
      order: order++,
    };
    open.push(start);
    best.set(key(startX, startY), 0);

    const neighbours = allowDiagonal
      ? [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ];

    let expanded = 0;
    while (open.length > 0 && expanded < maxNodes) {
      // Linear scan: fine for a test-only world, and it keeps tie-breaking obvious.
      let bestIndex = 0;
      for (let i = 1; i < open.length; i++) {
        const candidate = open[i] as Node;
        const incumbent = open[bestIndex] as Node;
        if (
          candidate.f < incumbent.f ||
          (candidate.f === incumbent.f && candidate.order < incumbent.order)
        ) {
          bestIndex = i;
        }
      }
      const current = open.splice(bestIndex, 1)[0] as Node;
      expanded++;

      const distanceToGoal = Math.max(
        Math.abs(current.tileX - goalX),
        Math.abs(current.tileY - goalY),
      );
      if (distanceToGoal <= tolerance) {
        const path: number[] = [];
        let node: Node | null = current;
        while (node) {
          path.unshift(node.tileX, node.tileY);
          node = node.parent;
        }
        return path;
      }

      for (const [ox, oy] of neighbours) {
        const nextX = current.tileX + (ox as number);
        const nextY = current.tileY + (oy as number);
        const cost = passable(nextX, nextY);
        if (cost === null) continue;
        if (ox !== 0 && oy !== 0) {
          // No corner cutting: both orthogonal neighbours must be free.
          if (passable(current.tileX + (ox as number), current.tileY) === null) continue;
          if (passable(current.tileX, current.tileY + (oy as number)) === null) continue;
        }
        const stepCost = (ox !== 0 && oy !== 0 ? Math.SQRT2 : 1) * cost;
        const g = current.g + stepCost;
        const nodeKey = key(nextX, nextY);
        const known = best.get(nodeKey);
        if (known !== undefined && known <= g) continue;
        best.set(nodeKey, g);
        open.push({
          tileX: nextX,
          tileY: nextY,
          g,
          f: g + heuristic(nextX, nextY),
          parent: current,
          order: order++,
        });
      }
    }
    return [];
  }

  function buildFlowField(goalX: number, goalY: number, tick: number, extent = 24): FlowField {
    const goalTileX = pixelToTile(goalX);
    const goalTileY = pixelToTile(goalY);
    const minTileX = goalTileX - extent;
    const minTileY = goalTileY - extent;
    const width = extent * 2 + 1;
    const height = extent * 2 + 1;
    const cost = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
    const dir = new Uint8Array(width * height).fill(255);

    const index = (tileX: number, tileY: number) => (tileY - minTileY) * width + (tileX - minTileX);
    const inside = (tileX: number, tileY: number) =>
      tileX >= minTileX &&
      tileY >= minTileY &&
      tileX < minTileX + width &&
      tileY < minTileY + height;

    const offsets: Array<[number, number]> = [
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
    ];

    cost[index(goalTileX, goalTileY)] = 0;
    const queue: Array<[number, number]> = [[goalTileX, goalTileY]];
    let head = 0;
    while (head < queue.length) {
      const entry = queue[head++] as [number, number];
      const [tileX, tileY] = entry;
      const currentCost = cost[index(tileX, tileY)] as number;
      for (let d = 0; d < offsets.length; d++) {
        const [ox, oy] = offsets[d] as [number, number];
        const nextX = tileX + ox;
        const nextY = tileY + oy;
        if (!inside(nextX, nextY)) continue;
        if (isSolidTile(nextX, nextY)) continue;
        const step = ox !== 0 && oy !== 0 ? Math.SQRT2 : 1;
        const candidate = currentCost + step;
        const at = index(nextX, nextY);
        if (candidate >= (cost[at] as number)) continue;
        cost[at] = candidate;
        // Point back towards the tile we came from: that is the descent direction.
        dir[at] = (d + 4) % 8;
        queue.push([nextX, nextY]);
      }
    }

    return { goalTileX, goalTileY, minTileX, minTileY, width, height, cost, dir, builtTick: tick };
  }

  const world: FlatWorld = {
    seed,
    generator,

    ensureChunk(cx, cy) {
      loaded.add(chunkKey(cx, cy));
      return makeTerrain(cx, cy, baseTile);
    },
    isChunkLoaded: (chunk) => loaded.has(chunk),
    loadedChunkKeys: () => [...loaded],
    unloadChunk: (chunk) => {
      loaded.delete(chunk);
    },

    getTile,
    getTileAt: (x, y) => getTile(pixelToTile(x), pixelToTile(y)),
    getBiome: () => 0,
    setTile: (tileX, tileY, tile) => {
      tiles.set(key(tileX, tileY), tile);
      const chunk = chunkKey(Math.floor(tileX / CHUNK_TILES), Math.floor(tileY / CHUNK_TILES));
      const list = overrides.get(chunk) ?? [];
      const localIndex =
        (((tileY % CHUNK_TILES) + CHUNK_TILES) % CHUNK_TILES) * CHUNK_TILES +
        (((tileX % CHUNK_TILES) + CHUNK_TILES) % CHUNK_TILES);
      const existing = list.find((entry) => entry.index === localIndex);
      if (existing) existing.tile = tile;
      else list.push({ index: localIndex, tile });
      overrides.set(chunk, list);
    },
    getOverrides: (cx, cy) => [...(overrides.get(chunkKey(cx, cy)) ?? [])],
    applyOverrides: (cx, cy, list) => {
      for (const entry of list) {
        const localX = entry.index % CHUNK_TILES;
        const localY = Math.floor(entry.index / CHUNK_TILES);
        tiles.set(key(cx * CHUNK_TILES + localX, cy * CHUNK_TILES + localY), entry.tile);
      }
      overrides.set(chunkKey(cx, cy), [...list]);
    },

    addCollision: (tileX, tileY, flags) => {
      const at = key(tileX, tileY);
      collision.set(at, (collision.get(at) ?? CollisionFlag.None) | flags);
    },
    removeCollision: (tileX, tileY, flags) => {
      const at = key(tileX, tileY);
      collision.set(at, (collision.get(at) ?? CollisionFlag.None) & ~flags);
    },
    getCollision,
    isSolidTile,
    isSolidAt: (x, y) => isSolidTile(pixelToTile(x), pixelToTile(y)),
    isOpaqueTile,
    speedAt: (x, y) => tileProps(getTile(pixelToTile(x), pixelToTile(y))).speed,
    circleBlocked,
    moveCircle,
    raycast: (x0, y0, x1, y1) => traverse(x0, y0, x1, y1, SOLID_MASK),
    hasLineOfSight: (x0, y0, x1, y1) => traverse(x0, y0, x1, y1, OPAQUE_MASK) === null,

    findPath,
    getFlowField: (goalX, goalY, tick) => {
      const fieldKey = key(pixelToTile(goalX), pixelToTile(goalY));
      const existing = flowFields.get(fieldKey);
      // Expired by age, as the real cache does. A field that never expires makes the
      // harness follow a route computed before the test carved a wall into the world, so
      // steering appears to walk through geometry that is genuinely solid - and the bug
      // looks like it is in the AI.
      if (existing) {
        const age = tick - existing.builtTick;
        if (age >= 0 && age < DEFAULT_FLOW_FIELD_MAX_AGE_TICKS) return existing;
      }
      const field = buildFlowField(goalX, goalY, tick);
      flowFieldBuilds++;
      flowFields.set(fieldKey, field);
      return field;
    },
    sampleFlow: (field, x, y) => {
      const tileX = pixelToTile(x);
      const tileY = pixelToTile(y);
      if (
        tileX < field.minTileX ||
        tileY < field.minTileY ||
        tileX >= field.minTileX + field.width ||
        tileY >= field.minTileY + field.height
      ) {
        return null;
      }
      const at = (tileY - field.minTileY) * field.width + (tileX - field.minTileX);
      const packed = field.dir[at];
      if (packed === undefined || packed === 255) return null;
      const offsets: Array<[number, number]> = [
        [1, 0],
        [0.7071, 0.7071],
        [0, 1],
        [-0.7071, 0.7071],
        [-1, 0],
        [-0.7071, -0.7071],
        [0, -1],
        [0.7071, -0.7071],
      ];
      const offset = offsets[packed];
      return offset ? { x: offset[0], y: offset[1] } : null;
    },
    get flowFieldBuilds() {
      return flowFieldBuilds;
    },

    pruneFlowFields: (tick, maxAgeTicks) => {
      for (const [fieldKey, field] of flowFields) {
        if (tick - field.builtTick > maxAgeTicks) flowFields.delete(fieldKey);
      }
    },

    findSpawnPosition: (x, y, radius, entityRadius, roll, attempts = 32) => {
      for (let i = 0; i < attempts; i++) {
        const angle = roll() * Math.PI * 2;
        const distance = roll() * radius;
        const candidateX = x + Math.cos(angle) * distance;
        const candidateY = y + Math.sin(angle) * distance;
        if (!circleBlocked(candidateX, candidateY, entityRadius)) {
          return { x: candidateX, y: candidateY };
        }
      }
      return circleBlocked(x, y, entityRadius) ? null : { x, y };
    },

    fill: (fromTileX, fromTileY, toTileX, toTileY, tile) => {
      const minX = Math.min(fromTileX, toTileX);
      const maxX = Math.max(fromTileX, toTileX);
      const minY = Math.min(fromTileY, toTileY);
      const maxY = Math.max(fromTileY, toTileY);
      for (let tileY = minY; tileY <= maxY; tileY++) {
        for (let tileX = minX; tileX <= maxX; tileX++) world.setTile(tileX, tileY, tile);
      }
    },
    wall: (fromTileX, fromTileY, toTileX, toTileY, tile = Tile.WallConcrete) => {
      world.fill(fromTileX, fromTileY, toTileX, toTileY, tile);
    },
    paintedTiles: () =>
      [...tiles.entries()].map(([at, tile]) => {
        const comma = at.indexOf(',');
        return {
          tileX: Number.parseInt(at.slice(0, comma), 10),
          tileY: Number.parseInt(at.slice(comma + 1), 10),
          tile,
        };
      }),
  };

  return world;
}

function makeTerrain(cx: number, cy: number, tile: number): ChunkTerrain {
  const count = CHUNK_TILES * CHUNK_TILES;
  return {
    cx,
    cy,
    tiles: new Array<number>(count).fill(tile),
    biomes: new Array<number>(count).fill(0),
    version: 1,
  };
}
