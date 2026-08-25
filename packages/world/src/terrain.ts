/**
 * Deterministic terrain generation.
 *
 * `generate(cx, cy)` is a pure function of `(seed, cx, cy)`: chunk (5, 7) contains the
 * same 1024 tiles whether it is the first chunk a player walks into or the ten
 * thousandth, and whether or not its neighbours have ever been generated (spec section
 * 29, Architecture Guard rules 7 and 9). Two things follow from that, and they shape
 * the whole file:
 *
 * - **Nothing is cached.** Every value is recomputed from the noise fields in
 *   {@link ./noise}, which are themselves stateless hashes of `(seed, x, y)`.
 * - **No layer may read a neighbouring chunk.** Where a rule genuinely needs a
 *   neighbourhood - the shallow ring around deep water, the slope test that produces
 *   cliffs - the neighbourhood is *resampled from the fields* on a one-tile padded
 *   border, so the answer cannot depend on which chunk asked the question.
 *
 * The layers, applied in this order at every tile:
 *
 * 1. elevation and moisture fields (warped fractal noise)
 * 2. water: lakes from the height field, rivers from a ridged valley test, then a
 *    shallow ring and a sand shore
 * 3. biome and ground tiles from (elevation, moisture, slope, latitude)
 * 4. roads: a jittered arterial grid plus dirt spurs towards town sites
 * 5. towns: rectangular buildings on a per-site street grid, every one with doors
 *
 * Terrain places **tiles only**. Trees, ore, containers and structures are entities the
 * simulation places later from the biome ids written here, so this file never imports
 * `@survive/game-data`.
 */

import {
  Biome,
  CHUNK_TILES,
  CHUNK_TILE_COUNT,
  Tile,
  WORLD_TILES,
  hashNoise,
  mixSeeds,
} from '@survive/protocol';
import type { ChunkTerrain, WorldGenConfig } from '@survive/protocol';
import { fbm2D, ridged2D, valueNoise2D, warpedFbm2D } from './noise';
import type { FbmParams } from './noise';
import type { TerrainGenerator } from './types';

/**
 * Generator version, stored in every {@link ChunkTerrain}.
 *
 * Bump it whenever a change here would move a tile: saves record the version their
 * dynamic layer was built against, so a loader can tell "this override sits on terrain
 * I no longer generate" instead of silently corrupting a world.
 */
export const TERRAIN_VERSION = 1;

// ---------------------------------------------------------------------------
// Field seeds
// ---------------------------------------------------------------------------

/**
 * Per-field seed salts.
 *
 * Each field gets its own derived seed so that the fields are independent: sharing one
 * seed would correlate elevation with moisture and produce the tell-tale look of every
 * mountain being a desert.
 */
const Salt = {
  Elevation: 0x1a2b,
  Moisture: 0x3c4d,
  SnowLine: 0x4d5e,
  River: 0x5e6f,
  Forest: 0x6f70,
  Ground: 0x7081,
  ArterialX: 0x8192,
  ArterialY: 0x92a3,
  Town: 0xa3b4,
  Building: 0xb4c5,
  Spur: 0xc5d6,
} as const;

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
//
// The thresholds below were picked against the measured distribution of the noise
// fields rather than guessed: at these scales the elevation field is very close to a
// bell centred on 0.50 with a standard deviation of 0.16, so (for example) SEA_LEVEL
// 0.34 puts roughly 15% of the world under water and ROCK_LEVEL 0.70 leaves about 8%
// of it bare rock. Changing a *scale* invalidates the matching threshold.

/** Lattice cells per tile for the elevation field: continents about 320 tiles across. */
const ELEVATION_SCALE = 1 / 320;
const ELEVATION_FBM: FbmParams = { octaves: 4, frequency: 1, lacunarity: 2.03, gain: 0.5 };
const ELEVATION_WARP = 0.45;
const ELEVATION_WARP_FREQUENCY = 0.7;

/** Elevation at and below which standing water collects. */
export const SEA_LEVEL = 0.34;
/** How far below {@link SEA_LEVEL} water stops being wadeable. */
const DEEP_BAND = 0.01;
/** How far above the waterline the sand shore reaches. */
const SHORE_BAND = 0.008;

/** Elevation above which the ground is bare rock. */
const ROCK_LEVEL = 0.7;
/** Snow line at the northern edge of the world, and how much it rises going south. */
const SNOW_LINE_BASE = 0.72;
const SNOW_LINE_LATITUDE_SPAN = 0.09;
const SNOW_LINE_WOBBLE = 0.03;
const SNOW_LINE_SCALE = 1 / 700;
const SNOW_LINE_FBM: FbmParams = { octaves: 2, frequency: 1, lacunarity: 2.11, gain: 0.5 };

/**
 * Elevation change per tile above which a slope becomes a {@link Tile.Cliff}.
 *
 * The 99th percentile of the measured per-tile gradient is 0.0052, so this picks out
 * roughly the steepest one percent of the world - cliff *bands* along the contours of
 * hills, not a scattering of solid tiles across open ground.
 */
const CLIFF_SLOPE = 0.0055;
/** Below the rock line a slope only cliffs out where the ground is dry. */
const CLIFF_DRY_MOISTURE = 0.55;

const MOISTURE_SCALE = 1 / 260;
const MOISTURE_FBM: FbmParams = { octaves: 3, frequency: 1, lacunarity: 2.05, gain: 0.5 };
const MOISTURE_WARP = 0.5;
const MOISTURE_WARP_FREQUENCY = 0.8;
/** How much of the moisture field comes from lying low rather than from noise. */
const MOISTURE_LOWLAND_WEIGHT = 0.32;
/** Elevation range above the waterline over which the lowland bonus decays. */
const MOISTURE_LOWLAND_RANGE = 0.3;

/** Wet *and* low ground turns to swamp. */
const SWAMP_MOISTURE = 0.66;
const SWAMP_ELEVATION_BAND = 0.09;

