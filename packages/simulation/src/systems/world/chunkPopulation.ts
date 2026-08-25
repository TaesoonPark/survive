import {
  CHUNK_ACTIVE_RADIUS,
  CHUNK_SIZE,
  CHUNK_TILES,
  CHUNK_TILE_COUNT,
  CHUNK_UNLOAD_RADIUS,
  Tile,
  biomeProps,
  bucket,
  chunkDistance,
  chunkKey,
  isChunkInWorld,
  pixelToChunk,
  rngForCoord,
  tileCenter,
  tileProps,
  type BiomeId,
  type ChunkActivity,
  type ChunkRuntimeState,
  type Rng,
} from '@survive/protocol';
import type { AnimalDef, ResourceNodeDef } from '@survive/game-data';
import type { WorldService } from '@survive/world';
import { SystemOrder, type System } from '../../core/context';
import type { SimContext } from '../../core/context';
import { bump, livingPlayers, markStructureDirty, structureAtTile } from '../../core/queries';
import { spawnNode, spawnStructure } from '../../core/structures';
import { spawnAnimalAt } from './creatures';

/**
 * One-time chunk content, and the chunk activity bookkeeping that goes with it.
 *
 * The hard rule here is that a chunk's generated contents must be a pure function of
 * `(seed, cx, cy)` and nothing else - not the master RNG, not the tick, not which
 * chunks happen to be loaded. Draw from `ctx.rng` instead and the same chunk populates
 * differently depending on when the player first walked into it, which turns "I left a
 * chest by the three pines" into a lie the moment the chunk is unloaded and reloaded in
 * a different session. Everything below therefore derives from {@link rngForCoord}.
 *
 * The three passes are separately salted so that changing how many animals a chunk
 * gets does not also move every tree in the world.
 */

/** RNG salts. Changing one of these re-rolls that pass for every chunk in every save. */
export const NODE_SALT = 0x6e6f_6465;
export const CONTAINER_SALT = 0x6c6f_6f74;
export const ANIMAL_SALT = 0x616e_696d;

/** Tiles that mean "inside a building": rooms get loot, not trees. */
const INTERIOR_FLOORS: ReadonlySet<number> = new Set([
  Tile.FloorWood,
  Tile.FloorTile,
  Tile.FloorConcrete,
]);

/** A floor region smaller than this is a doorway or a landing, not a room. */
const MIN_ROOM_TILES = 4;

/** Roughly one lootable container per this many tiles of floor. */
const TILES_PER_CONTAINER = 14;

/** Attempts to find a free tile before giving up on one placement. */
const PLACEMENT_ATTEMPTS = 8;

/**
 * Tile stride used when only a rough biome mix is needed (spawn budgets).
 * A 4x4 sample of a 32x32 chunk: 16 `getBiome` calls instead of 1024.
 */
export const BUDGET_SAMPLE_STEP = 8;

/** How far ahead of a walking player chunks are pre-requested, in seconds. */
const PREFETCH_LOOKAHEAD_SECONDS = 3;

// ---------------------------------------------------------------------------
// Surveying a chunk
// ---------------------------------------------------------------------------

/** Everything the population passes need to know about a chunk's tiles. */
export interface ChunkTileSurvey {
  /** Local tile indices of open, walkable, outdoor ground, grouped by biome. */
  land: Map<number, number[]>;
  /** Local tile indices of shallow water, grouped by biome. */
  water: Map<number, number[]>;
  /** Fraction of the chunk covered by each biome, 0..1. */
  fractions: Map<number, number>;
  /** Local index -> tile id for building-interior floors. */
  floors: Map<number, number>;
  /** Local indices already taken by a node or a structure. */
  occupied: Set<number>;
}

function localIndex(lx: number, ly: number): number {
  return ly * CHUNK_TILES + lx;
}

function localToTileX(cx: number, local: number): number {
  return cx * CHUNK_TILES + (local % CHUNK_TILES);
}

function localToTileY(cy: number, local: number): number {
  return cy * CHUNK_TILES + Math.floor(local / CHUNK_TILES);
}

/**
 * Walk every tile in a chunk once, recording what can be placed where.
 *
 * Deliberately a single pass: the alternative is four passes over 1024 tiles asking
 * the world service the same questions, and this runs on the tick a chunk streams in.
 */
