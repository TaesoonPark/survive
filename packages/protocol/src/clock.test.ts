import { describe, expect, it } from 'vitest';
import { FixedStepDriver, SimulationClock, secondsToTicks, ticksToSeconds } from './clock';
import { SIM_DT_MS, SIM_HZ } from './constants';

describe('SimulationClock', () => {
  it('starts at zero and advances by whole ticks', () => {
    const clock = new SimulationClock();
    expect(clock.tick).toBe(0);
    clock.advance();
    expect(clock.tick).toBe(1);
    clock.advance(99);
    expect(clock.tick).toBe(100);
  });

  it('fast-forwards without waiting on real time', () => {
    const clock = new SimulationClock();
    clock.advance(SIM_HZ * 60 * 60 * 10); // ten hours of simulation
    expect(clock.elapsedSeconds).toBeCloseTo(36000, 6);
  });

  it('refuses to run backwards', () => {
    const clock = new SimulationClock(10);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(clock.tick).toBe(10);
  });

  it('truncates fractional advances rather than drifting', () => {
    const clock = new SimulationClock();
    clock.advance(2.9);
    expect(clock.tick).toBe(2);
  });

  it('restores a saved tick', () => {
    const clock = new SimulationClock();
    clock.setTick(4242);
    expect(clock.tick).toBe(4242);
    clock.setTick(-5);
    expect(clock.tick).toBe(0);
  });

  it('converts between seconds and ticks consistently', () => {
    expect(secondsToTicks(1)).toBe(SIM_HZ);
    expect(secondsToTicks(0)).toBe(0);
    expect(secondsToTicks(-3)).toBe(0);
    // A tiny positive duration still costs at least one tick.
    expect(secondsToTicks(0.0001)).toBe(1);
    expect(ticksToSeconds(SIM_HZ)).toBeCloseTo(1, 10);
  });
});

describe('FixedStepDriver', () => {
  function makeDriver(maxCatchUpSteps?: number) {
    let now = 1000;
    let steps = 0;
    const driver = new FixedStepDriver({
      step: () => {
        steps++;
      },
      now: () => now,
      ...(maxCatchUpSteps !== undefined ? { maxCatchUpSteps } : {}),
    });
    return {
      driver,
      advance: (ms: number) => {
        now += ms;
      },
      get steps() {
        return steps;
      },
    };
  }

  it('runs no steps on the first pump, which only establishes a baseline', () => {
    const harness = makeDriver();
    expect(harness.driver.pump()).toBe(0);
    expect(harness.steps).toBe(0);
  });

  it('runs exactly the number of steps real time earned', () => {
    const harness = makeDriver();
    harness.driver.pump();
    harness.advance(SIM_DT_MS * 3);
    expect(harness.driver.pump()).toBe(3);
    expect(harness.steps).toBe(3);
  });

  it('carries the remainder rather than losing it', () => {
    const harness = makeDriver();
    harness.driver.pump();
    harness.advance(SIM_DT_MS * 0.6);
    expect(harness.driver.pump()).toBe(0);
    harness.advance(SIM_DT_MS * 0.6);
    expect(harness.driver.pump()).toBe(1);
  });

  it('caps catch-up and records what it dropped instead of spiralling', () => {
    const harness = makeDriver(4);
    harness.driver.pump();
    harness.advance(SIM_DT_MS * 100);
    expect(harness.driver.pump()).toBe(4);
    expect(harness.driver.dropped).toBeGreaterThan(90);
    // The next pump starts clean, not from a backlog.
    harness.advance(SIM_DT_MS);
    expect(harness.driver.pump()).toBe(1);
  });

  it('reports the fractional progress towards the next step', () => {
    const harness = makeDriver();
    harness.driver.pump();
    harness.advance(SIM_DT_MS * 0.5);
    harness.driver.pump();
    expect(harness.driver.alpha).toBeCloseTo(0.5, 5);
  });

  it('reset drops the accumulated time, for unpausing', () => {
    const harness = makeDriver();
    harness.driver.pump();
    harness.advance(SIM_DT_MS * 5);
    harness.driver.reset();
    expect(harness.driver.pump()).toBe(0);
    expect(harness.steps).toBe(0);
  });
});
