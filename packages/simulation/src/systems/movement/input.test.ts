import { describe, expect, it } from 'vitest';
import { Button, angleDelta, type InputFrame } from '@survive/protocol';
import {
  createTestSimulation,
  type TestSimulation,
  type TestSimulationOptions,
} from '@survive/test-utils';
import { SystemOrder, type System } from '../../core/context';
import {
  AIM_CELLS,
  AIM_EPSILON,
  KNOWN_BUTTONS,
  aimCell,
  applyAim,
  bindInputSource,
  coastingFrame,
  createInputSystem,
  sanitizeInputFrame,
  unbindInputSource,
  type TakeInput,
} from './input';
import { createMovementSystem } from './movement';

/** Records the frame every player had published to them, once per tick. */
function inputProbe(rows: Array<Record<string, InputFrame | undefined>>): System {
  return {
    // Ordered where combat runs: the point is that a later system sees the frame the
    // input system consumed *this* tick.
    id: 'input-probe',
    order: SystemOrder.Combat,
    update(ctx) {
      const row: Record<string, InputFrame | undefined> = {};
      for (const id of Object.keys(ctx.state.players)) row[id] = ctx.inputs.get(id);
      rows.push(row);
    },
  };
}

function makeSim(
  options: Omit<TestSimulationOptions, 'systems'> = {},
  extra: System[] = [],
): TestSimulation {
  const sim = createTestSimulation({
    ...options,
    systems: [createInputSystem(), createMovementSystem(), ...extra],
  });
  bindInputSource(sim.sim);
  return sim;
}

