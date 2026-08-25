/**
 * The world clock and the weather that hangs off it.
 *
 * Two systems in the same tick phase: {@link createTimeSystem} at
 * `SystemOrder.Time` derives the calendar and the light level from `state.tick`, and
 * {@link createWeatherSystem} one slot later drives the sky, the temperature and the
 * wind. Both must be registered for the world to have a working day/night cycle.
 */
export {
  MOONLIGHT_MAX,
  MOON_CYCLE_DAYS,
  NIGHT_SUN_THRESHOLD,
  SEASONAL_DAYLIGHT_SHIFT_HOURS,
  SUNRISE_BASE_HOUR,
  SUNSET_BASE_HOUR,
  TWILIGHT_HOURS,
  applyWorldTime,
  createTimeSystem,
  dayIndexAt,
  deriveWorldTime,
  describeTime,
  fractionalDayAt,
  hourOfDayAt,
  lightLevelAt,
  moonIllumination,
  moonPhase,
  seasonForDay,
  seasonalTilt,
  sunlightFactor,
  sunriseHourForDay,
  sunsetHourForDay,
  weatherLightMultiplier,
  yearForDay,
} from './timeSystem';

export {
  FREEZING_TEMPERATURE_C,
  TEMPERATURE_DAILY_SWING_C,
  TEMPERATURE_DIURNAL_AMPLITUDE_C,
  TEMPERATURE_MEAN_C,
  TEMPERATURE_SEASON_AMPLITUDE_C,
  createWeatherSystem,
  dailyTemperatureOffset,
  isFreezing,
  isPrecipitating,
  nextWeatherType,
  seasonalBaseTemperature,
  weatherSeasonWeight,
  weatherTemperature,
  windAngleAt,
} from './weatherSystem';
