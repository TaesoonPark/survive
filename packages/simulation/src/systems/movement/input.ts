import {
  Button,
  clamp,
  wrapAngle,
  type InputFrame,
  type PlayerId,
  type PlayerState,
} from '@survive/protocol';
import { SystemOrder, type SimContext, type System } from '../../core/context';
import type { SimulationState } from '../../core/state';
import { bump } from '../../core/queries';

/**
 * Input consumption.
 *
 * The server consumes exactly one {@link InputFrame} per player per tick, in sequence
 * order, because that is the rate the client produced them at. Draining two frames in
 * a tick would make the player briefly move at double speed and the client's predictor
 * would never converge; draining none would stall them. One in, one out (spec
 * section 17).
 *
 * The consumed frame is published on `ctx.inputs` so every later system in the tick -
 * movement, combat, interaction - reads the *same* frame. `player.lastInputSeq` is set
 * to the seq of the frame that was actually consumed, which is what the client
 * reconciles its prediction against.
 *
 * Wiring
 * ------
 * The pending-frame buffer lives on the {@link import('../../simulation').Simulation},
 * not on {@link SimContext}: it is transient network state, so it is deliberately not
 * part of the world. This system therefore needs the host to hand it a way to reach
 * that buffer. There are two equivalent ways to do it, and both end up calling
 * `Simulation.takeInput`:
 *
 * ```ts
 * // 1. Pass the getter at construction. Needs a late-bound reference because the
 * //    systems list is built before the Simulation exists.
 * let sim: Simulation;
 * const systems = [createInputSystem((id) => sim.takeInput(id)), createMovementSystem()];
 * sim = new Simulation({ config, data, world, systems });
 *
 * // 2. Build the systems with no arguments and bind afterwards. This is the form
 * //    `createDefaultSystems()` needs, since it takes no arguments.
 * const sim = new Simulation({ config, data, world, systems: createDefaultSystems() });
 * bindInputSource(sim);
 * ```
 *
 * An unbound system is not an error: every player simply coasts. That keeps a
 * simulation built for a non-interactive purpose (a replay tool, a headless AI test)
 * from having to care about input at all.
 */

/** Pulls the next unconsumed frame for a player, or undefined when starved. */
export type TakeInput = (playerId: PlayerId) => InputFrame | undefined;

/** Anything that owns a pending-input buffer. {@link Simulation} satisfies this. */
export interface InputSource {
  takeInput(playerId: PlayerId): InputFrame | undefined;
}

/** A host that owns both a world and the input buffer for it. */
export interface InputSourceHost extends InputSource {
  readonly state: SimulationState;
}

/**
 * Every button bit the protocol defines.
 *
 * Unknown bits are masked off rather than trusted: a client is free to send whatever
 * integer it likes, and a stray high bit must never become a game action later.
 */
export const KNOWN_BUTTONS: number =
  Button.Primary |
  Button.Secondary |
  Button.Sprint |
  Button.Crouch |
  Button.Interact |
  Button.Reload |
  Button.Block;

/**
 * Angular resolution, in radians, at which aim is replicated.
 *
 * Aim is replicated to other clients so they can draw the arm and muzzle. A pointer
 * jitters by fractions of a milliradian between ticks, and bumping `rev` for that
 * would ship every standing player in every snapshot forever. 0.005 rad is ~0.3
 * degrees: about 2 px of muzzle offset at 400 px, and far below anything a hand can
 * hold steady, so no real turn ever hides under it.
 */
export const AIM_EPSILON = 0.005;

/**
 * Number of aim buckets around the full circle, one per {@link AIM_EPSILON}.
 *
 * Deliberately even. An odd count would put a bucket *boundary* exactly on +/-PI, so
 * a hair of jitter across the wrap point would land in a different bucket and count as
 * a turn; an even count puts a bucket *centre* there, and the wrap point stops being a
 * special place at all.
 */
export const AIM_CELLS = 2 * Math.round(Math.PI / AIM_EPSILON);

/** Buckets per radian. Hoisted so the hot path is one multiply. */
const AIM_CELLS_PER_RADIAN = AIM_CELLS / (Math.PI * 2);

