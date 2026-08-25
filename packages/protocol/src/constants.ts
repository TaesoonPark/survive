/**
 * Global, engine-independent constants.
 *
 * Units
 * -----
 * - **World space is measured in pixels (px).** One tile is {@link TILE_SIZE} px.
 *   The simulation stores float pixel positions; the renderer draws them 1:1.
 * - Speeds are px/second, times are seconds, angles are radians (0 = +X, growing
 *   clockwise because +Y is down, matching screen space).
 * - All "need" stats (hunger/thirst/fatigue) use **need semantics**: 0 = satisfied,
 *   100 = critical. They all grow over time and shrink when the need is met.
 *   `stamina`, `health` and body-part health use the opposite, obvious direction
 *   (0 = empty/dead, max = full).
 */

/** Side length of one tile, in world pixels. */
export const TILE_SIZE = 32;

/** Tiles per chunk edge. One chunk is CHUNK_TILES x CHUNK_TILES tiles. */
export const CHUNK_TILES = 32;

/** Side length of one chunk, in world pixels. */
export const CHUNK_SIZE = CHUNK_TILES * TILE_SIZE;

/** Tiles in one chunk. */
export const CHUNK_TILE_COUNT = CHUNK_TILES * CHUNK_TILES;

/** World size in chunks along each axis. */
export const WORLD_CHUNKS = 256;

/** World size in tiles along each axis. */
export const WORLD_TILES = WORLD_CHUNKS * CHUNK_TILES;

/** World size in pixels along each axis. */
export const WORLD_SIZE = WORLD_CHUNKS * CHUNK_SIZE;

/** Authoritative simulation frequency, in Hz. */
export const SIM_HZ = 20;

/** Fixed simulation timestep, in seconds. */
export const SIM_DT = 1 / SIM_HZ;

/** Fixed simulation timestep, in milliseconds. */
export const SIM_DT_MS = 1000 / SIM_HZ;

/** How often authoritative snapshots are pushed to clients, in Hz. */
export const SNAPSHOT_HZ = 10;

/** Simulation ticks between snapshots. */
export const TICKS_PER_SNAPSHOT = Math.round(SIM_HZ / SNAPSHOT_HZ);

/** Simulation ticks that make up one in-game minute (1 real second = 1 game minute). */
export const TICKS_PER_GAME_MINUTE = SIM_HZ;

/** Simulation ticks in one in-game hour. */
export const TICKS_PER_GAME_HOUR = TICKS_PER_GAME_MINUTE * 60;

/** Simulation ticks in one in-game day. */
export const TICKS_PER_GAME_DAY = TICKS_PER_GAME_HOUR * 24;

/**
 * Tick a brand-new world starts at.
 *
 * The clock is a pure function of the tick, so tick 0 is midnight. Dropping a fresh
 * player into pitch darkness on their first night with no tools is a miserable opening,
 * so a new world starts on the morning of day 1 instead. Saves store the absolute tick,
 * so this only ever affects world creation.
 */
export const WORLD_START_TICK = 8 * TICKS_PER_GAME_HOUR;

/** In-game days per season. */
export const DAYS_PER_SEASON = 14;

/** In-game days per year. */
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;

/** Radius, in pixels, of the area of interest replicated to each client. */
export const AOI_RADIUS = CHUNK_SIZE * 2.5;

/** Radius, in chunks, of the ring of chunks kept loaded around each player. */
export const CHUNK_LOAD_RADIUS = 2;

/** Radius, in chunks, beyond which a loaded chunk is unloaded (hysteresis). */
export const CHUNK_UNLOAD_RADIUS = 4;

/** Chunks within this radius of a player run full-rate simulation. */
export const CHUNK_ACTIVE_RADIUS = 2;

/** Maximum inputs a client may have in flight before the server drops the oldest. */
export const MAX_PENDING_INPUTS = 120;

/** Hard cap on how far a client's predicted position may drift before a hard snap. */
export const RECONCILE_SNAP_DISTANCE = TILE_SIZE * 4;

/** Default player inventory slot count (a backpack adds more). */
export const BASE_INVENTORY_SLOTS = 24;

/** Number of hotbar slots. */
export const HOTBAR_SLOTS = 8;

/** Autosave interval, in simulation ticks. */
export const AUTOSAVE_TICKS = SIM_HZ * 60;

/** Wire protocol version. Client and server must agree exactly. */
export const PROTOCOL_VERSION = 1;

/** Colyseus room name used for all gameplay rooms. */
export const GAME_ROOM_NAME = 'survive';

/** Default dedicated-server port. */
export const DEFAULT_PORT = 27500;
