import {
  TILE_SIZE,
  circleOverlapsAabb,
  distance,
  isTileInWorld,
  tileCenter,
  tileProps,
  type ItemStack,
  type PlayerState,
  type StructureDefId,
  type StructureState,
} from '@survive/protocol';
import type { ItemAmount, StructureCategory, StructureDef, ToolKind } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import {
  countItem,
  createStack,
  findTool,
  recomputeCarryWeight,
  removeFromInventory,
} from '../../core/items';
import { skillLevel } from '../../core/skills';
import { bump, structureAtTile, structureTiles } from '../../core/queries';
import { tileKey } from '../../core/state';

/**
 * Placement validation, on its own so the answer can never differ between the two
 * callers that need it.
 *
 * The client draws a placement ghost every frame and has to colour it correctly; the
 * server has to reject a lie. If those were two implementations they would drift, and
 * the symptom would be the worst kind: a green ghost that refuses to build. So
 * {@link canPlace} is the *only* implementation, it mutates nothing, and `build` is
 * defined as "canPlace, then charge and spawn".
 */

/** How far from the player a new piece may be placed, in pixels. */
export const BUILD_RANGE = TILE_SIZE * 5;

/** How close a builder must stand for a blueprint to keep making progress. */
export const BLUEPRINT_BUILD_RANGE = TILE_SIZE * 4;

/** How far a player may reach to demolish, repair or open a placed structure. */
export const STRUCTURE_REACH = TILE_SIZE * 3;

/**
 * Categories that hold a `requiresSupport` piece up.
 *
 * Doors, windows and barricades all need something to hang off. A blueprint frame
 * counts: the timber is physically standing there, and refusing to hang a door until
 * the neighbouring wall is *finished* only teaches players to build in a strange order.
 */
const SUPPORT_CATEGORIES: readonly StructureCategory[] = [
  'wall',
  'foundation',
  'floor',
  'door',
  'window',
];

/** Categories that count as "there is a floor here" for `placeOn: 'floor'`. */
const FLOOR_CATEGORIES: readonly StructureCategory[] = ['floor', 'foundation'];

const ORTHOGONAL: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Why a placement was refused.
 *
 * A closed set of codes rather than prose: the client turns each one into its own
 * message and its own ghost colour, and a test can assert on the exact failure it set
 * up rather than on a sentence.
 */
export type PlacementRejection =
  | 'unknownStructure'
  | 'notBuildable'
  | 'dead'
  | 'badTile'
  | 'badRotation'
  | 'missingSkill'
  | 'missingTool'
  | 'outOfRange'
  | 'outOfWorld'
  | 'unbuildableSurface'
  | 'deepWater'
  | 'needsWater'
  | 'needsFloor'
  | 'occupied'
  | 'blockedByNode'
  | 'blockedByEntity'
  | 'noSupport'
  | 'missingMaterials';

export interface PlacementCheck {
  ok: boolean;
  reason?: PlacementRejection;
  /** The footprint tile that failed, when the failure is about one specific tile. */
  tileX?: number;
  tileY?: number;
  /** The cost entry the player is short of, when `reason` is `missingMaterials`. */
  missing?: ItemAmount;
}

const OK: PlacementCheck = { ok: true };

function fail(
  reason: PlacementRejection,
  extra: Omit<PlacementCheck, 'ok' | 'reason'> = {},
): PlacementCheck {
  return { ok: false, reason, ...extra };
}

/** Whether a definition is offered by the build menu at all. */
export function isBuildable(ctx: SimContext, defId: StructureDefId): boolean {
  return ctx.data.buildableStructures().some((candidate) => candidate.id === defId);
}

/** Footprint tiles a definition would occupy at the given origin and rotation. */
export function footprint(
  def: StructureDef,
  tileX: number,
  tileY: number,
  rotation: number,
): Array<{ tileX: number; tileY: number }> {
  return structureTiles(tileX, tileY, def.width, def.height, rotation);
}

/** Footprint tiles a *placed* structure occupies, rotation included. */
export function structureFootprint(
  structure: StructureState,
  def: StructureDef,
): Array<{ tileX: number; tileY: number }> {
  return structureTiles(
    structure.tileX,
    structure.tileY,
    def.width,
    def.height,
    structure.rotation,
  );
}