/** Forest patches are deliberately low frequency: woods have edges, trees are not noise. */
const FOREST_SCALE = 1 / 90;
const FOREST_FBM: FbmParams = { octaves: 3, frequency: 1, lacunarity: 2.05, gain: 0.5 };
const FOREST_MOISTURE_WEIGHT = 0.35;
const FOREST_DENSITY = 0.5;
const DEEP_FOREST_DENSITY = 0.6;

/**
 * River field.
 *
 * The crest lines of a ridged multifractal are long, thin, branching curves, which is
 * exactly the shape of a river network - so rivers are "the top slice of a ridged
 * field" rather than "the low slice of the height field", which would only ever give
 * blobs. The threshold *rises with elevation* ({@link RIVER_CLIMB}), so channels fade
 * out as the ground climbs and survive in the valleys: water runs downhill without
 * anything having to simulate drainage.
 *
 * {@link RIVER_DEPTH} is deliberately smaller than {@link DEEP_BAND}: rivers stay
 * wadeable, so an arterial can bridge one without leaving a hole in the road, and only
 * lakes and seas get deep water.
 */
const RIVER_SCALE = 1 / 72;
const RIVER_FBM: FbmParams = { octaves: 4, frequency: 1, lacunarity: 2.07, gain: 0.55 };
const RIVER_WARP = 0.4;
const RIVER_WARP_FREQUENCY = 0.6;
const RIVER_THRESHOLD = 0.79;
const RIVER_CLIMB = 0.12;
const RIVER_DEPTH = 0.012;

/** Chunks between arterial roads along each axis. */
export const ARTERIAL_PERIOD_CHUNKS = 6;
/** Tiles between arterial roads along each axis. */
export const ARTERIAL_PERIOD_TILES = ARTERIAL_PERIOD_CHUNKS * CHUNK_TILES;
/**
 * Largest per-line offset from the ideal lattice position, in tiles.
 *
 * Must stay well under half the period: the offset has to be small enough that the road
 * with index `i` is still the nearest road to `i * ARTERIAL_PERIOD_TILES`, or the whole
 * "which arterial is near me" search stops being a three-index window.
 */
const ARTERIAL_JITTER_TILES = 40;
/** Asphalt spans `2 * half + 1` tiles, with sidewalk out to the next ring. */
const ARTERIAL_HALF_WIDTH = 2;
const SIDEWALK_HALF_WIDTH = 3;
/** Dirt spurs are three tiles across. */
const SPUR_HALF_WIDTH = 1;

/** Tiles from a town's centre to the edge of its built-up area. */
export const TOWN_RADIUS = 38;
/** Ring of worked fields wrapped around the built-up area. */
export const TOWN_FARM_RING = 12;
/** Street grid pitch inside a town, in tiles. */
const TOWN_BLOCK = 20;
/**
 * Street corridor width. Deliberately equal to the arterial corridor
 * (`2 * SIDEWALK_HALF_WIDTH + 1`) so the arterial *is* one of the town's streets
 * instead of ploughing a second road through the middle of a block.
 */
const TOWN_STREET_WIDTH = 2 * SIDEWALK_HALF_WIDTH + 1;
const TOWN_STREET_OFFSET = SIDEWALK_HALF_WIDTH;
/** Buildable span between two streets. */
const TOWN_BLOCK_INTERIOR = TOWN_BLOCK - TOWN_STREET_WIDTH;
/** Yard kept clear between a building and its block edge, so nothing is ever sealed in. */
const BUILDING_MARGIN = 2;
const BUILDING_MIN_SIZE = 5;
const BUILDING_MAX_SIZE = TOWN_BLOCK_INTERIOR - 2 * BUILDING_MARGIN;
/** Fraction of lots left empty, so a town does not look machine-stamped. */
const TOWN_VACANT_CHANCE = 0.18;
/** A town needs dry ground: sites at or under the waterline are rejected outright. */
const TOWN_DRY_MARGIN = 0.03;
/** Rows of crop between the dirt tracks that cross the fields. */
const FARM_TRACK_PITCH = 9;
/** Moisture above which a field is worked wet. */
const FARM_WET_MOISTURE = 0.5;

/**
 * How many arterial indices either side of a query box can still reach into it.
 *
 * A town's dirt spurs run all the way to the *next* arterial, up to one full period
 * plus two jitters away, so the site search has to look two indices out.
 */
const SITE_INDEX_MARGIN = 2;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Modulo that stays non-negative for negative inputs, unlike `%`. */
function floorMod(value: number, modulus: number): number {
  const rest = value % modulus;
  return rest < 0 ? rest + modulus : rest;
}

/**
 * Tile and biome id packed into one integer.
 *
 * The classifier answers both questions at once and is called for every tile of every
 * chunk; packing lets it return a plain number instead of allocating a pair, and lets
 * the padded scratch buffers stay typed arrays. Tile ids are under 256 and biome ids
 * under 16, so one 16-bit word holds both.
 */
function pack(tile: number, biome: number): number {
  return (biome << 8) | tile;
}

function unpackTile(packed: number): number {
  return packed & 0xff;
}

function unpackBiome(packed: number): number {
  return packed >>> 8;
}

/** Sentinel for "this layer does not claim the tile"; no real tile or packed pair is negative. */
const NOTHING = -1;

/** A stable roll in `[0, 1)` from a derived seed and a slot index. */
function roll(seed: number, slot: number): number {
  return hashNoise(seed, slot, 0x9e37);
}

// ---------------------------------------------------------------------------
// Layer 1: elevation, moisture, latitude
// ---------------------------------------------------------------------------

/**
 * Height field in `[0, 1]`.
 *
 * Domain-warped so coastlines get inlets and peninsulas: without the warp, thresholding
 * plain value noise gives visibly axis-aligned lakes.
 */
export function elevationAt(seed: number, tileX: number, tileY: number): number {
  return warpedFbm2D(
    mixSeeds(seed, Salt.Elevation),
    tileX * ELEVATION_SCALE,
    tileY * ELEVATION_SCALE,
    ELEVATION_FBM,
    ELEVATION_WARP,
    ELEVATION_WARP_FREQUENCY,
  );
}

