import {
  createEmptyInventory,
  pixelToTile,
  SAVE_FORMAT_VERSION,
  tileCenter,
  type EntityId,
  type PlayerId,
  type ResourceNodeState,
  type StructureState,
} from '@survive/protocol';
import { CollisionFlag, type CollisionFlags } from '@survive/world';
import type { ResourceNodeDef, StructureDef } from '@survive/game-data';
import type { SimContext } from './context';
import { indexStructure, markStructureDirty, structureTiles, unindexStructure } from './queries';

/**
 * Structure and resource-node lifecycle.
 *
 * Placing a structure has to keep three things in sync: the entity table, the
 * tile->structure index, and the collision grid. Every path that creates or removes
 * one goes through here so they cannot drift - including chunk load from disk, which
 * is why this lives in `core` rather than inside the building system.
 */

/** Collision bits a structure definition contributes to the tiles it occupies. */
export function structureCollisionFlags(def: StructureDef, doorOpen: boolean): CollisionFlags {
  let flags: CollisionFlags = CollisionFlag.None;
  if (def.door) {
    flags |= CollisionFlag.Door;
    if (!doorOpen) {
      if (def.blocksMovement) flags |= CollisionFlag.StructureSolid;
      if (def.blocksSight) flags |= CollisionFlag.StructureOpaque;
    }
  } else {
    if (def.blocksMovement) flags |= CollisionFlag.StructureSolid;
    if (def.blocksSight) flags |= CollisionFlag.StructureOpaque;
  }
  if (def.plot) flags |= CollisionFlag.Plot;
  return flags;
}

/** Centre of a structure's footprint, in world pixels. */
export function structureCenter(
  structure: StructureState,
  def: StructureDef,
): { x: number; y: number } {
  const swapped = structure.rotation % 2 === 1;
  const w = swapped ? def.height : def.width;
  const h = swapped ? def.width : def.height;
  return {
    x: tileCenter(structure.tileX) + ((w - 1) * 32) / 2,
    y: tileCenter(structure.tileY) + ((h - 1) * 32) / 2,
  };
}

/** Build the runtime state for a structure from its definition. */
export function buildStructureState(
  ctx: SimContext,
  id: EntityId,
  def: StructureDef,
  tileX: number,
  tileY: number,
  rotation: number,
  ownerId: PlayerId | undefined,
  progress = 1,
): StructureState {
  const structure: StructureState = {
    id,
    defId: def.id,
    tileX,
    tileY,
    rotation: ((rotation % 4) + 4) % 4,
    health: Math.max(1, Math.round(def.maxHealth * (progress >= 1 ? 1 : 0.35))),
    maxHealth: def.maxHealth,
    builtTick: ctx.state.tick,
    progress,
    rev: 1,
  };
  if (ownerId) structure.ownerId = ownerId;

  if (def.door) structure.door = { open: false, locked: false };
  if (def.container) {
    const inv = createEmptyInventory(def.container.slots);
    structure.container = {
      slots: inv.slots,
      capacity: inv.capacity,
      rolled: true,
      viewers: [],
    };
  }
  if (def.station) {
    structure.station = {
      lit: !def.station.needsFuel,
      fuel: 0,
      maxFuel: def.station.maxFuel,
      heat: def.station.needsFuel ? 0 : def.station.heat,
      jobs: [],
    };
  }
  if (def.plot) {
    structure.plot = {
      tilled: true,
      moisture: def.plot.moisture,
      fertility: def.plot.fertility,
    };
  }
  if (def.light) structure.light = { on: false, fuel: 0, radius: def.light.radius };
  if (def.bed) structure.bed = { sleepStartTick: -1 };

  return structure;
}

/** Register a structure in the tile index and the collision grid. */
export function attachStructure(ctx: SimContext, structure: StructureState): void {
  const def = ctx.data.structures.get(structure.defId);
  if (!def) {
    ctx.log.warn('attachStructure: unknown definition', { defId: structure.defId });
    return;
  }
  indexStructure(ctx.state, structure, def.width, def.height);
  const flags = structureCollisionFlags(def, structure.door?.open ?? false);
  if (flags !== CollisionFlag.None) {
    for (const tile of structureTiles(
      structure.tileX,
      structure.tileY,
      def.width,
      def.height,
      structure.rotation,
    )) {
      ctx.world.addCollision(tile.tileX, tile.tileY, flags);
    }
  }
}

/** Remove a structure from the tile index and the collision grid. */
export function detachStructure(ctx: SimContext, structure: StructureState): void {
  const def = ctx.data.structures.get(structure.defId);
  if (!def) return;
  const flags =
    CollisionFlag.StructureSolid |
    CollisionFlag.StructureOpaque |
    CollisionFlag.Door |
    CollisionFlag.Plot;
  for (const tile of structureTiles(
    structure.tileX,
    structure.tileY,
    def.width,
    def.height,
    structure.rotation,
  )) {
    ctx.world.removeCollision(tile.tileX, tile.tileY, flags);
  }
  unindexStructure(ctx.state, structure, def.width, def.height);
}