describe('input system', () => {
  it('consumes exactly one frame per tick and echoes the consumed seq', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.input(player, { moveX: 1 });
    sim.input(player, { moveX: 1 });
    sim.input(player, { moveX: 1 });
    expect(sim.sim.pendingInputCount(player.id)).toBe(3);

    sim.step(1);
    expect(player.lastInputSeq).toBe(1);
    expect(sim.sim.pendingInputCount(player.id)).toBe(2);

    sim.step(1);
    expect(player.lastInputSeq).toBe(2);

    sim.step(1);
    expect(player.lastInputSeq).toBe(3);
    expect(sim.sim.pendingInputCount(player.id)).toBe(0);
  });

  it('publishes the consumed frame for systems that run later in the same tick', () => {
    const rows: Array<Record<string, InputFrame | undefined>> = [];
    const sim = makeSim({}, [inputProbe(rows)]);
    const player = sim.addPlayer();

    sim.input(player, { moveX: 1, moveY: -1, aimAngle: 0.75, buttons: Button.Primary });
    sim.step(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[player.id]).toEqual({
      seq: 1,
      moveX: 1,
      moveY: -1,
      aimAngle: 0.75,
      buttons: Button.Primary,
    });
  });

  it('coasts on starvation: keeps the aim, drops the movement, never throws', () => {
    const rows: Array<Record<string, InputFrame | undefined>> = [];
    const sim = makeSim({}, [inputProbe(rows)]);
    const player = sim.addPlayer();

    sim.input(player, { moveX: 1, moveY: 1, aimAngle: 1.25, buttons: Button.Primary });
    expect(() => sim.step(3)).not.toThrow();

    expect(rows[0]?.[player.id]?.moveX).toBe(1);
    for (const row of rows.slice(1)) {
      const frame = row[player.id];
      expect(frame).toBeDefined();
      expect(frame?.moveX).toBe(0);
      expect(frame?.moveY).toBe(0);
      // Aim survives the outage; a starved client must not spin the player's sights.
      expect(frame?.aimAngle).toBeCloseTo(1.25, 6);
      // Buttons do not: going quiet must never be a way to hold attack or block.
      expect(frame?.buttons).toBe(0);
    }
    // Nothing new was consumed, so the acknowledgement does not creep forward.
    expect(player.lastInputSeq).toBe(1);
  });

  it('repairs a frame from a lying client instead of trusting or dropping it', () => {
    const rows: Array<Record<string, InputFrame | undefined>> = [];
    const sim = makeSim({}, [inputProbe(rows)]);
    const player = sim.addPlayer();

    sim.input(player, {
      seq: 4.9,
      moveX: 50,
      moveY: Number.NaN,
      aimAngle: Number.NaN,
      buttons: 0xffff,
    });
    sim.step(1);

    const frame = rows[0]?.[player.id];
    expect(frame?.seq).toBe(4);
    expect(frame?.moveX).toBe(1);
    expect(frame?.moveY).toBe(0);
    expect(frame?.aimAngle).toBe(0);
    expect(frame?.buttons).toBe(KNOWN_BUTTONS);
    expect(Number.isFinite(player.x)).toBe(true);
    expect(Number.isFinite(player.y)).toBe(true);
  });

  it('applies aim to the player and bumps rev for a real turn but not for jitter', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    bindInputSource(sim.sim);
    const player = sim.addPlayer();

    sim.input(player, { aimAngle: 1 });
    sim.step(1);
    const afterTurn = player.rev;
    expect(player.aimAngle).toBeCloseTo(1, 6);
    expect(afterTurn).toBeGreaterThan(1);

    sim.input(player, { aimAngle: 1 + AIM_EPSILON / 2 });
    sim.step(1);
    expect(player.aimAngle).toBeCloseTo(1 + AIM_EPSILON / 2, 6);
    expect(player.rev).toBe(afterTurn);

    sim.input(player, { aimAngle: -2 });
    sim.step(1);
    expect(player.aimAngle).toBeCloseTo(-2, 6);
    expect(player.rev).toBeGreaterThan(afterTurn);
  });

  it('wraps an aim angle the client sent unwrapped', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    bindInputSource(sim.sim);
    const player = sim.addPlayer();

    sim.input(player, { aimAngle: Math.PI * 2 + 0.5 });
    sim.step(1);
    expect(player.aimAngle).toBeCloseTo(0.5, 6);
  });

  it('keeps acknowledging a dead player without acting on their input', () => {
    const rows: Array<Record<string, InputFrame | undefined>> = [];
    const sim = makeSim({}, [inputProbe(rows)]);
    const player = sim.addPlayer();
    player.alive = false;

    sim.input(player, { moveX: 1, aimAngle: 2 });
    sim.step(1);

    // The buffer still drains, so a death screen does not build a backlog that would
    // replay in a burst on respawn, and ackSeq keeps advancing for the predictor.
    expect(player.lastInputSeq).toBe(1);
    expect(sim.sim.pendingInputCount(player.id)).toBe(0);
    // But nothing is published and nothing is applied.
    expect(rows[0]?.[player.id]).toBeUndefined();
    expect(player.aimAngle).toBe(0);
  });

  it('gives each player their own frame', () => {
    const rows: Array<Record<string, InputFrame | undefined>> = [];
    const sim = makeSim({}, [inputProbe(rows)]);
    const a = sim.addPlayer({ id: 'aaa' });
    const b = sim.addPlayer({ id: 'bbb' });

    sim.input(a, { moveX: 1 });
    sim.input(b, { moveY: -1 });
    sim.step(1);

    expect(rows[0]?.aaa?.moveX).toBe(1);
    expect(rows[0]?.aaa?.moveY).toBe(0);
    expect(rows[0]?.bbb?.moveX).toBe(0);
    expect(rows[0]?.bbb?.moveY).toBe(-1);
    expect(a.lastInputSeq).toBe(1);
    expect(b.lastInputSeq).toBe(1);
  });

  it('coasts harmlessly when no input source is bound at all', () => {
    const sim = createTestSimulation({
      // The harness binds input for you unless told not to, and an unbound system is
      // exactly what is on trial here.
      bindInput: false,
      systems: [createInputSystem(), createMovementSystem()],
    });
    const player = sim.addPlayer();
    const startX = player.x;

    sim.input(player, { moveX: 1 });
    expect(() => sim.step(5)).not.toThrow();
    expect(player.x).toBe(startX);
    expect(player.lastInputSeq).toBe(0);
  });

  it('accepts a getter handed in at construction', () => {
    let take: TakeInput = () => undefined;
    const sim = createTestSimulation({
      systems: [createInputSystem((id) => take(id)), createMovementSystem()],
    });
    take = (id) => sim.sim.takeInput(id);
    const player = sim.addPlayer();

    sim.hold(player, { moveX: 1 }, 20);
    expect(player.x).toBeGreaterThan(0);
    expect(player.lastInputSeq).toBe(20);
  });

  it('never lets a stale frame walk the acknowledgement backwards', () => {
    // A source that hands out a newer frame and then an older one - which is what a
    // buggy or hostile host looks like from in here.
    const script: InputFrame[] = [
      { seq: 5, moveX: 0, moveY: 0, aimAngle: 0, buttons: 0 },
      { seq: 2, moveX: 0, moveY: 0, aimAngle: 0, buttons: 0 },
    ];
    let index = 0;
    const sim = createTestSimulation({
      systems: [createInputSystem(() => script[index++])],
    });
    const player = sim.addPlayer();

    sim.step(1);
    expect(player.lastInputSeq).toBe(5);
    sim.step(1);
    expect(player.lastInputSeq).toBe(5);
  });
});