/**
 * Moisture in `[0, 1]`, blending a noise field with how low the ground lies.
 *
 * The lowland term is what puts swamps in the hollows beside lakes and keeps the tops
 * of hills dry, instead of scattering wet biomes at random across the height range.
 */
function moisture(seed: number, tileX: number, tileY: number, elevation: number): number {
  const noise = warpedFbm2D(
    mixSeeds(seed, Salt.Moisture),
    tileX * MOISTURE_SCALE,
    tileY * MOISTURE_SCALE,
    MOISTURE_FBM,
    MOISTURE_WARP,
    MOISTURE_WARP_FREQUENCY,
  );
  const lowland = 1 - clamp01((elevation - SEA_LEVEL) / MOISTURE_LOWLAND_RANGE);
  return clamp01(noise * (1 - MOISTURE_LOWLAND_WEIGHT) + lowland * MOISTURE_LOWLAND_WEIGHT);
}

export function moistureAt(seed: number, tileX: number, tileY: number): number {
  return moisture(seed, tileX, tileY, elevationAt(seed, tileX, tileY));
}

/** 0 at the northern edge of the world, 1 at the southern edge. */
function latitude(tileY: number): number {
  return clamp01(tileY / WORLD_TILES);
}

/**
 * Elevation above which snow lies, at this tile.
 *
 * This is the whole of the "latitude-ish variation": the north is colder, so its snow
 * line sits lower and its peaks are white while southern peaks of the same height are
 * bare rock. A slow wobble keeps the transition from reading as a straight line of
 * latitude drawn across the map.
 */
export function snowLineAt(seed: number, tileX: number, tileY: number): number {
  const wobble = fbm2D(
    mixSeeds(seed, Salt.SnowLine),
    tileX * SNOW_LINE_SCALE,
    tileY * SNOW_LINE_SCALE,
    SNOW_LINE_FBM,
  );
  return (
    SNOW_LINE_BASE +
    SNOW_LINE_LATITUDE_SPAN * latitude(tileY) +
    (wobble - 0.5) * 2 * SNOW_LINE_WOBBLE
  );
}

/**
 * Forest density in `[0, 1]`.
 *
 * Only low-frequency terms go in here. A per-tile roll would give salt-and-pepper trees;
 * a patch field gives woods with an edge, a dense core and clearings.
 */
function forestDensity(seed: number, tileX: number, tileY: number, damp: number): number {
  const patches = fbm2D(
    mixSeeds(seed, Salt.Forest),
    tileX * FOREST_SCALE,
    tileY * FOREST_SCALE,
    FOREST_FBM,
  );
  return clamp01(patches * (1 - FOREST_MOISTURE_WEIGHT) + damp * FOREST_MOISTURE_WEIGHT);
}

export function forestDensityAt(seed: number, tileX: number, tileY: number): number {
  const elevation = elevationAt(seed, tileX, tileY);
  return forestDensity(seed, tileX, tileY, moisture(seed, tileX, tileY, elevation));
}

// ---------------------------------------------------------------------------
// Layer 2: water
// ---------------------------------------------------------------------------

/**
 * Signed river depth: positive inside a channel, negative (and growing more negative)
 * outside it. Kept signed so the shore band below produces banks along a river the same
 * way it produces beaches along a lake.
 */
function riverDepth(seed: number, tileX: number, tileY: number, elevation: number): number {
  const fieldSeed = mixSeeds(seed, Salt.River);
  const x = tileX * RIVER_SCALE;
  const y = tileY * RIVER_SCALE;
  // Warp inline rather than through domainWarp2D: this runs for every tile of every
  // padded chunk row and the intermediate vector is pure garbage.
  const wx =
    valueNoise2D(mixSeeds(fieldSeed, 0x517c), x * RIVER_WARP_FREQUENCY, y * RIVER_WARP_FREQUENCY) *
      2 -
    1;
  const wy =
    valueNoise2D(mixSeeds(fieldSeed, 0x9e37), x * RIVER_WARP_FREQUENCY, y * RIVER_WARP_FREQUENCY) *
      2 -
    1;
  const ridge = ridged2D(fieldSeed, x + wx * RIVER_WARP, y + wy * RIVER_WARP, RIVER_FBM);
  const highland = clamp01((elevation - SEA_LEVEL) / (1 - SEA_LEVEL));
  const threshold = RIVER_THRESHOLD + RIVER_CLIMB * highland;
  return ((ridge - threshold) / (1 - threshold)) * RIVER_DEPTH;
}

/** 0 outside a river, rising to 1 at the centre of the strongest channels. */
export function riverStrengthAt(seed: number, tileX: number, tileY: number): number {
  const elevation = elevationAt(seed, tileX, tileY);
  const depth = riverDepth(seed, tileX, tileY, elevation);
  return depth > 0 ? clamp01(depth / RIVER_DEPTH) : 0;
}

/**
 * Depth of standing water at a tile: positive under water, negative on land, in the same
 * units as elevation. Lakes and rivers are combined with `max`, so a river running into
 * a lake simply becomes the lake.
 */
function waterDepth(seed: number, tileX: number, tileY: number, elevation: number): number {
  const lake = SEA_LEVEL - elevation;
  const river = riverDepth(seed, tileX, tileY, elevation);
  return lake > river ? lake : river;
}

export function waterDepthAt(seed: number, tileX: number, tileY: number): number {
  return waterDepth(seed, tileX, tileY, elevationAt(seed, tileX, tileY));
}

/**
 * How wet a tile is. Ordered, so `>=` comparisons read naturally and the shore rules
 * below can be written as min/max tests over a neighbourhood.
 */
export const Wetness = {
  Land: 0,
  /** Dry, but close enough to water to be sand. */
  Shore: 1,
  Shallow: 2,
  Deep: 3,
} as const;

function wetnessFromDepth(depth: number): number {
  if (depth > DEEP_BAND) return Wetness.Deep;
  if (depth > 0) return Wetness.Shallow;
  if (depth > -SHORE_BAND) return Wetness.Shore;
  return Wetness.Land;
}

