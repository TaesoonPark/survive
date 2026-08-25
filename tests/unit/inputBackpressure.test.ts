import { describe, expect, it } from 'vitest';
import type { InputFrame } from '@survive/protocol';
import { createTestSimulation } from '@survive/test-utils';

/**
 * The server must not queue the same input twice.
 *
 * The client resends every frame the server has not acknowledged yet - on purpose, so a
 * dropped packet does not cost a movement step. Acks ride on snapshots at 10 Hz while
 * frames are produced at 20 Hz, so a frame is legitimately sent several times before its
 * ack returns.
 *
 * That makes de-duplication load-bearing. Guarding against the last *consumed* sequence
 * instead of the highest *accepted* one let every still-queued frame back in on each
 * resend: the queue filled with copies, the server spent a tick on each copy, and it ran
 * seconds behind the player's actual intent. What that looks like in the game is the
 * character barely moving while the key is held, then continuing to walk for a second after
 * it is released - which reads as latency and is not.
 */
describe('input backpressure', () => {
  function frame(seq: number): InputFrame {
    return { seq, moveX: 1, moveY: 0, aimAngle: 0, buttons: 0 };
  }

  it('ignores a resend of frames already queued', () => {
    const sim = createTestSimulation({ systems: [] });
    const player = sim.addPlayer();

    sim.sim.pushInput(player.id, [frame(1), frame(2), frame(3)]);
    expect(sim.sim.pendingInputCount(player.id)).toBe(3);

    // Exactly what the client does on its next step: the whole unacknowledged window again.
    sim.sim.pushInput(player.id, [frame(1), frame(2), frame(3)]);
    expect(sim.sim.pendingInputCount(player.id)).toBe(3);

    // ...and again with one new frame on the end.
    sim.sim.pushInput(player.id, [frame(1), frame(2), frame(3), frame(4)]);
    expect(sim.sim.pendingInputCount(player.id)).toBe(4);
  });

  it('does not re-accept a frame that has already been consumed', () => {
    const sim = createTestSimulation({ systems: [] });
    const player = sim.addPlayer();

    sim.sim.pushInput(player.id, [frame(1), frame(2)]);
    expect(sim.sim.takeInput(player.id)?.seq).toBe(1);
    expect(sim.sim.pendingInputCount(player.id)).toBe(1);

    // The resend arrives after the server already spent frame 1.
    sim.sim.pushInput(player.id, [frame(1), frame(2)]);
    expect(sim.sim.pendingInputCount(player.id)).toBe(1);
    expect(sim.sim.takeInput(player.id)?.seq).toBe(2);
    expect(sim.sim.takeInput(player.id)).toBeUndefined();
  });

  it('still accepts the gap left by a dropped packet', () => {
    const sim = createTestSimulation({ systems: [] });
    const player = sim.addPlayer();

    sim.sim.pushInput(player.id, [frame(1)]);
    // 2 and 3 never arrived; the resend carries them.
    sim.sim.pushInput(player.id, [frame(1), frame(2), frame(3)]);
    expect(sim.sim.pendingInputCount(player.id)).toBe(3);
    expect(sim.sim.takeInput(player.id)?.seq).toBe(1);
    expect(sim.sim.takeInput(player.id)?.seq).toBe(2);
    expect(sim.sim.takeInput(player.id)?.seq).toBe(3);
  });

  it('holds the queue near one frame per tick under a realistic resend loop', () => {
    // 20 Hz production, acks arriving at 10 Hz, one frame consumed per tick. The queue has
    // to stay shallow; it used to grow until MAX_PENDING_INPUTS clamped it at 120.
    const sim = createTestSimulation({ systems: [] });
    const player = sim.addPlayer();

    let seq = 1;
    let acked = 0;
    for (let tick = 0; tick < 200; tick++) {
      const pending: InputFrame[] = [];
      for (let s = acked + 1; s <= seq; s++) pending.push(frame(s));
      sim.sim.pushInput(player.id, pending);
      sim.sim.takeInput(player.id);
      // A snapshot every other tick acknowledges everything consumed so far.
      if (tick % 2 === 1) acked = Math.min(seq, acked + 2);
      seq++;
    }

    expect(sim.sim.pendingInputCount(player.id)).toBeLessThan(5);
  });
});