describe('input frame sanitising', () => {
  const base: InputFrame = { seq: 1, moveX: 0, moveY: 0, aimAngle: 0, buttons: 0 };

  it('clamps the movement axes into range', () => {
    expect(sanitizeInputFrame({ ...base, moveX: 9, moveY: -9 }, 0).moveX).toBe(1);
    expect(sanitizeInputFrame({ ...base, moveX: 9, moveY: -9 }, 0).moveY).toBe(-1);
    expect(sanitizeInputFrame({ ...base, moveX: 0.4 }, 0).moveX).toBeCloseTo(0.4, 6);
  });

  it('turns non-finite numbers into no intent rather than poisoning the state', () => {
    const frame = sanitizeInputFrame(
      {
        seq: Number.POSITIVE_INFINITY,
        moveX: Number.NaN,
        moveY: Number.POSITIVE_INFINITY,
        aimAngle: Number.NaN,
        buttons: Number.NaN,
      },
      0.25,
    );
    expect(frame.seq).toBe(0);
    expect(frame.moveX).toBe(0);
    expect(frame.moveY).toBe(0);
    expect(frame.aimAngle).toBe(0.25);
    expect(frame.buttons).toBe(0);
  });

  it('masks off button bits the protocol does not define', () => {
    const frame = sanitizeInputFrame({ ...base, buttons: 0xffff }, 0);
    expect(frame.buttons).toBe(KNOWN_BUTTONS);
    expect(frame.buttons & ~KNOWN_BUTTONS).toBe(0);
  });
});

describe('coasting frame', () => {
  it('prefers the aim of the last frame actually consumed', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    const player = sim.addPlayer();
    player.aimAngle = 3;
    const previous: InputFrame = { seq: 7, moveX: 1, moveY: 1, aimAngle: 1.5, buttons: 0xff };

    const coasted = coastingFrame(player, previous);
    expect(coasted.aimAngle).toBe(1.5);
    expect(coasted.moveX).toBe(0);
    expect(coasted.moveY).toBe(0);
    expect(coasted.buttons).toBe(0);
  });

  it('falls back to the aim the player is already holding when nothing was consumed', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    const player = sim.addPlayer();
    player.aimAngle = -1.2;
    expect(coastingFrame(player, undefined).aimAngle).toBe(-1.2);
  });
});