export function surveyChunk(ctx: SimContext, cx: number, cy: number): ChunkTileSurvey {
  const land = new Map<number, number[]>();
  const water = new Map<number, number[]>();
  const counts = new Map<number, number>();
  const floors = new Map<number, number>();
  const occupied = new Set<number>();

  for (let ly = 0; ly < CHUNK_TILES; ly++) {
    for (let lx = 0; lx < CHUNK_TILES; lx++) {
      const tileX = cx * CHUNK_TILES + lx;
      const tileY = cy * CHUNK_TILES + ly;
      const local = localIndex(lx, ly);

      const biome = ctx.world.getBiome(tileX, tileY);
      counts.set(biome, (counts.get(biome) ?? 0) + 1);

      if (structureAtTile(ctx.state, tileX, tileY)) occupied.add(local);

      const tile = ctx.world.getTile(tileX, tileY);
      if (INTERIOR_FLOORS.has(tile)) {
        floors.set(local, tile);
        continue;
      }
      if (ctx.world.isSolidTile(tileX, tileY)) continue;

      const props = tileProps(tile);
      if (props.water) {
        // Deep water is for swimming; nothing generates in it.
        if (!props.deep) bucket(water, biome).push(local);
        continue;
      }
      bucket(land, biome).push(local);
    }
  }

  for (const id of Object.keys(ctx.state.nodes).sort()) {
    const node = ctx.state.nodes[id];
    if (!node) continue;
    if (Math.floor(node.tileX / CHUNK_TILES) !== cx) continue;
    if (Math.floor(node.tileY / CHUNK_TILES) !== cy) continue;
    const lx = ((node.tileX % CHUNK_TILES) + CHUNK_TILES) % CHUNK_TILES;
    const ly = ((node.tileY % CHUNK_TILES) + CHUNK_TILES) % CHUNK_TILES;
    occupied.add(localIndex(lx, ly));
  }

  const fractions = new Map<number, number>();
  for (const [biome, count] of counts) fractions.set(biome, count / CHUNK_TILE_COUNT);
  return { land, water, fractions, floors, occupied };
}

/**
 * Cheap biome mix for a chunk, sampled on a stride.
 *
 * Spawn budgets are asked for repeatedly at runtime and only need to know "mostly
 * town" from "mostly forest", so they sample rather than scan.
 */
export function chunkBiomeFractions(
  world: WorldService,
  cx: number,
  cy: number,
  step = BUDGET_SAMPLE_STEP,
): Map<number, number> {
  const counts = new Map<number, number>();
  let total = 0;
  for (let ly = 0; ly < CHUNK_TILES; ly += step) {
    for (let lx = 0; lx < CHUNK_TILES; lx += step) {
      const biome = world.getBiome(cx * CHUNK_TILES + lx, cy * CHUNK_TILES + ly);
      counts.set(biome, (counts.get(biome) ?? 0) + 1);
      total++;
    }
  }
  const fractions = new Map<number, number>();
  if (total === 0) return fractions;
  for (const [biome, count] of counts) fractions.set(biome, count / total);
  return fractions;
}

// ---------------------------------------------------------------------------
// Density targets
// ---------------------------------------------------------------------------

/** How many of each node definition a chunk with this biome mix should hold. */
export function nodeTargets(
  ctx: SimContext,
  fractions: ReadonlyMap<number, number>,
): Array<{ def: ResourceNodeDef; target: number }> {
  const defs = new Map<string, ResourceNodeDef>();
  for (const biome of [...fractions.keys()].sort((a, b) => a - b)) {
    for (const def of ctx.data.nodesForBiome(biome as BiomeId)) defs.set(def.id, def);
  }
  const out: Array<{ def: ResourceNodeDef; target: number }> = [];
  for (const id of [...defs.keys()].sort()) {
    const def = defs.get(id);
    if (!def) continue;
    let weighted = 0;
    for (const [biome, fraction] of fractions) {
      const weight = def.spawnBiomes[biome as BiomeId] ?? 0;
      if (weight <= 0) continue;
      weighted += weight * biomeProps(biome).resourceWeight * fraction;
    }
    if (weighted <= 0) continue;
    out.push({ def, target: def.densityPerChunk * weighted * ctx.config.world.resourceDensity });
  }
  return out;
}

