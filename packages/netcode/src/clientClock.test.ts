import { describe, expect, it } from 'vitest';
import { SIM_DT_MS } from '@survive/protocol';
import { ClientClock } from './clientClock';

function makeClock(
  options: { smoothing?: number; resyncThresholdTicks?: number; startMs?: number } = {},
) {
  let now = options.startMs ?? 0;
  const clock = new ClientClock({
    now: () => now,
    smoothing: options.smoothing ?? 0.5,
    ...(options.resyncThresholdTicks !== undefined
      ? { resyncThresholdTicks: options.resyncThresholdTicks }
      : {}),
  });
  return {
    clock,
    at(ms: number) {
      now = ms;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('ClientClock', () => {
  it('is unsynced until something anchors it', () => {
    // Deliberately a wall-clock-sized start time: an unanchored clock that simply
    // extrapolated from local time would report ~34 billion ticks here.
    const h = makeClock({ startMs: 1_700_000_000_000 });
    expect(h.clock.synced).toBe(false);
    expect(h.clock.serverTick).toBe(0);
    expect(h.clock.tick).toBe(0);
    expect(h.clock.interpolationAlpha).toBe(0);
    expect(h.clock.serverTimeMs).toBe(0);
    expect(h.clock.latencyMs).toBe(0);

    h.advance(5000);
    expect(h.clock.serverTick).toBe(0);
  });

  it('anchors correctly however far along the local clock is', () => {
    const h = makeClock({ startMs: 1_700_000_000_000 });
    h.clock.onWelcome({ tick: 40, serverTimeMs: 2000 });

    expect(h.clock.serverTick).toBeCloseTo(40, 6);
    h.advance(SIM_DT_MS * 10);
    expect(h.clock.serverTick).toBeCloseTo(50, 6);
    expect(h.clock.serverTimeMs).toBeCloseTo(2500, 6);
  });

  it('anchors on the welcome and advances with local time', () => {
    const h = makeClock();
    h.clock.onWelcome({ tick: 200, serverTimeMs: 10_000 });

    expect(h.clock.synced).toBe(true);
    expect(h.clock.serverTick).toBeCloseTo(200, 6);

    h.advance(SIM_DT_MS * 10);
    expect(h.clock.serverTick).toBeCloseTo(210, 6);
    expect(h.clock.tick).toBe(210);
    expect(h.clock.serverTimeMs).toBeCloseTo(10_500, 6);
  });

  it('exposes the fraction of a tick as the interpolation alpha', () => {
    const h = makeClock();
    h.clock.onWelcome({ tick: 5, serverTimeMs: 0 });

    h.advance(SIM_DT_MS * 0.75);
    expect(h.clock.tick).toBe(5);
    expect(h.clock.interpolationAlpha).toBeCloseTo(0.75, 6);

    h.advance(SIM_DT_MS * 0.5);
    expect(h.clock.tick).toBe(6);
    expect(h.clock.interpolationAlpha).toBeCloseTo(0.25, 6);
  });

  it('takes the first round-trip sample whole and blends later ones', () => {
    const h = makeClock({ smoothing: 0.5 });
    h.clock.onWelcome({ tick: 0, serverTimeMs: 0 });

    h.at(100);
    h.clock.onPong({ clientTimeMs: 0, serverTimeMs: 50, tick: 1 });
    expect(h.clock.latencyMs).toBeCloseTo(100, 6);
    expect(h.clock.halfLatencyMs).toBeCloseTo(50, 6);
    expect(h.clock.sampleCount).toBe(1);

    h.at(400);
    h.clock.onPong({ clientTimeMs: 100, serverTimeMs: 200, tick: 4 });
    expect(h.clock.latencyMs).toBeCloseTo(200, 6);
  });

  it('ages a pong by half its round trip', () => {
    const h = makeClock();
    h.at(200);
    // The server said "tick 10" 100 ms ago, so it is 2 ticks further along by now.
    h.clock.onPong({ clientTimeMs: 0, serverTimeMs: 100, tick: 10 });

    expect(h.clock.serverTick).toBeCloseTo(12, 6);
  });

  it('eases towards a disagreeing sample instead of snapping', () => {
    const h = makeClock({ smoothing: 0.5 });
    h.clock.onWelcome({ tick: 0, serverTimeMs: 0 });

    h.at(1000);
    h.clock.onServerTick(30, 1500);

    // Extrapolation said 20; the sample says 30; half the difference is applied.
    expect(h.clock.serverTick).toBeCloseTo(25, 6);
    expect(h.clock.driftTicks).toBeCloseTo(10, 6);
  });

  it('re-anchors outright when the drift is too large to ease away', () => {
    const h = makeClock({ smoothing: 0.5, resyncThresholdTicks: 20 });
    h.clock.onWelcome({ tick: 0, serverTimeMs: 0 });

    // Process suspended: local time ran on but the server is 2000 ticks ahead.
    h.at(1000);
    h.clock.onServerTick(2000, 100_000);

    expect(h.clock.serverTick).toBeCloseTo(2000, 6);
  });

  it('discards an impossible round trip rather than poisoning the average', () => {
    const h = makeClock({ smoothing: 1 });
    h.at(1_000_000);
    h.clock.onPong({ clientTimeMs: 0, serverTimeMs: 0, tick: 0 });

    // Clamped to maxRttMs (5 s by default), not a million milliseconds.
    expect(h.clock.latencyMs).toBe(5000);
  });

  it('treats a pong from the future as zero latency', () => {
    const h = makeClock();
    h.at(0);
    h.clock.onPong({ clientTimeMs: 500, serverTimeMs: 0, tick: 0 });

    expect(h.clock.latencyMs).toBe(0);
  });

  it('forgets everything on reset', () => {
    const h = makeClock({ startMs: 60_000 });
    h.clock.onWelcome({ tick: 500, serverTimeMs: 1000 });
    h.clock.reset();

    expect(h.clock.synced).toBe(false);
    expect(h.clock.sampleCount).toBe(0);
    expect(h.clock.serverTick).toBe(0);
    expect(h.clock.serverTimeMs).toBe(0);

    // And it re-anchors cleanly afterwards rather than drifting from the stale anchor.
    h.advance(1000);
    h.clock.onWelcome({ tick: 20, serverTimeMs: 500 });
    expect(h.clock.serverTick).toBeCloseTo(20, 6);
  });
});
