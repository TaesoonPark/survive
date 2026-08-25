import {
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  Tile,
  clamp,
  clamp01,
  type CropSubState,
  type PlotSubState,
  type Season,
  type WeatherState,
} from '@survive/protocol';
import type { CropDef } from '@survive/game-data';

/**
 * The agronomy model, as pure functions.
 *
 * Everything here is a function of plain state and content definitions: no
 * {@link SimContext}, no RNG, no mutation. That is deliberate on three counts.
 *
 * 1. The client needs the same answers the server has - which sprite a crop is on,
 *    what a plot tooltip says, whether watering would help - and it must arrive at
 *    them without asking the server (Architecture Guard rules 1 and 6).
 * 2. The growth model is the part of farming most likely to be retuned, and a pure
 *    function is the only kind you can retune with confidence.
 * 3. Determinism: no clock, no `Math.random`, so replaying a tick sequence reproduces
 *    the same crop to the last decimal.
 *
 * Units throughout: moisture, fertility, health and blight are 0..100 point scales;
 * rates are *points per simulation tick* so they compose with a tick delta by simple
 * multiplication. Durations in {@link CropDef} are ticks (spec section 8).
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Soil moisture at which the ground reads as watered.
 *
 * Also the threshold that flips the terrain tile between {@link Tile.FarmlandDry} and
 * {@link Tile.FarmlandWet}, so "is it wet" is one number rather than two sources of
 * truth that can disagree.
 *
 * The value is bracketed on both sides by content, not chosen for looks. It must sit
 * *above* `farm_plot`'s starting moisture of 40, or freshly dug soil would render wet
 * before anybody had watered it; and *below* that 40 plus one canful
 * (`MOISTURE_PER_FILL_UNIT`, 30 points), or watering would produce no visible change
 * and the player would have no feedback that the can did anything. A `planter_box`
 * starts at 70 and so reads wet from the moment it is built, which is what its
 * description promises.
 */
export const FARMLAND_WET_MOISTURE = 50;

/** Moisture a plot is comfortable at. Above this, extra water buys nothing. */
export const COMFORTABLE_MOISTURE = 60;

/**
 * Evaporation from bare, sunlit, 20 degree soil, in moisture points per tick.
 *
 * Twelve points a day sounds gentle until you add the plant's own draw: a wheat plot
 * at `waterPerTick` 0.00035 pulls another ten. A `farm_plot` starts at 40 moisture, so
 * an unwatered plot crosses `minMoisture` on the second day - which is exactly the
 * pressure that makes a watering can worth carrying.
 */
export const BASE_EVAPORATION_PER_TICK = 12 / TICKS_PER_GAME_DAY;

/**
 * Moisture retention of a raised bed relative to open ground.
 *
 * A `planter_box` declares `plot.moisture` 70 against the plain plot's 40; that high
 * starting figure is the table's way of saying "this thing holds water", so it is also
 * what selects the slower evaporation curve here rather than a second content field.
 */
export const RAISED_BED_RETENTION = 0.55;

/** A plot whose definition starts at or above this moisture counts as a raised bed. */
export const RAISED_BED_MOISTURE = 60;

/** Health lost per tick by a plot that is bone dry. Kills in a day and a half. */
export const DROUGHT_HEALTH_PER_TICK = 100 / (TICKS_PER_GAME_DAY * 1.5);

/** Health lost per tick at full blight. Kills in two days. */
export const BLIGHT_HEALTH_PER_TICK = 100 / (TICKS_PER_GAME_DAY * 2);

/** How fast blight itself worsens once a plant has it. Full in one day. */
export const BLIGHT_PROGRESS_PER_TICK = 100 / TICKS_PER_GAME_DAY;

/** Health regained per tick in good conditions. Recovery is slower than ruin. */
export const HEALTH_RECOVERY_PER_TICK = 100 / (TICKS_PER_GAME_DAY * 3);

/**
 * Per-tick chance that a blighted plot infects one neighbour, at full blight.
 *
 * Scaled by `blight / 100`, so a plant that has just caught it is barely contagious
 * and a rotting one takes the row down with it. Blight is the reason to keep a spare
 * seed stock and not to plant one crop in one block.
 */
export const BLIGHT_SPREAD_PER_TICK = 1.5e-4;

/** Blight level at which a plot becomes contagious at all. */
export const BLIGHT_CONTAGIOUS_AT = 20;

/** Blight a freshly infected neighbour starts at. */
export const BLIGHT_SEED_LEVEL = 12;