/** How many of each animal definition a chunk with this biome mix should hold. */
export function animalTargets(
  ctx: SimContext,
  fractions: ReadonlyMap<number, number>,
): Array<{ def: AnimalDef; target: number }> {
  const defs = new Map<string, AnimalDef>();
  for (const biome of [...fractions.keys()].sort((a, b) => a - b)) {
    for (const def of ctx.data.animalsForBiome(biome as BiomeId)) defs.set(def.id, def);
  }
  const out: Array<{ def: AnimalDef; target: number }> = [];
  for (const id of [...defs.keys()].sort()) {
    const def = defs.get(id);
    if (!def) continue;
    let weighted = 0;
    for (const [biome, fraction] of fractions) {
      const weight = def.spawnBiomes[biome as BiomeId] ?? 0;
      if (weight <= 0) continue;
      weighted += weight * biomeProps(biome).animalWeight * fraction;
    }
    if (weighted <= 0) continue;
    out.push({ def, target: def.densityPerChunk * weighted * ctx.config.world.animalDensity });
  }
  return out;
}

/** Total animals a chunk should hold. Shared with the spawn system's top-up. */
export function animalBudgetForChunk(ctx: SimContext, cx: number, cy: number): number {
  const fractions = chunkBiomeFractions(ctx.world, cx, cy);
  let total = 0;
  for (const entry of animalTargets(ctx, fractions)) total += entry.target;
  return total;
}

/** Turn a fractional target into a whole count, carrying the remainder as a chance. */
function wholeCount(rng: Rng, target: number): number {
  if (target <= 0) return 0;
  const floor = Math.floor(target);
  return floor + (rng.chance(target - floor) ? 1 : 0);
}

/**
 * Pick a free tile whose biome the definition wants, weighted by both the biome's
 * preference and how much of the chunk it covers.
 */
