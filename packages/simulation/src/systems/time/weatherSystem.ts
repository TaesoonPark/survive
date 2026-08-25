import {
  DAYS_PER_SEASON,
  TAU,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  TICKS_PER_GAME_MINUTE,
  WEATHER_TYPES,
  clamp,
  clamp01,
  hashNoise,
  lerp,
  smoothstep,
  wrapAngle,
  type CommandOf,
  type PlayerId,
  type PlayerState,
  type Rng,
  type Season,
  type WeatherState,
  type WeatherType,
  type WorldTimeState,
} from '@survive/protocol';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import { livingPlayers } from '../../core/queries';
import { deriveWorldTime, fractionalDayAt, seasonalTilt, sunriseHourForDay } from './timeSystem';

/**
 * Weather, temperature and wind.
 *
 * The model is a seeded Markov chain over {@link WeatherType} with season-weighted
 * edges: each episode picks a successor, an intensity and a duration, and sets
 * `nextChangeTick`. Everything between two transitions - temperature, wind, rainfall,
 * lightning - is derived rather than accumulated, so weather survives a save/load and
 * a replay without drifting.
 *
 * Randomness is split deliberately:
 *
 * - the transition roll forks `ctx.rng`, because it is a rare, genuine state change
 *   and wants the shared, saved stream;
 * - the per-tick rolls (lightning, the day's temperature offset) use
 *   {@link hashNoise} over `seed` and `tick` instead. Drawing from `ctx.rng` on every
 *   single tick would make the master stream's position depend on how long the world
 *   had been running, shifting every other system's rolls.
 *
 * Weather is world metadata, not chunk data, so nothing here marks chunks dirty; the
 * host writes `state.weather` out with the world header on autosave.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** At or below this air temperature, water freezes and frost damage applies. */
export const FREEZING_TEMPERATURE_C = 0;

/** Mean annual temperature at the equinoxes, in Celsius. */
export const TEMPERATURE_MEAN_C = 12;

/** Swing between mid-winter and mid-summer baselines, in Celsius (peak-to-mean). */
export const TEMPERATURE_SEASON_AMPLITUDE_C = 13;

/** Swing between the pre-dawn low and the mid-afternoon high, in Celsius. */
export const TEMPERATURE_DIURNAL_AMPLITUDE_C = 5;

/** Maximum size of the seeded per-day temperature wobble, in Celsius. */
export const TEMPERATURE_DAILY_SWING_C = 2.5;

/** Hard clamp on the reported temperature, so a bad seed can never produce nonsense. */
const TEMPERATURE_LIMIT_C = 60;

/** Temperature offset each weather type carries at full intensity, in Celsius. */
const WEATHER_TEMPERATURE_OFFSET_C: Record<WeatherType, number> = {
  clear: 1.2,
  cloudy: 0,
  overcast: -1.2,
  rain: -3,
  storm: -4.5,
  fog: -1.8,
  snow: -6,
};

/** Intensity is rolled uniformly inside this band when an episode starts. */
const WEATHER_INTENSITY_RANGE: Record<WeatherType, readonly [number, number]> = {
  clear: [0, 0.15],
  cloudy: [0.2, 0.5],
  overcast: [0.4, 0.8],
  rain: [0.25, 0.9],
  storm: [0.6, 1],
  fog: [0.3, 0.9],
  snow: [0.3, 0.95],
};

/** Episode length in *game* hours. Violent weather is short, dull weather is long. */
const WEATHER_DURATION_HOURS: Record<WeatherType, readonly [number, number]> = {
  clear: [4, 10],
  cloudy: [3, 8],
  overcast: [2, 6],
  rain: [1, 4],
  storm: [0.5, 2],
  fog: [1, 3],
  snow: [2, 6],
};

