import { MAX_PENDING_INPUTS, RECONCILE_SNAP_DISTANCE } from '@survive/protocol';
import type { ButtonMask, InputFrame } from '@survive/protocol';

/**
 * Client-side prediction and reconciliation.
 *
 * The server is authoritative (Architecture Guard rule 4), so the client cannot wait
 * for it: at 100 ms of latency, moving only when the server says so feels broken.
 * Instead the client applies its own inputs immediately and remembers them. When the
 * authoritative state for input `n` arrives, it compares that state against what it
 * had predicted *for that same input*, and if they disagree it snaps to the server
 * and re-applies inputs `n+1..latest`. The player sees a small correction instead of
 * a rubber-band, and never sees input lag.
 *
 * This module owns none of the movement rules. The caller supplies a `step` function
 * — in practice a thin wrapper around the same movement maths the simulation uses —
 * which keeps this file free of both Phaser and the simulation package.
 */

/** The slice of player state prediction actually touches. Pixels and px/second. */
export interface PredictedState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** One input frame minus the sequence number, which the predictor allocates. */
export interface InputIntent {
  moveX: number;
  moveY: number;
  aimAngle: number;
  buttons: ButtonMask;
}

/**
 * Advance `state` by exactly one input frame, in place.
 *
 * Must be a pure function of (state, frame): the same pair has to produce the same
 * result every time it is replayed, or reconciliation will not converge.
 */
export type ReplayStep = (state: PredictedState, frame: InputFrame) => void;

/**
 * Positional error, in pixels, below which a mismatch is left alone.
 *
 * Correcting sub-pixel disagreements would replay the whole pending queue every
 * snapshot and jitter the sprite for no visible gain. Float drift between the
 * server's and the client's evaluation of the same maths lives well under this.
 */
export const DEFAULT_RECONCILE_EPSILON = 0.5;

export interface InputPredictorOptions {
  /** Unacknowledged frames to keep. Defaults to {@link MAX_PENDING_INPUTS}. */
  capacity?: number;
  /** Error dead zone in pixels. Defaults to {@link DEFAULT_RECONCILE_EPSILON}. */
  epsilon?: number;
  /** Error in pixels above which the client gives up and teleports. */
  snapDistance?: number;
  /** Starting predicted state. Copied, not aliased. */
  initial?: Readonly<PredictedState>;
  /** Weight of a fresh error sample in {@link InputPredictor.averageError}. */
  errorSmoothing?: number;
}

/** What one call to {@link InputPredictor.reconcile} did. */
export interface ReconcileResult {
  /** Distance in pixels between the prediction for `ackSeq` and the server's state. */
  error: number;
  /** Frames dropped because the server has now consumed them. */
  acknowledged: number;
  /** Frames re-applied on top of the authoritative state. */
  replayed: number;
  /** True when the predicted state was moved. */
  corrected: boolean;
  /** True when the error was so large that the client teleported. */
  hardSnapped: boolean;
  /** The live predicted state, after correction. */
  state: PredictedState;
}

/** A buffered frame together with where the client thought it ended up. */
interface PendingFrame {
  frame: InputFrame;
  /** Predicted position immediately after `frame` was applied. */
  x: number;
  y: number;
}

export class InputPredictor {
  /**
   * Fixed-size ring buffer.
   *
   * A plain array with `shift()` would reallocate on every acknowledgement, sixty
   * times a second, forever. The ring reuses its slots, and the cap doubles as the
   * same back-pressure rule the server applies: past MAX_PENDING_INPUTS in flight,
   * the oldest frame is the one that goes.
   */
  private readonly slots: (PendingFrame | undefined)[];
  private readonly capacityValue: number;
  private head = 0;
  private count = 0;

  private readonly epsilon: number;
  private readonly snapDistanceValue: number;
  private readonly errorSmoothing: number;

  private readonly state: PredictedState;
  private seqCounter = 0;
  private ackedSeq = 0;
  private lastError = 0;
  private smoothedError = 0;
  private corrections = 0;
  private hardSnaps = 0;
  private overflowed = 0;

  /**
   * Predicted position immediately *before* the oldest frame still in the buffer —
   * i.e. where the client believes it was as of the last frame the server has
   * consumed.
   *
   * This is the reference `reconcile` measures against when the acknowledged frame
   * itself is no longer buffered, which happens routinely: a snapshot arrives ten
   * times a second and repeats the same `ackSeq` whenever the server has not
   * consumed a new input since the last one. Falling back to the *newest* prediction
   * in that case would count every unacknowledged frame's legitimate movement as
   * error, replay the whole queue for nothing, and — once a stall pushed that phantom
   * error past `snapDistance` — teleport the player backwards and throw their pending
   * inputs away.
   */
  private baseX = 0;
  private baseY = 0;