describe('input system wiring', () => {
  it('consumes nothing on the tick a pause takes effect, and keeps the frame for after', () => {
    const rows: Array<Record<string, InputFrame | undefined>> = [];
    const sim = makeSim({}, [inputProbe(rows)]);
    const player = sim.addPlayer();

    sim.input(player, { moveX: 1, buttons: Button.Primary });
    sim.run(player, { type: 'setPaused', paused: true });

    expect(sim.sim.state.paused).toBe(true);
    // The frame is still queued: pausing costs the player nothing, and no system that
    // runs later in the pausing tick gets to act on an intent from a stopped world.
    expect(sim.sim.pendingInputCount(player.id)).toBe(1);
    expect(player.lastInputSeq).toBe(0);
    expect(rows[0]?.[player.id]).toBeUndefined();

    sim.sim.setPaused(false);
    sim.step(1);
    expect(player.lastInputSeq).toBe(1);
    expect(rows[1]?.[player.id]?.buttons).toBe(Button.Primary);
  });

  it('reads a takeInput hung on the context itself', () => {
    const sim = createTestSimulation({
      systems: [createInputSystem(), createMovementSystem()],
    });
    // The escape hatch a host that is not `Simulation` - a replay driver, an
    // integration harness - can use without touching this file.
    Object.assign(sim.ctx, { takeInput: (id: string) => sim.sim.takeInput(id) });
    const player = sim.addPlayer();

    sim.hold(player, { moveX: 1 }, 10);
    expect(player.lastInputSeq).toBe(10);
    expect(player.x).toBeGreaterThan(sim.spawn.x);
  });

  it('reads a take() exposed on ctx.inputs', () => {
    const sim = createTestSimulation({
      systems: [createInputSystem(), createMovementSystem()],
    });
    Object.assign(sim.ctx.inputs, { take: (id: string) => sim.sim.takeInput(id) });
    const player = sim.addPlayer();

    sim.hold(player, { moveX: 1 }, 10);
    expect(player.lastInputSeq).toBe(10);
  });

  it('stops delivering once the source is unbound', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.hold(player, { moveX: 1 }, 5);
    expect(player.lastInputSeq).toBe(5);

    unbindInputSource(sim.sim.state);
    const stalledAt = player.x;
    sim.hold(player, { moveX: 1 }, 5);
    expect(player.lastInputSeq).toBe(5);
    expect(player.x).toBe(stalledAt);
  });

  it('refuses a source that cannot hand out frames', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    expect(() =>
      bindInputSource(sim.ctx, {} as unknown as Parameters<typeof bindInputSource>[1]),
    ).toThrow(TypeError);
  });

  it('keeps two simulations in one process out of each other input', () => {
    const bound = makeSim({ seed: 7 });
    const unbound = createTestSimulation({
      seed: 7,
      bindInput: false,
      systems: [createInputSystem(), createMovementSystem()],
    });
    const a = bound.addPlayer();
    const b = unbound.addPlayer();

    bound.hold(a, { moveX: 1 }, 10);
    unbound.hold(b, { moveX: 1 }, 10);

    expect(a.x).toBeGreaterThan(bound.spawn.x);
    expect(b.x).toBe(unbound.spawn.x);
  });

  it('prefers the getter given at construction over any later binding', () => {
    const sim = createTestSimulation({
      // Explicitly starved. A binding must not be able to override the host's own
      // decision to drive this simulation by hand.
      systems: [createInputSystem(() => undefined), createMovementSystem()],
    });
    bindInputSource(sim.sim);
    const player = sim.addPlayer();

    sim.hold(player, { moveX: 1 }, 10);
    expect(player.lastInputSeq).toBe(0);
    expect(player.x).toBe(sim.spawn.x);
  });

  it('does not leave a departing player intent lying around', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.input(player, { moveX: 1 });
    sim.step(1);
    expect(sim.ctx.inputs.get(player.id)).toBeDefined();

    sim.sim.removePlayer(player.id);
    expect(sim.ctx.inputs.get(player.id)).toBeUndefined();
  });
});