/** Growth speed multiplier while fertilizer is still in the soil. */
export const FERTILIZER_GROWTH_BONUS = 1.35;

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/**
 * Rain reaching the soil, in moisture points per tick.
 *
 * Farming owns this curve rather than the weather system, and that is a decision the two
 * made together: `systems/time/weatherSystem.ts` deliberately models no precipitation and
 * points here. The reason is calibration. The numbers below are meaningless except
 * against the crop table - plot capacity is 100 points, a crop drinks roughly 0.0005 a
 * tick, and the snowmelt gate exists because `CropDef.frostTemperature` made freezing
 * water a gameplay rule. Any curve living next to the transition weights instead would be
 * tuned against nothing, and because both barrels are re-exported from `systems/index.ts`
 * a second copy would be a duplicate export as well.
 *
 * It stays a pure function of replicated state (`weather.type`, `weather.intensity` and
 * `weather.temperature`, nothing else), so the client can predict a plot drying out
 * between snapshots without asking the server.
 *
 * Calibration: a full-intensity downpour delivers 72 points an hour, so it saturates a
 * dry plot in about an hour and a half. Snow only wets the ground once it is above
 * freezing; below that it sits there, which is why a winter crop still needs watering.
 */
export function rainfallRate(weather: WeatherState): number {
  const intensity = clamp01(weather.intensity);
  switch (weather.type) {
    case 'rain':
      return (24 + 48 * intensity) / TICKS_PER_GAME_HOUR;
    case 'storm':
      return (60 + 90 * intensity) / TICKS_PER_GAME_HOUR;
    case 'snow':
      return weather.temperature > 0 ? (4 + 8 * intensity) / TICKS_PER_GAME_HOUR : 0;
    default:
      return 0;
  }
}

/**
 * Evaporation from a plot, in moisture points per tick.
 *
 * Sun and heat drive it up; cloud, rain and fog hold it down. `retention` is the
 * plot's own multiplier ({@link RAISED_BED_RETENTION} for a planter box, 1 for dug
 * ground).
 */
export function evaporationRate(
  weather: WeatherState,
  lightLevel: number,
  retention: number,
): number {
  const sun = 0.35 + 0.65 * clamp01(lightLevel);
  const warmth = clamp(0.35 + Math.max(0, weather.temperature) / 24, 0.25, 2.4);
  const humidity = humidityFactor(weather);
  return BASE_EVAPORATION_PER_TICK * sun * warmth * humidity * Math.max(0, retention);
}

/** How much the current sky suppresses evaporation. 1 = clear and dry. */
function humidityFactor(weather: WeatherState): number {
  switch (weather.type) {
    case 'rain':
    case 'storm':
    case 'fog':
      return 0.35;
    case 'overcast':
      return 0.7;
    case 'snow':
      return 0.4;
    default:
      return 1;
  }
}