/**
 * Re-apply collision after a door opens or closes.
 *
 * Cheaper and less error-prone than detach+attach, and it leaves the tile index
 * untouched, which matters because interaction lookups run through that index.
 */
export function refreshStructureCollision(ctx: SimContext, structure: StructureState): void {
  const def = ctx.data.structures.get(structure.defId);
  if (!def) return;
  const clear = CollisionFlag.StructureSolid | CollisionFlag.StructureOpaque | CollisionFlag.Door;
  const flags = structureCollisionFlags(def, structure.door?.open ?? false);
  for (const tile of structureTiles(
    structure.tileX,
    structure.tileY,
    def.width,
    def.height,
    structure.rotation,
  )) {
    ctx.world.removeCollision(tile.tileX, tile.tileY, clear);
    if (flags !== CollisionFlag.None) ctx.world.addCollision(tile.tileX, tile.tileY, flags);
  }
}

/** Create, register and store a structure. Returns the new entity. */
export function spawnStructure(
  ctx: SimContext,
  defId: string,
  tileX: number,
  tileY: number,
  rotation: number,
  ownerId?: PlayerId,
  progress = 1,
): StructureState | null {
  const def = ctx.data.structures.get(defId);
  if (!def) {
    ctx.log.warn('spawnStructure: unknown definition', { defId });
    return null;
  }
  const structure = buildStructureState(
    ctx,
    ctx.ids.structure(),
    def,
    tileX,
    tileY,
    rotation,
    ownerId,
    progress,
  );
  ctx.state.structures[structure.id] = structure;
  attachStructure(ctx, structure);
  markStructureDirty(ctx.state, structure);
  return structure;
}

/** Unregister and delete a structure. */
export function removeStructure(ctx: SimContext, structure: StructureState): void {
  detachStructure(ctx, structure);
  markStructureDirty(ctx.state, structure);
  delete ctx.state.structures[structure.id];
  ctx.state.destroyed.push(structure.id);
}

// ---------------------------------------------------------------------------
// Resource nodes
// ---------------------------------------------------------------------------

export function nodeCollisionFlags(def: ResourceNodeDef): CollisionFlags {
  let flags: CollisionFlags = CollisionFlag.None;
  if (def.blocksMovement) flags |= CollisionFlag.NodeSolid;
  if (def.blocksSight) flags |= CollisionFlag.NodeOpaque;
  return flags;
}

export function attachNode(ctx: SimContext, node: ResourceNodeState): void {
  const def = ctx.data.nodes.get(node.defId);
  if (!def) return;
  const flags = nodeCollisionFlags(def);
  if (flags !== CollisionFlag.None && !node.depleted) {
    ctx.world.addCollision(node.tileX, node.tileY, flags);
  }
}

export function detachNode(ctx: SimContext, node: ResourceNodeState): void {
  // Only the node's own bits. Clearing `StructureOpaque` here used to strip the sight
  // blocking off a wall sharing the tile - solid but see-through.
  ctx.world.removeCollision(
    node.tileX,
    node.tileY,
    CollisionFlag.NodeSolid | CollisionFlag.NodeOpaque,
  );
}

export function buildNodeState(
  _ctx: SimContext,
  id: EntityId,
  def: ResourceNodeDef,
  tileX: number,
  tileY: number,
  variant: number,
): ResourceNodeState {
  return {
    id,
    defId: def.id,
    x: tileCenter(tileX),
    y: tileCenter(tileY),
    tileX,
    tileY,
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    harvests: 0,
    depleted: false,
    respawnAtTick: -1,
    variant,
    rev: 1,
  };
}

/** Create, register and store a resource node. */
export function spawnNode(
  ctx: SimContext,
  defId: string,
  tileX: number,
  tileY: number,
  variant = 0,
): ResourceNodeState | null {
  const def = ctx.data.nodes.get(defId);
  if (!def) return null;
  const node = buildNodeState(ctx, ctx.ids.node(), def, tileX, tileY, variant);
  ctx.state.nodes[node.id] = node;
  attachNode(ctx, node);
  return node;
}

export function removeNode(ctx: SimContext, node: ResourceNodeState): void {
  detachNode(ctx, node);
  delete ctx.state.nodes[node.id];
  ctx.state.destroyed.push(node.id);
}

/** Tile a world position falls in, as a convenience for command handlers. */
export function tileOf(x: number, y: number): { tileX: number; tileY: number } {
  return { tileX: pixelToTile(x), tileY: pixelToTile(y) };
}

/** Save-format version stamped onto newly written chunks. */
export const CURRENT_SAVE_VERSION = SAVE_FORMAT_VERSION;
