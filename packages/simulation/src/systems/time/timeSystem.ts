import {
  DAYS_PER_SEASON,
  DAYS_PER_YEAR,
  SEASONS,
  TAU,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  TICKS_PER_GAME_MINUTE,
  clamp,
  clamp01,
  smoothstep,
  type Season,
  type WeatherState,
  type WeatherType,
  type WorldTimeState,
} from '@survive/protocol';
import { SystemOrder, type System } from '../../core/context';
import type { SimulationState } from '../../core/state';

/**
 * The world clock.
 *
 * `state.tick` is the only clock the simulation trusts, so every other field of
 * {@link WorldTimeState} is a *pure function of it* rather than an accumulator. That
 * matters for three reasons:
 *
 * - a save that stores nothing but `tick` restores the calendar exactly;
 * - a client can derive the same clock locally from the tick it is rendering, so the
 *   HUD clock never needs its own network field;
 * - nothing can drift. An accumulated `minute++` would desync the moment a tick was
 *   dropped or replayed.
 *
 * The same stateless rule drives the day-rollover event: instead of remembering
 * yesterday in a closure (which a `loadMeta` jump would immediately invalidate) we ask
 * whether `tick` and `tick - 1` fall in different days.
 */

// ---------------------------------------------------------------------------
// Daylight model
// ---------------------------------------------------------------------------

/** Sunrise at the equinoxes, in hours. Seasons push it either side of this. */
export const SUNRISE_BASE_HOUR = 6;

/** Sunset at the equinoxes, in hours. */
export const SUNSET_BASE_HOUR = 20;

/**
 * How far mid-summer/mid-winter drag sunrise and sunset, in hours.
 *
 * Applied to both shoulders in opposite directions, so a winter day is
 * `2 * 2 * SEASONAL_DAYLIGHT_SHIFT_HOURS` = 7 hours shorter than a summer one:
 * roughly 07:45-18:15 in winter against 04:15-21:45 at midsummer.
 */
export const SEASONAL_DAYLIGHT_SHIFT_HOURS = 1.75;

/**
 * Half-width of the dawn and dusk ramps, in hours.
 *
 * Light is a smoothstep across `sunrise +/- TWILIGHT_HOURS`, never a step: stealth,
 * zombie aggression and the renderer all read `lightLevel`, and a hard switch at
 * sunrise would make all three pop.
 */
export const TWILIGHT_HOURS = 1.25;

/** Below this fraction of full sun it counts as night for gameplay purposes. */
export const NIGHT_SUN_THRESHOLD = 0.2;

/**
 * Days in one lunar cycle.
 *
 * Deliberately not {@link DAYS_PER_SEASON}: a 15-day moon against a 14-day season
 * makes the full moon drift through the calendar instead of always landing on the
 * same day of every season.
 */
export const MOON_CYCLE_DAYS = 15;

/** Light level a full moon adds to an otherwise pitch-black night. */
export const MOONLIGHT_MAX = 0.14;

/**
 * How much each weather type can dim the sky at full intensity, 0..1.
 *
 * Storms are the darkest, fog is bright but flat, and `clear` is very slightly under
 * 1 so that even a clear sky reads as weather rather than a special case.
 */
const WEATHER_DIMMING: Record<WeatherType, number> = {
  clear: 0.02,
  cloudy: 0.15,
  overcast: 0.4,
  rain: 0.45,
  storm: 0.65,
  fog: 0.35,
  snow: 0.3,
};

/** Floor on the weather light multiplier: even the worst storm is not midnight. */
const MIN_WEATHER_LIGHT = 0.25;

/**
 * Day of the year (0-based) with the longest day.
 *
 * The middle of summer: seasons run spring, summer, autumn, winter, so this is one
 * whole season plus half of the next, minus the half-day that centres it on a day
 * rather than on a boundary.
 */
const SUMMER_SOLSTICE_DAY = DAYS_PER_SEASON * 1.5 - 0.5;

// ---------------------------------------------------------------------------
// Pure clock derivation
// ---------------------------------------------------------------------------

/** 0-based day number since world creation. `state.time.day` is this plus one. */
export function dayIndexAt(tick: number): number {
  return Math.floor(sanitizeTick(tick) / TICKS_PER_GAME_DAY);
}

/** Day number including the fraction elapsed, e.g. 3.5 at noon on the fourth day. */
export function fractionalDayAt(tick: number): number {
  return sanitizeTick(tick) / TICKS_PER_GAME_DAY;
}

/** Time of day as a float in [0, 24). */
export function hourOfDayAt(tick: number): number {
  const t = sanitizeTick(tick);
  return (t - dayIndexAt(t) * TICKS_PER_GAME_DAY) / TICKS_PER_GAME_HOUR;
}

