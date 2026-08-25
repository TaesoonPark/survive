import { describe, expect, it } from 'vitest';
import {
  AOI_RADIUS,
  DAYS_PER_SEASON,
  Rng,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  distance,
  type WeatherState,
  type WeatherType,
  type WorldTimeState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { createTimeSystem, deriveWorldTime, sunriseHourForDay } from './timeSystem';
import {
  FREEZING_TEMPERATURE_C,
  TEMPERATURE_DAILY_SWING_C,
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

/** The clock and the sky, which is how they ship. */
function sky(seed = 4242) {
  return createTestSimulation({ seed, systems: [createTimeSystem(), createWeatherSystem()] });
}

function weather(partial: Partial<WeatherState> = {}): WeatherState {
  return {
    type: 'clear',
    intensity: 0.5,
    temperature: 15,
    windAngle: 0,
    windSpeed: 0,
    nextChangeTick: Number.MAX_SAFE_INTEGER,
    lightning: false,
    ...partial,
  };
}

/** Pin the sky so a test can observe one weather type for as long as it likes. */
function forceWeather(sim: TestSimulation, type: WeatherType, intensity: number): void {
  const state = sim.sim.state.weather;
  state.type = type;
  state.intensity = intensity;
  state.nextChangeTick = sim.sim.state.tick + TICKS_PER_GAME_DAY * 100;
}

/** Jump the world to the start of a season without simulating the year up to it. */
function jumpToDay(sim: TestSimulation, dayIndex: number): void {
  sim.sim.state.tick = dayIndex * TICKS_PER_GAME_DAY;
  sim.sim.clock.setTick(sim.sim.state.tick);
}

function timeAt(dayIndex: number, hour: number): WorldTimeState {
  return deriveWorldTime(dayIndex * TICKS_PER_GAME_DAY + Math.round(hour * TICKS_PER_GAME_HOUR));
}

/**
 * An `Rng` pinned to `pickWeighted`'s float tie-break branch, which returns the last
 * candidate no matter what weight it carries.
 */
class TieBreakRng extends Rng {
  override pickWeighted<T>(items: readonly T[]): T | undefined {
    return items[items.length - 1];
  }
}

describe('weather transitions', () => {
  it('rolls real weather on the very first tick', () => {
    const sim = sky();
    // A fresh state carries `nextChangeTick: 0`, which is the signal to roll now
    // rather than leave the placeholder `clear` in place.
    expect(sim.sim.state.weather.nextChangeTick).toBe(0);
    sim.step(1);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
    expect(sim.sim.state.weather.nextChangeTick).toBeGreaterThan(sim.sim.state.tick);
  });

  it('holds an episode until nextChangeTick and then rolls again', () => {
    const sim = sky();
    sim.step(1);
    const first = sim.sim.state.weather.type;
    const until = sim.sim.state.weather.nextChangeTick;

    sim.step(until - sim.sim.state.tick - 1);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
    expect(sim.sim.state.weather.type).toBe(first);

    sim.step(1);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(2);
    expect(sim.sim.state.weather.type).not.toBe(first);
  });

  it('changes many times over a long run and visits several types', () => {
    const sim = sky(7);
    sim.step(TICKS_PER_GAME_DAY * 5);
    const changes = sim.eventsOf('weatherChanged');
    expect(changes.length).toBeGreaterThan(10);
    expect(new Set(changes.map((event) => event.weather)).size).toBeGreaterThanOrEqual(4);
  });

  it('never reports a change to the type it already was', () => {
    const sim = sky(7);
    sim.step(TICKS_PER_GAME_DAY * 5);
    const types = sim.eventsOf('weatherChanged').map((event) => event.weather);
    for (let i = 1; i < types.length; i++) {
      expect(types[i], `change ${i}`).not.toBe(types[i - 1]);
    }
  });

  it('rolls plausible intensities and episode lengths', () => {
    const sim = sky(7);
    // Stepping one tick at a time is the only way to observe *when* a change landed,
    // since `weatherChanged` deliberately carries no tick of its own.
    const episodes: Array<{ type: WeatherType; intensity: number; ticks: number }> = [];
    let previousChangeTick = 0;
    for (let i = 0; i < TICKS_PER_GAME_DAY * 3; i++) {
      const events = sim.step(1);
      if (!events.some((event) => event.type === 'weatherChanged')) continue;
      const now = sim.sim.state.tick;
      const state = sim.sim.state.weather;
      // The gap since the previous change is the duration the *previous* episode
      // actually ran for; the planned length of this one is `nextChangeTick - now`.
      if (episodes.length > 0) {
        const previous = episodes[episodes.length - 1];
        expect(now - previousChangeTick, `episode ${episodes.length - 1} ran short`).toBe(
          previous?.ticks,
        );
      }
      episodes.push({
        type: state.type,
        intensity: state.intensity,
        ticks: state.nextChangeTick - now,
      });
      previousChangeTick = now;
    }

    expect(episodes.length).toBeGreaterThan(5);
    for (const episode of episodes) {
      expect(episode.intensity).toBeGreaterThanOrEqual(0);
      expect(episode.intensity).toBeLessThanOrEqual(1);
      // A storm is never a drizzle, and a clear sky is never "intense".
      if (episode.type === 'storm') expect(episode.intensity).toBeGreaterThanOrEqual(0.5);
      if (episode.type === 'clear') expect(episode.intensity).toBeLessThanOrEqual(0.2);
      // Every band in the table is between half a game hour and ten game hours, so an
      // episode is always long enough to notice and short enough to sit out.
      expect(episode.ticks, episode.type).toBeGreaterThanOrEqual(TICKS_PER_GAME_HOUR / 2);
      expect(episode.ticks, episode.type).toBeLessThanOrEqual(TICKS_PER_GAME_HOUR * 10);
    }
    // Violent weather is short-lived; a dull sky hangs around.
    const storms = episodes.filter((episode) => episode.type === 'storm');
    const calm = episodes.filter(
      (episode) => episode.type === 'clear' || episode.type === 'cloudy',
    );
    expect(storms.length).toBeGreaterThan(0);
    expect(calm.length).toBeGreaterThan(0);
    expect(Math.max(...storms.map((episode) => episode.ticks))).toBeLessThan(
      Math.max(...calm.map((episode) => episode.ticks)),
    );
  });

  it('is reproducible for a seed and different for another', () => {
    const trace = (seed: number) => {
      const sim = sky(seed);
      sim.step(TICKS_PER_GAME_DAY * 3);
      return sim
        .eventsOf('weatherChanged')
        .map((event) => `${event.weather}:${event.intensity.toFixed(4)}`)
        .join('|');
    };
    expect(trace(7)).toBe(trace(7));
    expect(trace(7)).not.toBe(trace(1234));
  });

  it('reproduces the whole weather state tick for tick', () => {
    const a = sky(31);
    const b = sky(31);
    a.step(TICKS_PER_GAME_DAY * 2);
    b.step(TICKS_PER_GAME_DAY * 2);
    expect(a.sim.state.weather).toEqual(b.sim.state.weather);
    expect(a.sim.state.time).toEqual(b.sim.state.time);
  });
});

describe('seasonal weighting', () => {
  it('never allows snow outside winter and late autumn', () => {
    const springDawn = timeAt(3, 6);
    const summerNoon = timeAt(DAYS_PER_SEASON + 5, 12);
    const earlyAutumn = timeAt(DAYS_PER_SEASON * 2 + 2, 12);
    const lateAutumn = timeAt(DAYS_PER_SEASON * 3 - 1, 12);
    const winter = timeAt(DAYS_PER_SEASON * 3 + 4, 12);

    expect(weatherSeasonWeight('snow', springDawn)).toBe(0);
    expect(weatherSeasonWeight('snow', summerNoon)).toBe(0);
    expect(weatherSeasonWeight('snow', earlyAutumn)).toBe(0);
    expect(weatherSeasonWeight('snow', lateAutumn)).toBeGreaterThan(0);
    expect(weatherSeasonWeight('snow', winter)).toBeGreaterThan(
      weatherSeasonWeight('snow', lateAutumn),
    );
  });

  it('puts storms mostly in summer', () => {
    const spring = weatherSeasonWeight('storm', timeAt(4, 15));
    const summer = weatherSeasonWeight('storm', timeAt(DAYS_PER_SEASON + 4, 15));
    const autumn = weatherSeasonWeight('storm', timeAt(DAYS_PER_SEASON * 2 + 4, 15));
    const winter = weatherSeasonWeight('storm', timeAt(DAYS_PER_SEASON * 3 + 4, 15));
    expect(summer).toBeGreaterThan(spring);
    expect(spring).toBeGreaterThan(autumn);
    expect(autumn).toBeGreaterThan(winter);
  });

  it('puts fog at dawn, and mostly in spring and autumn', () => {
    const autumnDay = DAYS_PER_SEASON * 2 + 6;
    const sunrise = sunriseHourForDay(autumnDay);
    const dawn = weatherSeasonWeight('fog', timeAt(autumnDay, sunrise));
    const afternoon = weatherSeasonWeight('fog', timeAt(autumnDay, 15));
    expect(dawn).toBeGreaterThan(afternoon * 4);

    const summerDay = DAYS_PER_SEASON + 6;
    const summerDawn = weatherSeasonWeight('fog', timeAt(summerDay, sunriseHourForDay(summerDay)));
    expect(dawn).toBeGreaterThan(summerDawn);
  });

  it('rolls snow in winter and never in summer', () => {
    const rng = new Rng(99);
    const winter = timeAt(DAYS_PER_SEASON * 3 + 6, 8);
    const summer = timeAt(DAYS_PER_SEASON + 6, 8);
    let winterSnow = 0;
    let summerSnow = 0;
    for (let i = 0; i < 2000; i++) {
      if (nextWeatherType(rng, 'overcast', winter) === 'snow') winterSnow++;
      if (nextWeatherType(rng, 'overcast', summer) === 'snow') summerSnow++;
    }
    expect(winterSnow).toBeGreaterThan(50);
    expect(summerSnow).toBe(0);
  });

  it('always returns a valid type, even from a corrupt saved type', () => {
    const rng = new Rng(5);
    const type = nextWeatherType(rng, 'not-a-type' as WeatherType, timeAt(0, 12));
    expect(['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog', 'snow']).toContain(type);
  });

  it('refuses a zero-weight pick even when the weighted roll hands one back', () => {
    // `Rng.pickWeighted` falls back to the *last* candidate on a floating-point
    // tie-break, and the last entry in `WEATHER_TYPES` is `snow` - the one type summer
    // forbids outright. A summer blizzard has to be unreachable rather than a one in
    // 2^53 event, so the roll's answer is checked against its own weight.
    const summer = timeAt(DAYS_PER_SEASON + 6, 12);
    expect(weatherSeasonWeight('snow', summer)).toBe(0);
    expect(nextWeatherType(new TieBreakRng(1), 'overcast', summer)).not.toBe('snow');
    // And the last resort is still a real transition, never the sky it already was.
    expect(nextWeatherType(new TieBreakRng(1), 'clear', summer)).not.toBe('clear');
    expect(nextWeatherType(new TieBreakRng(1), 'cloudy', summer)).not.toBe('cloudy');
  });

  it('actually snows during a winter run of the live simulation', () => {
    // The month-long run below only reaches early autumn, so winter needs its own
    // world. Jumping the tick is safe here: nothing in the sky is an accumulator.
    const sim = sky(7);
    jumpToDay(sim, DAYS_PER_SEASON * 3);
    const seen = new Set<WeatherType>();
    for (let i = 0; i < (TICKS_PER_GAME_DAY * 10) / 20; i++) {
      sim.step(20);
      seen.add(sim.sim.state.weather.type);
      expect(sim.sim.state.time.season).toBe('winter');
    }
    expect(seen.has('snow')).toBe(true);
    // Winter is cold enough to freeze at some point over ten days.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('keeps the sky and the freezing test agreeing over a winter run', () => {
    const sim = sky(11);
    jumpToDay(sim, DAYS_PER_SEASON * 3 + 3);
    let froze = 0;
    for (let i = 0; i < (TICKS_PER_GAME_DAY * 5) / 20; i++) {
      sim.step(20);
      if (isFreezing(sim.sim.state.weather)) froze++;
    }
    expect(froze).toBeGreaterThan(0);
  });
});

describe('temperature', () => {
  it('is stored in the state every tick', () => {
    const sim = sky();
    sim.step(10);
    expect(Number.isFinite(sim.sim.state.weather.temperature)).toBe(true);
    const first = sim.sim.state.weather.temperature;
    sim.step(TICKS_PER_GAME_HOUR * 6);
    expect(sim.sim.state.weather.temperature).not.toBe(first);
  });

  it('is coldest just before dawn', () => {
    for (const day of [0, 20, 48]) {
      let coldestHour = -1;
      let coldest = Number.POSITIVE_INFINITY;
      let warmest = Number.NEGATIVE_INFINITY;
      for (let minutes = 0; minutes < 24 * 60; minutes += 5) {
        const tick = day * TICKS_PER_GAME_DAY + minutes * 20;
        const value = weatherTemperature(4242, tick, weather({ type: 'clear', intensity: 0.1 }));
        if (value < coldest) {
          coldest = value;
          coldestHour = minutes / 60;
        }
        warmest = Math.max(warmest, value);
      }
      const sunrise = sunriseHourForDay(day);
      expect(coldestHour, `day ${day}`).toBeLessThan(sunrise);
      expect(coldestHour, `day ${day}`).toBeGreaterThan(sunrise - 2);
      expect(warmest - coldest).toBeGreaterThan(4);
    }
  });

  it('is warmer in the afternoon than at dawn', () => {
    const dawn = weatherTemperature(4242, Math.round(5.5 * TICKS_PER_GAME_HOUR), weather());
    const afternoon = weatherTemperature(4242, 16 * TICKS_PER_GAME_HOUR, weather());
    expect(afternoon).toBeGreaterThan(dawn);
  });

  it('follows the seasons', () => {
    const midSpring = DAYS_PER_SEASON * 0.5 - 0.5;
    const midSummer = DAYS_PER_SEASON * 1.5 - 0.5;
    const midWinter = DAYS_PER_SEASON * 3.5 - 0.5;
    expect(seasonalBaseTemperature(midSummer)).toBeGreaterThan(
      seasonalBaseTemperature(midSpring) + 10,
    );
    expect(seasonalBaseTemperature(midWinter)).toBeLessThan(
      seasonalBaseTemperature(midSpring) - 10,
    );
    expect(seasonalBaseTemperature(midWinter)).toBeLessThan(FREEZING_TEMPERATURE_C + 1);
  });

  it('is colder under snow than under a clear sky at the same moment', () => {
    const tick = DAYS_PER_SEASON * 3 * TICKS_PER_GAME_DAY + 8 * TICKS_PER_GAME_HOUR;
    const clear = weatherTemperature(4242, tick, weather({ type: 'clear', intensity: 0.1 }));
    const snowing = weatherTemperature(4242, tick, weather({ type: 'snow', intensity: 0.9 }));
    const storming = weatherTemperature(4242, tick, weather({ type: 'storm', intensity: 1 }));
    expect(snowing).toBeLessThan(clear - 4);
    expect(storming).toBeLessThan(clear - 3);
  });

  it('scales the weather offset with intensity', () => {
    const tick = 9 * TICKS_PER_GAME_HOUR;
    const light = weatherTemperature(4242, tick, weather({ type: 'rain', intensity: 0.1 }));
    const heavy = weatherTemperature(4242, tick, weather({ type: 'rain', intensity: 1 }));
    expect(heavy).toBeLessThan(light);
  });

  it('varies from one day to the next, within a small band', () => {
    const offsets: number[] = [];
    for (let day = 0; day < 30; day++) offsets.push(dailyTemperatureOffset(4242, day));
    for (const offset of offsets) {
      expect(Math.abs(offset)).toBeLessThanOrEqual(TEMPERATURE_DAILY_SWING_C + 1e-9);
    }
    expect(new Set(offsets.map((value) => value.toFixed(4))).size).toBeGreaterThan(20);
    // Continuous across midnight: the value at the very end of a day matches the next
    // day's opening value.
    expect(dailyTemperatureOffset(4242, 4.999999)).toBeCloseTo(dailyTemperatureOffset(4242, 5), 3);
  });

  it('depends on the world seed', () => {
    const tick = 12 * TICKS_PER_GAME_HOUR;
    expect(weatherTemperature(1, tick, weather())).not.toBe(weatherTemperature(2, tick, weather()));
  });

  it('freezes only at or below zero', () => {
    expect(isFreezing(weather({ temperature: -0.5 }))).toBe(true);
    expect(isFreezing(weather({ temperature: FREEZING_TEMPERATURE_C }))).toBe(true);
    expect(isFreezing(weather({ temperature: 0.1 }))).toBe(false);
    expect(isFreezing(weather({ temperature: 20 }))).toBe(false);
  });

  it('gets below freezing in mid-winter', () => {
    const midWinterNight =
      Math.round((DAYS_PER_SEASON * 3.5 - 0.5) * TICKS_PER_GAME_DAY) + 6 * TICKS_PER_GAME_HOUR;
    const value = weatherTemperature(
      4242,
      midWinterNight,
      weather({ type: 'snow', intensity: 0.8 }),
    );
    expect(isFreezing(weather({ temperature: value }))).toBe(true);
  });
});

describe('wind', () => {
  it('drifts slowly rather than jumping', () => {
    const perTick = Math.abs(windAngleAt(4242, 1000) - windAngleAt(4242, 1001));
    expect(perTick).toBeLessThan(0.01);
    // Over an hour it has actually moved.
    expect(Math.abs(windAngleAt(4242, 0) - windAngleAt(4242, TICKS_PER_GAME_HOUR))).toBeGreaterThan(
      0.005,
    );
  });

  it('keeps the angle wrapped and depends on the seed', () => {
    for (let tick = 0; tick < TICKS_PER_GAME_DAY * 4; tick += 997) {
      const angle = windAngleAt(4242, tick);
      expect(angle).toBeGreaterThan(-Math.PI - 1e-9);
      expect(angle).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
    expect(windAngleAt(1, 500)).not.toBe(windAngleAt(2, 500));
  });

  it('picks up in a storm and dies down when it clears', () => {
    const sim = sky();
    forceWeather(sim, 'storm', 1);
    sim.step(TICKS_PER_GAME_HOUR * 2);
    const stormWind = sim.sim.state.weather.windSpeed;
    expect(stormWind).toBeGreaterThan(40);

    forceWeather(sim, 'clear', 0.05);
    sim.step(TICKS_PER_GAME_HOUR * 3);
    expect(sim.sim.state.weather.windSpeed).toBeLessThan(stormWind / 2);
    expect(sim.sim.state.weather.windSpeed).toBeGreaterThanOrEqual(0);
  });

  it('settles on the same speed however it got there', () => {
    // Wind speed is the only smoothed value in the sky, so it is the only one that can
    // carry history - and it must not. Two worlds under the same weather at the same
    // tick have to report the same wind whether they arrived from a storm or from dead
    // calm. Rounding the eased value more coarsely than one tick's movement used to
    // break exactly this: the ramp froze wherever the rounding swallowed it, stranding
    // a calm sky at 6.3 px/s after a storm against 1.4 px/s if it had always been calm.
    const rising = sky(1);
    forceWeather(rising, 'clear', 0.05);
    rising.step(TICKS_PER_GAME_HOUR * 6);

    const falling = sky(1);
    forceWeather(falling, 'storm', 1);
    falling.step(TICKS_PER_GAME_HOUR * 3);
    forceWeather(falling, 'clear', 0.05);
    falling.step(TICKS_PER_GAME_HOUR * 3);

    expect(falling.sim.state.tick).toBe(rising.sim.state.tick);
    expect(falling.sim.state.weather.windSpeed).toBeCloseTo(rising.sim.state.weather.windSpeed, 2);
    // And both actually arrived: a clear sky at 5% intensity wants a shade under
    // 4 px/s, which is neither where a stalled ramp up nor a stalled ramp down sat.
    expect(rising.sim.state.weather.windSpeed).toBeGreaterThan(3);
    expect(rising.sim.state.weather.windSpeed).toBeLessThan(4.5);
  });

  it('ramps rather than snapping to a new speed', () => {
    const sim = sky();
    forceWeather(sim, 'fog', 0.5);
    sim.step(TICKS_PER_GAME_HOUR * 2);
    const calm = sim.sim.state.weather.windSpeed;
    forceWeather(sim, 'storm', 1);
    sim.step(1);
    const oneTickLater = sim.sim.state.weather.windSpeed;
    expect(oneTickLater).toBeGreaterThan(calm);
    // Nowhere near the storm's target yet: the response is smoothed over seconds.
    expect(oneTickLater).toBeLessThan(calm + 2);
  });
});

describe('lightning', () => {
  it('strikes during a storm, near a player, and flashes for one tick', () => {
    const sim = sky(7);
    const player = sim.addPlayer();
    forceWeather(sim, 'storm', 1);

    let struckTick = -1;
    for (let i = 0; i < 3000 && struckTick < 0; i++) {
      const events = sim.step(1);
      if (events.some((event) => event.type === 'lightning')) {
        struckTick = sim.sim.state.tick;
        expect(sim.sim.state.weather.lightning).toBe(true);
      }
    }
    expect(struckTick).toBeGreaterThan(0);

    const strike = sim.lastEvent('lightning');
    expect(strike).toBeDefined();
    const away = distance(player.x, player.y, strike?.x ?? 0, strike?.y ?? 0);
    expect(away).toBeGreaterThan(0);
    expect(away).toBeLessThan(AOI_RADIUS);

    // The Simulation clears the flag at the head of every tick, so the very next tick
    // without a strike must read false.
    let cleared = false;
    for (let i = 0; i < 20 && !cleared; i++) {
      const events = sim.step(1);
      if (!events.some((event) => event.type === 'lightning')) {
        expect(sim.sim.state.weather.lightning).toBe(false);
        cleared = true;
      }
    }
    expect(cleared).toBe(true);
  });

  it('never strikes when it is not storming', () => {
    for (const type of ['rain', 'snow', 'clear', 'fog'] as const) {
      const sim = sky(7);
      sim.addPlayer();
      forceWeather(sim, type, 1);
      sim.step(TICKS_PER_GAME_HOUR * 3);
      expect(sim.eventsOf('lightning'), type).toHaveLength(0);
      expect(sim.sim.state.weather.lightning).toBe(false);
    }
  });

  it('does not strike for a dead player', () => {
    // Strikes exist to be seen and heard, so they are positioned relative to somebody
    // who can see them. A corpse on the respawn screen is not an audience.
    const sim = sky(7);
    const player = sim.addPlayer();
    player.alive = false;
    forceWeather(sim, 'storm', 1);
    sim.step(TICKS_PER_GAME_HOUR * 3);
    expect(sim.eventsOf('lightning')).toHaveLength(0);
    expect(sim.sim.state.weather.lightning).toBe(false);
  });

  it('does not strike when nobody is in the world', () => {
    const sim = sky(7);
    forceWeather(sim, 'storm', 1);
    sim.step(TICKS_PER_GAME_HOUR * 3);
    expect(sim.eventsOf('lightning')).toHaveLength(0);
    expect(sim.sim.state.weather.lightning).toBe(false);
  });

  it('strikes more often in a violent storm than a mild one', () => {
    const count = (intensity: number) => {
      const sim = sky(7);
      sim.addPlayer();
      forceWeather(sim, 'storm', intensity);
      sim.step(TICKS_PER_GAME_HOUR * 20);
      return sim.eventsOf('lightning').length;
    };
    expect(count(1)).toBeGreaterThan(count(0.6));
  });
});

describe('a month of weather', () => {
  it('never goes out of range, never produces NaN, and never snows in summer', () => {
    const sim = sky(7);
    sim.addPlayer();
    const seen = new Set<WeatherType>();
    let snowInSummer = 0;
    let coldest = Number.POSITIVE_INFINITY;
    let warmest = Number.NEGATIVE_INFINITY;

    // Sampling every 20 ticks (one game minute) still cannot miss an episode: the
    // shortest one the table can roll is half a game hour. The checks accumulate into
    // one report rather than firing 43 200 assertions - a failing `expect` inside the
    // loop costs more than the simulation it is watching, and a count of bad samples
    // says more than the first one to trip.
    const bad: string[] = [];
    for (let i = 0; i < (TICKS_PER_GAME_DAY * 30) / 20; i++) {
      sim.step(20);
      const sky = sim.sim.state.weather;
      const time = sim.sim.state.time;
      seen.add(sky.type);
      if (sky.type === 'snow' && time.season === 'summer') snowInSummer++;

      const wrong =
        !Number.isFinite(sky.temperature) ||
        !Number.isFinite(sky.intensity) ||
        !Number.isFinite(sky.windSpeed) ||
        !Number.isFinite(sky.windAngle) ||
        !Number.isFinite(time.lightLevel) ||
        sky.intensity < 0 ||
        sky.intensity > 1 ||
        sky.windSpeed < 0 ||
        Math.abs(sky.windAngle) > Math.PI + 1e-6 ||
        sky.temperature <= -60 ||
        sky.temperature >= 60 ||
        time.lightLevel < 0 ||
        time.lightLevel > 1 ||
        // The schedule must always point at this tick or later: a stale one means the
        // episode ran out without anything rolling a new one.
        sky.nextChangeTick <= sim.sim.state.tick - 20;
      if (wrong)
        bad.push(`tick ${sim.sim.state.tick}: ${JSON.stringify(sky)} light ${time.lightLevel}`);

      coldest = Math.min(coldest, sky.temperature);
      warmest = Math.max(warmest, sky.temperature);
    }

    expect(bad.slice(0, 3)).toEqual([]);
    expect(snowInSummer).toBe(0);
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(sim.eventsOf('weatherChanged').length).toBeGreaterThan(50);
    expect(sim.eventsOf('dayPassed')).toHaveLength(30);
    // Spring through early autumn: cool nights, warm afternoons, nothing absurd.
    expect(coldest).toBeGreaterThan(-20);
    expect(warmest).toBeLessThan(45);
    expect(warmest - coldest).toBeGreaterThan(10);
  });
});

describe('precipitation', () => {
  it('knows what counts as precipitation', () => {
    expect(isPrecipitating(weather({ type: 'rain' }))).toBe(true);
    expect(isPrecipitating(weather({ type: 'storm' }))).toBe(true);
    expect(isPrecipitating(weather({ type: 'snow' }))).toBe(true);
    expect(isPrecipitating(weather({ type: 'fog' }))).toBe(false);
    expect(isPrecipitating(weather({ type: 'overcast' }))).toBe(false);
    expect(isPrecipitating(weather({ type: 'clear' }))).toBe(false);
    expect(isPrecipitating(weather({ type: 'cloudy' }))).toBe(false);
  });
});

describe('untrusted weather state', () => {
  // `Simulation.loadMeta` installs `meta.weather` verbatim, and the whole struct is
  // replicated in every snapshot, so a corrupt or hand-edited save is an input this
  // system has to survive rather than propagate.

  it('scrubs a non-finite intensity instead of poisoning temperature, wind and light', () => {
    const sim = sky(5);
    sim.step(1);
    const state = sim.sim.state.weather;
    state.intensity = Number.NaN;
    // Pin the schedule so the next roll cannot quietly paper over the bad value.
    state.nextChangeTick = sim.sim.state.tick + TICKS_PER_GAME_DAY;
    sim.step(2);

    expect(state.intensity).toBe(0);
    expect(Number.isFinite(state.temperature)).toBe(true);
    expect(Number.isFinite(state.windSpeed)).toBe(true);
    expect(Number.isFinite(sim.sim.state.time.lightLevel)).toBe(true);
  });

  it('clamps an out-of-range intensity in state, not just at the read sites', () => {
    // `survival/environment.ts` scales wetness by a raw `weather.intensity`, so an
    // intensity of 9 would be a 9x soaking. State has to be in range, not merely
    // clamped by whoever remembers to.
    const sim = sky(5);
    sim.step(1);
    const state = sim.sim.state.weather;
    state.nextChangeTick = sim.sim.state.tick + TICKS_PER_GAME_DAY;

    state.intensity = 9;
    sim.step(1);
    expect(state.intensity).toBe(1);

    state.intensity = -4;
    sim.step(1);
    expect(state.intensity).toBe(0);
  });

  it('re-rolls rather than freezing when the schedule is not a number', () => {
    // `tick >= NaN` is false for ever, which used to strand the sky on whatever type
    // and intensity the bad save carried, permanently.
    const sim = sky(5);
    sim.step(1);
    sim.clearEvents();
    sim.sim.state.weather.nextChangeTick = Number.NaN;
    sim.step(1);

    expect(Number.isFinite(sim.sim.state.weather.nextChangeTick)).toBe(true);
    expect(sim.sim.state.weather.nextChangeTick).toBeGreaterThan(sim.sim.state.tick);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
  });

  it('re-rolls when the schedule is in the past or negative', () => {
    const sim = sky(5);
    sim.step(1);
    sim.clearEvents();
    sim.sim.state.weather.nextChangeTick = -500;
    sim.step(1);
    expect(sim.sim.state.weather.nextChangeTick).toBeGreaterThan(sim.sim.state.tick);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
  });

  it('replaces a weather type that is not in the table', () => {
    const sim = sky(5);
    sim.step(1);
    const state = sim.sim.state.weather;
    state.type = 'sharknado' as WeatherType;
    state.nextChangeTick = sim.sim.state.tick + TICKS_PER_GAME_DAY;
    sim.step(1);
    expect(['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog', 'snow']).toContain(state.type);
  });

  it('recovers a negative or non-finite wind speed', () => {
    const sim = sky(5);
    sim.step(1);
    const state = sim.sim.state.weather;
    state.nextChangeTick = sim.sim.state.tick + TICKS_PER_GAME_DAY;

    state.windSpeed = Number.NaN;
    sim.step(1);
    expect(Number.isFinite(state.windSpeed)).toBe(true);
    expect(state.windSpeed).toBeGreaterThanOrEqual(0);

    state.windSpeed = -99;
    sim.step(1);
    expect(state.windSpeed).toBeGreaterThanOrEqual(0);
  });

  it('honours a far-future but finite schedule, because that is how you pin the sky', () => {
    const sim = sky(5);
    sim.step(1);
    sim.clearEvents();
    forceWeather(sim, 'fog', 0.5);
    sim.step(TICKS_PER_GAME_HOUR * 12);
    expect(sim.sim.state.weather.type).toBe('fog');
    expect(sim.eventsOf('weatherChanged')).toHaveLength(0);
  });
});

describe('independence from the time system', () => {
  it('still follows the seasons when the clock system is not registered', () => {
    // Reading `state.time` directly meant a host that ran only the weather system saw
    // the `createEmptyState` placeholder - spring, 08:00 - for ever, so snow and
    // summer storms were unreachable with nothing to show anything was wrong.
    const alone = createTestSimulation({ seed: 7, systems: [createWeatherSystem()] });
    alone.sim.state.tick = DAYS_PER_SEASON * 3 * TICKS_PER_GAME_DAY;
    alone.sim.clock.setTick(alone.sim.state.tick);

    const seen = new Set<WeatherType>();
    for (let i = 0; i < (TICKS_PER_GAME_DAY * 10) / 20; i++) {
      alone.step(20);
      seen.add(alone.sim.state.weather.type);
    }
    expect(seen.has('snow')).toBe(true);
  });

  it('picks the same weather with or without the clock system present', () => {
    const withClock = sky(31);
    const withoutClock = createTestSimulation({ seed: 31, systems: [createWeatherSystem()] });
    withClock.step(TICKS_PER_GAME_DAY * 2);
    withoutClock.step(TICKS_PER_GAME_DAY * 2);
    expect(withoutClock.sim.state.weather).toEqual(withClock.sim.state.weather);
  });
});

describe('debug setweather', () => {
  function cheats(enabled: boolean, seed = 5) {
    return createTestSimulation({
      seed,
      systems: [createTimeSystem(), createWeatherSystem()],
      config: (config) => {
        config.mode.cheatsEnabled = enabled;
      },
    });
  }

  it('sets the sky and announces it', () => {
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    sim.clearEvents();

    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    expect(sim.sim.state.weather.type).toBe('storm');
    expect(sim.sim.state.weather.intensity).toBeGreaterThan(0.5);
    expect(sim.lastEvent('weatherChanged')?.weather).toBe('storm');
    // The announced temperature is this tick's, recomputed for the forced weather.
    expect(sim.lastEvent('weatherChanged')?.temperature).toBe(sim.sim.state.weather.temperature);
    expect(sim.lastEvent('notification')?.playerId).toBe(player.id);
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
  });

  it('honours an explicit intensity and duration, and holds for it', () => {
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    sim.clearEvents();

    sim.run(player, {
      type: 'debug',
      action: 'setweather',
      args: { type: 'rain', intensity: 0.25, hours: 3 },
    });
    expect(sim.sim.state.weather.intensity).toBe(0.25);
    expect(sim.sim.state.weather.nextChangeTick).toBe(sim.sim.state.tick + TICKS_PER_GAME_HOUR * 3);

    sim.step(TICKS_PER_GAME_HOUR * 3 - 1);
    expect(sim.sim.state.weather.type).toBe('rain');
    sim.step(1);
    expect(sim.sim.state.weather.type).not.toBe('rain');
  });

  it('announces exactly once, not once per tick', () => {
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    sim.clearEvents();
    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'fog', hours: 5 } });
    sim.step(50);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
  });

  it('refuses when cheats are disabled', () => {
    const sim = cheats(false);
    const player = sim.addPlayer();
    sim.step(1);
    const before = sim.sim.state.weather.type;
    sim.clearEvents();

    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    expect(sim.sim.state.weather.type).toBe(before);
    expect(sim.lastEvent('commandRejected')).toMatchObject({
      playerId: player.id,
      command: 'debug setweather',
    });
    expect(sim.eventsOf('weatherChanged')).toHaveLength(0);
  });

  it('refuses a type, intensity or duration the table does not allow', () => {
    const cases: Array<Record<string, number | string | boolean>> = [
      {},
      { type: 'sharknado' },
      { type: 42 },
      { type: 'storm', intensity: 5 },
      { type: 'storm', intensity: -1 },
      { type: 'storm', intensity: 'lots' },
      { type: 'storm', hours: 0 },
      { type: 'storm', hours: 10000 },
      { type: 'storm', hours: 'ages' },
    ];
    for (const args of cases) {
      const sim = cheats(true);
      const player = sim.addPlayer();
      sim.step(1);
      const before = { ...sim.sim.state.weather };
      sim.clearEvents();

      sim.run(player, { type: 'debug', action: 'setweather', args });
      expect(sim.eventsOf('commandRejected'), JSON.stringify(args)).toHaveLength(1);
      expect(sim.sim.state.weather.type, JSON.stringify(args)).toBe(before.type);
      expect(sim.sim.state.weather.intensity, JSON.stringify(args)).toBe(before.intensity);
      expect(sim.eventsOf('weatherChanged'), JSON.stringify(args)).toHaveLength(0);
    }
  });

  it('stays silent about debug actions it does not own', () => {
    // The router fans `debug` out to every handler, so rejecting a stranger's action
    // would report a failure for a command that succeeded elsewhere.
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    sim.clearEvents();
    sim.run(player, { type: 'debug', action: 'spawnzombie', args: { count: 3 } });
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(sim.eventsOf('notification')).toHaveLength(0);
  });

  it('never moves the clock', () => {
    // Only `Simulation.stepOnce` advances the tick (Architecture Guard rule 8); every
    // cooldown in the game is an absolute tick, so a cheat that jumped the clock would
    // silently expire all of them.
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    const tick = sim.sim.state.tick;
    const day = sim.sim.state.time.day;
    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'snow', hours: 20 } });
    expect(sim.sim.state.tick).toBe(tick + 1);
    expect(sim.sim.state.time.day).toBe(day);
  });

  it('answers a dead admin too, deliberately', () => {
    // Every *gameplay* handler in the simulation refuses a corpse. This one does not,
    // and that is the decision rather than an oversight: `cheatsEnabled` is the gate,
    // and being dead confers nothing that being alive does not already allow. Pinned so
    // that changing it has to be a choice.
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    player.alive = false;
    sim.clearEvents();

    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'fog' } });
    expect(sim.sim.state.weather.type).toBe('fog');
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
  });

  it('cannot be sent by a player who is not in the world', () => {
    // `Simulation.dispatchCommands` resolves the sender out of `state.players` first, so
    // a command carrying somebody else's id - or a stale one - never reaches a handler.
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(1);
    const before = sim.sim.state.weather.type;
    sim.clearEvents();

    sim.sim.queueCommand('ghost', { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    sim.step(1);
    expect(sim.sim.state.weather.type).toBe(before);
    expect(sim.eventsOf('notification')).toHaveLength(0);
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(player.id).not.toBe('ghost');
  });

  it('lets a cheat put snow on a summer afternoon, unlike the roll', () => {
    // Deliberate: the season gate exists to stop the *simulation* rolling a summer
    // blizzard, not to stop a developer asking for one.
    const sim = cheats(true);
    const player = sim.addPlayer();
    sim.step(DAYS_PER_SEASON * TICKS_PER_GAME_DAY + 14 * TICKS_PER_GAME_HOUR);
    expect(sim.sim.state.time.season).toBe('summer');
    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'snow', hours: 1 } });
    expect(sim.sim.state.weather.type).toBe('snow');
  });
});