/** Wetness straight from the fields, before the neighbourhood rules. */
export function baseWetnessAt(seed: number, tileX: number, tileY: number): number {
  return wetnessFromDepth(waterDepthAt(seed, tileX, tileY));
}

/**
 * Force the shallow ring and the sand shore, given the wetness of the eight neighbours.
 *
 * The bands are wide enough that the level sets of a smooth field nest naturally, but
 * "naturally" is not "always": wherever the height field is steep, a band can pinch to
 * less than a tile and deep water would end up lapping straight against grass. These
 * two rules make the invariant unconditional -
 *
 * - deep water never touches anything that is not water, and
 * - land that touches water is sand
 *
 * - and because they read only the *base* classification they can be evaluated from a
 * padded border and stay identical whichever chunk asks.
 */
function applyShoreRules(own: number, minNeighbour: number, maxNeighbour: number): number {
  if (own === Wetness.Deep && minNeighbour <= Wetness.Shore) return Wetness.Shallow;
  if (own === Wetness.Land && maxNeighbour >= Wetness.Shallow) return Wetness.Shore;
  return own;
}

/**
 * Final wetness at a single tile, resampling the eight neighbours from the fields.
 *
 * Costs nine field evaluations, which is the price of a point query that agrees exactly
 * with {@link TerrainGenerator.generate} - the chunk path gets the same numbers from its
 * padded scratch buffer instead.
 */
export function wetnessAt(seed: number, tileX: number, tileY: number): number {
  const own = baseWetnessAt(seed, tileX, tileY);
  if (own === Wetness.Shore || own === Wetness.Shallow) return own;
  let min: number = Wetness.Deep;
  let max: number = Wetness.Land;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const neighbour = baseWetnessAt(seed, tileX + dx, tileY + dy);
      if (neighbour < min) min = neighbour;
      if (neighbour > max) max = neighbour;
    }
  }
  return applyShoreRules(own, min, max);
}

// ---------------------------------------------------------------------------
// Layer 4: roads
// ---------------------------------------------------------------------------

/** Which way an arterial runs. */
export const RoadAxis = {
  /** Runs north-south; its position is an X tile coordinate. */
  Vertical: 0,
  /** Runs east-west; its position is a Y tile coordinate. */
  Horizontal: 1,
} as const;

/**
 * Centre tile of arterial `index` along one axis.
 *
 * The grid is a lattice with a per-line seeded offset. One offset per *line* rather than
 * one per axis is what stops the network reading as graph paper: junction spacing varies
 * from 112 to 272 tiles while the period stays exactly
 * {@link ARTERIAL_PERIOD_TILES}, which keeps "which arterial is nearest" a three-index
 * search.
 */
export function arterialTileFor(seed: number, axis: number, index: number): number {
  const fieldSeed = mixSeeds(seed, axis === RoadAxis.Vertical ? Salt.ArterialX : Salt.ArterialY);
  const jitter = hashNoise(fieldSeed, index, axis) * 2 - 1;
  return index * ARTERIAL_PERIOD_TILES + Math.round(jitter * ARTERIAL_JITTER_TILES);
}

/** Arterial index whose ideal lattice position is closest to a tile coordinate. */
export function arterialIndexNear(coordinate: number): number {
  return Math.round(coordinate / ARTERIAL_PERIOD_TILES);
}

/** Centre coordinates of every arterial whose corridor touches `[lo, hi]`. */
function arterialsBetween(seed: number, axis: number, lo: number, hi: number): number[] {
  const first = arterialIndexNear(lo) - 1;
  const last = arterialIndexNear(hi) + 1;
  const centres: number[] = [];
  for (let index = first; index <= last; index++) {
    const centre = arterialTileFor(seed, axis, index);
    if (centre + SIDEWALK_HALF_WIDTH >= lo && centre - SIDEWALK_HALF_WIDTH <= hi) {
      centres.push(centre);
    }
  }
  return centres;
}

// ---------------------------------------------------------------------------
// Layer 5: town sites
// ---------------------------------------------------------------------------

/** A town: the arterial intersection it grew around. */
export interface TownSite {
  /** Arterial indices along X and Y. */
  ix: number;
  iy: number;
  /** Centre tile, i.e. the intersection itself. */
  tileX: number;
  tileY: number;
}

/**
 * The town at the intersection of arterials `ix` and `iy`, or `null` for open country.
 *
 * `urbanization` is read straight as the probability that an intersection is settled, so
 * 0 gives a world with roads and no towns and 1 settles every junction. Sites in the
 * water are rejected: that costs one height sample, which keeps
 * {@link TerrainGenerator.isUrban} cheap.
 */
export function townSiteFor(
  seed: number,
  urbanization: number,
  ix: number,
  iy: number,
): TownSite | null {
  const chance = clamp01(urbanization);
  if (chance <= 0) return null;
  if (hashNoise(mixSeeds(seed, Salt.Town), ix, iy) >= chance) return null;
  const tileX = arterialTileFor(seed, RoadAxis.Vertical, ix);
  const tileY = arterialTileFor(seed, RoadAxis.Horizontal, iy);
  if (elevationAt(seed, tileX, tileY) < SEA_LEVEL + TOWN_DRY_MARGIN) return null;
  return { ix, iy, tileX, tileY };
}

/** The town whose built-up area or fields cover a tile, or `null`. */
export function townSiteAt(
  seed: number,
  urbanization: number,
  tileX: number,
  tileY: number,
): TownSite | null {
  const reach = TOWN_RADIUS + TOWN_FARM_RING;
  const ix = arterialIndexNear(tileX);
  const iy = arterialIndexNear(tileY);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const site = townSiteFor(seed, urbanization, ix + dx, iy + dy);
      if (site === null) continue;
      if (Math.abs(tileX - site.tileX) <= reach && Math.abs(tileY - site.tileY) <= reach) {
        return site;
      }
    }
  }
  return null;
}

/**
 * One straight dirt lane, as an inclusive tile rectangle.
 *
 * Spurs are precomputed per query area rather than tested per tile: a rectangle test is
 * a handful of integer comparisons, where re-deriving the lane geometry would mean
 * re-rolling every nearby town site for all 1024 tiles of a chunk.
 */