/** Whether a placed structure's footprint covers a tile. */
export function structureCovers(
  structure: StructureState,
  def: StructureDef,
  tileX: number,
  tileY: number,
): boolean {
  const swapped = structure.rotation % 2 === 1;
  const w = swapped ? def.height : def.width;
  const h = swapped ? def.width : def.height;
  return (
    tileX >= structure.tileX &&
    tileX < structure.tileX + w &&
    tileY >= structure.tileY &&
    tileY < structure.tileY + h
  );
}

/** Distance from a world position to the nearest tile centre of a footprint. */
export function footprintDistance(
  tiles: readonly { tileX: number; tileY: number }[],
  x: number,
  y: number,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const tile of tiles) {
    const d = distance(x, y, tileCenter(tile.tileX), tileCenter(tile.tileY));
    if (d < best) best = d;
  }
  return best;
}

/** Centre of an arbitrary footprint, in world pixels. */
export function footprintCenter(tiles: readonly { tileX: number; tileY: number }[]): {
  x: number;
  y: number;
} {
  if (tiles.length === 0) return { x: 0, y: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    if (tile.tileX < minX) minX = tile.tileX;
    if (tile.tileY < minY) minY = tile.tileY;
    if (tile.tileX > maxX) maxX = tile.tileX;
    if (tile.tileY > maxY) maxY = tile.tileY;
  }
  return { x: ((minX + maxX + 1) * TILE_SIZE) / 2, y: ((minY + maxY + 1) * TILE_SIZE) / 2 };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * Scale a cost list by a ratio, rounding down. Entries that round to zero drop out.
 *
 * Flooring is right for *rubble*: a structure smashed to pieces owes you nothing, and a
 * single-item cost yielding no debris is the intended outcome. It is wrong for a refund -
 * see {@link scaleRefund}.
 */
export function scaleCost(cost: readonly ItemAmount[], ratio: number): ItemAmount[] {
  const out: ItemAmount[] = [];
  for (const entry of cost) {
    const count = Math.floor(entry.count * ratio);
    if (count > 0) out.push({ defId: entry.defId, count });
  }
  return out;
}

/**
 * Scale a cost list for a voluntary demolish, never below one unit of each input.
 *
 * A structure definition advertises a `refundRatio` of 0.5 to 0.8, and flooring turned that
 * into nothing at all for every kit-built piece: a storage box costs one kit, and
 * `floor(1 * 0.5)` is zero. Taking your own chest down returned an empty hand while the
 * game promised most of it back.
 *
 * Rounding up matches `REPAIR_COST_FRACTION`, whose comment already documents the same
 * single-kit edge and resolves it the same way. A ratio of zero still refunds nothing -
 * that is a definition saying "this is not recoverable", not a rounding artefact.
 */
export function scaleRefund(cost: readonly ItemAmount[], ratio: number): ItemAmount[] {
  if (ratio <= 0) return [];
  const out: ItemAmount[] = [];
  for (const entry of cost) {
    if (entry.count <= 0) continue;
    out.push({ defId: entry.defId, count: Math.max(1, Math.floor(entry.count * ratio)) });
  }
  return out;
}

/** Turn a cost list into real stacks, skipping anything the item table does not know. */
export function costStacks(ctx: SimContext, cost: readonly ItemAmount[]): ItemStack[] {
  const out: ItemStack[] = [];
  for (const entry of cost) {
    if (entry.count <= 0) continue;
    if (!ctx.data.items.has(entry.defId)) continue;
    out.push(createStack(ctx.data, entry.defId, entry.count));
  }
  return out;
}

/** The first cost entry the player cannot pay, or null when they can pay all of them. */
export function missingMaterial(
  player: PlayerState,
  cost: readonly ItemAmount[],
): ItemAmount | null {
  for (const entry of cost) {
    if (countItem(player.inventory, entry.defId) < entry.count) return entry;
  }
  return null;
}

/**
 * Take a cost out of the player's inventory.
 *
 * Callers must have checked {@link missingMaterial} first: this deliberately does not
 * roll back a partial payment, because a caller that skipped validation has a bug, and
 * quietly refunding would hide it.
 */
export function chargeMaterials(
  ctx: SimContext,
  player: PlayerState,
  cost: readonly ItemAmount[],
): void {
  for (const entry of cost) removeFromInventory(player.inventory, entry.defId, entry.count);
  recomputeCarryWeight(player, ctx.data);
  bump(player);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * The stack filling a definition's tool requirement, or null when the player has none.
 *
 * `StructureDef.tool` documents itself as "equipped", but {@link findTool} looks in the
 * hands first and the pack second, and making a player swap a hammer into their hand to
 * hit a nail is friction with no gameplay behind it.
 */
export function findBuildTool(
  ctx: SimContext,
  player: PlayerState,
  kind: ToolKind,
): ItemStack | null {
  return findTool(player, kind, ctx.data)?.stack ?? null;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** Whether a floor or foundation covers a tile. */
function floorAt(ctx: SimContext, tileX: number, tileY: number): boolean {
  const existing = structureAtTile(ctx.state, tileX, tileY);
  if (!existing) return false;
  const def = ctx.data.structures.get(existing.defId);
  return def ? FLOOR_CATEGORIES.includes(def.category) : false;
}

/**
 * A generated building wall or cliff: solid *and* opaque terrain.
 *
 * Boarding up the window of a house you found has to work, and that house's walls are
 * terrain tiles rather than structures, so they have to count as support.
 */
function staticWallAt(ctx: SimContext, tileX: number, tileY: number): boolean {
  const props = tileProps(ctx.world.getTile(tileX, tileY));
  return props.solid && props.opaque;
}

function surfaceCheck(
  ctx: SimContext,
  def: StructureDef,
  tileX: number,
  tileY: number,
): PlacementCheck {
  const props = tileProps(ctx.world.getTile(tileX, tileY));

  // Deep water swallows anything not explicitly built for it (a dock), whatever the
  // rest of the tile's properties say.
  if (props.deep && def.placeOn !== 'water') return fail('deepWater', { tileX, tileY });

  switch (def.placeOn) {
    case 'water':
      if (!props.water) return fail('needsWater', { tileX, tileY });
      return OK;
    case 'floor':
      if (!floorAt(ctx, tileX, tileY)) return fail('needsFloor', { tileX, tileY });
      return OK;
    case 'ground':
      if (!props.buildable) return fail('unbuildableSurface', { tileX, tileY });
      return OK;
    case 'any':
      // "any" means ground *or* an existing deck: planking out over a pond is a fair
      // way to reach the water, but only once something is already there to stand on.
      if (props.buildable || floorAt(ctx, tileX, tileY)) return OK;
      return fail('unbuildableSurface', { tileX, tileY });
    default:
      return fail('unbuildableSurface', { tileX, tileY });
  }
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

function occupancyCheck(
  ctx: SimContext,
  def: StructureDef,
  tileX: number,
  tileY: number,
): PlacementCheck {
  const existing = structureAtTile(ctx.state, tileX, tileY);
  if (!existing) return OK;
  const existingDef = ctx.data.structures.get(existing.defId);
  // An unknown definition is not something to build over: that is a content bug, and
  // stacking on top of it would hide it.
  if (!existingDef) return fail('occupied', { tileX, tileY });
  if (def.stacksOver.includes(existingDef.category)) return OK;
  return fail('occupied', { tileX, tileY });
}

/**
 * Resource nodes and creatures standing in the footprint.
 *
 * Both come from the per-tick spatial index rather than a scan of the entity tables:
 * the index is rebuilt at the top of every tick, *before* commands are dispatched, so
 * it is exactly as current as the command being validated.
 */
function blockerCheck(
  ctx: SimContext,
  def: StructureDef,
  tiles: readonly { tileX: number; tileY: number }[],
): PlacementCheck {
  const occupied = new Set(tiles.map((tile) => tileKey(tile.tileX, tile.tileY)));
  const centre = footprintCenter(tiles);
  // Half the footprint span, plus slack for the radius of a large creature straddling
  // the edge. Exact overlap is decided per tile below.
  const reach = (Math.max(tiles.length, 2) * TILE_SIZE) / 2 + TILE_SIZE * 2;

  for (const entry of ctx.spatial.query(centre.x, centre.y, reach)) {
    if (entry.kind === 'node') {
      const node = ctx.state.nodes[entry.id];
      if (!node || node.depleted) continue;
      if (occupied.has(tileKey(node.tileX, node.tileY))) {
        return fail('blockedByNode', { tileX: node.tileX, tileY: node.tileY });
      }
      continue;
    }

    // Only solid pieces care about bodies: a farm plot or a bear trap can be laid down
    // under someone's feet, a wall cannot.
    if (!def.blocksMovement) continue;

    if (entry.kind === 'player') {
      if (!ctx.state.players[entry.id]?.alive) continue;
    } else if (entry.kind === 'zombie') {
      const zombie = ctx.state.zombies[entry.id];
      if (!zombie || zombie.ai === 'dead') continue;
    } else if (entry.kind === 'animal') {
      const animal = ctx.state.animals[entry.id];
      if (!animal || animal.ai === 'dead') continue;
    } else {
      continue;
    }

    for (const tile of tiles) {
      const box = {
        x: tile.tileX * TILE_SIZE,
        y: tile.tileY * TILE_SIZE,
        w: TILE_SIZE,
        h: TILE_SIZE,
      };
      if (circleOverlapsAabb(entry.x, entry.y, entry.radius, box)) {
        return fail('blockedByEntity', { tileX: tile.tileX, tileY: tile.tileY });
      }
    }
  }
  return OK;
}

function supportCheck(
  ctx: SimContext,
  tiles: readonly { tileX: number; tileY: number }[],
): PlacementCheck {
  const own = new Set(tiles.map((tile) => tileKey(tile.tileX, tile.tileY)));
  for (const tile of tiles) {
    // Something already under the piece holds it up: that is what a hatch in a floor is.
    const under = structureAtTile(ctx.state, tile.tileX, tile.tileY);
    const underDef = under ? ctx.data.structures.get(under.defId) : undefined;
    if (underDef && SUPPORT_CATEGORIES.includes(underDef.category)) return OK;

    for (const [dx, dy] of ORTHOGONAL) {
      const nx = tile.tileX + dx;
      const ny = tile.tileY + dy;
      if (own.has(tileKey(nx, ny))) continue;
      if (staticWallAt(ctx, nx, ny)) return OK;
      const neighbour = structureAtTile(ctx.state, nx, ny);
      const neighbourDef = neighbour ? ctx.data.structures.get(neighbour.defId) : undefined;
      if (neighbourDef && SUPPORT_CATEGORIES.includes(neighbourDef.category)) return OK;
    }
  }
  const first = tiles[0];
  return fail('noSupport', first ? { tileX: first.tileX, tileY: first.tileY } : {});
}

// ---------------------------------------------------------------------------
// The one placement check
// ---------------------------------------------------------------------------

/**
 * Can this player put this structure here, right now?
 *
 * The order of the checks is part of the contract, because the client shows the *first*
 * reason: cheap whole-structure failures ("you have not levelled this yet") come before
 * per-tile ones, and materials come last, since "you may build here but cannot afford
 * it" is the most useful thing to say when several things are wrong at once.
 *
 * Deliberately *not* checked here: the shared use cooldown. That is a rate limit on the
 * command, not a property of the location, and folding it in would make the ghost
 * flicker red for a fifth of a second after every placement.
 */
export function canPlace(
  ctx: SimContext,
  player: PlayerState,
  defId: StructureDefId,
  tileX: number,
  tileY: number,
  rotation: number,
): PlacementCheck {
  const def = ctx.data.structures.get(defId);
  if (!def) return fail('unknownStructure');
  if (!isBuildable(ctx, defId)) return fail('notBuildable');
  if (!player.alive) return fail('dead');

  if (!Number.isInteger(tileX) || !Number.isInteger(tileY)) return fail('badTile');
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) return fail('badRotation');

  if (def.requiredSkill && skillLevel(player, def.requiredSkill.id) < def.requiredSkill.level) {
    return fail('missingSkill');
  }
  if (def.tool && !findBuildTool(ctx, player, def.tool)) return fail('missingTool');

  const tiles = footprint(def, tileX, tileY, rotation);
  if (footprintDistance(tiles, player.x, player.y) > BUILD_RANGE) return fail('outOfRange');

  for (const tile of tiles) {
    if (!isTileInWorld(tile.tileX, tile.tileY)) {
      return fail('outOfWorld', { tileX: tile.tileX, tileY: tile.tileY });
    }
    const surface = surfaceCheck(ctx, def, tile.tileX, tile.tileY);
    if (!surface.ok) return surface;
    const occupancy = occupancyCheck(ctx, def, tile.tileX, tile.tileY);
    if (!occupancy.ok) return occupancy;
  }

  const blocked = blockerCheck(ctx, def, tiles);
  if (!blocked.ok) return blocked;

  if (def.requiresSupport) {
    const support = supportCheck(ctx, tiles);
    if (!support.ok) return support;
  }

  const missing = missingMaterial(player, def.cost);
  if (missing) return fail('missingMaterials', { missing });

  return OK;
}
