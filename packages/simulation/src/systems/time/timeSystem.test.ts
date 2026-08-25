import { describe, expect, it } from 'vitest';
import {
  DAYS_PER_SEASON,
  DAYS_PER_YEAR,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  TICKS_PER_GAME_MINUTE,
  WORLD_START_TICK,
  type WeatherState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import {
  MOONLIGHT_MAX,
  MOON_CYCLE_DAYS,
  createTimeSystem,
  dayIndexAt,
  deriveWorldTime,
  describeTime,
  hourOfDayAt,
  lightLevelAt,
  moonIllumination,
  moonPhase,
  seasonForDay,
  sunlightFactor,
  sunriseHourForDay,
  sunsetHourForDay,
  weatherLightMultiplier,
  yearForDay,
} from './timeSystem';

/** Only the clock: weather stays at the state's `clear`/0 default. */
function timeOnly(seed = 4242) {
  return createTestSimulation({ seed, systems: [createTimeSystem()] });
}

function weather(partial: Partial<WeatherState> = {}): WeatherState {
  return {
    type: 'clear',
    intensity: 0,
    temperature: 15,
    windAngle: 0,
    windSpeed: 0,
    nextChangeTick: Number.MAX_SAFE_INTEGER,
    lightning: false,
    ...partial,
  };
}

/** Tick at the given hour of the given 0-based day. */
function tickAt(dayIndex: number, hour: number, minute = 0): number {
  return (
    dayIndex * TICKS_PER_GAME_DAY + hour * TICKS_PER_GAME_HOUR + minute * TICKS_PER_GAME_MINUTE
  );
}

/**
 * Step until `state.tick` is exactly `tick`.
 *
 * A fresh world does not start at tick 0 - it starts at {@link WORLD_START_TICK}, the
 * morning of day 1 - so a test that wants a particular hour has to step to an absolute
 * tick rather than assume the clock began at midnight.
 */
function stepTo(sim: TestSimulation, tick: number): void {
  const delta = tick - sim.sim.state.tick;
  if (delta < 0) throw new Error(`stepTo: tick ${tick} is already behind ${sim.sim.state.tick}`);
  sim.step(delta);
}

describe('clock derivation', () => {
  it('derives the calendar from the tick alone', () => {
    const cases: Array<[number, { day: number; hour: number; minute: number }]> = [
      [0, { day: 1, hour: 0, minute: 0 }],
      [1, { day: 1, hour: 0, minute: 0 }],
      [TICKS_PER_GAME_MINUTE, { day: 1, hour: 0, minute: 1 }],
      [TICKS_PER_GAME_MINUTE - 1, { day: 1, hour: 0, minute: 0 }],
      [TICKS_PER_GAME_HOUR, { day: 1, hour: 1, minute: 0 }],
      [tickAt(0, 6, 12), { day: 1, hour: 6, minute: 12 }],
      [tickAt(0, 23, 59), { day: 1, hour: 23, minute: 59 }],
      [TICKS_PER_GAME_DAY - 1, { day: 1, hour: 23, minute: 59 }],
      [TICKS_PER_GAME_DAY, { day: 2, hour: 0, minute: 0 }],
      [tickAt(3, 6, 12), { day: 4, hour: 6, minute: 12 }],
      [tickAt(400, 17, 45), { day: 401, hour: 17, minute: 45 }],
    ];
    for (const [tick, expected] of cases) {
      const time = deriveWorldTime(tick);
      expect({ day: time.day, hour: time.hour, minute: time.minute }, `tick ${tick}`).toEqual(
        expected,
      );
      expect(time.tick).toBe(tick);
    }
  });

  it('agrees with independent arithmetic across many ticks', () => {
    for (let tick = 0; tick < TICKS_PER_GAME_DAY * 3; tick += 97) {
      const time = deriveWorldTime(tick);
      const totalMinutes = Math.floor(tick / TICKS_PER_GAME_MINUTE);
      expect(time.hour).toBe(Math.floor(totalMinutes / 60) % 24);
      expect(time.minute).toBe(totalMinutes % 60);
      expect(time.day).toBe(Math.floor(tick / TICKS_PER_GAME_DAY) + 1);
      expect(time.dayProgress).toBeCloseTo((tick % TICKS_PER_GAME_DAY) / TICKS_PER_GAME_DAY, 10);
    }
  });

  it('keeps dayProgress in 0..1 and in step with the hour', () => {
    for (let tick = 0; tick < TICKS_PER_GAME_DAY; tick += 311) {
      const time = deriveWorldTime(tick);
      expect(time.dayProgress).toBeGreaterThanOrEqual(0);
      expect(time.dayProgress).toBeLessThan(1);
      expect(Math.floor(time.dayProgress * 24)).toBe(time.hour);
      expect(hourOfDayAt(tick)).toBeCloseTo(time.dayProgress * 24, 10);
    }
  });

  it('refuses to produce nonsense for a negative or broken tick', () => {
    for (const tick of [-1, -TICKS_PER_GAME_DAY, Number.NaN, Number.POSITIVE_INFINITY]) {
      const time = deriveWorldTime(tick);
      expect(time.day).toBe(1);
      expect(time.hour).toBe(0);
      expect(time.season).toBe('spring');
      expect(Number.isFinite(time.lightLevel)).toBe(true);
    }
  });

  it('installs a coherent clock before the first tick is stepped', () => {
    const sim = timeOnly();
    // `createEmptyState` ships placeholder values; the system derives over them in
    // `init` so the first snapshot a joining client sees is already correct - which
    // matters because a fresh world starts at `WORLD_START_TICK`, not at tick 0.
    expect(sim.sim.state.tick).toBe(WORLD_START_TICK);
    expect(sim.sim.state.time).toEqual(deriveWorldTime(WORLD_START_TICK, sim.sim.state.weather));
    expect(sim.sim.state.time.day).toBe(1);
    expect(sim.sim.state.time.season).toBe('spring');
  });

  it('opens a new world in the morning, not in the dark', () => {
    // The whole point of `WORLD_START_TICK`: dropping a fresh player into pitch
    // darkness on their first night with no tools is a miserable opening.
    const sim = timeOnly();
    expect(sim.sim.state.time.hour).toBe(8);
    expect(sim.sim.state.time.isNight).toBe(false);
    expect(sim.sim.state.time.lightLevel).toBeGreaterThan(0.5);
    // And it is genuinely derived rather than the struct's placeholder: 08:00 in early
    // spring is still climbing towards noon.
    expect(sim.sim.state.time.lightLevel).toBeLessThan(1);
  });

  it('advances state.time as the simulation steps', () => {
    const sim = timeOnly();
    stepTo(sim, tickAt(0, 14, 12));
    expect(sim.sim.state.time.hour).toBe(14);
    expect(sim.sim.state.time.minute).toBe(12);
    expect(describeTime(sim.sim.state.time)).toBe('Day 1, 14:12, spring');

    sim.step(TICKS_PER_GAME_DAY * 3);
    expect(sim.sim.state.time.day).toBe(4);
    expect(describeTime(sim.sim.state.time)).toBe('Day 4, 14:12, spring');
  });

  it('formats hours and minutes with two digits', () => {
    expect(describeTime(deriveWorldTime(0))).toBe('Day 1, 00:00, spring');
    expect(describeTime(deriveWorldTime(tickAt(0, 9, 5)))).toBe('Day 1, 09:05, spring');
    expect(describeTime(deriveWorldTime(tickAt(0, 23, 59)))).toBe('Day 1, 23:59, spring');
  });
});

describe('seasons and years', () => {
  it('advances the season after DAYS_PER_SEASON days', () => {
    expect(seasonForDay(0)).toBe('spring');
    expect(seasonForDay(DAYS_PER_SEASON - 1)).toBe('spring');
    expect(seasonForDay(DAYS_PER_SEASON)).toBe('summer');
    expect(seasonForDay(DAYS_PER_SEASON * 2)).toBe('autumn');
    expect(seasonForDay(DAYS_PER_SEASON * 3)).toBe('winter');
    expect(seasonForDay(DAYS_PER_SEASON * 4)).toBe('spring');
  });

  it('advances the year after DAYS_PER_YEAR days', () => {
    expect(yearForDay(0)).toBe(1);
    expect(yearForDay(DAYS_PER_YEAR - 1)).toBe(1);
    expect(yearForDay(DAYS_PER_YEAR)).toBe(2);
    expect(yearForDay(DAYS_PER_YEAR * 3 + 5)).toBe(4);
  });

  it('rolls the season in the live state on the right day', () => {
    const sim = timeOnly();
    sim.step(TICKS_PER_GAME_DAY * (DAYS_PER_SEASON - 1));
    expect(sim.sim.state.time.season).toBe('spring');
    expect(sim.sim.state.time.day).toBe(DAYS_PER_SEASON);
    sim.step(TICKS_PER_GAME_DAY);
    expect(sim.sim.state.time.day).toBe(DAYS_PER_SEASON + 1);
    expect(sim.sim.state.time.season).toBe('summer');
  });

  it('keeps the day number counting across years', () => {
    const time = deriveWorldTime(TICKS_PER_GAME_DAY * DAYS_PER_YEAR);
    expect(time.day).toBe(DAYS_PER_YEAR + 1);
    expect(time.year).toBe(2);
    expect(time.season).toBe('spring');
  });
});

describe('dayPassed', () => {
  it('emits exactly once per rollover', () => {
    const sim = timeOnly();
    stepTo(sim, tickAt(1, 0) - 1);
    expect(sim.eventsOf('dayPassed')).toHaveLength(0);

    sim.step(1);
    const first = sim.eventsOf('dayPassed');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ day: 2, season: 'spring', year: 1 });

    sim.step(1);
    expect(sim.eventsOf('dayPassed')).toHaveLength(1);
  });

  it('emits one event per day over a long run, in order', () => {
    const sim = timeOnly();
    sim.step(TICKS_PER_GAME_DAY * 5);
    const days = sim.eventsOf('dayPassed').map((event) => event.day);
    expect(days).toEqual([2, 3, 4, 5, 6]);
  });

  it('reports the season and year of the day that just began', () => {
    const sim = timeOnly();
    sim.step(TICKS_PER_GAME_DAY * DAYS_PER_SEASON);
    const last = sim.lastEvent('dayPassed');
    expect(last?.day).toBe(DAYS_PER_SEASON + 1);
    expect(last?.season).toBe('summer');
  });

  it('does not fire spuriously after a mid-day resume', () => {
    // `loadMeta` moves the tick without a rollover; the stateless day test must not
    // mistake the jump for a new day.
    const sim = timeOnly();
    sim.sim.state.tick = tickAt(9, 13, 30);
    sim.sim.clock.setTick(sim.sim.state.tick);
    sim.clearEvents();
    sim.step(5);
    expect(sim.eventsOf('dayPassed')).toHaveLength(0);
    expect(sim.sim.state.time.day).toBe(10);
  });

  it('restores the whole calendar from a save that only stored the tick', () => {
    // `loadMeta` writes `tick` and `weather` and leaves the rest of the clock alone,
    // precisely because it is derivable. This is the test that keeps that true.
    const sim = timeOnly();
    const tick = tickAt(DAYS_PER_SEASON * 2 + 3, 21, 40);
    sim.sim.loadMeta({
      version: 1,
      name: 'resumed',
      seed: sim.sim.state.seed,
      tick,
      weather: weather({ type: 'overcast', intensity: 0.7 }),
      rng: sim.sim.state.rng,
      nextId: sim.sim.state.nextId,
      createdAtMs: 0,
      savedAtMs: 0,
      totalTicks: tick,
    });
    sim.clearEvents();
    sim.step(1);

    const time = sim.sim.state.time;
    expect(time.day).toBe(DAYS_PER_SEASON * 2 + 4);
    expect(time.hour).toBe(21);
    expect(time.minute).toBe(40);
    expect(time.season).toBe('autumn');
    expect(time.isNight).toBe(true);
    expect(sim.eventsOf('dayPassed')).toHaveLength(0);
    // And the restored weather is already dimming the sky, not just sitting in state.
    expect(time.lightLevel).toBeLessThan(weatherLightMultiplier(sim.sim.state.weather) + 1e-6);
  });

  it('rolls the day over on the first tick after a resume at one minute to midnight', () => {
    const sim = timeOnly();
    sim.sim.state.tick = TICKS_PER_GAME_DAY * 3 - 1;
    sim.sim.clock.setTick(sim.sim.state.tick);
    sim.clearEvents();
    sim.step(1);
    expect(sim.eventsOf('dayPassed')).toHaveLength(1);
    expect(sim.lastEvent('dayPassed')?.day).toBe(4);
  });
});