/** Wind speed each type reaches at full intensity, in px/second. */
const WEATHER_WIND_SPEED: Record<WeatherType, number> = {
  clear: 10,
  cloudy: 20,
  overcast: 26,
  rain: 38,
  storm: 95,
  fog: 4,
  snow: 32,
};

/** Seconds for wind speed to close ~63% of the gap to its target. */
const WIND_RESPONSE_SECONDS = 25;

/** Peak gust as a fraction of the target speed, at full intensity. */
const WIND_GUST_FRACTION = 0.2;

/**
 * Precision the replicated wind speed is quantised to, in px/second.
 *
 * Wind speed is the one smoothed value in {@link WeatherState}, so it is also the one
 * that a coarse rounding can *stall*: see {@link stepWind} for why this has to stay
 * finer than one tick's step. Must match the rounding {@link round3} applies.
 */
const WIND_QUANTUM = 0.001;

/** Strikes per second during a storm: a floor plus an intensity-scaled term. */
const LIGHTNING_BASE_PER_SECOND = 0.02;
const LIGHTNING_INTENSITY_PER_SECOND = 0.12;

/** Strikes land this far from the player they were rolled for, in pixels. */
const LIGHTNING_MIN_DISTANCE = 220;
const LIGHTNING_MAX_DISTANCE = 900;

/** Distinct salts keep the hash-derived streams independent of one another. */
const SALT_TEMPERATURE = 0x7e4d;
const SALT_WIND = 0x1f3b;
const SALT_LIGHTNING = 0x5c91;

/**
 * Base transition weights: `TRANSITIONS[from][to]`.
 *
 * Self-transitions are zero, so a `weatherChanged` event always means the sky actually
 * changed; an episode is extended by rolling a longer duration, never by re-picking
 * itself. The shape encodes the obvious physical ordering - clear skies cloud over
 * before they rain, storms decay into rain, fog burns off into clear.
 */
const TRANSITIONS: Record<WeatherType, Record<WeatherType, number>> = {
  clear: { clear: 0, cloudy: 6, overcast: 1.2, rain: 0.6, storm: 0.15, fog: 1.2, snow: 0.4 },
  cloudy: { clear: 4, cloudy: 0, overcast: 3.5, rain: 2.2, storm: 0.5, fog: 1, snow: 1.2 },
  overcast: { clear: 1.2, cloudy: 3.5, overcast: 0, rain: 4.5, storm: 1.2, fog: 1.2, snow: 2.5 },
  rain: { clear: 0.8, cloudy: 3, overcast: 3, rain: 0, storm: 1.6, fog: 1.2, snow: 1 },
  storm: { clear: 0.5, cloudy: 1.5, overcast: 2.5, rain: 4, storm: 0, fog: 0.5, snow: 0.6 },
  fog: { clear: 3, cloudy: 3, overcast: 1.5, rain: 0.8, storm: 0.2, fog: 0, snow: 0.4 },
  snow: { clear: 1.5, cloudy: 2.5, overcast: 2.5, rain: 0.4, storm: 0.3, fog: 0.8, snow: 0 },
};

/** Snow is impossible outside winter and the last part of autumn. */
const AUTUMN_SNOW_FROM = 0.6;

/** Fog wants dawn: this window is relative to sunrise, in hours. */
const FOG_WINDOW_BEFORE_SUNRISE = 1.5;
const FOG_WINDOW_AFTER_SUNRISE = 2.5;

/** Weight fog keeps outside its dawn window. Rare, not impossible. */
const FOG_OFF_PEAK_WEIGHT = 0.12;

// ---------------------------------------------------------------------------
// Pure helpers other systems use
// ---------------------------------------------------------------------------

/**
 * Precipitation is *not* modelled here on purpose.
 *
 * `systems/farming/crops.ts` owns `rainfallRate`, calibrated against the crop table
 * (plot capacity, drink rate, the snowmelt gate at 0 degrees) and consumed by the
 * farming system. A second curve here would be a duplicate that disagrees with the
 * live one and, because both barrels are re-exported from `systems/index.ts`, a
 * duplicate export name as well. Anything that needs "is water falling right now"
 * asks {@link isPrecipitating} and scales by `intensity` itself.
 */