  constructor(options: InputPredictorOptions = {}) {
    this.capacityValue = Math.max(1, Math.floor(options.capacity ?? MAX_PENDING_INPUTS));
    this.slots = new Array<PendingFrame | undefined>(this.capacityValue);
    this.epsilon = options.epsilon ?? DEFAULT_RECONCILE_EPSILON;
    this.snapDistanceValue = options.snapDistance ?? RECONCILE_SNAP_DISTANCE;
    this.errorSmoothing = options.errorSmoothing ?? 0.2;
    this.state = { x: 0, y: 0, vx: 0, vy: 0 };
    if (options.initial) copyState(this.state, options.initial);
    this.baseX = this.state.x;
    this.baseY = this.state.y;
  }

  /**
   * The live predicted state.
   *
   * Returned by reference on purpose: the client's movement code, the camera and the
   * local sprite all read the same object, and `reconcile` corrects it in place.
   */
  get predicted(): PredictedState {
    return this.state;
  }

  /**
   * Overwrite the prediction, e.g. from the welcome handshake or after a respawn.
   *
   * This is a teleport, so the acknowledged-position reference moves with it: the old
   * one described a place the player is no longer at.
   */
  setPredicted(state: Readonly<PredictedState>): void {
    copyState(this.state, state);
    this.baseX = this.state.x;
    this.baseY = this.state.y;
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get snapDistance(): number {
    return this.snapDistanceValue;
  }

  /** Sequence number the next frame will get. */
  get nextSeq(): number {
    return this.seqCounter + 1;
  }

  /** Highest sequence number the server has confirmed consuming. */
  get lastAckedSeq(): number {
    return this.ackedSeq;
  }

  /** Frames sent but not yet acknowledged. */
  get pendingCount(): number {
    return this.count;
  }

  /** Frames silently dropped because the client outran the server. Diagnostic. */
  get overflowCount(): number {
    return this.overflowed;
  }

  /** Distance in pixels the last reconciliation was off by. Feeds the netgraph. */
  get errorMagnitude(): number {
    return this.lastError;
  }

  /** Smoothed {@link errorMagnitude}, which is the readable version of the same. */
  get averageError(): number {
    return this.smoothedError;
  }

  /** Reconciliations that moved the player. */
  get correctionCount(): number {
    return this.corrections;
  }

  /** Reconciliations that teleported the player. */
  get hardSnapCount(): number {
    return this.hardSnaps;
  }

  /** Unacknowledged frames, oldest first. A copy; safe to hand to a send call. */
  pendingFrames(): InputFrame[] {
    const out: InputFrame[] = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacityValue];
      if (entry) out.push(entry.frame);
    }
    return out;
  }

  /** Allocate the next sequence number. Does not buffer or predict anything. */
  createFrame(intent: InputIntent): InputFrame {
    this.seqCounter++;
    return {
      seq: this.seqCounter,
      moveX: intent.moveX,
      moveY: intent.moveY,
      aimAngle: intent.aimAngle,
      buttons: intent.buttons,
    };
  }

  /**
   * Buffer `frame` and advance the prediction by it.
   *
   * The resulting position is stored alongside the frame so `reconcile` can measure
   * the error against the prediction for the exact frame the server acknowledged,
   * rather than against the newest prediction (which legitimately differs, because
   * it contains inputs the server has not seen yet).
   */
  apply(frame: InputFrame, step: ReplayStep): void {
    if (frame.seq > this.seqCounter) this.seqCounter = frame.seq;
    // With an empty queue the current position *is* the acknowledged one, and this
    // frame is about to become the oldest pending frame, so pin the reference here.
    if (this.count === 0) {
      this.baseX = this.state.x;
      this.baseY = this.state.y;
    }
    step(this.state, frame);
    this.push({ frame, x: this.state.x, y: this.state.y });
  }

  /**
   * {@link createFrame} + {@link apply}: the normal client call, once per
   * *simulation* tick.
   *
   * Not once per rendered frame. An {@link InputFrame} is one tick of continuous
   * input, so a 60 Hz caller would send three frames for every tick the server
   * consumes, permanently overflow the queue (its cap is `MAX_PENDING_INPUTS` = six
   * seconds at `SIM_HZ`) and make the server's back-pressure discard inputs the
   * player actually gave. Sample input at render rate, accumulate, and push here on
   * the fixed step.
   */
  pushInput(intent: InputIntent, step: ReplayStep): InputFrame {
    const frame = this.createFrame(intent);
    this.apply(frame, step);
    return frame;
  }

  /** Drop frames the server has consumed. Returns how many were dropped. */
  acknowledge(seq: number): number {
    if (seq > this.ackedSeq) this.ackedSeq = seq;
    let dropped = 0;
    while (this.count > 0) {
      const entry = this.slots[this.head];
      if (!entry || entry.frame.seq > seq) break;
      // The last frame dropped here is the newest one the server has consumed, so its
      // prediction becomes the acknowledged-position reference.
      this.baseX = entry.x;
      this.baseY = entry.y;
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.capacityValue;
      this.count--;
      dropped++;
    }
    return dropped;
  }

  /**
   * Fold an authoritative state into the prediction.
   *
   * @param authoritative Server state as of input `ackSeq`.
   * @param ackSeq        Highest input sequence the server has consumed.
   * @param replay        Step function used to re-apply the still-pending frames.
   */
  reconcile(
    authoritative: Readonly<PredictedState>,
    ackSeq: number,
    replay: ReplayStep,
  ): ReconcileResult {
    // Read the prediction for the acknowledged frame *before* dropping it.
    const { x: referenceX, y: referenceY } = this.referenceFor(ackSeq);
    const acknowledged = this.acknowledge(ackSeq);

    const error = Math.hypot(authoritative.x - referenceX, authoritative.y - referenceY);
    this.lastError = error;
    this.smoothedError += (error - this.smoothedError) * this.errorSmoothing;

    if (error > this.snapDistanceValue) {
      // Too far gone to hide: a teleport, a knockback the client never saw, or a
      // desynced movement rule. Accept the server wholesale and throw the pending
      // queue away — those intents were computed from a position that no longer
      // exists, and replaying them would only fight the next snapshot. The server
      // still applies the frames it already has, and the next snapshot re-converges.
      copyState(this.state, authoritative);
      // clearPending() re-pins the acknowledged-position reference to the state we
      // just adopted, which is exactly the authoritative one.
      this.clearPending();
      this.hardSnaps++;
      return {
        error,
        acknowledged,
        replayed: 0,
        corrected: true,
        hardSnapped: true,
        state: this.state,
      };
    }

    if (error <= this.epsilon) {
      return {
        error,
        acknowledged,
        replayed: 0,
        corrected: false,
        hardSnapped: false,
        state: this.state,
      };
    }

    copyState(this.state, authoritative);
    // The client now believes the server: the acknowledged position is the
    // authoritative one, and the replay below rebuilds everything after it.
    this.baseX = authoritative.x;
    this.baseY = authoritative.y;
    let replayed = 0;
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacityValue];
      if (!entry) continue;
      replay(this.state, entry.frame);
      // Keep the stored prediction in step, so the next reconciliation measures
      // against the corrected history rather than the discarded one.
      entry.x = this.state.x;
      entry.y = this.state.y;
      replayed++;
    }
    this.corrections++;
    return {
      error,
      acknowledged,
      replayed,
      corrected: true,
      hardSnapped: false,
      state: this.state,
    };
  }

  /** Drop every pending frame without touching the prediction. */
  clearPending(): void {
    this.slots.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.baseX = this.state.x;
    this.baseY = this.state.y;
  }

  /**
   * Full reset, including the sequence counter.
   *
   * Used on reconnect: the server starts counting this client's inputs from zero
   * again, so a client that kept its old counter would look permanently acknowledged.
   */
  reset(state?: Readonly<PredictedState>): void {
    this.seqCounter = 0;
    this.ackedSeq = 0;
    this.lastError = 0;
    this.smoothedError = 0;
    this.corrections = 0;
    this.hardSnaps = 0;
    this.overflowed = 0;
    if (state) copyState(this.state, state);
    // Last, so the reference lands on the state the caller asked for.
    this.clearPending();
  }

  private push(entry: PendingFrame): void {
    if (this.count === this.capacityValue) {
      // Buffer full: the server is not consuming as fast as we produce. Drop the
      // oldest, which is the one the server is least likely to still want.
      const evicted = this.slots[this.head];
      // The evicted frame's prediction is now the best "before the oldest pending
      // frame" position we have; without this the reference would lag behind by
      // however much movement the evicted frames contained.
      if (evicted) {
        this.baseX = evicted.x;
        this.baseY = evicted.y;
      }
      this.slots[this.head] = undefined;
      this.head = (this.head + 1) % this.capacityValue;
      this.count--;
      this.overflowed++;
    }
    this.slots[(this.head + this.count) % this.capacityValue] = entry;
    this.count++;
  }

  /**
   * Where the client thought it was as of input `ackSeq`.
   *
   * The buffer is in sequence order, so this is the prediction stored with the newest
   * buffered frame at or below `ackSeq` — the exact frame when it is still buffered,
   * the newest of them when the server has raced ahead of everything we kept, and the
   * standing acknowledged position when the server has consumed nothing new (in which
   * case every buffered frame is still in flight and none of them may count as error).
   */
  private referenceFor(ackSeq: number): { x: number; y: number } {
    let x = this.baseX;
    let y = this.baseY;
    for (let i = 0; i < this.count; i++) {
      const entry = this.slots[(this.head + i) % this.capacityValue];
      if (!entry) continue;
      if (entry.frame.seq > ackSeq) break;
      x = entry.x;
      y = entry.y;
    }
    return { x, y };
  }
}

function copyState(target: PredictedState, source: Readonly<PredictedState>): void {
  target.x = source.x;
  target.y = source.y;
  target.vx = source.vx;
  target.vy = source.vy;
}