function pickTileForBiomes(
  rng: Rng,
  spawnBiomes: Partial<Record<BiomeId, number>>,
  pools: ReadonlyMap<number, number[]>,
  occupied: ReadonlySet<number> | null,
): number | null {
  const biomes: number[] = [];
  for (const biome of [...pools.keys()].sort((a, b) => a - b)) {
    const weight = spawnBiomes[biome as BiomeId] ?? 0;
    if (weight <= 0) continue;
    if ((pools.get(biome)?.length ?? 0) === 0) continue;
    biomes.push(biome);
  }
  if (biomes.length === 0) return null;

  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const biome = rng.pickWeighted(
      biomes,
      (candidate) => (spawnBiomes[candidate as BiomeId] ?? 0) * (pools.get(candidate)?.length ?? 0),
    );
    if (biome === undefined) return null;
    const list = pools.get(biome);
    if (!list || list.length === 0) continue;
    const local = list[rng.int(0, list.length - 1)];
    if (local === undefined) continue;
    if (occupied?.has(local)) continue;
    return local;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass 1: resource nodes
// ---------------------------------------------------------------------------

function placeResourceNodes(
  ctx: SimContext,
  cx: number,
  cy: number,
  survey: ChunkTileSurvey,
): void {
  const rng = rngForCoord(ctx.state.seed, cx, cy, NODE_SALT);
  for (const { def, target } of nodeTargets(ctx, survey.fractions)) {
    const count = wholeCount(rng, target);
    // Water nodes (ponds to scoop from, fishing spots) belong on water; everything
    // else belongs on dry, open ground.
    const pools = def.category === 'water' ? survey.water : survey.land;
    for (let i = 0; i < count; i++) {
      const local = pickTileForBiomes(rng, def.spawnBiomes, pools, survey.occupied);
      if (local === null) break;
      survey.occupied.add(local);
      spawnNode(
        ctx,
        def.id,
        localToTileX(cx, local),
        localToTileY(cy, local),
        rng.int(0, Math.max(0, def.variants - 1)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: lootable containers in buildings
// ---------------------------------------------------------------------------

interface ContainerProfile {
  lootTableId: string;
  structureDefId: string;
  weight: number;
  /** Shops, pharmacies and police stations only exist where a town does. */
  urbanOnly?: boolean;
}

/**
 * What a room's floor says about what is in its cupboards.
 *
 * Tiled floors are kitchens and bathrooms, boards are living space and sheds, and bare
 * concrete is a garage, a shop floor or something official. It is a crude reading of a
 * building, but it is the only signal the terrain layer actually carries, and it makes
 * looting legible: a player learns to head for the concrete.
 */
const PROFILES_BY_FLOOR: Readonly<Record<number, readonly ContainerProfile[]>> = {
  [Tile.FloorTile]: [
    { lootTableId: 'house_kitchen', structureDefId: 'storage_box', weight: 3 },
    { lootTableId: 'house_bathroom', structureDefId: 'storage_box', weight: 2.5 },
    {
      lootTableId: 'store_pharmacy',
      structureDefId: 'storage_crate',
      weight: 0.8,
      urbanOnly: true,
    },
  ],
  [Tile.FloorWood]: [
    { lootTableId: 'house_bedroom', structureDefId: 'storage_box', weight: 3 },
    { lootTableId: 'house_kitchen', structureDefId: 'storage_box', weight: 2 },
    { lootTableId: 'shed', structureDefId: 'storage_crate', weight: 1.5 },
    { lootTableId: 'store_general', structureDefId: 'storage_crate', weight: 1, urbanOnly: true },
  ],
  [Tile.FloorConcrete]: [
    { lootTableId: 'house_garage', structureDefId: 'storage_crate', weight: 2.5 },
    { lootTableId: 'store_hardware', structureDefId: 'storage_crate', weight: 2, urbanOnly: true },
    { lootTableId: 'store_general', structureDefId: 'storage_crate', weight: 1.5, urbanOnly: true },
    {
      lootTableId: 'police_station',
      structureDefId: 'storage_locker',
      weight: 0.6,
      urbanOnly: true,
    },
  ],
};

const DEFAULT_PROFILES = PROFILES_BY_FLOOR[Tile.FloorWood] ?? [];

/** Profiles usable here: content that exists, and shops only where there is a town. */
function availableProfiles(ctx: SimContext, floorTile: number, urban: boolean): ContainerProfile[] {
  const profiles = PROFILES_BY_FLOOR[floorTile] ?? DEFAULT_PROFILES;
  return profiles.filter(
    (profile) =>
      (urban || !profile.urbanOnly) &&
      ctx.data.lootTables.has(profile.lootTableId) &&
      ctx.data.structures.has(profile.structureDefId),
  );
}

/** One contiguous run of interior floor inside a chunk: a room, near enough. */
export interface Room {
  /** Lowest local index in the room. A stable, position-derived identity. */
  anchor: number;
  tiles: number[];
  /** Floor tile id at the anchor, which decides the loot profile. */
  tile: number;
}

/** Contiguous floor regions inside one chunk. */
export function findRooms(floors: ReadonlyMap<number, number>): Room[] {
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (const start of [...floors.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const tiles: number[] = [];
    const queue: number[] = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      tiles.push(current);
      const lx = current % CHUNK_TILES;
      const ly = Math.floor(current / CHUNK_TILES);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = lx + dx;
        const ny = ly + dy;
        if (nx < 0 || ny < 0 || nx >= CHUNK_TILES || ny >= CHUNK_TILES) continue;
        const next = localIndex(nx, ny);
        if (!floors.has(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    // Sorted so the anchor and the placement order do not depend on the flood order.
    tiles.sort((a, b) => a - b);
    const anchor = tiles[0];
    if (anchor === undefined) continue;
    rooms.push({ anchor, tiles, tile: floors.get(anchor) ?? Tile.FloorWood });
  }
  return rooms;
}

function placeLootContainers(
  ctx: SimContext,
  cx: number,
  cy: number,
  survey: ChunkTileSurvey,
): void {
  if (survey.floors.size === 0) return;
  const urban = ctx.world.generator.isUrban(cx, cy);

  for (const room of findRooms(survey.floors)) {
    if (room.tiles.length < MIN_ROOM_TILES) continue;
    const profiles = availableProfiles(ctx, room.tile, urban);
    if (profiles.length === 0) continue;

    // Seeded from the room's own anchor tile rather than the chunk, so a building that
    // straddles a chunk boundary still furnishes both halves independently and stably.
    const rng = rngForCoord(
      ctx.state.seed,
      localToTileX(cx, room.anchor),
      localToTileY(cy, room.anchor),
      CONTAINER_SALT,
    );
    const count = Math.min(
      Math.max(1, Math.round(room.tiles.length / TILES_PER_CONTAINER)),
      // Never wall a room in with its own furniture.
      Math.floor(room.tiles.length / 3),
    );

    for (let i = 0; i < count; i++) {
      const profile = rng.pickWeighted(profiles, (candidate) => candidate.weight);
      if (!profile) break;
      let local: number | null = null;
      for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
        const candidate = room.tiles[rng.int(0, room.tiles.length - 1)];
        if (candidate === undefined) continue;
        if (survey.occupied.has(candidate)) continue;
        local = candidate;
        break;
      }
      if (local === null) break;
      survey.occupied.add(local);

      const structure = spawnStructure(
        ctx,
        profile.structureDefId,
        localToTileX(cx, local),
        localToTileY(cy, local),
        0,
      );
      if (!structure?.container) continue;
      structure.container.lootTableId = profile.lootTableId;
      // Left unrolled on purpose. The inventory system rolls a container the first time
      // a player opens it, so its contents follow `lootAbundance` as configured then,
      // and a world generated on a stingy server is not stuck that way forever.
      structure.container.rolled = false;
      bump(structure);
      markStructureDirty(ctx.state, structure);
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 3: the initial animal population
// ---------------------------------------------------------------------------

function placeInitialAnimals(
  ctx: SimContext,
  cx: number,
  cy: number,
  survey: ChunkTileSurvey,
): void {
  const rng = rngForCoord(ctx.state.seed, cx, cy, ANIMAL_SALT);
  for (const { def, target } of animalTargets(ctx, survey.fractions)) {
    const count = wholeCount(rng, target);
    for (let i = 0; i < count; i++) {
      // Animals do not reserve their tile: two rabbits may start next to each other,
      // and they will have wandered apart within the minute.
      const local = pickTileForBiomes(rng, def.spawnBiomes, survey.land, null);
      if (local === null) break;
      const x = tileCenter(localToTileX(cx, local));
      const y = tileCenter(localToTileY(cy, local));
      if (ctx.world.circleBlocked(x, y, def.radius)) continue;
      spawnAnimalAt(ctx, def, x, y, rng);
    }
  }
}

// ---------------------------------------------------------------------------
// Population entry point
// ---------------------------------------------------------------------------

/**
 * Generate a chunk's one-time contents. Idempotent: a populated chunk is left alone.
 *
 * Exported so tests can populate a chunk directly, and so a world-generation tool can
 * pre-bake a save without running the simulation.
 */
export function populateChunk(ctx: SimContext, runtime: ChunkRuntimeState): void {
  if (runtime.populated) return;
  const survey = surveyChunk(ctx, runtime.cx, runtime.cy);
  placeResourceNodes(ctx, runtime.cx, runtime.cy, survey);
  placeLootContainers(ctx, runtime.cx, runtime.cy, survey);
  placeInitialAnimals(ctx, runtime.cx, runtime.cy, survey);
  runtime.populated = true;
  runtime.dirty = true;
}

// ---------------------------------------------------------------------------
// Activity tiers and streaming
// ---------------------------------------------------------------------------

/**
 * Ask the host for a chunk's dynamic layer.
 *
 * The simulation cannot load anything itself (rule 11), so it leaves the key in
 * `pendingChunkLoads` and the host answers with `installChunk`. Duplicate requests are
 * dropped here rather than at the host, because a request list that grows every tick
 * is a leak.
 */
export function requestChunkLoad(ctx: SimContext, cx: number, cy: number): boolean {
  if (!isChunkInWorld(cx, cy)) return false;
  const key = chunkKey(cx, cy);
  if (ctx.state.chunks[key]) return false;
  if (ctx.state.pendingChunkLoads.includes(key)) return false;
  ctx.state.pendingChunkLoads.push(key);
  return true;
}

function requestRing(ctx: SimContext, x: number, y: number, radius: number): void {
  const centreX = pixelToChunk(x);
  const centreY = pixelToChunk(y);
  for (let cy = centreY - radius; cy <= centreY + radius; cy++) {
    for (let cx = centreX - radius; cx <= centreX + radius; cx++) requestChunkLoad(ctx, cx, cy);
  }
}

/** Activity tier for a chunk a given number of chunks from the nearest player. */
export function activityForDistance(chunks: number): ChunkActivity {
  if (chunks <= CHUNK_ACTIVE_RADIUS) return 'active';
  if (chunks <= CHUNK_UNLOAD_RADIUS) return 'low';
  return 'dormant';
}

/**
 * The chunk population and streaming system.
 *
 * Populating happens both on the chunk-loaded hook (so a streamed-in chunk has its
 * trees before anything else looks at it) and as a sweep in `update` (so a chunk whose
 * runtime record appeared some other way is not left blank forever).
 */
/**
 * Chunks given their one-time contents per tick.
 *
 * Two is enough to keep up with a sprinting player (who crosses a chunk border roughly
 * every six seconds, or 120 ticks) with a wide margin, while capping the worst tick.
 */
export const MAX_POPULATIONS_PER_TICK = 2;

export function createChunkPopulationSystem(): System {
  return {
    id: 'chunkPopulation',
    order: SystemOrder.Chunk,

    onChunkLoaded(ctx, chunkKeyLoaded) {
      const runtime = ctx.state.chunks[chunkKeyLoaded];
      if (!runtime) return;
      // Populate immediately only for the chunk a player is actually standing in: they
      // must never see bare ground under their feet. Everything else waits for `update`,
      // which spreads the work out - see MAX_POPULATIONS_PER_TICK.
      for (const player of livingPlayers(ctx.state)) {
        if (pixelToChunk(player.x) === runtime.cx && pixelToChunk(player.y) === runtime.cy) {
          populateChunk(ctx, runtime);
          return;
        }
      }
    },

    update(ctx) {
      const players = livingPlayers(ctx.state).sort((a, b) => (a.id < b.id ? -1 : 1));

      /**
       * Chunks still awaiting their one-time contents, nearest player first.
       *
       * Populating is the most expensive thing this system does - a chunk gets its
       * resource nodes, its wildlife and its lootable containers in one go - and crossing
       * a chunk border pulls a whole new row of the load ring in at once. Doing all of
       * them in the tick they arrive produced 80ms ticks while sprinting, which is a
       * visible stutter against a 50ms budget. Spreading them over consecutive ticks costs
       * a fraction of a second of "this chunk is still filling in" at the edge of the
       * area of interest, which nobody can see, and keeps the worst tick flat.
       */
      const pending: Array<{ runtime: ChunkRuntimeState; distance: number }> = [];

      for (const key of Object.keys(ctx.state.chunks).sort()) {
        const runtime = ctx.state.chunks[key];
        if (!runtime) continue;

        let nearest = Number.POSITIVE_INFINITY;
        for (const player of players) {
          const d = chunkDistance(
            runtime.cx,
            runtime.cy,
            pixelToChunk(player.x),
            pixelToChunk(player.y),
          );
          if (d < nearest) nearest = d;
        }

        runtime.activity = Number.isFinite(nearest)
          ? activityForDistance(nearest)
          : // Nobody nearby at all: dormant, whatever the arithmetic would say.
            'dormant';
        if (nearest <= ctx.config.chunkLoadRadius) runtime.lastTouchedTick = ctx.state.tick;
        if (runtime.activity !== 'dormant') runtime.lastSimulatedTick = ctx.state.tick;

        if (!runtime.populated) pending.push({ runtime, distance: nearest });
      }

      if (pending.length > 0) {
        // Nearest first, with the chunk key as a deterministic tie-break so a replay
        // populates in the same order every time.
        pending.sort((a, b) => a.distance - b.distance || (a.runtime.key < b.runtime.key ? -1 : 1));
        for (let i = 0; i < Math.min(MAX_POPULATIONS_PER_TICK, pending.length); i++) {
          populateChunk(ctx, pending[i]!.runtime);
        }
      }

      for (const player of players) {
        requestRing(ctx, player.x, player.y, ctx.config.chunkLoadRadius);
        // Pre-fetch where the player is heading. Loading a chunk only once they have
        // crossed into it means they walk into an empty world for a few frames.
        const speed = Math.hypot(player.vx, player.vy);
        if (speed * PREFETCH_LOOKAHEAD_SECONDS < CHUNK_SIZE / 4) continue;
        requestRing(
          ctx,
          player.x + player.vx * PREFETCH_LOOKAHEAD_SECONDS,
          player.y + player.vy * PREFETCH_LOOKAHEAD_SECONDS,
          ctx.config.chunkLoadRadius,
        );
      }
    },
  };
}