interface SpurRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The two dirt lanes leaving a town.
 *
 * Each lane leaves the built-up area along one of the town's own street lines - offset
 * by exactly one block from the centre - and runs out across the fields to the next
 * arterial over. Starting on a street line is what makes a spur *connected*: it is the
 * continuation of a town street, not a road that happens to end near one. Lanes stop at
 * the district edge so they never plough through a block.
 */
function spursForSite(seed: number, site: TownSite, out: SpurRect[]): void {
  const fieldSeed = mixSeeds(seed, Salt.Spur);
  const towardsEast = hashNoise(fieldSeed, site.ix, site.iy, 0) < 0.5 ? 1 : -1;
  const towardsSouth = hashNoise(fieldSeed, site.ix, site.iy, 1) < 0.5 ? 1 : -1;
  const laneNorthSouth = hashNoise(fieldSeed, site.ix, site.iy, 2) < 0.5 ? 1 : -1;
  const laneEastWest = hashNoise(fieldSeed, site.ix, site.iy, 3) < 0.5 ? 1 : -1;

  const laneY = site.tileY + laneNorthSouth * TOWN_BLOCK;
  const startX = site.tileX + towardsEast * (TOWN_RADIUS + 1);
  const endX = arterialTileFor(seed, RoadAxis.Vertical, site.ix + towardsEast);
  out.push({
    minX: Math.min(startX, endX),
    maxX: Math.max(startX, endX),
    minY: laneY - SPUR_HALF_WIDTH,
    maxY: laneY + SPUR_HALF_WIDTH,
  });

  const laneX = site.tileX + laneEastWest * TOWN_BLOCK;
  const startY = site.tileY + towardsSouth * (TOWN_RADIUS + 1);
  const endY = arterialTileFor(seed, RoadAxis.Horizontal, site.iy + towardsSouth);
  out.push({
    minX: laneX - SPUR_HALF_WIDTH,
    maxX: laneX + SPUR_HALF_WIDTH,
    minY: Math.min(startY, endY),
    maxY: Math.max(startY, endY),
  });
}

// ---------------------------------------------------------------------------
// Layer 5: buildings
// ---------------------------------------------------------------------------

/**
 * One building, in the coordinates of its block's interior (0 .. TOWN_BLOCK_INTERIOR-1).
 *
 * Bounds are inclusive and name the *wall* ring; everything strictly inside is floor.
 */
interface Building {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  wall: number;
  floor: number;
  /** 0 = doors in the west and east walls, 1 = north and south. */
  doorAxis: number;
  /** Position of each door along its wall, in block-interior coordinates. */
  doorA: number;
  doorB: number;
  windowPhase: number;
}

/**
 * The building on one lot, or `null` for a vacant lot.
 *
 * Every building is confined to its own block and inset {@link BUILDING_MARGIN} tiles
 * from the block edge, so two buildings can never touch: the yard around each one is
 * continuous with the street grid, which is continuous with the arterial. That is the
 * structural half of the "no sealed pockets" guarantee; the door gaps below are the
 * other half.
 */
function buildingFor(
  seed: number,
  site: TownSite,
  blockU: number,
  blockV: number,
): Building | null {
  const lotSeed = mixSeeds(
    mixSeeds(seed, Salt.Building),
    mixSeeds(mixSeeds(site.ix >>> 0, site.iy >>> 0), mixSeeds(blockU >>> 0, blockV >>> 0)),
  );
  if (roll(lotSeed, 0) < TOWN_VACANT_CHANCE) return null;

  const sizeSpan = BUILDING_MAX_SIZE - BUILDING_MIN_SIZE + 1;
  const width = BUILDING_MIN_SIZE + Math.floor(roll(lotSeed, 1) * sizeSpan);
  const height = BUILDING_MIN_SIZE + Math.floor(roll(lotSeed, 2) * sizeSpan);
  const slackU = TOWN_BLOCK_INTERIOR - 2 * BUILDING_MARGIN - width;
  const slackV = TOWN_BLOCK_INTERIOR - 2 * BUILDING_MARGIN - height;
  const u0 = BUILDING_MARGIN + Math.floor(roll(lotSeed, 3) * (slackU + 1));
  const v0 = BUILDING_MARGIN + Math.floor(roll(lotSeed, 4) * (slackV + 1));
  const u1 = u0 + width - 1;
  const v1 = v0 + height - 1;

  // A lot that hangs over the edge of the built-up area is left vacant rather than
  // clipped: half a house with an open side is worse than a field.
  const originU = blockU * TOWN_BLOCK + TOWN_STREET_WIDTH - TOWN_STREET_OFFSET;
  const originV = blockV * TOWN_BLOCK + TOWN_STREET_WIDTH - TOWN_STREET_OFFSET;
  if (originU + u0 < -TOWN_RADIUS || originU + u1 > TOWN_RADIUS) return null;
  if (originV + v0 < -TOWN_RADIUS || originV + v1 > TOWN_RADIUS) return null;

  const material = roll(lotSeed, 5);
  const wall =
    material < 0.4 ? Tile.WallWood : material < 0.75 ? Tile.WallBrick : Tile.WallConcrete;
  const floor = wall === Tile.WallConcrete ? Tile.FloorConcrete : Tile.FloorWood;

  // Two doors, in opposite walls, each strictly between the corners. Two rather than one
  // so a building stays enterable even where a pond or a cliff has eaten one wall, and
  // never at a corner because a corner gap would leave a diagonal-only opening.
  const doorAxis = roll(lotSeed, 6) < 0.5 ? 0 : 1;
  const doorSpan = doorAxis === 0 ? height - 2 : width - 2;
  const doorBase = doorAxis === 0 ? v0 + 1 : u0 + 1;
  const doorA = doorBase + Math.floor(roll(lotSeed, 7) * doorSpan);
  const doorB = doorBase + Math.floor(roll(lotSeed, 8) * doorSpan);

  return {
    u0,
    u1,
    v0,
    v1,
    wall,
    floor,
    doorAxis,
    doorA,
    doorB,
    windowPhase: Math.floor(roll(lotSeed, 9) * 3),
  };
}