/** Evaporation multiplier implied by a plot definition's starting moisture. */
export function plotRetention(definitionMoisture: number): number {
  return definitionMoisture >= RAISED_BED_MOISTURE ? RAISED_BED_RETENTION : 1;
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

/** Everything outside the crop definition that decides how fast it grows. */
export interface GrowthConditions {
  /** Soil moisture, 0..100. */
  moisture: number;
  /** Soil fertility, 0..100 (or higher for a composted planter). */
  fertility: number;
  /** Fertility this plot type is designed to sit at, used to normalise the above. */
  nominalFertility: number;
  /** Air temperature at the plot, degrees Celsius. */
  temperature: number;
  season: Season;
  /** Ambient light, 0..1. */
  lightLevel: number;
  /** True while fertilizer is still in the soil. */
  fertilized: boolean;
  /** `ctx.config.tuning.cropGrowthRate`. */
  growthRateTuning: number;
}

/**
 * Combined growth rate multiplier. `0` means the crop is stalled, not dying.
 *
 * Season is a hard gate: `CropDef.seasons` documents that a crop stalls outside its
 * seasons, and that is a calendar rule, not a gradient.
 *
 * Temperature is deliberately *not* a hard gate. The seasonal temperature curve puts an
 * early-spring morning a few degrees below wheat's comfortable band, so a hard cut-off
 * meant a crop listed as growing in spring made literally zero progress for the first
 * week of a new world - which reads as a broken plant, not as a cold snap. Instead it
 * tapers to zero over {@link TEMPERATURE_TAPER_C} degrees either side of the band, and a
 * genuine frost still kills outright through {@link isFrostKilling}. A tomato in a frost
 * is dead; a tomato at nine degrees is merely sulking.
 */
export function growthMultiplier(def: CropDef, conditions: GrowthConditions): number {
  if (!def.seasons.includes(conditions.season)) return 0;
  const temperature = temperatureGrowthFactor(def, conditions.temperature);
  if (temperature <= 0) return 0;
  if (conditions.moisture < def.minMoisture) return 0;

  const tuning = Number.isFinite(conditions.growthRateTuning)
    ? Math.max(0, conditions.growthRateTuning)
    : 1;

  return (
    tuning *
    temperature *
    moistureGrowthFactor(def, conditions.moisture) *
    fertilityGrowthFactor(conditions.fertility, conditions.nominalFertility) *
    daylightGrowthFactor(conditions.lightLevel) *
    (conditions.fertilized ? FERTILIZER_GROWTH_BONUS : 1)
  );
}

/** True while the plot's air temperature is inside the crop's comfortable band. */
export function withinIdealTemperature(def: CropDef, temperature: number): boolean {
  const [low, high] = def.idealTemperature;
  return temperature >= low && temperature <= high;
}

/** Degrees either side of the ideal band over which growth fades to nothing. */
export const TEMPERATURE_TAPER_C = 8;

/**
 * Temperature's contribution to growth, 0..1.
 *
 * 1 inside the crop's comfortable band, falling linearly to 0 across
 * {@link TEMPERATURE_TAPER_C} degrees outside it, and 0 beyond. A crop in a chilly spring
 * morning creeps; a crop in a heatwave or a hard freeze does not move at all.
 */
export function temperatureGrowthFactor(def: CropDef, temperature: number): number {
  const [low, high] = def.idealTemperature;
  if (temperature >= low && temperature <= high) return 1;
  const distance = temperature < low ? low - temperature : temperature - high;
  return clamp01(1 - distance / TEMPERATURE_TAPER_C);
}

/** True when the temperature has dropped far enough to kill this crop outright. */
export function isFrostKilling(def: CropDef, temperature: number): boolean {
  return temperature <= def.frostTemperature;
}

/**
 * Moisture's contribution to growth, 0.55 at the bare minimum and 1 once the soil is
 * comfortable. Never zero: the stall case is handled by the caller's hard gate, so a
 * crop that is merely thirsty keeps creeping along.
 */
export function moistureGrowthFactor(def: CropDef, moisture: number): number {
  const span = Math.max(1, COMFORTABLE_MOISTURE - def.minMoisture);
  return 0.55 + 0.45 * clamp01((moisture - def.minMoisture) / span);
}

/** Fertility's contribution: 0.85 in exhausted soil, 1.15 in soil at its nominal best. */
export function fertilityGrowthFactor(fertility: number, nominalFertility: number): number {
  const nominal = Math.max(1, nominalFertility);
  return 0.85 + 0.3 * clamp01(fertility / nominal);
}

/** Daylight's contribution: full sun grows twice as fast as the middle of the night. */
export function daylightGrowthFactor(lightLevel: number): number {
  return 0.5 + 0.5 * clamp01(lightLevel);
}

/**
 * Ticks the given stage transition takes at rate 1.
 *
 * `ticksPerStage` holds `stages - 1` *transitions*, so the mature stage has no entry.
 * Returns 0 for a crop that has nowhere left to grow, and never returns a value that
 * could divide to infinity.
 */
export function stageTicks(def: CropDef, stage: number): number {
  if (stage < 0 || stage >= def.ticksPerStage.length) return 0;
  const ticks = def.ticksPerStage[stage];
  return ticks !== undefined && ticks > 0 ? ticks : 1;
}

/** Index of the final, mature stage. */
export function matureStage(def: CropDef): number {
  return Math.max(0, def.stages - 1);
}

/**
 * The stage a regrowing crop falls back to after a picking.
 *
 * One stage short of mature: the plant is still there, it just has to set fruit again.
 */
export function regrowthStage(def: CropDef): number {
  return Math.max(0, def.stages - 2);
}

/** True when the crop has reached its final stage and is not dead. */
export function isCropMature(crop: CropSubState, def: CropDef): boolean {
  return !crop.dead && crop.stage >= matureStage(def);
}

/** True when `farm harvest` would produce something. */
export function isCropHarvestable(crop: CropSubState, def: CropDef): boolean {
  return isCropMature(crop, def) && crop.harvestsLeft > 0;
}

/** Overall progress from seed to harvest, 0..1. Drives progress bars, not rules. */
export function cropGrowthFraction(crop: CropSubState, def: CropDef): number {
  let total = 0;
  for (let stage = 0; stage < def.ticksPerStage.length; stage++) total += stageTicks(def, stage);
  if (total <= 0) return 1;
  let done = 0;
  for (let stage = 0; stage < crop.stage && stage < def.ticksPerStage.length; stage++) {
    done += stageTicks(def, stage);
  }
  done += stageTicks(def, crop.stage) * clamp01(crop.stageProgress);
  return clamp01(done / total);
}

// ---------------------------------------------------------------------------
// Yield
// ---------------------------------------------------------------------------

/**
 * Multiplier applied to the rolled `yieldMin..yieldMax` figure.
 *
 * A neglected plant in exhausted soil picked by a novice returns roughly 40% of the
 * roll; a healthy one in composted soil picked by a master returns about 1.8x. That
 * spread is the whole reward loop of farming, so it is deliberately wide.
 */
export function harvestYieldMultiplier(
  crop: CropSubState,
  plot: PlotSubState,
  nominalFertility: number,
  farmingLevel: number,
): number {
  const health = 0.4 + 0.6 * clamp01(crop.health / 100);
  const fertility = 0.7 + 0.5 * clamp01(plot.fertility / Math.max(1, nominalFertility));
  const skill = 1 + 0.05 * clamp(farmingLevel, 0, 20);
  const disease = 1 - 0.5 * clamp01(crop.blight / 100);
  return health * fertility * skill * disease;
}

/**
 * How much more likely blight is in this plot than the crop's base chance.
 *
 * Fertility is the memory of the plot: every harvest takes `fertilityCost` out of it,
 * so a player who plants the same crop in the same square over and over walks the
 * multiplier up to 4x without any extra bookkeeping. Damp soil raises it further,
 * which is the cost of over-watering.
 */
export function blightRiskMultiplier(plot: PlotSubState, nominalFertility: number): number {
  const depletion = 1 - clamp01(plot.fertility / Math.max(1, nominalFertility));
  return (1 + 3 * depletion) * (1 + 0.5 * clamp01(plot.moisture / 100));
}

// ---------------------------------------------------------------------------
// Presentation helpers the client needs
// ---------------------------------------------------------------------------

/**
 * Sprite key for a crop's current appearance.
 *
 * `CropDef.sprite` is the family (`crop_wheat`); the suffix is the visible stage, or
 * `dead` for a failed plant. Kept here rather than in the renderer so the server, the
 * client and a headless test all agree on what is on screen.
 */
export function cropStageSprite(crop: CropSubState, def: CropDef): string {
  if (crop.dead) return `${def.sprite}_dead`;
  const stage = clamp(Math.floor(crop.stage), 0, matureStage(def));
  return `${def.sprite}_${stage}`;
}

/** Terrain tile a plot's soil should be showing, given its moisture. */
export function plotTileFor(plot: PlotSubState): number {
  return plot.moisture >= FARMLAND_WET_MOISTURE ? Tile.FarmlandWet : Tile.FarmlandDry;
}

/** One-word verdict on a plant's condition, for tooltips and the crop overlay. */
export function cropConditionLabel(crop: CropSubState): string {
  if (crop.dead) return 'dead';
  if (crop.health >= 85) return 'healthy';
  if (crop.health >= 60) return 'wilting';
  if (crop.health >= 30) return 'failing';
  return 'dying';
}

/**
 * Human-readable summary of a plot, for the interaction tooltip.
 *
 * Pass the crop definition when you have it - the plot alone knows the crop's id but
 * not its name or how many stages it has, and a tooltip reading "wheat, stage 3" is
 * strictly worse than "Wheat, stage 3 of 5".
 */
export function describePlot(plot: PlotSubState, def?: CropDef): string {
  const soil = `${Math.round(clamp(plot.moisture, 0, 100))}% moisture, ${Math.round(
    Math.max(0, plot.fertility),
  )}% fertility`;

  if (!plot.tilled) return `Untilled soil. Break it with a hoe first.`;

  const crop = plot.crop;
  if (!crop) return `Tilled soil - ${soil}. Ready for seed.`;

  const name = def?.name ?? crop.defId;
  if (crop.dead) return `Dead ${name.toLowerCase()} - clear the plot to replant. ${soil}.`;

  const parts: string[] = [];
  if (def && isCropHarvestable(crop, def)) {
    parts.push(`${name}, ready to harvest`);
  } else if (def) {
    const percent = Math.round(clamp01(crop.stageProgress) * 100);
    parts.push(`${name}, stage ${crop.stage + 1} of ${def.stages} (${percent}%)`);
  } else {
    parts.push(`${name}, stage ${crop.stage + 1}`);
  }
  parts.push(cropConditionLabel(crop));
  if (crop.blight >= 5) parts.push(`blighted ${Math.round(crop.blight)}%`);
  if (crop.fertilizedTicks > 0) parts.push('fertilized');
  if (def?.regrows && crop.harvestsLeft > 0) parts.push(`${crop.harvestsLeft} pickings left`);
  return `${parts.join(' - ')}. ${soil}.`;
}
