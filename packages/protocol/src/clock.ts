import { SIM_DT, SIM_DT_MS, SIM_HZ } from './constants';

/**
 * Fixed-step simulation clock.
 *
 * Game logic never reads the wall clock. It reads `tick` (an integer count of fixed
 * steps) and is advanced explicitly. Tests can therefore fast-forward ten in-game
 * hours without waiting, and a replay of the same tick count produces the same state.
 *
 * The server drives this from a real timer via {@link FixedStepDriver}; tests drive it
 * by calling {@link SimulationClock.advance} directly.
 */
export class SimulationClock {
  private currentTick: number;

  constructor(startTick = 0) {
    this.currentTick = startTick;
  }

  /** Current tick index. Monotonic, integer. */
  get tick(): number {
    return this.currentTick;
  }

  /** Fixed timestep in seconds. */
  get dt(): number {
    return SIM_DT;
  }

  /** Simulated seconds elapsed since tick 0. */
  get elapsedSeconds(): number {
    return this.currentTick * SIM_DT;
  }

  /** Simulated milliseconds elapsed since tick 0. */
  get elapsedMs(): number {
    return this.currentTick * SIM_DT_MS;
  }

  /** Advance by `ticks` steps. */
  advance(ticks = 1): void {
    if (ticks < 0) throw new RangeError('SimulationClock cannot run backwards');
    this.currentTick += Math.floor(ticks);
  }

  /** Restore a saved tick count. */
  setTick(tick: number): void {
    this.currentTick = Math.max(0, Math.floor(tick));
  }

  /** Convert seconds to a whole number of ticks (rounded, at least 1 for positives). */
  static secondsToTicks(seconds: number): number {
    if (seconds <= 0) return 0;
    return Math.max(1, Math.round(seconds * SIM_HZ));
  }

  static ticksToSeconds(ticks: number): number {
    return ticks * SIM_DT;
  }
}

/** Convert seconds to ticks without needing a clock instance. */
export function secondsToTicks(seconds: number): number {
  return SimulationClock.secondsToTicks(seconds);
}

/** Convert ticks to seconds without needing a clock instance. */
export function ticksToSeconds(ticks: number): number {
  return SimulationClock.ticksToSeconds(ticks);
}

/** Injectable source of real time, so the driver itself stays testable. */
export type TimeSource = () => number;

export interface FixedStepDriverOptions {
  /** Called once per fixed step. */
  step: () => void;
  /** Real-time source in milliseconds. Defaults to `performance.now`. */
  now?: TimeSource;
  /**
   * Upper bound on steps executed in one pump. Prevents a stalled process from
   * running thousands of catch-up ticks and stalling further.
   */
  maxCatchUpSteps?: number;
}

/**
 * Turns irregular real-time pumps into an exact number of fixed steps.
 *
 * Owned by the server loop. The simulation itself never sees this class, which is
 * what keeps headless tests free of timers.
 */
export class FixedStepDriver {
  private readonly step: () => void;
  private readonly now: TimeSource;
  private readonly maxCatchUpSteps: number;
  private accumulatorMs = 0;
  private lastMs: number | null = null;
  /** Steps skipped because the process fell too far behind. */
  private droppedSteps = 0;

  constructor(options: FixedStepDriverOptions) {
    this.step = options.step;
    this.now =
      options.now ??
      (typeof performance !== 'undefined'
        ? () => performance.now()
        : () => Number(process.hrtime.bigint() / 1_000_000n));
    this.maxCatchUpSteps = options.maxCatchUpSteps ?? 8;
  }

  get dropped(): number {
    return this.droppedSteps;
  }

  /** Fractional progress towards the next step, 0..1. Useful for render smoothing. */
  get alpha(): number {
    return this.accumulatorMs / SIM_DT_MS;
  }

  /** Reset timing state, e.g. after unpausing. */
  reset(): void {
    this.lastMs = null;
    this.accumulatorMs = 0;
  }

  /** Run however many fixed steps real time has earned. Returns the count executed. */
  pump(): number {
    const now = this.now();
    if (this.lastMs === null) {
      this.lastMs = now;
      return 0;
    }
    this.accumulatorMs += now - this.lastMs;
    this.lastMs = now;

    let steps = 0;
    while (this.accumulatorMs >= SIM_DT_MS && steps < this.maxCatchUpSteps) {
      this.accumulatorMs -= SIM_DT_MS;
      this.step();
      steps++;
    }
    if (this.accumulatorMs >= SIM_DT_MS) {
      // Too far behind to catch up; drop the backlog rather than spiral.
      this.droppedSteps += Math.floor(this.accumulatorMs / SIM_DT_MS);
      this.accumulatorMs = 0;
    }
    return steps;
  }
}