function isDoor(building: Building, bu: number, bv: number): boolean {
  if (building.doorAxis === 0) {
    return (
      (bu === building.u0 && bv === building.doorA) || (bu === building.u1 && bv === building.doorB)
    );
  }
  return (
    (bv === building.v0 && bu === building.doorA) || (bv === building.v1 && bu === building.doorB)
  );
}

/** Tile for one cell of a building's footprint. */
function buildingTile(building: Building, bu: number, bv: number): number {
  const onVertical = bu === building.u0 || bu === building.u1;
  const onHorizontal = bv === building.v0 || bv === building.v1;
  if (!onVertical && !onHorizontal) return building.floor;
  if (isDoor(building, bu, bv)) return building.floor;
  // Corners hold the structure up; a window there would read as a missing wall.
  if (onVertical && onHorizontal) return building.wall;
  const along = onVertical ? bv - building.v0 : bu - building.u0;
  if ((along + building.windowPhase) % 3 === 0) return Tile.WindowStatic;
  return building.wall;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

interface TerrainParams {
  seed: number;
  urbanization: number;
}

/**
 * Road and town geometry overlapping one tile rectangle.
 *
 * Built once per `generate` call (and once per point query) so the per-tile work is a
 * few integer comparisons instead of re-rolling every arterial and town site 1024 times.
 * It is derived purely from the rectangle, so a chunk and a point inside it always agree.
 */
interface AreaContext {
  /** X centres of arterials running north-south. */
  arterialX: number[];
  /** Y centres of arterials running east-west. */
  arterialY: number[];
  spurs: SpurRect[];
  towns: TownSite[];
}

function areaContextFor(
  params: TerrainParams,
  minTileX: number,
  minTileY: number,
  maxTileX: number,
  maxTileY: number,
): AreaContext {
  const { seed } = params;
  const context: AreaContext = {
    arterialX: arterialsBetween(seed, RoadAxis.Vertical, minTileX, maxTileX),
    arterialY: arterialsBetween(seed, RoadAxis.Horizontal, minTileY, maxTileY),
    spurs: [],
    towns: [],
  };
  if (params.urbanization <= 0) return context;

  const reach = TOWN_RADIUS + TOWN_FARM_RING;
  const firstX = arterialIndexNear(minTileX) - SITE_INDEX_MARGIN;
  const lastX = arterialIndexNear(maxTileX) + SITE_INDEX_MARGIN;
  const firstY = arterialIndexNear(minTileY) - SITE_INDEX_MARGIN;
  const lastY = arterialIndexNear(maxTileY) + SITE_INDEX_MARGIN;
  const candidateSpurs: SpurRect[] = [];
  for (let iy = firstY; iy <= lastY; iy++) {
    for (let ix = firstX; ix <= lastX; ix++) {
      const site = townSiteFor(seed, params.urbanization, ix, iy);
      if (site === null) continue;
      if (
        site.tileX + reach >= minTileX &&
        site.tileX - reach <= maxTileX &&
        site.tileY + reach >= minTileY &&
        site.tileY - reach <= maxTileY
      ) {
        context.towns.push(site);
      }
      candidateSpurs.length = 0;
      spursForSite(seed, site, candidateSpurs);
      for (const spur of candidateSpurs) {
        if (
          spur.maxX >= minTileX &&
          spur.minX <= maxTileX &&
          spur.maxY >= minTileY &&
          spur.minY <= maxTileY
        ) {
          context.spurs.push(spur);
        }
      }
    }
  }
  return context;
}

/** Nearest distance from a coordinate to any of the precomputed arterial centres. */
function distanceToArterial(centres: readonly number[], coordinate: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const centre of centres) {
    const distance = coordinate < centre ? centre - coordinate : coordinate - centre;
    if (distance < best) best = distance;
  }
  return best;
}

/** Arterial surface at a tile, or {@link NOTHING}. */
function arterialTile(context: AreaContext, tileX: number, tileY: number): number {
  const distance = Math.min(
    distanceToArterial(context.arterialX, tileX),
    distanceToArterial(context.arterialY, tileY),
  );
  if (distance <= ARTERIAL_HALF_WIDTH) return Tile.RoadAsphalt;
  if (distance <= SIDEWALK_HALF_WIDTH) return Tile.Sidewalk;
  return NOTHING;
}

function spurCovers(spurs: readonly SpurRect[], tileX: number, tileY: number): boolean {
  for (const spur of spurs) {
    if (tileX >= spur.minX && tileX <= spur.maxX && tileY >= spur.minY && tileY <= spur.maxY) {
      return true;
    }
  }
  return false;
}

/** The town whose district or fields cover a tile, from a prepared context. */
function townCovering(towns: readonly TownSite[], tileX: number, tileY: number): TownSite | null {
  const reach = TOWN_RADIUS + TOWN_FARM_RING;
  for (const site of towns) {
    if (Math.abs(tileX - site.tileX) <= reach && Math.abs(tileY - site.tileY) <= reach) {
      return site;
    }
  }
  return null;
}

/** Worked field: rows of crop cut by a dirt track every few rows. */
function farmlandTile(tileY: number, damp: number): number {
  if (floorMod(tileY, FARM_TRACK_PITCH) === 0) return pack(Tile.Dirt, Biome.Farmland);
  return pack(damp >= FARM_WET_MOISTURE ? Tile.FarmlandWet : Tile.FarmlandDry, Biome.Farmland);
}

/** Trodden ground around the buildings. */
function yardTile(seed: number, tileX: number, tileY: number): number {
  const texture = hashNoise(mixSeeds(seed, Salt.Ground), tileX, tileY, 0x7a);
  const tile =
    texture < 0.42
      ? Tile.Dirt
      : texture < 0.68
        ? Tile.Gravel
        : texture < 0.9
          ? Tile.Grass
          : Tile.GrassTall;
  return pack(tile, Biome.Town);
}

