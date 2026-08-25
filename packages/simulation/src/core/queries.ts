import {
  chunkKey,
  distanceSq,
  pixelToChunk,
  pixelToTile,
  type AnimalState,
  type ChunkKey,
  type ChunkRuntimeState,
  type EntityId,
  type ItemEntityState,
  type PlayerId,
  type PlayerState,
  type ProjectileState,
  type ResourceNodeState,
  type StructureState,
  type ZombieState,
} from '@survive/protocol';
import { tileKey, type SimulationState } from './state';

/** Anything with a monotonic revision counter. */
export interface Revisioned {
  rev: number;
}

/**
 * Mark an entity as changed.
 *
 * The snapshot builder ships an entity only when its `rev` is newer than what a
 * client last acknowledged, so forgetting this call means a change never reaches
 * the client. Call it after every mutation.
 */
export function bump(entity: Revisioned): void {
  entity.rev++;
}

/** Every replicated entity, tagged with which table it came from. */
export type AnyEntity =
  | { kind: 'player'; entity: PlayerState }
  | { kind: 'zombie'; entity: ZombieState }
  | { kind: 'animal'; entity: AnimalState }
  | { kind: 'item'; entity: ItemEntityState }
  | { kind: 'projectile'; entity: ProjectileState }
  | { kind: 'structure'; entity: StructureState }
  | { kind: 'node'; entity: ResourceNodeState };

/** Look an entity up across every table. */
export function findEntity(state: SimulationState, id: EntityId): AnyEntity | undefined {
  const player = state.players[id];
  if (player) return { kind: 'player', entity: player };
  const zombie = state.zombies[id];
  if (zombie) return { kind: 'zombie', entity: zombie };
  const animal = state.animals[id];
  if (animal) return { kind: 'animal', entity: animal };
  const item = state.items[id];
  if (item) return { kind: 'item', entity: item };
  const projectile = state.projectiles[id];
  if (projectile) return { kind: 'projectile', entity: projectile };
  const structure = state.structures[id];
  if (structure) return { kind: 'structure', entity: structure };
  const node = state.nodes[id];
  if (node) return { kind: 'node', entity: node };
  return undefined;
}

/** World position of any entity, or null when the id is unknown. */
export function entityPosition(
  state: SimulationState,
  id: EntityId,
): { x: number; y: number } | null {
  const found = findEntity(state, id);
  if (!found) return null;
  if (found.kind === 'structure') {
    const { tileX, tileY } = found.entity;
    return { x: tileX * 32 + 16, y: tileY * 32 + 16 };
  }
  const entity = found.entity as { x: number; y: number };
  return { x: entity.x, y: entity.y };
}

/** Living things that can take damage. */
export function isDamageable(entity: AnyEntity): boolean {
  switch (entity.kind) {
    case 'player':
      return entity.entity.alive;
    case 'zombie':
      return entity.entity.ai !== 'dead' && entity.entity.health > 0;
    case 'animal':
      return entity.entity.ai !== 'dead' && entity.entity.health > 0;
    case 'structure':
      return entity.entity.health > 0;
    case 'node':
      return !entity.entity.depleted;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Structure tile index
// ---------------------------------------------------------------------------

/** Structure occupying a tile, if any. */
export function structureAtTile(
  state: SimulationState,
  tileX: number,
  tileY: number,
): StructureState | undefined {
  const id = state.structureTiles[tileKey(tileX, tileY)];
  return id ? state.structures[id] : undefined;
}

/** Structure occupying the tile under a world position. */
export function structureAtPosition(
  state: SimulationState,
  x: number,
  y: number,
): StructureState | undefined {
  return structureAtTile(state, pixelToTile(x), pixelToTile(y));
}

/**
 * Footprint tiles of a structure, accounting for rotation.
 *
 * Odd rotations swap width and height, which is what lets a 1x2 bench be placed
 * either way round.
 */
export function structureTiles(
  tileX: number,
  tileY: number,
  width: number,
  height: number,
  rotation: number,
): Array<{ tileX: number; tileY: number }> {
  const swapped = rotation % 2 === 1;
  const w = swapped ? height : width;
  const h = swapped ? width : height;
  const tiles: Array<{ tileX: number; tileY: number }> = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) tiles.push({ tileX: tileX + dx, tileY: tileY + dy });
  }
  return tiles;
}

