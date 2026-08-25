import { clamp01, SIM_DT_MS } from '@survive/protocol';
import type { PongPayload, WelcomePayload } from '@survive/protocol';

/**
 * Client-side estimate of "what tick is the server on right now?".
 *
 * The client never simulates authoritatively, but it still needs the server's tick:
 * to label the inputs it sends, to pick the render time for interpolation, and to
 * show a netgraph. Three things make that estimate awkward:
 *
 * 1. Every sample we get is stale by roughly half a round trip.
 * 2. Samples are noisy, so using the newest one directly makes the estimate jitter.
 * 3. Between samples we have nothing but local wall time, which drifts.
 *
 * So the clock keeps an *anchor* (a server tick paired with the local time it was
 * believed to be true) and extrapolates from it with the local clock. Each new
 * sample eases the anchor towards the measurement instead of snapping to it, which
 * turns a noisy sequence into a smoothly moving estimate. A sample that disagrees
 * wildly (process suspended, laptop lid closed, server restarted) is applied whole:
 * easing towards it would take minutes.
 *
 * Wall-clock use is deliberate and legal here — this is the *client's* view of the
 * network, not simulation code. The simulation reads {@link SimulationClock}.
 */
export interface ClientClockOptions {
  /** Milliseconds of real time per simulation tick. Defaults to {@link SIM_DT_MS}. */
  tickIntervalMs?: number;
  /** Monotonic millisecond time source. Injected by tests. */
  now?: () => number;
  /**
   * Weight given to each fresh sample, 0..1. Low values are smooth but slow to
   * follow a genuine change in latency; 0.1 converges in roughly 20 samples.
   */
  smoothing?: number;
  /** Drift, in ticks, beyond which the clock re-anchors instead of easing. */
  resyncThresholdTicks?: number;
  /**
   * Round trips longer than this are treated as garbage rather than latency, so one
   * pong that came back after a stall cannot poison the average.
   */
  maxRttMs?: number;
}

/** Real-time source that prefers the monotonic clock where one exists. */
export function defaultTimeSource(): () => number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return () => performance.now();
  }
  return () => Date.now();
}

export class ClientClock {
  private readonly tickIntervalMsValue: number;
  private readonly nowFn: () => number;
  private readonly smoothing: number;
  private readonly resyncThresholdTicks: number;
  private readonly maxRttMs: number;

  /** Server tick believed correct at {@link anchorLocalMs}. Fractional on purpose. */
  private anchorTick = 0;
  private anchorLocalMs = 0;
  /** Server wall-clock believed correct at {@link anchorLocalMs}. */
  private anchorServerTimeMs = 0;

  private rttMs = 0;
  private lastDriftTicks = 0;
  private samples = 0;
  private hasAnchor = false;

  constructor(options: ClientClockOptions = {}) {
    this.tickIntervalMsValue = options.tickIntervalMs ?? SIM_DT_MS;
    this.nowFn = options.now ?? defaultTimeSource();
    this.smoothing = clamp01(options.smoothing ?? 0.1);
    this.resyncThresholdTicks = options.resyncThresholdTicks ?? 20;
    this.maxRttMs = options.maxRttMs ?? 5000;
  }

  /** The clock's own time source. Ping timestamps must come from here. */
  now(): number {
    return this.nowFn();
  }

  get tickIntervalMs(): number {
    return this.tickIntervalMsValue;
  }

  /** True once a welcome or a pong has anchored the estimate. */
  get synced(): boolean {
    return this.hasAnchor;
  }

  /** Smoothed round-trip time in milliseconds. This is what a netgraph shows. */
  get latencyMs(): number {
    return this.rttMs;
  }

  /** Smoothed one-way delay estimate. Assumes a symmetric route. */
  get halfLatencyMs(): number {
    return this.rttMs / 2;
  }

  /** Ticks the last sample disagreed with the extrapolated estimate. Diagnostic. */
  get driftTicks(): number {
    return this.lastDriftTicks;
  }

  /** How many samples have been folded in. Zero means the estimate is a guess. */
  get sampleCount(): number {
    return this.samples;
  }

  /** Fractional server tick right now. */
  get serverTick(): number {
    return this.tickAt(this.nowFn());
  }

  /** Whole server tick right now, never negative. */
  get tick(): number {
    return Math.max(0, Math.floor(this.serverTick));
  }