/**
 * Everything inside a town: street grid, lots, buildings and the fields around the edge.
 *
 * The street grid is anchored on the arterial intersection and shares its width, so the
 * arterial is simply the widest street in town and no building can ever sit on it.
 */
function townTile(
  params: TerrainParams,
  site: TownSite,
  tileX: number,
  tileY: number,
  elevation: number,
  damp: number,
): number {
  const du = tileX - site.tileX;
  const dv = tileY - site.tileY;
  if (Math.max(Math.abs(du), Math.abs(dv)) > TOWN_RADIUS) {
    // Nobody ploughs bare rock: the fields leave the outcrops to the wilderness layer.
    return elevation >= ROCK_LEVEL ? NOTHING : farmlandTile(tileY, damp);
  }

  const su = floorMod(du + TOWN_STREET_OFFSET, TOWN_BLOCK);
  const sv = floorMod(dv + TOWN_STREET_OFFSET, TOWN_BLOCK);
  if (su < TOWN_STREET_WIDTH || sv < TOWN_STREET_WIDTH) return pack(Tile.RoadDirt, Biome.Road);

  const blockU = Math.floor((du + TOWN_STREET_OFFSET) / TOWN_BLOCK);
  const blockV = Math.floor((dv + TOWN_STREET_OFFSET) / TOWN_BLOCK);
  const building = buildingFor(params.seed, site, blockU, blockV);
  if (building === null) return yardTile(params.seed, tileX, tileY);

  const bu = su - TOWN_STREET_WIDTH;
  const bv = sv - TOWN_STREET_WIDTH;
  if (bu < building.u0 || bu > building.u1 || bv < building.v0 || bv > building.v1) {
    return yardTile(params.seed, tileX, tileY);
  }
  return pack(buildingTile(building, bu, bv), Biome.Town);
}

/** Wilderness ground, once water, roads and towns have all declined the tile. */
function wildernessTile(
  seed: number,
  tileX: number,
  tileY: number,
  elevation: number,
  slope: number,
  damp: number,
): number {
  const texture = hashNoise(mixSeeds(seed, Salt.Ground), tileX, tileY);

  if (elevation >= snowLineAt(seed, tileX, tileY)) {
    return slope >= CLIFF_SLOPE ? pack(Tile.Cliff, Biome.Rocky) : pack(Tile.Snow, Biome.Rocky);
  }
  if (elevation >= ROCK_LEVEL) {
    if (slope >= CLIFF_SLOPE) return pack(Tile.Cliff, Biome.Rocky);
    const tile = texture < 0.55 ? Tile.StoneGround : texture < 0.85 ? Tile.Gravel : Tile.Dirt;
    return pack(tile, Biome.Rocky);
  }
  // Below the rock line only dry slopes cliff out; a wet slope is a wooded hillside.
  if (slope >= CLIFF_SLOPE && damp < CLIFF_DRY_MOISTURE) return pack(Tile.Cliff, Biome.Rocky);

  if (damp >= SWAMP_MOISTURE && elevation < SEA_LEVEL + SWAMP_ELEVATION_BAND) {
    const tile = texture < 0.5 ? Tile.Mud : texture < 0.8 ? Tile.GrassTall : Tile.Grass;
    return pack(tile, Biome.Swamp);
  }

  const forest = forestDensity(seed, tileX, tileY, damp);
  if (forest >= DEEP_FOREST_DENSITY) {
    const tile = texture < 0.55 ? Tile.GrassTall : texture < 0.85 ? Tile.Grass : Tile.Dirt;
    return pack(tile, Biome.DeepForest);
  }
  if (forest >= FOREST_DENSITY) {
    const tile = texture < 0.45 ? Tile.GrassTall : texture < 0.9 ? Tile.Grass : Tile.Dirt;
    return pack(tile, Biome.Forest);
  }
  const tile = texture < 0.72 ? Tile.Grass : texture < 0.9 ? Tile.GrassTall : Tile.Dirt;
  return pack(tile, Biome.Grassland);
}

/**
 * The single place a tile is decided, shared by chunk generation and point queries.
 *
 * Precedence, highest first:
 *
 * 1. **arterial** - the road network is the world's skeleton, so it wins against
 *    everything except deep water, which it cannot bridge (it would leave a strip of
 *    asphalt over open sea). Over shallow water it bridges, over a cliff it cuts a pass.
 * 2. **town** - district streets, lots, buildings and the fields around them; water
 *    inside a district stays water, so a pond in a town is still a pond.
 * 3. **dirt spur** - same deep-water rule as the arterial, and suppressed inside a
 *    built-up area so a lane never ploughs through somebody's block.
 * 4. **water, shore, wilderness**.
 *
 * Because roads and towns lose to deep water rather than paving it, every tile marked
 * {@link Biome.Road} or {@link Biome.Town} is walkable ground.
 */
function composeTile(
  params: TerrainParams,
  context: AreaContext,
  tileX: number,
  tileY: number,
  wetness: number,
  elevation: number,
  slope: number,
): number {
  if (wetness !== Wetness.Deep) {
    const road = arterialTile(context, tileX, tileY);
    if (road !== NOTHING) return pack(road, Biome.Road);
  }

  const damp = moisture(params.seed, tileX, tileY, elevation);
  const site = townCovering(context.towns, tileX, tileY);
  // A lane crosses the fields - that is how it reaches the town at all - but stops at
  // the edge of the built-up area, where the town's own street grid takes over.
  const builtUp =
    site !== null &&
    Math.max(Math.abs(tileX - site.tileX), Math.abs(tileY - site.tileY)) <= TOWN_RADIUS;
  if (!builtUp && wetness !== Wetness.Deep && spurCovers(context.spurs, tileX, tileY)) {
    return pack(Tile.RoadDirt, Biome.Road);
  }
  if (site !== null && wetness < Wetness.Shallow) {
    const town = townTile(params, site, tileX, tileY, elevation, damp);
    if (town !== NOTHING) return town;
  }

  if (wetness === Wetness.Deep) return pack(Tile.WaterDeep, Biome.Lake);
  if (wetness === Wetness.Shallow) return pack(Tile.WaterShallow, Biome.Lake);
  if (wetness === Wetness.Shore) return pack(Tile.Sand, Biome.Beach);
  return wildernessTile(params.seed, tileX, tileY, elevation, slope, damp);
}

