import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_INPUTS,
  RECONCILE_SNAP_DISTANCE,
  SIM_DT,
  TICKS_PER_SNAPSHOT,
} from '@survive/protocol';
import type { InputFrame } from '@survive/protocol';
import { DEFAULT_RECONCILE_EPSILON, InputPredictor } from './predictor';
import type { InputIntent, PredictedState } from './predictor';

/**
 * Deliberately trivial movement: 10 px per frame of held input, no acceleration and
 * no friction. Replay results are then exact integers, so a failing assertion points
 * at the reconciler rather than at floating point.
 */
const PX_PER_FRAME = 10;

function step(state: PredictedState, frame: InputFrame): void {
  state.vx = frame.moveX * PX_PER_FRAME;
  state.vy = frame.moveY * PX_PER_FRAME;
  state.x += state.vx;
  state.y += state.vy;
}

const right: InputIntent = { moveX: 1, moveY: 0, aimAngle: 0, buttons: 0 };

function pushFrames(predictor: InputPredictor, count: number): void {
  for (let i = 0; i < count; i++) predictor.pushInput(right, step);
}

describe('InputPredictor', () => {
  it('allocates monotonic sequence numbers and predicts immediately', () => {
    const predictor = new InputPredictor();
    const first = predictor.pushInput(right, step);
    const second = predictor.pushInput(right, step);

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(predictor.nextSeq).toBe(3);
    expect(predictor.predicted.x).toBe(20);
    expect(predictor.pendingCount).toBe(2);
  });

  it('drops frames the server has acknowledged', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);

    const result = predictor.reconcile({ x: 30, y: 0, vx: 10, vy: 0 }, 3, step);

    expect(result.acknowledged).toBe(3);
    expect(predictor.lastAckedSeq).toBe(3);
    expect(predictor.pendingCount).toBe(2);
    expect(predictor.pendingFrames().map((frame) => frame.seq)).toEqual([4, 5]);
  });

  it('measures error against the prediction for the acknowledged frame', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);

    // The newest prediction is x=50, but the server has only consumed 3 frames, so
    // agreeing at x=30 means zero error - not 20 px of it.
    const result = predictor.reconcile({ x: 30, y: 0, vx: 10, vy: 0 }, 3, step);

    expect(result.error).toBe(0);
    expect(result.corrected).toBe(false);
    expect(predictor.errorMagnitude).toBe(0);
    expect(predictor.predicted.x).toBe(50);
  });

  it('ignores disagreement inside the epsilon dead zone', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);

    const drift = DEFAULT_RECONCILE_EPSILON / 2;
    const result = predictor.reconcile({ x: 30 + drift, y: 0, vx: 10, vy: 0 }, 3, step);

    expect(result.corrected).toBe(false);
    expect(result.replayed).toBe(0);
    expect(predictor.predicted.x).toBe(50);
    expect(predictor.correctionCount).toBe(0);
  });

  it('snaps to the authoritative state and replays the unacked frames', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);

    const result = predictor.reconcile({ x: 35, y: 0, vx: 10, vy: 0 }, 3, step);

    expect(result.error).toBe(5);
    expect(result.corrected).toBe(true);
    expect(result.hardSnapped).toBe(false);
    expect(result.replayed).toBe(2);
    // 35 (server) + two replayed frames of 10 px.
    expect(predictor.predicted.x).toBe(55);
    expect(predictor.pendingCount).toBe(2);
    expect(predictor.correctionCount).toBe(1);
  });

  it('keeps replayed frames consistent for the next reconciliation', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);
    predictor.reconcile({ x: 35, y: 0, vx: 10, vy: 0 }, 3, step);

    // Frame 4's stored prediction was rewritten to 45 during the replay, so a server
    // that now agrees at 45 must report no further error.
    const result = predictor.reconcile({ x: 45, y: 0, vx: 10, vy: 0 }, 4, step);

    expect(result.error).toBe(0);
    expect(result.corrected).toBe(false);
    expect(predictor.pendingCount).toBe(1);
  });

  it('hard-snaps without replaying past RECONCILE_SNAP_DISTANCE', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);

    const authoritative = { x: 30 + RECONCILE_SNAP_DISTANCE + 1, y: 0, vx: 0, vy: 0 };
    const result = predictor.reconcile(authoritative, 3, step);

    expect(result.hardSnapped).toBe(true);
    expect(result.corrected).toBe(true);
    expect(result.replayed).toBe(0);
    expect(predictor.predicted.x).toBe(authoritative.x);
    expect(predictor.predicted.vx).toBe(0);
    // The queued intents were computed from a position that no longer exists.
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.hardSnapCount).toBe(1);
  });

  it('stays exactly at the snap threshold instead of teleporting', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);

    const result = predictor.reconcile(
      { x: 30 + RECONCILE_SNAP_DISTANCE, y: 0, vx: 10, vy: 0 },
      3,
      step,
    );

    expect(result.hardSnapped).toBe(false);
    expect(result.replayed).toBe(2);
  });

  it('caps the ring buffer at MAX_PENDING_INPUTS and drops the oldest frame', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, MAX_PENDING_INPUTS + 5);

    const pending = predictor.pendingFrames();
    expect(predictor.pendingCount).toBe(MAX_PENDING_INPUTS);
    expect(pending).toHaveLength(MAX_PENDING_INPUTS);
    expect(pending[0]?.seq).toBe(6);
    expect(pending[pending.length - 1]?.seq).toBe(MAX_PENDING_INPUTS + 5);
    expect(predictor.overflowCount).toBe(5);
    // Prediction is unaffected by buffer eviction.
    expect(predictor.predicted.x).toBe((MAX_PENDING_INPUTS + 5) * PX_PER_FRAME);
  });

  it('reuses ring slots after wrapping around', () => {
    const predictor = new InputPredictor({ capacity: 4 });
    pushFrames(predictor, 3);
    predictor.reconcile({ x: 20, y: 0, vx: 10, vy: 0 }, 2, step);
    pushFrames(predictor, 3);

    expect(predictor.pendingCount).toBe(4);
    expect(predictor.pendingFrames().map((frame) => frame.seq)).toEqual([3, 4, 5, 6]);
  });

  it('falls back to the acknowledged position when the acked frame is gone', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 2);
    predictor.reconcile({ x: 20, y: 0, vx: 10, vy: 0 }, 2, step);

    // Nothing pending: the acknowledged position is the current prediction.
    const result = predictor.reconcile({ x: 20, y: 0, vx: 10, vy: 0 }, 2, step);
    expect(result.error).toBe(0);
    expect(result.acknowledged).toBe(0);
  });

  it('reports no error when a snapshot repeats an ackSeq it already reported', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 10);
    expect(predictor.reconcile({ x: 50, y: 0, vx: 10, vy: 0 }, 5, step).error).toBe(0);

    // The server consumed nothing new (input backlog, a dropped packet) but keeps
    // snapshotting. Frames 6..15 are still in flight, so their movement is not error.
    pushFrames(predictor, 5);
    const stalled = predictor.reconcile({ x: 50, y: 0, vx: 10, vy: 0 }, 5, step);

    expect(stalled.error).toBe(0);
    expect(stalled.corrected).toBe(false);
    expect(stalled.replayed).toBe(0);
    expect(predictor.predicted.x).toBe(150);
    expect(predictor.pendingCount).toBe(10);
  });

  it('does not hard-snap backwards when an ack stall outruns the snap distance', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);
    predictor.reconcile({ x: 50, y: 0, vx: 10, vy: 0 }, 5, step);

    // Enough unacknowledged movement that measuring it as error would teleport the
    // player back to x=50 and bin the frames the server is about to consume.
    const stalled = Math.ceil(RECONCILE_SNAP_DISTANCE / PX_PER_FRAME) + 1;
    pushFrames(predictor, stalled);
    const result = predictor.reconcile({ x: 50, y: 0, vx: 10, vy: 0 }, 5, step);

    expect(result.error).toBe(0);
    expect(result.hardSnapped).toBe(false);
    expect(predictor.hardSnapCount).toBe(0);
    expect(predictor.pendingCount).toBe(stalled);
    expect(predictor.predicted.x).toBe(50 + stalled * PX_PER_FRAME);
  });

  it('still corrects a repeated ackSeq whose authoritative position moved', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 8);
    predictor.reconcile({ x: 50, y: 0, vx: 10, vy: 0 }, 5, step);

    // Same ackSeq, different place: the server pushed the player (knockback, a shove)
    // without consuming an input. That is real error and must be applied.
    const result = predictor.reconcile({ x: 90, y: 0, vx: 10, vy: 0 }, 5, step);

    expect(result.error).toBe(40);
    expect(result.corrected).toBe(true);
    expect(result.replayed).toBe(3);
    expect(predictor.predicted.x).toBe(120);
  });

  it('keeps the reference honest when the ring evicted the acked frame', () => {
    const predictor = new InputPredictor({ capacity: 4 });
    // Frames 1 and 2 are evicted; the prediction after frame 2 was x=20.
    pushFrames(predictor, 6);
    expect(predictor.overflowCount).toBe(2);

    // The server has only consumed frame 2, which is no longer buffered.
    const result = predictor.reconcile({ x: 20, y: 0, vx: 10, vy: 0 }, 2, step);

    expect(result.error).toBe(0);
    expect(result.corrected).toBe(false);
    expect(predictor.pendingCount).toBe(4);
  });

  it('measures against the newest kept frame when the server races ahead', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 3);

    // ackSeq is beyond everything we ever sent: the reference is the newest
    // prediction (x=30), so agreeing there is zero error and the queue empties.
    const result = predictor.reconcile({ x: 30, y: 0, vx: 10, vy: 0 }, 99, step);

    expect(result.error).toBe(0);
    expect(result.acknowledged).toBe(3);
    expect(predictor.pendingCount).toBe(0);
  });

  it('resets the sequence counter, because the server restarts counting too', () => {
    const predictor = new InputPredictor();
    pushFrames(predictor, 5);
    predictor.reset({ x: 100, y: 200, vx: 0, vy: 0 });

    expect(predictor.pendingCount).toBe(0);
    expect(predictor.lastAckedSeq).toBe(0);
    expect(predictor.nextSeq).toBe(1);
    expect(predictor.predicted).toEqual({ x: 100, y: 200, vx: 0, vy: 0 });
    expect(predictor.pushInput(right, step).seq).toBe(1);
  });

  it('tracks a smoothed error for the netgraph', () => {
    const predictor = new InputPredictor({ errorSmoothing: 0.5 });
    pushFrames(predictor, 2);
    predictor.reconcile({ x: 10 + 4, y: 0, vx: 10, vy: 0 }, 1, step);

    expect(predictor.errorMagnitude).toBe(4);
    expect(predictor.averageError).toBe(2);
  });

  it('accepts caller-built frames through apply()', () => {
    const predictor = new InputPredictor();
    predictor.apply({ seq: 7, moveX: 0, moveY: 1, aimAngle: 0, buttons: 0 }, step);

    expect(predictor.predicted.y).toBe(10);
    expect(predictor.nextSeq).toBe(8);
    expect(predictor.pendingFrames().map((frame) => frame.seq)).toEqual([7]);
  });
});