/** True when the air is cold enough to frost crops and chill anyone outdoors. */
export function isFreezing(weather: WeatherState): boolean {
  return weather.temperature <= FREEZING_TEMPERATURE_C;
}

/** True when something is falling out of the sky (rain, storm or snow). */
export function isPrecipitating(weather: WeatherState): boolean {
  return weather.type === 'rain' || weather.type === 'storm' || weather.type === 'snow';
}

/**
 * Seasonal temperature baseline, before time of day and weather.
 *
 * Shares {@link seasonalTilt} with the daylight model, so the coldest part of the year
 * is also the darkest one.
 */
export function seasonalBaseTemperature(fractionalDay: number): number {
  return TEMPERATURE_MEAN_C + TEMPERATURE_SEASON_AMPLITUDE_C * seasonalTilt(fractionalDay);
}

/**
 * The seeded wobble that makes one day warmer than its neighbour.
 *
 * Sampled once per day boundary and smoothly interpolated between, so the temperature
 * curve has no discontinuity at midnight - a step there would look like a bug to
 * anything watching for frost.
 */
export function dailyTemperatureOffset(seed: number, fractionalDay: number): number {
  const dayIndex = Math.floor(fractionalDay);
  const today = dayTemperatureSample(seed, dayIndex);
  const tomorrow = dayTemperatureSample(seed, dayIndex + 1);
  return lerp(today, tomorrow, smoothstep(0, 1, fractionalDay - dayIndex));
}

/**
 * Air temperature for a tick, in Celsius.
 *
 * Seasonal baseline + diurnal sine (coldest half an hour before sunrise, warmest
 * twelve hours later) + the weather's own offset + the day's wobble.
 */
export function weatherTemperature(seed: number, tick: number, weather: WeatherState): number {
  const fractionalDay = fractionalDayAt(tick);
  const hourFloat = (fractionalDay - Math.floor(fractionalDay)) * 24;
  const coldestHour = sunriseHourForDay(fractionalDay) - 0.5;
  const diurnal =
    -TEMPERATURE_DIURNAL_AMPLITUDE_C * Math.cos((TAU * (hourFloat - coldestHour)) / 24);
  const intensity = clamp01(weather.intensity);
  const weatherOffset = (WEATHER_TEMPERATURE_OFFSET_C[weather.type] ?? 0) * (0.4 + 0.6 * intensity);
  const total =
    seasonalBaseTemperature(fractionalDay) +
    diurnal +
    weatherOffset +
    dailyTemperatureOffset(seed, fractionalDay);
  return round2(clamp(total, -TEMPERATURE_LIMIT_C, TEMPERATURE_LIMIT_C));
}

/**
 * Wind direction for a tick, in radians.
 *
 * Two slow sinusoids over a seeded base angle: a pure function of `tick`, so the wind
 * is identical after a reload and cannot random-walk away from the saved value. The
 * periods (1.7 and 0.53 game days) are incommensurate enough that the direction never
 * looks like it is cycling.
 */
export function windAngleAt(seed: number, tick: number): number {
  const base = hashNoise(seed, 0, 0, SALT_WIND) * TAU;
  const slow = Math.sin((TAU * tick) / (TICKS_PER_GAME_DAY * 1.7));
  const faster = Math.sin((TAU * tick) / (TICKS_PER_GAME_DAY * 0.53) + 1.7);
  return wrapAngle(base + 1.1 * slow + 0.4 * faster);
}

/**
 * How likely this weather type is right now, before transition weights.
 *
 * This is where the seasonal character lives: snow only in winter and late autumn,
 * storms mostly in summer, fog mostly around dawn in spring and autumn.
 */