/** Padding needed by the shore rules and the slope test, in tiles. */
const PAD = 1;
const PADDED_SPAN = CHUNK_TILES + 2 * PAD;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build a terrain generator for one world.
 *
 * The returned object holds no mutable state whatsoever - only the seed and the
 * urbanization dial - so callers may keep one per world forever, share it between
 * systems, and rely on identical answers for identical arguments.
 */
export function createTerrainGenerator(config: WorldGenConfig): TerrainGenerator {
  const params: TerrainParams = { seed: config.seed, urbanization: clamp01(config.urbanization) };
  const { seed } = params;

  function generate(cx: number, cy: number): ChunkTerrain {
    const originX = cx * CHUNK_TILES;
    const originY = cy * CHUNK_TILES;

    // Height and base wetness over the chunk plus a one-tile border. The border is
    // sampled from the fields, never borrowed from a neighbouring chunk, which is what
    // makes the neighbourhood rules below order-independent.
    const elevation = new Float64Array(PADDED_SPAN * PADDED_SPAN);
    const baseWetness = new Uint8Array(PADDED_SPAN * PADDED_SPAN);
    for (let py = 0; py < PADDED_SPAN; py++) {
      const tileY = originY + py - PAD;
      const row = py * PADDED_SPAN;
      for (let px = 0; px < PADDED_SPAN; px++) {
        const tileX = originX + px - PAD;
        const height = elevationAt(seed, tileX, tileY);
        elevation[row + px] = height;
        baseWetness[row + px] = wetnessFromDepth(waterDepth(seed, tileX, tileY, height));
      }
    }

    const context = areaContextFor(
      params,
      originX,
      originY,
      originX + CHUNK_TILES - 1,
      originY + CHUNK_TILES - 1,
    );

    const tiles = new Array<number>(CHUNK_TILE_COUNT);
    const biomes = new Array<number>(CHUNK_TILE_COUNT);
    for (let localY = 0; localY < CHUNK_TILES; localY++) {
      const tileY = originY + localY;
      const padded = (localY + PAD) * PADDED_SPAN + PAD;
      const out = localY * CHUNK_TILES;
      for (let localX = 0; localX < CHUNK_TILES; localX++) {
        // Every index below is inside the padded buffers by construction, so the reads
        // are asserted rather than defaulted: `noUncheckedIndexedAccess` widens even a
        // typed array read to `number | undefined`, and `?? 0` here would hide a real
        // indexing bug behind a plausible sea-level elevation.
        const index = padded + localX;
        const height = elevation[index]!;

        // Central differences over the padded ring: elevation change per tile.
        const slope =
          Math.max(
            Math.abs(elevation[index + 1]! - elevation[index - 1]!),
            Math.abs(elevation[index + PADDED_SPAN]! - elevation[index - PADDED_SPAN]!),
          ) * 0.5;

        const own = baseWetness[index]!;
        let wetness = own;
        if (own === Wetness.Land || own === Wetness.Deep) {
          let min: number = Wetness.Deep;
          let max: number = Wetness.Land;
          for (let dy = -1; dy <= 1; dy++) {
            const neighbourRow = index + dy * PADDED_SPAN;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const neighbour = baseWetness[neighbourRow + dx]!;
              if (neighbour < min) min = neighbour;
              if (neighbour > max) max = neighbour;
            }
          }
          wetness = applyShoreRules(own, min, max);
        }

        const composed = composeTile(
          params,
          context,
          originX + localX,
          tileY,
          wetness,
          height,
          slope,
        );
        tiles[out + localX] = unpackTile(composed);
        biomes[out + localX] = unpackBiome(composed);
      }
    }

    return { cx, cy, tiles, biomes, version: TERRAIN_VERSION };
  }

  function biomeAt(tileX: number, tileY: number): number {
    const height = elevationAt(seed, tileX, tileY);
    const slope =
      Math.max(
        Math.abs(elevationAt(seed, tileX + 1, tileY) - elevationAt(seed, tileX - 1, tileY)),
        Math.abs(elevationAt(seed, tileX, tileY + 1) - elevationAt(seed, tileX, tileY - 1)),
      ) * 0.5;
    const context = areaContextFor(params, tileX, tileY, tileX, tileY);
    const composed = composeTile(
      params,
      context,
      tileX,
      tileY,
      wetnessAt(seed, tileX, tileY),
      height,
      slope,
    );
    return unpackBiome(composed);
  }

  function isUrban(cx: number, cy: number): boolean {
    if (params.urbanization <= 0) return false;
    const minTileX = cx * CHUNK_TILES;
    const minTileY = cy * CHUNK_TILES;
    const maxTileX = minTileX + CHUNK_TILES - 1;
    const maxTileY = minTileY + CHUNK_TILES - 1;
    const firstX = arterialIndexNear(minTileX) - 1;
    const lastX = arterialIndexNear(maxTileX) + 1;
    const firstY = arterialIndexNear(minTileY) - 1;
    const lastY = arterialIndexNear(maxTileY) + 1;
    for (let iy = firstY; iy <= lastY; iy++) {
      for (let ix = firstX; ix <= lastX; ix++) {
        const site = townSiteFor(seed, params.urbanization, ix, iy);
        if (site === null) continue;
        // The built-up area only: the fields around a town are countryside as far as
        // spawning and loot are concerned.
        if (
          site.tileX + TOWN_RADIUS >= minTileX &&
          site.tileX - TOWN_RADIUS <= maxTileX &&
          site.tileY + TOWN_RADIUS >= minTileY &&
          site.tileY - TOWN_RADIUS <= maxTileY
        ) {
          return true;
        }
      }
    }
    return false;
  }

  return { seed, version: TERRAIN_VERSION, generate, biomeAt, isUrban };
}