/** Season a given 0-based day index falls in. */
export function seasonForDay(dayIndex: number): Season {
  const index = Math.floor(dayIndex / DAYS_PER_SEASON) % SEASONS.length;
  // `%` keeps the sign of the dividend, so a negative index would fall off the table.
  const wrapped = (index + SEASONS.length) % SEASONS.length;
  return SEASONS[wrapped] ?? 'spring';
}

/** Year number of a 0-based day index, starting at 1. */
export function yearForDay(dayIndex: number): number {
  return Math.floor(dayIndex / DAYS_PER_YEAR) + 1;
}

/**
 * Seasonal tilt, -1 at mid-winter to +1 at mid-summer.
 *
 * A continuous cosine of the fractional day rather than a per-season constant: the
 * seasons are a smooth wheel, so sunrise creeps a few minutes a day instead of jumping
 * an hour when the season label changes.
 */
export function seasonalTilt(fractionalDay: number): number {
  const dayOfYear = ((fractionalDay % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  return Math.cos((TAU * (dayOfYear - SUMMER_SOLSTICE_DAY)) / DAYS_PER_YEAR);
}

/** Hour the sun clears the horizon on a given (fractional) day. */
export function sunriseHourForDay(fractionalDay: number): number {
  return SUNRISE_BASE_HOUR - SEASONAL_DAYLIGHT_SHIFT_HOURS * seasonalTilt(fractionalDay);
}

/** Hour the sun sets on a given (fractional) day. */
export function sunsetHourForDay(fractionalDay: number): number {
  return SUNSET_BASE_HOUR + SEASONAL_DAYLIGHT_SHIFT_HOURS * seasonalTilt(fractionalDay);
}

/**
 * Sun contribution to ambient light, 0..1, ignoring the moon and the weather.
 *
 * The product of a rising dawn ramp and a falling dusk ramp. Both shoulders are
 * smoothsteps, so this is monotonic through dawn, exactly 1 across the middle of the
 * day, and exactly 0 through the small hours.
 */
export function sunlightFactor(fractionalDay: number, hourFloat: number): number {
  const sunrise = sunriseHourForDay(fractionalDay);
  const sunset = sunsetHourForDay(fractionalDay);
  const rising = smoothstep(sunrise - TWILIGHT_HOURS, sunrise + TWILIGHT_HOURS, hourFloat);
  const falling = 1 - smoothstep(sunset - TWILIGHT_HOURS, sunset + TWILIGHT_HOURS, hourFloat);
  return clamp01(rising * falling);
}

/** Moon phase, 0 = new, 0.5 = full, wrapping back to new at 1. */
export function moonPhase(fractionalDay: number): number {
  const cycle = ((fractionalDay % MOON_CYCLE_DAYS) + MOON_CYCLE_DAYS) % MOON_CYCLE_DAYS;
  return cycle / MOON_CYCLE_DAYS;
}

/** Fraction of the moon's disc that is lit, 0 (new) .. 1 (full). */
export function moonIllumination(fractionalDay: number): number {
  return (1 - Math.cos(TAU * moonPhase(fractionalDay))) / 2;
}

/**
 * How much of the sky's light the current weather lets through, 0..1.
 *
 * Kept separate from {@link sunlightFactor} so the renderer can tint for weather
 * without double-applying the dimming it already sees in `lightLevel`.
 */
export function weatherLightMultiplier(weather: WeatherState): number {
  const dimming = WEATHER_DIMMING[weather.type] ?? 0;
  // `clamp` returns its input when neither comparison holds and every comparison
  // against NaN is false, so `clamp01(NaN)` is NaN. The weather system normalizes
  // `state.weather` at the head of its own update, but it runs one slot *after* this
  // one, so on the first tick after a bad `loadMeta` the guard has to be here too -
  // otherwise `lightLevel` replicates as NaN, which the wire flattens to `null`.
  const intensity = Number.isFinite(weather.intensity) ? clamp01(weather.intensity) : 0;
  return clamp(1 - dimming * intensity, MIN_WEATHER_LIGHT, 1);
}

/**
 * Ambient light for a tick, 0..1.
 *
 * Moonlight fills in only what the sun leaves behind, so noon is exactly 1 regardless
 * of the moon, and a new-moon midnight under a clear sky is exactly 0.
 */
export function lightLevelAt(tick: number, weather?: WeatherState): number {
  const day = fractionalDayAt(tick);
  const sun = sunlightFactor(day, hourOfDayAt(tick));
  const moon = MOONLIGHT_MAX * moonIllumination(day);
  const ambient = sun + (1 - sun) * moon;
  const multiplier = weather ? weatherLightMultiplier(weather) : 1;
  return round4(clamp01(ambient * multiplier));
}

/**
 * The whole clock for a tick, as a fresh object.
 *
 * `weather` is optional because most callers (tests, the client's own clock, log
 * lines) only care about the calendar; omitting it reports the light of a clear sky.
 */
export function deriveWorldTime(tick: number, weather?: WeatherState): WorldTimeState {
  const t = sanitizeTick(tick);
  const dayIndex = dayIndexAt(t);
  const tickOfDay = t - dayIndex * TICKS_PER_GAME_DAY;
  const hour = Math.floor(tickOfDay / TICKS_PER_GAME_HOUR);
  const minute = Math.floor((tickOfDay - hour * TICKS_PER_GAME_HOUR) / TICKS_PER_GAME_MINUTE);
  const hourFloat = tickOfDay / TICKS_PER_GAME_HOUR;
  const fractionalDay = t / TICKS_PER_GAME_DAY;
  const sun = sunlightFactor(fractionalDay, hourFloat);

  return {
    tick: t,
    day: dayIndex + 1,
    hour,
    minute,
    season: seasonForDay(dayIndex),
    year: yearForDay(dayIndex),
    dayProgress: tickOfDay / TICKS_PER_GAME_DAY,
    isNight: sun < NIGHT_SUN_THRESHOLD,
    lightLevel: lightLevelAt(t, weather),
  };
}

/**
 * Recompute `state.time` in place from `state.tick`.
 *
 * Mutates rather than replaces the object so that anything holding a reference to
 * `state.time` (the snapshot builder, a test) keeps seeing the live clock.
 */
export function applyWorldTime(state: SimulationState): WorldTimeState {
  const next = deriveWorldTime(state.tick, state.weather);
  const time = state.time;
  time.tick = next.tick;
  time.day = next.day;
  time.hour = next.hour;
  time.minute = next.minute;
  time.season = next.season;
  time.year = next.year;
  time.dayProgress = next.dayProgress;
  time.isNight = next.isNight;
  time.lightLevel = next.lightLevel;
  return time;
}

/** Human-readable clock, e.g. `"Day 4, 06:12, spring"`. Used by logs and the HUD. */
export function describeTime(time: WorldTimeState): string {
  return `Day ${time.day}, ${pad2(time.hour)}:${pad2(time.minute)}, ${time.season}`;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * Advances the calendar and the light level, and announces each new day.
 *
 * Runs first in the tick ({@link SystemOrder.Time}) because almost everything else
 * reads the clock: crop growth, zombie aggression, spawn budgets and the survival
 * system's warmth model all branch on season, `isNight` or `lightLevel`.
 *
 * Note that `lightLevel` uses the weather from the *previous* tick, since the weather
 * system deliberately runs just after this one. One tick of lag (50 ms) is invisible,
 * and the alternative - splitting weather across two phases - would be worse.
 */
export function createTimeSystem(): System {
  return {
    id: 'time',
    order: SystemOrder.Time,

    init(ctx) {
      // A fresh `SimulationState` carries placeholder clock values, and `loadMeta`
      // restores `tick` without touching `time`. Deriving once here means the clock is
      // already coherent for the first snapshot, before any tick has run.
      applyWorldTime(ctx.state);
    },

    onPlayerJoin(ctx) {
      // `init` runs in the `Simulation` constructor, which is *before* `loadMeta`
      // ("call before adding any players"), so a resumed world sits with `time.tick`
      // at the restored tick and the rest of the calendar still at the tick-0
      // placeholder until the first step. A client that joins in that window gets a
      // snapshot claiming Day 1, 00:00, pitch dark at what the same struct says is
      // day 41. Deriving on join closes the gap; it is O(1) and idempotent.
      applyWorldTime(ctx.state);
    },

    update(ctx) {
      const time = applyWorldTime(ctx.state);
      const tick = ctx.state.tick;
      // Stateless rollover test: no closure to get out of step with a loaded save,
      // and it fires exactly once because the clock only ever advances one tick per
      // step. `day` is the day that has just *begun*, matching the HUD's "Day N".
      if (tick > 0 && dayIndexAt(tick) !== dayIndexAt(tick - 1)) {
        ctx.events.emit({
          type: 'dayPassed',
          day: time.day,
          season: time.season,
          year: time.year,
        });
        ctx.log.debug('day rolled over', { time: describeTime(time) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Ticks are whole and never negative; a corrupt save must not produce NaN light. */
function sanitizeTick(tick: number): number {
  if (!Number.isFinite(tick)) return 0;
  return Math.max(0, Math.floor(tick));
}

/**
 * Quantise to four decimals.
 *
 * `lightLevel` is replicated every snapshot; rounding keeps the middle of the day at
 * exactly 1 and the small hours at exactly 0 instead of jittering in the last bits of
 * a float, which would make every tick look like a change.
 */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}