describe('daylight', () => {
  it('is pitch dark at the first midnight and full at noon', () => {
    // Day 0 is a new moon under a clear sky: the darkest night the world has.
    expect(lightLevelAt(0)).toBe(0);
    expect(lightLevelAt(tickAt(0, 12))).toBe(1);
  });

  it('is full at noon and near zero at midnight on every day of a month', () => {
    for (let day = 0; day < 30; day++) {
      expect(lightLevelAt(tickAt(day, 12)), `noon of day ${day}`).toBe(1);
      const midnight = lightLevelAt(tickAt(day, 0));
      expect(midnight, `midnight of day ${day}`).toBeLessThanOrEqual(MOONLIGHT_MAX);
      expect(midnight).toBeGreaterThanOrEqual(0);
    }
  });

  it('ramps smoothly and monotonically through dawn', () => {
    const dayIndex = 0;
    const sunrise = sunriseHourForDay(dayIndex);
    const samples: number[] = [];
    for (let minutes = 0; minutes <= 6 * 60; minutes += 10) {
      const hour = sunrise - 2 + minutes / 60;
      samples.push(lightLevelAt(tickAt(dayIndex, 0) + hour * TICKS_PER_GAME_HOUR));
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i] ?? 0, `sample ${i}`).toBeGreaterThanOrEqual(samples[i - 1] ?? 0);
    }
    expect(samples[0]).toBeLessThan(0.05);
    expect(samples[samples.length - 1]).toBe(1);
    // Smooth, not a step: mid-ramp light is neither 0 nor 1.
    const middle = lightLevelAt(tickAt(dayIndex, 0) + sunrise * TICKS_PER_GAME_HOUR);
    expect(middle).toBeGreaterThan(0.2);
    expect(middle).toBeLessThan(0.8);
  });

  it('falls smoothly through dusk', () => {
    const sunset = sunsetHourForDay(0);
    const before = lightLevelAt(Math.round((sunset - 1.5) * TICKS_PER_GAME_HOUR));
    const at = lightLevelAt(Math.round(sunset * TICKS_PER_GAME_HOUR));
    const after = lightLevelAt(Math.round((sunset + 1.5) * TICKS_PER_GAME_HOUR));
    expect(before).toBeGreaterThan(at);
    expect(at).toBeGreaterThan(after);
  });

  it('marks night only when the sun is effectively down', () => {
    expect(deriveWorldTime(tickAt(0, 0)).isNight).toBe(true);
    expect(deriveWorldTime(tickAt(0, 3)).isNight).toBe(true);
    expect(deriveWorldTime(tickAt(0, 12)).isNight).toBe(false);
    expect(deriveWorldTime(tickAt(0, 16)).isNight).toBe(false);
    expect(deriveWorldTime(tickAt(0, 23)).isNight).toBe(true);
  });

  it('gives winter short days and summer long ones', () => {
    const midSummer = DAYS_PER_SEASON * 1.5 - 0.5;
    const midWinter = DAYS_PER_SEASON * 3.5 - 0.5;
    const summerLength = sunsetHourForDay(midSummer) - sunriseHourForDay(midSummer);
    const winterLength = sunsetHourForDay(midWinter) - sunriseHourForDay(midWinter);
    expect(summerLength).toBeGreaterThan(winterLength + 5);
    expect(sunriseHourForDay(midWinter)).toBeGreaterThan(sunriseHourForDay(midSummer));
    expect(sunsetHourForDay(midWinter)).toBeLessThan(sunsetHourForDay(midSummer));
  });

  it('puts sunrise near 06:00 and sunset near 20:00 at the equinoxes', () => {
    const midSpring = DAYS_PER_SEASON * 0.5 - 0.5;
    expect(sunriseHourForDay(midSpring)).toBeCloseTo(6, 6);
    expect(sunsetHourForDay(midSpring)).toBeCloseTo(20, 6);
  });

  it('shifts the shoulders continuously, never in season-sized jumps', () => {
    const lastSpringDay = DAYS_PER_SEASON - 0.001;
    const firstSummerDay = DAYS_PER_SEASON;
    expect(
      Math.abs(sunriseHourForDay(firstSummerDay) - sunriseHourForDay(lastSpringDay)),
    ).toBeLessThan(0.01);
  });

  it('makes a full moon brighter than a new moon at the same hour', () => {
    const newMoonDay = 0;
    const fullMoonDay = Math.round(MOON_CYCLE_DAYS / 2);
    expect(moonPhase(newMoonDay)).toBe(0);
    expect(moonIllumination(newMoonDay)).toBe(0);
    expect(moonIllumination(fullMoonDay)).toBeGreaterThan(0.95);
    expect(lightLevelAt(tickAt(fullMoonDay, 0))).toBeGreaterThan(
      lightLevelAt(tickAt(newMoonDay, 0)),
    );
    expect(lightLevelAt(tickAt(fullMoonDay, 0))).toBeLessThanOrEqual(MOONLIGHT_MAX);
  });

  it('does not let the moon brighten the middle of the day', () => {
    const fullMoonDay = Math.round(MOON_CYCLE_DAYS / 2);
    expect(lightLevelAt(tickAt(fullMoonDay, 12))).toBe(1);
    expect(sunlightFactor(fullMoonDay, 12)).toBe(1);
  });

  it('cycles the moon back to new after MOON_CYCLE_DAYS', () => {
    expect(moonPhase(MOON_CYCLE_DAYS)).toBe(0);
    expect(moonIllumination(MOON_CYCLE_DAYS)).toBeCloseTo(0, 10);
  });
});