/**
 * The unit tests above poke one behaviour at a time. This one runs the loop the
 * client actually runs — one input per simulation tick, a snapshot every
 * TICKS_PER_SNAPSHOT ticks, 100 ms of round trip — against a "server" applying the
 * same movement maths. Prediction that is right must cost zero corrections.
 */
describe('InputPredictor over a simulated session', () => {
  const SPEED = 200; // px/s
  const ONE_WAY_TICKS = 2; // 100 ms at SIM_HZ = 20

  function tickStep(state: PredictedState, frame: InputFrame): void {
    state.vx = frame.moveX * SPEED;
    state.vy = frame.moveY * SPEED;
    state.x += state.vx * SIM_DT;
    state.y += state.vy * SIM_DT;
  }

  it('never corrects while the server agrees, at protocol rates', () => {
    const predictor = new InputPredictor();
    const server: PredictedState = { x: 0, y: 0, vx: 0, vy: 0 };
    const inFlight: InputFrame[] = [];
    let ackSeq = 0;

    for (let tick = 0; tick < 200; tick++) {
      inFlight.push(predictor.pushInput(right, tickStep));

      if (tick >= ONE_WAY_TICKS) {
        const consumed = inFlight.shift();
        if (consumed) {
          tickStep(server, consumed);
          ackSeq = consumed.seq;
        }
      }

      if (tick > 4 && tick % TICKS_PER_SNAPSHOT === 0) {
        const result = predictor.reconcile({ ...server }, ackSeq, tickStep);
        expect(result.error).toBeLessThan(1e-9);
        expect(result.hardSnapped).toBe(false);
      }
    }

    expect(predictor.correctionCount).toBe(0);
    expect(predictor.hardSnapCount).toBe(0);
    // Only the frames still crossing the wire stay queued.
    expect(predictor.pendingCount).toBeLessThanOrEqual(ONE_WAY_TICKS + 1);
  });
});