/**
 * Which replication bucket an aim angle falls in, 0..{@link AIM_CELLS} - 1.
 *
 * The bucket *index* is what decides whether a turn is worth replicating, rather than
 * the per-tick change in angle, and that difference is load-bearing. Comparing
 * per-tick deltas against a threshold is leaky: a player turning by just under the
 * threshold every tick - a slow tracking aim, or a client deliberately turning at
 * 0.004 rad/tick - accumulates an unbounded error that never trips it, so other
 * clients keep drawing them aiming somewhere they stopped aiming seconds ago. Because
 * the buckets sit on a fixed grid the error can never exceed one of them, however the
 * angle got there.
 *
 * Modulo, not clamp, so bucket 0 and bucket `AIM_CELLS - 1` are neighbours the same way
 * -PI and +PI are.
 */
export function aimCell(angle: number): number {
  const cell = Math.round(wrapAngle(angle) * AIM_CELLS_PER_RADIAN);
  return ((cell % AIM_CELLS) + AIM_CELLS) % AIM_CELLS;
}

/** Late bindings, keyed by the world the source feeds. */
const boundSources = new WeakMap<SimulationState, TakeInput>();

function asTake(source: InputSource | TakeInput): TakeInput {
  return typeof source === 'function' ? source : (playerId) => source.takeInput(playerId);
}

function stateOf(target: SimContext | SimulationState): SimulationState {
  return 'state' in target ? target.state : target;
}

/**
 * Point a zero-argument {@link createInputSystem} at a host's pending-input buffer.
 *
 * Call it once, any time after the simulation is constructed and before it is stepped.
 * Binding is keyed by {@link SimulationState} identity, so two simulations in one
 * process never see each other's input.
 */
export function bindInputSource(host: InputSourceHost): void;
export function bindInputSource(
  target: SimContext | SimulationState,
  source: InputSource | TakeInput,
): void;
export function bindInputSource(
  target: InputSourceHost | SimContext | SimulationState,
  source?: InputSource | TakeInput,
): void {
  const resolved = source ?? (target as InputSource);
  if (typeof resolved !== 'function' && typeof resolved.takeInput !== 'function') {
    throw new TypeError('bindInputSource: no takeInput(playerId) on the given source');
  }
  boundSources.set(stateOf(target as SimContext | SimulationState), asTake(resolved));
}

/** Forget a binding. Call when a simulation is torn down mid-process. */
export function unbindInputSource(target: SimContext | SimulationState): void {
  boundSources.delete(stateOf(target));
}

/**
 * Find the input source for a context.
 *
 * Checked fresh every tick rather than cached, so `bindInputSource` works whether it
 * is called before or after the first step. The two structural probes let a host that
 * is not {@link Simulation} - a replay driver, an integration harness - expose the
 * buffer by simply having a `takeInput` on the context or a `take` on `ctx.inputs`
 * (the shape {@link import('../../core/context').InputBuffer} already describes).
 */
export function resolveTakeInput(ctx: SimContext): TakeInput | undefined {
  const bound = boundSources.get(ctx.state);
  if (bound) return bound;
  const onContext = (ctx as Partial<InputSource>).takeInput;
  if (typeof onContext === 'function') return (id) => onContext.call(ctx, id);
  const onInputs = (ctx.inputs as { take?: TakeInput }).take;
  if (typeof onInputs === 'function') return (id) => onInputs.call(ctx.inputs, id);
  return undefined;
}

