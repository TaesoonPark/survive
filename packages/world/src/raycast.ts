/**
 * Tile traversal for shooting and for sight.
 *
 * Both use one Amanatides-Woo grid walk. Fixed-step sampling along the ray - "step 8 px,
 * test the tile" - is what most prototypes do and it is wrong in two ways that players
 * notice immediately: a shot can pass through a one-tile wall when the step straddles it,
 * and a shot can slip diagonally between two walls that meet at a corner. The DDA visits
 * *every* tile the segment enters, in order, with two adds per tile, so neither is
 * possible.
 *
 * The two entry points differ only in the mask they stop on, which is the whole point of
 * splitting {@link SOLID_MASK} from {@link OPAQUE_MASK}: a chain-link fence or a window is
 * solid but transparent (you can see and shoot over it but not walk through it), while
 * smoke or a curtain is opaque but passable.
 */

import { TILE_SIZE, pixelToTile } from '@survive/protocol';
import type { CollisionGrid } from './collision';
import { OPAQUE_MASK, SOLID_MASK } from './types';
import type { CollisionFlags, RaycastHit } from './types';

/**
 * Walk the ray from (x0, y0) to (x1, y1) and return the first tile whose bits intersect
 * `mask`, or null when the ray reaches its end unobstructed.
 *
 * Degenerate inputs are all handled here rather than by callers:
 * - a zero-length ray tests only the tile it sits in;
 * - an axis-aligned ray never divides by zero - the perpendicular axis gets an infinite
 *   crossing distance, so it simply never wins the comparison;
 * - a start point already inside a blocking tile reports a hit at the origin with
 *   distance 0, which is what a bullet spawned inside a wall should do;
 * - a non-finite coordinate reports no hit at all.
 */
export function raycastMasked(
  grid: CollisionGrid,
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

  let tileX = pixelToTile(x0);
  let tileY = pixelToTile(y0);

  const startFlags = grid.get(tileX, tileY);
  if ((startFlags & mask) !== 0) {
    return { x: x0, y: y0, tileX, tileY, distance: 0, flags: startFlags };
  }

  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const dirX = dx / length;
  const dirY = dy / length;

  const stepX = dirX > 0 ? 1 : dirX < 0 ? -1 : 0;
  const stepY = dirY > 0 ? 1 : dirY < 0 ? -1 : 0;

  // Distance along the ray between successive tile boundaries on each axis, and to the
  // first one. Both are Infinity on an axis the ray does not move along, which is the
  // clean way out of the classic axis-aligned division by zero: an Infinity crossing
  // distance never compares smaller, so that axis simply never steps.
  const deltaX = stepX === 0 ? Infinity : TILE_SIZE / Math.abs(dirX);
  const deltaY = stepY === 0 ? Infinity : TILE_SIZE / Math.abs(dirY);
  let nextX = stepX === 0 ? Infinity : ((stepX > 0 ? tileX + 1 : tileX) * TILE_SIZE - x0) / dirX;
  let nextY = stepY === 0 ? Infinity : ((stepY > 0 ? tileY + 1 : tileY) * TILE_SIZE - y0) / dirY;

  // The walk cannot need more steps than the tile span plus a slack step; bounding it
  // means float noise can never turn this into an infinite loop.
  const maxSteps = Math.abs(pixelToTile(x1) - tileX) + Math.abs(pixelToTile(y1) - tileY) + 2;

  for (let step = 0; step < maxSteps; step++) {
    let travelled: number;
    // Ties (a ray crossing a lattice corner exactly) resolve to the Y step, always. The
    // choice is arbitrary but it must be *fixed*: the alternative is a corner-dependent
    // coin flip, and a ray that sometimes slips between two touching walls.
    if (nextX < nextY) {
      travelled = nextX;
      tileX += stepX;
      nextX += deltaX;
    } else {
      travelled = nextY;
      tileY += stepY;
      nextY += deltaY;
    }
    if (travelled > length) return null;

    const flags = grid.get(tileX, tileY);
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

/**
 * First movement-blocking tile along a ray, or null when the ray reaches its end.
 *
 * This is the projectile and melee-sweep test: it stops on anything solid, transparent or
 * not, because a bullet does not care that it can see through a window frame.
 */
export function raycast(
  grid: CollisionGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): RaycastHit | null {
  return raycastMasked(grid, x0, y0, x1, y1, SOLID_MASK);
}

/**
 * Sight test: true when nothing opaque stands between the two points.
 *
 * Ignores solid-but-transparent geometry (fences, windows, low walls) so vision cones and
 * zombie awareness behave the way the level reads visually. A viewer standing inside an
 * opaque tile sees nothing, which only happens if something was built on top of it.
 */
export function hasLineOfSight(
  grid: CollisionGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return raycastMasked(grid, x0, y0, x1, y1, OPAQUE_MASK) === null;
}