describe('aim application', () => {
  it('reports a real turn and stays quiet about jitter', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    const player = sim.addPlayer();
    player.aimAngle = 0;

    expect(applyAim(player, AIM_EPSILON * 2)).toBe(true);
    expect(player.aimAngle).toBeCloseTo(AIM_EPSILON * 2, 9);
    // Applied either way - the return value is only about whether to replicate.
    expect(applyAim(player, AIM_EPSILON * 2.5)).toBe(false);
    expect(player.aimAngle).toBeCloseTo(AIM_EPSILON * 2.5, 9);
  });

  it('measures the short way round, so crossing the wrap point is not a spin', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    const player = sim.addPlayer();
    player.aimAngle = Math.PI - 0.001;

    // Nudging past +PI to -PI is a 0.002 rad twitch, not a half turn.
    expect(applyAim(player, -Math.PI + 0.001)).toBe(false);
    expect(applyAim(player, 0)).toBe(true);
  });
});

describe('aim replication cannot drift', () => {
  it('replicates a slow turn instead of letting it accumulate unseen', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    bindInputSource(sim.sim);
    const player = sim.addPlayer();

    // A tracking aim, or a client deliberately turning just under the old per-tick
    // threshold. Comparing per-tick deltas let 46 degrees of turn go out unreplicated;
    // the bucket grid bounds the error at one bucket however the angle got there.
    let aim = 0;
    let turns = 0;
    const startRev = player.rev;
    for (let tick = 0; tick < 200; tick++) {
      aim += AIM_EPSILON * 0.8;
      sim.input(player, { aimAngle: aim });
      const before = player.rev;
      sim.step(1);
      if (player.rev !== before) turns++;
    }

    expect(player.aimAngle).toBeCloseTo(aim, 6);
    expect(player.rev).toBeGreaterThan(startRev);
    // 0.8 of a bucket per tick, so roughly four bumps in five ticks - never zero.
    expect(turns).toBeGreaterThan(120);
    // And the replicated aim is never more than a bucket stale.
    expect(Math.abs(angleDelta(player.aimAngle, aim))).toBeLessThan(AIM_EPSILON);
  });

  it('still says nothing about jitter that stays inside one bucket', () => {
    const sim = createTestSimulation({ systems: [createInputSystem()] });
    bindInputSource(sim.sim);
    const player = sim.addPlayer();

    sim.input(player, { aimAngle: 1 });
    sim.step(1);
    const settled = player.rev;

    // Sub-milliradian wobble around a bucket centre, which is what a real pointer does.
    for (let tick = 0; tick < 40; tick++) {
      sim.input(player, { aimAngle: 1 + (tick % 2 === 0 ? 0.0004 : -0.0004) });
      sim.step(1);
    }
    expect(player.rev).toBe(settled);
  });

  it('puts a bucket centre on the wrap point, so crossing it is not a turn', () => {
    // An odd bucket count would put a boundary on +/-PI and make every player looking
    // west flicker in and out of every snapshot.
    expect(AIM_CELLS % 2).toBe(0);
    expect(aimCell(Math.PI)).toBe(aimCell(-Math.PI));
    expect(aimCell(Math.PI - 0.001)).toBe(aimCell(-Math.PI + 0.001));
    // Neighbouring buckets either side of the wrap are still neighbours.
    const west = aimCell(Math.PI);
    expect(Math.min(Math.abs(aimCell(Math.PI - AIM_EPSILON) - west), AIM_CELLS - 1)).toBe(1);
  });

  it('buckets the whole circle without a gap or an overlap', () => {
    // Sampled at cell *centres*, not edges. `aimCell` rounds, so a cell spans
    // [k - 0.5, k + 0.5) buckets-worth of angle and its centre sits on the integer k.
    // An edge sample lands exactly on x.5, which is the single input where the result is
    // decided by the last bit of the multiply rather than by the quantiser - half of them
    // round down, the neighbours collide, and the count comes out short for a reason that
    // says nothing about gaps or overlaps.
    const seen = new Set<number>();
    const perRadian = AIM_CELLS / (Math.PI * 2);
    for (let i = 0; i < AIM_CELLS; i++) {
      seen.add(aimCell(i / perRadian));
    }
    expect(seen.size).toBe(AIM_CELLS);
    for (const cell of seen) {
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(AIM_CELLS);
    }
  });
});