describe('weather dimming', () => {
  it('leaves a clear sky alone and darkens overcast, storm and fog', () => {
    expect(weatherLightMultiplier(weather({ type: 'clear', intensity: 0 }))).toBe(1);
    const overcast = weatherLightMultiplier(weather({ type: 'overcast', intensity: 1 }));
    const storm = weatherLightMultiplier(weather({ type: 'storm', intensity: 1 }));
    const fog = weatherLightMultiplier(weather({ type: 'fog', intensity: 1 }));
    expect(overcast).toBeLessThan(1);
    expect(fog).toBeLessThan(1);
    expect(storm).toBeLessThan(overcast);
    expect(storm).toBeGreaterThan(0);
  });

  it('scales the dimming with intensity', () => {
    const light = weatherLightMultiplier(weather({ type: 'rain', intensity: 0.2 }));
    const heavy = weatherLightMultiplier(weather({ type: 'rain', intensity: 1 }));
    expect(heavy).toBeLessThan(light);
    expect(weatherLightMultiplier(weather({ type: 'rain', intensity: 0 }))).toBe(1);
  });

  it('darkens noon when the state says storm', () => {
    const sim = timeOnly();
    sim.sim.state.weather.type = 'storm';
    sim.sim.state.weather.intensity = 1;
    stepTo(sim, tickAt(0, 12));
    expect(sim.sim.state.time.lightLevel).toBeLessThan(0.5);
    expect(sim.sim.state.time.lightLevel).toBeGreaterThan(0);
    // A dark storm is still not night: `isNight` follows the sun, not the clouds.
    expect(sim.sim.state.time.isNight).toBe(false);
  });

  it('never pushes the light level out of 0..1', () => {
    for (const type of ['clear', 'overcast', 'storm', 'fog', 'snow'] as const) {
      for (const intensity of [0, 0.5, 1, 2, -1]) {
        for (const hour of [0, 4, 6, 12, 18, 21, 23]) {
          const value = lightLevelAt(tickAt(3, hour), weather({ type, intensity }));
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('determinism and ranges', () => {
  it('produces identical clocks for identical ticks', () => {
    const a = timeOnly(11);
    const b = timeOnly(99);
    a.step(TICKS_PER_GAME_HOUR * 37);
    b.step(TICKS_PER_GAME_HOUR * 37);
    // The clock is a function of the tick alone, so even the seed cannot shift it.
    expect(a.sim.state.time).toEqual(b.sim.state.time);
  });

  it('stays in range for a month of ticks', () => {
    for (let tick = 0; tick <= TICKS_PER_GAME_DAY * 30; tick += 53) {
      const time = deriveWorldTime(tick, weather({ type: 'storm', intensity: 0.8 }));
      expect(Number.isNaN(time.lightLevel)).toBe(false);
      expect(time.hour).toBeGreaterThanOrEqual(0);
      expect(time.hour).toBeLessThanOrEqual(23);
      expect(time.minute).toBeGreaterThanOrEqual(0);
      expect(time.minute).toBeLessThanOrEqual(59);
      expect(time.lightLevel).toBeGreaterThanOrEqual(0);
      expect(time.lightLevel).toBeLessThanOrEqual(1);
      expect(time.day).toBe(dayIndexAt(tick) + 1);
      expect(['spring', 'summer', 'autumn', 'winter']).toContain(time.season);
    }
  });
});