export function weatherSeasonWeight(type: WeatherType, time: WorldTimeState): number {
  const season = time.season;
  const seasonProgress = seasonProgressOf(time);
  switch (type) {
    case 'clear':
      return pickSeason(season, 1, 1.3, 0.85, 0.9);
    case 'cloudy':
      return pickSeason(season, 1, 0.9, 1.2, 1.1);
    case 'overcast':
      return pickSeason(season, 1, 0.7, 1.3, 1.2);
    case 'rain':
      return pickSeason(season, 1.3, 1, 1.2, 0.3);
    case 'storm':
      return pickSeason(season, 0.7, 1.6, 0.45, 0.12);
    case 'fog': {
      const base = pickSeason(season, 1.2, 0.5, 1.4, 0.7);
      return base * fogTimeOfDayFactor(time);
    }
    case 'snow':
      // Hard zero outside winter and the tail of autumn: a summer blizzard is a bug,
      // not a rare event, so it must not be reachable at all.
      if (season === 'winter') return 1.4;
      if (season === 'autumn' && seasonProgress >= AUTUMN_SNOW_FROM) return 0.6;
      return 0;
    default:
      return 0;
  }
}

/**
 * Roll the successor of `from`.
 *
 * Candidates are walked in {@link WEATHER_TYPES} order - a fixed array, never a
 * `Record` iteration - so the weighted pick cannot depend on key insertion order.
 */