describe('resuming a saved world', () => {
  it('reports the restored calendar to the first player who joins, before any tick', () => {
    // `Simulation` calls `init` in its constructor, which is before `loadMeta`, so a
    // resumed world used to hand a joining client `time.tick` from the save with the
    // rest of the calendar still at the tick-0 placeholder.
    const sim = sky(5);
    const tick = 40 * TICKS_PER_GAME_DAY + 13 * TICKS_PER_GAME_HOUR;
    sim.sim.loadMeta({
      version: 1,
      name: 'resumed',
      seed: sim.sim.state.seed,
      tick,
      weather: weather({ type: 'overcast', intensity: 0.6 }),
      rng: sim.sim.state.rng,
      nextId: sim.sim.state.nextId,
      createdAtMs: 0,
      savedAtMs: 0,
      totalTicks: tick,
    });

    sim.addPlayer();
    const time = sim.sim.state.time;
    expect(time.tick).toBe(tick);
    expect(time.day).toBe(41);
    expect(time.hour).toBe(13);
    expect(time.season).toBe('autumn');
    expect(time.isNight).toBe(false);
    expect(time.lightLevel).toBeGreaterThan(0);
  });
});

describe('debug setweather flooding', () => {
  function cheatSim(seed = 5) {
    return createTestSimulation({
      seed,
      systems: [createTimeSystem(), createWeatherSystem()],
      config: (config) => {
        config.mode.cheatsEnabled = true;
      },
    });
  }

  it('accepts one command per cooldown, not one per queued message', () => {
    // `Simulation.dispatchCommands` drains the whole queue every tick with no
    // per-player cap, so a client that queues fifty of these in one step would
    // otherwise rewrite the sky and notify fifty times.
    const sim = cheatSim();
    const player = sim.addPlayer();
    sim.step(1);
    sim.clearEvents();

    for (let i = 0; i < 50; i++) {
      sim.command(player, { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    }
    sim.step(1);

    expect(sim.eventsOf('notification')).toHaveLength(1);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
    expect(sim.eventsOf('commandRejected')).toHaveLength(49);
    expect(sim.sim.state.weather.type).toBe('storm');
  });

  it('lets the same player through again once the cooldown has run', () => {
    const sim = cheatSim();
    const player = sim.addPlayer();
    sim.step(1);
    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'fog' } });
    sim.clearEvents();

    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    expect(sim.sim.state.weather.type).toBe('fog');
    expect(sim.eventsOf('commandRejected')).toHaveLength(1);

    sim.step(12);
    sim.clearEvents();
    sim.run(player, { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    expect(sim.sim.state.weather.type).toBe('storm');
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
  });

  it('cools one player down without blocking another', () => {
    const sim = cheatSim();
    const first = sim.addPlayer({ id: 'aaa' });
    const second = sim.addPlayer({ id: 'bbb' });
    sim.step(1);
    sim.run(first, { type: 'debug', action: 'setweather', args: { type: 'fog' } });
    sim.clearEvents();

    sim.run(second, { type: 'debug', action: 'setweather', args: { type: 'snow', hours: 1 } });
    expect(sim.sim.state.weather.type).toBe('snow');
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
  });

  it('collapses two players forcing weather in one tick into one announcement', () => {
    const sim = cheatSim();
    const first = sim.addPlayer({ id: 'aaa' });
    const second = sim.addPlayer({ id: 'bbb' });
    sim.step(1);
    sim.clearEvents();

    sim.command(first, { type: 'debug', action: 'setweather', args: { type: 'fog' } });
    sim.command(second, { type: 'debug', action: 'setweather', args: { type: 'storm' } });
    sim.step(1);

    expect(sim.eventsOf('notification')).toHaveLength(2);
    expect(sim.eventsOf('weatherChanged')).toHaveLength(1);
    // Last command in the queue wins, and the announcement describes what state holds.
    expect(sim.sim.state.weather.type).toBe('storm');
    expect(sim.lastEvent('weatherChanged')?.weather).toBe('storm');
  });
});
