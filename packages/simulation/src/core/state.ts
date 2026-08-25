import { WORLD_START_TICK } from '@survive/protocol';
import type {
  AnimalState,
  ChunkKey,
  ChunkRuntimeState,
  EntityId,
  ItemEntityState,
  PlayerId,
  PlayerState,
  ProjectileState,
  ResourceNodeState,
  RngState,
  StructureState,
  WeatherState,
  WorldTimeState,
  ZombieState,
} from '@survive/protocol';

/** A group of zombies sharing one navigation goal (spec section 23). */
export interface HordeState {
  id: string;
  memberIds: EntityId[];
  /** Shared goal in world pixels. */
  goalX: number;
  goalY: number;
  /** Tick the shared path was last refreshed. */
  pathTick: number;
}

/**
 * The whole authoritative world state.
 *
 * Plain JSON-serializable data, no class instances, no functions (Architecture Guard
 * rule 6). Everything that persists lives here; everything transient (network
 * buffers, spatial index, event list) lives on the {@link Simulation} instead.
 */
export interface SimulationState {
  /** Absolute tick count. The only clock the simulation trusts. */
  tick: number;
  /** World seed. Terrain, loot and spawns all derive from it. */
  seed: number;

  time: WorldTimeState;
  weather: WeatherState;

  players: Record<PlayerId, PlayerState>;
  zombies: Record<EntityId, ZombieState>;
  animals: Record<EntityId, AnimalState>;
  items: Record<EntityId, ItemEntityState>;
  projectiles: Record<EntityId, ProjectileState>;
  structures: Record<EntityId, StructureState>;
  nodes: Record<EntityId, ResourceNodeState>;

  /** Loaded chunk bookkeeping, keyed by `"cx,cy"`. */
  chunks: Record<ChunkKey, ChunkRuntimeState>;

  /**
   * `"tileX,tileY"` -> structure id, so tile queries do not scan the structure list.
   * Multi-tile structures register every tile they occupy.
   */
  structureTiles: Record<string, EntityId>;

  hordes: Record<string, HordeState>;

  /** Monotonic counter behind every generated entity id. */
  nextId: number;

  /** Serialized state of the master RNG, so a save resumes the same sequence. */
  rng: RngState;

  /** True while the simulation is paused (single-player ESC). */
  paused: boolean;

  /** Chunks the simulation wants dynamic data for. The host fulfils these. */
  pendingChunkLoads: ChunkKey[];

  /** Entities removed during the current tick, consumed by the snapshot builder. */
  destroyed: EntityId[];

  /** Total ticks the simulation has actually stepped, ignoring paused time. */
  steppedTicks: number;
}

/**
 * A brand-new world.
 *
 * Starts at {@link WORLD_START_TICK} - the morning of day 1 - rather than tick 0, because
 * the world clock is derived from the tick and tick 0 is midnight. `startTick` is
 * overridable so a test can begin at any hour it wants to exercise.
 */
export function createEmptyState(
  seed: number,
  rng: RngState,
  startTick: number = WORLD_START_TICK,
): SimulationState {
  const tick = Math.max(0, Math.floor(startTick));
  return {
    tick,
    seed,
    time: {
      tick,
      day: 1,
      hour: 8,
      minute: 0,
      season: 'spring',
      year: 1,
      dayProgress: 8 / 24,
      isNight: false,
      lightLevel: 1,
    },
    // Placeholders, not the climate's answer for `tick`. This is a plain-data
    // constructor (rule 6) and the model that computes real weather lives a layer up in
    // `systems/time/weatherSystem`, which overwrites all of this on the first tick.
    // Do not read `weather` or the derived `time` fields off a state that has never been
    // stepped - notably `temperature`, which reads as a mild 18C on what is actually a
    // frosty spring morning, and will happily convince a test that a crop should live.
    weather: {
      type: 'clear',
      intensity: 0,
      temperature: 18,
      windAngle: 0,
      windSpeed: 0,
      nextChangeTick: 0,
      lightning: false,
    },
    players: {},
    zombies: {},
    animals: {},
    items: {},
    projectiles: {},
    structures: {},
    nodes: {},
    chunks: {},
    structureTiles: {},
    hordes: {},
    nextId: 1,
    rng,
    paused: false,
    pendingChunkLoads: [],
    destroyed: [],
    steppedTicks: 0,
  };
}

/** Key for the {@link SimulationState.structureTiles} map. */
export function tileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}