export function nextWeatherType(rng: Rng, from: WeatherType, time: WorldTimeState): WeatherType {
  const row = TRANSITIONS[from] ?? TRANSITIONS.clear;
  const weightOf = (type: WeatherType): number =>
    (row[type] ?? 0) * weatherSeasonWeight(type, time);
  const picked = rng.pickWeighted(WEATHER_TYPES, weightOf);
  // `Rng.pickWeighted` has two escape hatches, and neither may be trusted to respect a
  // zero weight: it returns undefined when every weight is zero (the table makes that
  // impossible - clear and cloudy are always available), and on a floating-point
  // tie-break it returns the *last* candidate whatever its weight, which here is
  // `snow`. A summer blizzard has to be unreachable rather than merely improbable, so a
  // pick with no weight behind it is discarded instead of applied. `from` cannot be its
  // own successor, so the last resort is whichever of the two always-available types is
  // not the current sky.
  if (picked !== undefined && weightOf(picked) > 0) return picked;
  return from === 'clear' ? 'cloudy' : 'clear';
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * Drives {@link WeatherState}.
 *
 * Ordered one slot after the time system: same tick phase, but the clock it reads is
 * already today's. Everything downstream (farming's rainfall, survival's warmth, the
 * renderer's particles) sees a fully settled `state.weather` for the tick.
 *
 * The first thing every tick does is {@link normalizeWeather}. `Simulation.loadMeta`
 * installs `meta.weather` verbatim from whatever the persistence backend handed back,
 * and the whole struct is replicated in every snapshot, so this system treats it as
 * untrusted input exactly as a command handler would: an out-of-range `intensity` is
 * read unclamped by other systems (`survival/environment.ts` scales wetness by it) and
 * a non-finite one turns temperature, wind and `lightLevel` into NaN, which JSON
 * flattens to `null` on the wire.
 */
export function createWeatherSystem(): System {
  // Transient, not part of `WeatherState`: set by a `debug setweather` that landed
  // earlier in this same tick (commands dispatch before `update`) so the episode it
  // wrote still gets announced. Authoritative over nothing - dropping it on a reload
  // loses an event, not an episode - which is why it lives in a closure and not in
  // replicated state.
  let forcedThisTick = false;

  // Per-player cooldown for `debug setweather`, keyed on the tick it may next fire.
  // `Simulation.dispatchCommands` drains the *whole* queue every tick with no per-player
  // cap, so without this a client could rewrite the sky and emit a notification
  // hundreds of times in one step. Transient by design: losing it on a reload costs a
  // cheat one extra shot, so it has no business in replicated state.
  const nextAllowedTick = new Map<PlayerId, number>();

  return {
    id: 'weather',
    order: SystemOrder.Time + 1,

    init(ctx, router) {
      // Only the sky-side `debug` actions. See `handleDebugWeather` for why unknown
      // actions are ignored rather than rejected.
      router.on('debug', (handlerCtx, player, command) => {
        if (handleDebugWeather(handlerCtx, player, command, nextAllowedTick)) {
          forcedThisTick = true;
        }
      });
      normalizeWeather(ctx.state.weather, ctx.state.tick);
    },

    onPlayerLeave(_ctx, player) {
      nextAllowedTick.delete(player.id);
    },

    update(ctx) {
      const weather = ctx.state.weather;
      const tick = ctx.state.tick;

      normalizeWeather(weather, tick);

      // A fresh world has `nextChangeTick: 0`, so the first tick rolls real weather
      // instead of leaving the hardcoded placeholder in place. A forced episode has
      // already written `nextChangeTick` into the future, so it cannot also re-roll.
      const rolled = tick >= weather.nextChangeTick;
      if (rolled) rollNextEpisode(ctx);
      const changed = rolled || forcedThisTick;
      forcedThisTick = false;

      weather.temperature = weatherTemperature(ctx.state.seed, tick, weather);
      stepWind(ctx);

      if (changed) {
        ctx.events.emit({
          type: 'weatherChanged',
          weather: weather.type,
          intensity: weather.intensity,
          temperature: weather.temperature,
        });
        ctx.log.debug('weather changed', {
          type: weather.type,
          intensity: weather.intensity,
          untilTick: weather.nextChangeTick,
        });
      }

      maybeStrikeLightning(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Force `state.weather` back into its documented ranges.
 *
 * Cheap (a handful of comparisons, no iteration) and run every tick because the
 * struct has three untrusted authors: `loadMeta`, which installs whatever the
 * persistence backend returns without validating it; the debug command surface; and
 * any tooling that pokes state directly. Downstream readers are inconsistent about
 * clamping - `survival/environment.ts` scales wetness by a raw `weather.intensity`,
 * and `clamp01(NaN)` is NaN because `clamp` returns its input when neither comparison
 * is true - so the fix belongs at the one place that owns the struct.
 *
 * A far-future but *finite* `nextChangeTick` is honoured deliberately: writing one is
 * how a test or an admin tool pins the sky. Only a non-finite or negative schedule is
 * treated as corrupt, and the repair is to roll a fresh episode this tick.
 */
function normalizeWeather(weather: WeatherState, tick: number): void {
  if (!WEATHER_TYPES.includes(weather.type)) {
    // Unknown type: park it somewhere renderable and roll a real one immediately.
    weather.type = 'clear';
    weather.nextChangeTick = tick;
  }
  weather.intensity = finite01(weather.intensity);
  if (!Number.isFinite(weather.nextChangeTick) || weather.nextChangeTick < 0) {
    weather.nextChangeTick = tick;
  } else {
    weather.nextChangeTick = Math.floor(weather.nextChangeTick);
  }
  if (!Number.isFinite(weather.windSpeed) || weather.windSpeed < 0) weather.windSpeed = 0;
  if (!Number.isFinite(weather.temperature)) weather.temperature = TEMPERATURE_MEAN_C;
}

/** Pick the next type, intensity and duration, and schedule the following change. */
function rollNextEpisode(ctx: SimContext): void {
  const weather = ctx.state.weather;
  const rng = ctx.rng.fork('weather');
  const type = nextWeatherType(rng, weather.type, clockView(ctx));
  const intensityRange = WEATHER_INTENSITY_RANGE[type];
  const durationRange = WEATHER_DURATION_HOURS[type];

  weather.type = type;
  weather.intensity = clamp01(rng.float(intensityRange[0], intensityRange[1]));
  const hours = rng.float(durationRange[0], durationRange[1]);
  weather.nextChangeTick = ctx.state.tick + Math.max(1, Math.round(hours * TICKS_PER_GAME_HOUR));
}

/**
 * The calendar this tick, derived rather than read out of `state.time`.
 *
 * Identical to `state.time` whenever the time system is registered (it runs one slot
 * earlier over the same `state.tick`), but it does not *depend* on that. Reading
 * `state.time` directly meant that a host running the weather system alone - a farming
 * or survival test that only wants rain and temperature - silently got the placeholder
 * calendar `createEmptyState` ships, which is spring, 08:00, for ever: no seasons, so
 * no snow and no summer storms, with nothing to show that anything was wrong.
 */
function clockView(ctx: SimContext): WorldTimeState {
  return deriveWorldTime(ctx.state.tick);
}

/**
 * Ease the wind speed towards what the current weather wants, and re-derive its angle.
 *
 * Speed is smoothed through state (so a storm arriving does not slam a 95 px/s gust in
 * on one tick) while angle is a pure function of the tick; both survive a reload,
 * because the only thing carried in state is the value itself.
 *
 * The quantisation deserves its own note. One tick moves the speed `response` = 0.2%
 * of the way to its target, so rounding the result for the wire has to stay *finer*
 * than that step or the ramp stops dead: rounding to two decimals swallowed every step
 * below 0.005 px/s and stranded the wind up to 2.5 px/s from where the sky said it
 * should be, for ever, and by a different amount depending on which way it had come
 * from - a calm sky sat at 6.3 px/s after a storm against 1.4 px/s if it had been calm
 * all along, when both should read about 3.8. Snapping inside the dead band closes the
 * last fraction, so the value depends on the weather and not on its history.
 */
function stepWind(ctx: SimContext): void {
  const weather = ctx.state.weather;
  const intensity = clamp01(weather.intensity);
  const gust =
    1 +
    WIND_GUST_FRACTION * intensity * Math.sin((TAU * ctx.state.tick) / (TICKS_PER_GAME_MINUTE * 7));
  const target = (WEATHER_WIND_SPEED[weather.type] ?? 0) * (0.35 + 0.65 * intensity) * gust;

  const current = Number.isFinite(weather.windSpeed) ? weather.windSpeed : 0;
  const response = clamp01(ctx.clock.dt / WIND_RESPONSE_SECONDS);
  const stepped = current + (target - current) * response;
  // Half a quantum is the smallest change that survives the rounding, so this is
  // exactly the gap a single step can no longer cross. Derived rather than hardcoded
  // so retuning the timestep or the response cannot silently reopen the stall.
  const deadBand = response > 0 ? WIND_QUANTUM / 2 / response : 0;
  const next = Math.abs(target - stepped) <= deadBand ? target : stepped;
  weather.windSpeed = round3(Math.max(0, next));
  weather.windAngle = round3(windAngleAt(ctx.state.seed, ctx.state.tick));
}

/**
 * Roll for a lightning strike during a storm.
 *
 * The trigger is a hash of `(seed, tick)` rather than a draw from `ctx.rng`, so a
 * storm does not advance the shared stream once per tick. Only the strike's position
 * forks the master RNG, and only on the ticks that actually flash.
 *
 * The flag is *set* here and never cleared: {@link Simulation} clears it at the start
 * of every tick, which is what guarantees clients see it for exactly one frame.
 */
function maybeStrikeLightning(ctx: SimContext): void {
  const weather = ctx.state.weather;
  if (weather.type !== 'storm') return;

  const perSecond =
    LIGHTNING_BASE_PER_SECOND + LIGHTNING_INTENSITY_PER_SECOND * clamp01(weather.intensity);
  const chance = clamp01(perSecond * ctx.clock.dt);
  if (hashNoise(ctx.state.seed, ctx.state.tick, 0, SALT_LIGHTNING) >= chance) return;

  // Strikes exist to be seen and heard, so they land near somebody. Sorting by id
  // keeps the choice independent of player join order.
  const candidates = livingPlayers(ctx.state).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (candidates.length === 0) return;

  const rng = ctx.rng.fork('lightning');
  const player = candidates[rng.int(0, candidates.length - 1)];
  if (!player) return;
  const angle = rng.angle();
  const distance = rng.float(LIGHTNING_MIN_DISTANCE, LIGHTNING_MAX_DISTANCE);

  weather.lightning = true;
  ctx.events.emit({
    type: 'lightning',
    x: player.x + Math.cos(angle) * distance,
    y: player.y + Math.sin(angle) * distance,
  });
}

// ---------------------------------------------------------------------------
// Debug command surface
// ---------------------------------------------------------------------------

/** Shortest and longest episode a `debug setweather` may ask for, in game hours. */
const DEBUG_MIN_HOURS = 0.1;
const DEBUG_MAX_HOURS = 24;

/** Default length of a forced episode when the command does not name one. */
const DEBUG_DEFAULT_HOURS = 2;

/** Minimum ticks between two accepted `setweather` commands from one player. */
const DEBUG_COOLDOWN_TICKS = 10;

/**
 * `debug setweather` - the sky half of the `debug` command family.
 *
 * `SimulationConfig.mode.cheatsEnabled` exists precisely to gate this family (it is
 * `true` for single-player, `false` for a dedicated server), and nothing else in the
 * simulation claims `debug`, so the actions that write `state.weather` belong here.
 *
 * Three deliberate choices:
 *
 * - **Unknown actions return silently.** The router fans one command type out to every
 *   registered handler, so `debug spawn` or `debug settime` will one day be somebody
 *   else's. Rejecting what we do not own would spam a `commandRejected` at the client
 *   for commands that actually succeeded.
 * - **Nothing here moves `state.tick`.** Only `Simulation.stepOnce` advances the clock
 *   (Architecture Guard rule 8), which is why even sleeping through the night is
 *   modelled as accelerated recovery rather than a jump. Every cooldown in the game is
 *   an absolute tick, so a `settime` cheat would silently expire all of them; whoever
 *   wants it needs an offset field in {@link WorldTimeState} first, not this handler.
 * - **Liveness is not checked.** Cheats are an out-of-band admin surface, not a player
 *   action: once `cheatsEnabled` is true, refusing a corpse the ability to clear the
 *   storm buys nothing. Everything a *client* can lie about - the action, the type, the
 *   numbers - is still validated.
 *
 * Returns true when it actually changed the sky, so the system can announce it after
 * the tick's temperature has been recomputed.
 */
function handleDebugWeather(
  ctx: SimContext,
  player: PlayerState,
  command: CommandOf<'debug'>,
  nextAllowedTick: Map<PlayerId, number>,
): boolean {
  if (command.action !== 'setweather') return false;

  const reject = (reason: string): boolean => {
    ctx.events.emit({
      type: 'commandRejected',
      playerId: player.id,
      command: 'debug setweather',
      reason,
    });
    return false;
  };

  if (!ctx.config.mode.cheatsEnabled) return reject('cheats are disabled on this server');

  const allowedAt = nextAllowedTick.get(player.id) ?? 0;
  if (ctx.state.tick < allowedAt) return reject('setweather is cooling down');

  const args = command.args ?? {};
  const requested = args['type'];
  if (typeof requested !== 'string' || !isWeatherType(requested)) {
    return reject(`unknown weather type ${String(requested)}`);
  }

  // A lying client gets told no rather than quietly coerced, so a UI bug shows up as a
  // rejection instead of as weather nobody asked for.
  const rawIntensity = args['intensity'];
  let intensity = defaultIntensityFor(requested);
  if (rawIntensity !== undefined) {
    if (typeof rawIntensity !== 'number' || !Number.isFinite(rawIntensity)) {
      return reject('intensity must be a number between 0 and 1');
    }
    if (rawIntensity < 0 || rawIntensity > 1) {
      return reject('intensity must be between 0 and 1');
    }
    intensity = rawIntensity;
  }

  const rawHours = args['hours'];
  let hours = DEBUG_DEFAULT_HOURS;
  if (rawHours !== undefined) {
    if (typeof rawHours !== 'number' || !Number.isFinite(rawHours)) {
      return reject('hours must be a number');
    }
    if (rawHours < DEBUG_MIN_HOURS || rawHours > DEBUG_MAX_HOURS) {
      return reject(`hours must be between ${DEBUG_MIN_HOURS} and ${DEBUG_MAX_HOURS}`);
    }
    hours = rawHours;
  }

  const weather = ctx.state.weather;
  weather.type = requested;
  weather.intensity = intensity;
  weather.nextChangeTick = ctx.state.tick + Math.max(1, Math.round(hours * TICKS_PER_GAME_HOUR));
  // Only an accepted command starts the cooldown, so getting the arguments wrong does
  // not lock the sender out of their next attempt.
  nextAllowedTick.set(player.id, ctx.state.tick + DEBUG_COOLDOWN_TICKS);
  ctx.events.emit({
    type: 'notification',
    playerId: player.id,
    severity: 'info',
    text: `weather set to ${requested} (${intensity.toFixed(2)}) for ${hours}h`,
  });
  return true;
}

function isWeatherType(value: string): value is WeatherType {
  return (WEATHER_TYPES as readonly string[]).includes(value);
}

/** Middle of the type's own band, so `setweather storm` looks like a storm. */
function defaultIntensityFor(type: WeatherType): number {
  const range = WEATHER_INTENSITY_RANGE[type];
  return clamp01((range[0] + range[1]) / 2);
}

// ---------------------------------------------------------------------------
// Weighting helpers and arithmetic
// ---------------------------------------------------------------------------

/** Progress through the current season, 0..1, including the fraction of today. */
function seasonProgressOf(time: WorldTimeState): number {
  const dayOfSeason = (time.day - 1) % DAYS_PER_SEASON;
  return clamp01((dayOfSeason + clamp01(time.dayProgress)) / DAYS_PER_SEASON);
}

/** 1 inside the dawn window, {@link FOG_OFF_PEAK_WEIGHT} outside it. */
function fogTimeOfDayFactor(time: WorldTimeState): number {
  const fractionalDay = time.day - 1 + clamp01(time.dayProgress);
  const sunrise = sunriseHourForDay(fractionalDay);
  const hourFloat = clamp01(time.dayProgress) * 24;
  const inWindow =
    hourFloat >= sunrise - FOG_WINDOW_BEFORE_SUNRISE &&
    hourFloat <= sunrise + FOG_WINDOW_AFTER_SUNRISE;
  return inWindow ? 1 : FOG_OFF_PEAK_WEIGHT;
}

function pickSeason(
  season: Season,
  spring: number,
  summer: number,
  autumn: number,
  winter: number,
): number {
  switch (season) {
    case 'spring':
      return spring;
    case 'summer':
      return summer;
    case 'autumn':
      return autumn;
    default:
      return winter;
  }
}

/** One day's temperature wobble, in [-swing, +swing]. */
function dayTemperatureSample(seed: number, dayIndex: number): number {
  return (hashNoise(seed, dayIndex, 0, SALT_TEMPERATURE) * 2 - 1) * TEMPERATURE_DAILY_SWING_C;
}

/**
 * Clamp into 0..1, treating anything non-numeric as 0.
 *
 * `clamp01` cannot do this: `clamp` returns its input when neither `<` nor `>` holds,
 * and every comparison against NaN is false, so `clamp01(NaN)` is NaN.
 */
function finite01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return clamp01(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