/** Register a structure's footprint in the tile index. */
export function indexStructure(
  state: SimulationState,
  structure: StructureState,
  width: number,
  height: number,
): void {
  for (const tile of structureTiles(
    structure.tileX,
    structure.tileY,
    width,
    height,
    structure.rotation,
  )) {
    state.structureTiles[tileKey(tile.tileX, tile.tileY)] = structure.id;
  }
}

/** Remove a structure's footprint from the tile index. */
export function unindexStructure(
  state: SimulationState,
  structure: StructureState,
  width: number,
  height: number,
): void {
  for (const tile of structureTiles(
    structure.tileX,
    structure.tileY,
    width,
    height,
    structure.rotation,
  )) {
    const key = tileKey(tile.tileX, tile.tileY);
    if (state.structureTiles[key] === structure.id) delete state.structureTiles[key];
  }
}

// ---------------------------------------------------------------------------
// Chunk bookkeeping
// ---------------------------------------------------------------------------

/** Get, creating if needed, the runtime record for a chunk. */
export function ensureChunkRuntime(
  state: SimulationState,
  cx: number,
  cy: number,
): ChunkRuntimeState {
  const key = chunkKey(cx, cy);
  let runtime = state.chunks[key];
  if (!runtime) {
    runtime = {
      key,
      cx,
      cy,
      activity: 'dormant',
      lastTouchedTick: state.tick,
      lastSimulatedTick: state.tick,
      populated: false,
      dirty: false,
      nextSpawnTick: 0,
    };
    state.chunks[key] = runtime;
  }
  return runtime;
}

/** Flag the chunk containing a world position as needing a save. */
export function markDirtyAt(state: SimulationState, x: number, y: number): void {
  const runtime = state.chunks[chunkKey(pixelToChunk(x), pixelToChunk(y))];
  if (runtime) runtime.dirty = true;
}

/** Flag a chunk as needing a save. */
export function markDirty(state: SimulationState, key: ChunkKey): void {
  const runtime = state.chunks[key];
  if (runtime) runtime.dirty = true;
}

/** Flag the chunk a structure sits in as needing a save. */
export function markStructureDirty(state: SimulationState, structure: StructureState): void {
  markDirtyAt(state, structure.tileX * 32 + 1, structure.tileY * 32 + 1);
}

// ---------------------------------------------------------------------------
// Player queries
// ---------------------------------------------------------------------------

export function livingPlayers(state: SimulationState): PlayerState[] {
  const out: PlayerState[] = [];
  for (const id of Object.keys(state.players)) {
    const player = state.players[id];
    if (player && player.alive) out.push(player);
  }
  return out;
}

export function allPlayers(state: SimulationState): PlayerState[] {
  return Object.values(state.players);
}

/** Closest living player within `radius`, or null. */
export function nearestPlayer(
  state: SimulationState,
  x: number,
  y: number,
  radius: number,
  filter?: (player: PlayerState) => boolean,
): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDistSq = radius * radius;
  for (const player of Object.values(state.players)) {
    if (!player.alive) continue;
    if (filter && !filter(player)) continue;
    const d = distanceSq(x, y, player.x, player.y);
    if (d <= bestDistSq) {
      bestDistSq = d;
      best = player;
    }
  }
  return best;
}

/** Distance in pixels to the closest living player, or Infinity when nobody is near. */
export function distanceToNearestPlayer(state: SimulationState, x: number, y: number): number {
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const player of Object.values(state.players)) {
    if (!player.alive) continue;
    const d = distanceSq(x, y, player.x, player.y);
    if (d < bestDistSq) bestDistSq = d;
  }
  return bestDistSq === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.sqrt(bestDistSq);
}

export function requirePlayer(state: SimulationState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (!player) throw new Error(`Unknown player: ${id}`);
  return player;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove an entity and record it for the snapshot's `removed` list.
 *
 * Structures and nodes must be de-indexed from the collision grid by the owning
 * system before calling this.
 */
export function destroyEntity(state: SimulationState, id: EntityId): boolean {
  let removed = false;
  if (state.zombies[id]) {
    delete state.zombies[id];
    removed = true;
  } else if (state.animals[id]) {
    delete state.animals[id];
    removed = true;
  } else if (state.items[id]) {
    delete state.items[id];
    removed = true;
  } else if (state.projectiles[id]) {
    delete state.projectiles[id];
    removed = true;
  } else if (state.structures[id]) {
    delete state.structures[id];
    removed = true;
  } else if (state.nodes[id]) {
    delete state.nodes[id];
    removed = true;
  }
  if (removed) state.destroyed.push(id);
  return removed;
}