  /**
   * Progress from the current server tick towards the next one, 0..1.
   * The renderer uses this to smooth entities that move one tick at a time.
   */
  get interpolationAlpha(): number {
    const tick = this.serverTick;
    const alpha = tick - Math.floor(tick);
    return clamp01(alpha);
  }

  /** Estimated server wall clock in milliseconds, or 0 while {@link synced} is false. */
  get serverTimeMs(): number {
    if (!this.hasAnchor) return 0;
    return this.anchorServerTimeMs + (this.nowFn() - this.anchorLocalMs);
  }

  /**
   * Fractional server tick as of a specific local timestamp.
   *
   * Zero until the first sample anchors the clock. Without that guard the estimate
   * would be `localMs / tickIntervalMs` measured from an anchor at local time zero —
   * with a wall-clock source that is some 34 billion ticks, and with
   * `performance.now()` it is however long the page has been open. Callers that care
   * whether the number means anything check {@link synced}; callers that do not get a
   * harmless zero instead of a plausible-looking lie.
   */
  tickAt(localMs: number): number {
    if (!this.hasAnchor) return 0;
    return this.anchorTick + (localMs - this.anchorLocalMs) / this.tickIntervalMsValue;
  }

  /**
   * Anchor on the handshake. The welcome carries no round-trip information, so the
   * first estimate is short by one one-way delay; the first pong fixes that.
   */
  onWelcome(payload: Pick<WelcomePayload, 'tick' | 'serverTimeMs'>): void {
    this.applySample(payload.tick, payload.serverTimeMs, this.halfLatencyMs, true);
  }

  /** Fold in a latency probe. `clientTimeMs` must have come from {@link now}. */
  onPong(payload: PongPayload): void {
    const local = this.nowFn();
    const rtt = Math.min(this.maxRttMs, Math.max(0, local - payload.clientTimeMs));
    // First measurement has nothing to blend with, so take it whole.
    this.rttMs = this.samples === 0 ? rtt : this.rttMs + (rtt - this.rttMs) * this.smoothing;
    this.samples++;
    this.applySample(payload.tick, payload.serverTimeMs, rtt / 2, false, local);
  }

  /**
   * Fold in the tick carried by a snapshot.
   *
   * Snapshots arrive at the snapshot rate, far more often than anyone should ping, so
   * they are the main thing keeping the estimate honest. They carry no round-trip
   * measurement, so the standing latency estimate is used to age them.
   */
  onServerTick(tick: number, serverTimeMs = this.serverTimeMs): void {
    this.applySample(tick, serverTimeMs, this.halfLatencyMs, false);
  }

  /** Forget everything. Used when a reconnect lands on a different world. */
  reset(): void {
    this.anchorTick = 0;
    this.anchorLocalMs = 0;
    this.anchorServerTimeMs = 0;
    this.rttMs = 0;
    this.lastDriftTicks = 0;
    this.samples = 0;
    this.hasAnchor = false;
  }

  /**
   * Move the anchor towards a measurement.
   *
   * `oneWayMs` is how stale the sample is: the server was at `serverTick` that long
   * ago, so it is further along by now.
   */
  private applySample(
    serverTick: number,
    serverTimeMs: number,
    oneWayMs: number,
    authoritative: boolean,
    localMs = this.nowFn(),
  ): void {
    const measured = serverTick + oneWayMs / this.tickIntervalMsValue;

    if (!this.hasAnchor || authoritative) {
      this.lastDriftTicks = 0;
      this.anchorTick = measured;
      this.anchorLocalMs = localMs;
      this.anchorServerTimeMs = serverTimeMs + oneWayMs;
      this.hasAnchor = true;
      return;
    }

    const extrapolated = this.tickAt(localMs);
    const extrapolatedServerNow = this.anchorServerTimeMs + (localMs - this.anchorLocalMs);
    const drift = measured - extrapolated;
    this.lastDriftTicks = drift;

    // A large disagreement is not noise; easing towards it would rubber-band for
    // seconds. Take it whole and let the next samples smooth from there.
    const blend = Math.abs(drift) > this.resyncThresholdTicks ? 1 : this.smoothing;
    const serverNow = serverTimeMs + oneWayMs;

    this.anchorTick = extrapolated + drift * blend;
    this.anchorServerTimeMs = extrapolatedServerNow + (serverNow - extrapolatedServerNow) * blend;
    this.anchorLocalMs = localMs;
  }
}