function axis(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

/**
 * Repair a frame that came off the wire.
 *
 * The client is assumed to be lying, or at least broken: `NaN` in `moveX` would
 * propagate straight into the player's position and destroy the save, and an
 * un-normalised axis would be a free speed hack. Nothing here rejects the frame - a
 * malformed frame is treated as "no intent on that axis" so a bad packet costs the
 * player a movement step rather than a disconnect.
 */
export function sanitizeInputFrame(frame: InputFrame, fallbackAim: number): InputFrame {
  return {
    seq: Number.isFinite(frame.seq) ? Math.floor(frame.seq) : 0,
    moveX: axis(frame.moveX),
    moveY: axis(frame.moveY),
    aimAngle: Number.isFinite(frame.aimAngle) ? wrapAngle(frame.aimAngle) : fallbackAim,
    buttons: Number.isFinite(frame.buttons) ? (frame.buttons | 0) & KNOWN_BUTTONS : 0,
  };
}

/**
 * The frame a starved player is treated as having sent.
 *
 * Aim is held at wherever they were last looking - snapping it to zero would spin the
 * sprite on every dropped packet - but movement and every button are released. Both
 * halves of that matter: coasting forward on a stale intent lets a client walk through
 * a wall by going silent, and a held Primary or Block that survived the client going
 * away would make going away an exploit rather than a handicap.
 */
export function coastingFrame(player: PlayerState, previous: InputFrame | undefined): InputFrame {
  return {
    seq: player.lastInputSeq,
    moveX: 0,
    moveY: 0,
    aimAngle: previous?.aimAngle ?? player.aimAngle,
    buttons: 0,
  };
}

/**
 * Point the player at where the client says they are aiming.
 *
 * The full-precision angle is always stored - combat and the client's own predictor
 * both want it unrounded. The return value only says whether the *replicated* bucket
 * moved (see {@link aimCell}), which is what gates the `rev` bump: sub-bucket jitter
 * costs no bandwidth, and a slow drift is guaranteed to be shipped within one bucket
 * of where the player is actually looking.
 *
 * Aim is applied here, not in the movement system, because interaction and combat both
 * need it even on a tick where the player did not move.
 */
export function applyAim(player: PlayerState, aimAngle: number): boolean {
  const meaningful = aimCell(aimAngle) !== aimCell(player.aimAngle);
  player.aimAngle = aimAngle;
  return meaningful;
}

/**
 * Drain one input frame per player per tick.
 *
 * @param source Optional pending-input buffer. Omit it and call
 *               {@link bindInputSource} once the host exists instead.
 */
export function createInputSystem(source?: InputSource | TakeInput): System {
  const explicit = source ? asTake(source) : undefined;
  let warnedUnbound = false;

  return {
    id: 'input',
    order: SystemOrder.Input,

    update(ctx: SimContext): void {
      // `Simulation.step` refuses to run a paused world, so the only tick this can be
      // true on is the one a `setPaused` was dispatched in - commands are routed before
      // the systems. Bailing out keeps that tick honest: nothing is consumed, so the
      // frame the player had in flight when they hit ESC is still there when they
      // resume, `ackSeq` stops advancing (which is exactly what the client's predictor
      // needs in order to hold its pending queue), and no later system in the tick can
      // act on an intent from a world that has already stopped. Without this the pause
      // tick would still be worth one free swing.
      if (ctx.state.paused) return;

      const take = explicit ?? resolveTakeInput(ctx);
      if (!take && !warnedUnbound) {
        warnedUnbound = true;
        ctx.log.warn('input system has no input source; every player will coast', {
          hint: 'call bindInputSource(simulation) or pass the getter to createInputSystem',
        });
      }

      // Sorted so the drain order cannot depend on player-map insertion order. It does
      // not affect the outcome today - players do not interact during input - but a
      // future rule that reads another player's frame would silently desync without it.
      for (const playerId of Object.keys(ctx.state.players).sort()) {
        const player = ctx.state.players[playerId];
        if (!player) continue;

        const raw = take?.(playerId);
        if (!raw) {
          // Starved. Publishing a coasting frame rather than nothing keeps every later
          // system on one code path: they always have a frame to read.
          if (player.alive)
            ctx.inputs.set(playerId, coastingFrame(player, ctx.inputs.previous(playerId)));
          continue;
        }

        const frame = sanitizeInputFrame(raw, player.aimAngle);

        // Acknowledge the frame even for a corpse. The buffer is drained at one frame
        // per tick either way, so skipping the dead would let a death screen's worth of
        // frames pile up and then replay in a burst on respawn; and `ackSeq` has to
        // keep advancing or the client's predictor never releases its pending queue.
        // `lastInputSeq` does not need a `bump`: it ships as part of `self`/`ackSeq` in
        // every snapshot, outside the revision-gated entity delta.
        if (frame.seq > player.lastInputSeq) player.lastInputSeq = frame.seq;
        if (!player.alive) continue;

        ctx.inputs.set(playerId, frame);
        if (applyAim(player, frame.aimAngle)) bump(player);
      }
    },

    onPlayerLeave(ctx: SimContext, player: PlayerState): void {
      // The Simulation drops its own buffers; this clears the published frame so a
      // reconnecting player is not handed the intent they left with.
      ctx.inputs.remove(player.id);
    },
  };
}
