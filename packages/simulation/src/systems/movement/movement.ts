import {
  WORLD_SIZE,
  clamp,
  tileProps,
  type InputFrame,
  type MoveMode,
  type PlayerState,
} from '@survive/protocol';
import { SystemOrder, type CommandRouter, type SimContext, type System } from '../../core/context';
import { PLAYER_RADIUS, stepPlayerMovement } from '../../core/movement';
import { NoiseRadius, emitNoise } from '../../core/noise';
import { bump } from '../../core/queries';

/**
 * Player motion.
 *
 * Every step goes through `stepPlayerMovement` from `core/movement`, which is the same
 * function the client's predictor replays. That is not a nicety: the client applies its
 * own inputs immediately and only corrects when the server disagrees, so any divergence
 * between the two - a different speed curve, a different stamina rule, a different
 * order of operations - shows up as the player being dragged backwards several times a
 * second. The rules therefore live in `core/movement`; this system decides *which*
 * frame each player is stepped with, and owns everything the client does not predict:
 * lifetime distance, footstep noise, world bounds, and pausing.
 */

/**
 * Distance in pixels between one footstep and the next.
 *
 * Stride length, not a tick interval: a sprinter covers ground faster and so makes
 * noise more often, which is the behaviour we want, without the interval needing to
 * know anything about speed modifiers, terrain or injuries. 58 px is a little under two
 * tiles, which puts a walk at 1.8 steps/second and a sprint at 3.2 - a human cadence,
 * and two orders of magnitude below the twenty a tick-per-tick emitter would produce.
 *
 * ONE stride for every stance, and that is a security property rather than a
 * simplification. The stride phase is read off the lifetime odometer, so a per-stance
 * stride would re-bucket the whole odometer the instant the player changed stance: a
 * client that knows its own position - every client does, it predicts movement - could
 * pick, each tick, whichever stance's grid the coming step does not cross a boundary
 * of, and cross the map at better than walking pace in total silence. Measured: 863 px
 * in five seconds with zero footsteps. With one grid the odometer is monotonic and
 * every 58 px of ground costs exactly one noise, whatever the player does with their
 * stance keys. Stance still decides how *far* that noise carries and how much the AI
 * cares ({@link footstepRadius}, {@link FOOTSTEP_LOUDNESS}), and cadence still falls
 * out of speed for free.
 */
export const FOOTSTEP_STRIDE_PX = 58;

/**
 * Loudness scalar per stance, used by the AI to break ties between competing sounds.
 *
 * The audible radius already differs by stance ({@link NoiseRadius}); this is the
 * "how much do I care" weight on top of it.
 */
export const FOOTSTEP_LOUDNESS: Readonly<Record<MoveMode, number>> = {
  walk: 1,
  run: 1.8,
  crouch: 0.35,
};

/** Audible radius of one footstep, in pixels. */
export function footstepRadius(mode: MoveMode, tileNoise: number): number {
  const base =
    mode === 'run'
      ? NoiseRadius.Sprint
      : mode === 'crouch'
        ? NoiseRadius.Crouch
        : NoiseRadius.Footstep;
  return base * tileNoise;
}

/**
 * Keep a body inside the world rectangle.
 *
 * Out-of-bounds tiles read back as `Tile.Void`, which is solid, so collision normally
 * stops a player at the edge on its own. This is the belt to that braces: a knockback
 * impulse, a teleport or a world whose out-of-bounds tiles are walkable (the flat test
 * world) must never be able to park a player at a coordinate no chunk can hold.
 * Returns true when a clamp actually happened.
 *
 * Finite coordinates only: `clamp` passes `NaN` straight through, because `NaN` fails
 * both of its comparisons. Non-finite positions are caught in {@link stepPlayer}, which
 * is the only place that holds a known-good position to put the body back at.
 */
export function clampIntoWorld(body: { x: number; y: number }): boolean {
  const x = clamp(body.x, PLAYER_RADIUS, WORLD_SIZE - PLAYER_RADIUS);
  const y = clamp(body.y, PLAYER_RADIUS, WORLD_SIZE - PLAYER_RADIUS);
  if (x === body.x && y === body.y) return false;
  body.x = x;
  body.y = y;
  return true;
}

/** The frame a player with no published input is stepped with: still, aim held. */
function idleFrame(player: PlayerState): InputFrame {
  return { seq: player.lastInputSeq, moveX: 0, moveY: 0, aimAngle: player.aimAngle, buttons: 0 };
}

/**
 * Strip the movement out of a frame while leaving everything else intact.
 *
 * Used while a player is staggered. Aim and buttons survive, because being staggered
 * stops you walking, not looking; only the walk intent is dropped. Sprint needs no
 * special handling - `stepPlayerMovement` only sprints when there is movement intent.
 */
function withoutMovement(frame: InputFrame): InputFrame {
  return { ...frame, moveX: 0, moveY: 0 };
}

export function createMovementSystem(): System {
  return {
    id: 'movement',
    order: SystemOrder.Movement,

    init(_ctx: SimContext, router: CommandRouter): void {
      router.on('setPaused', (ctx, player, command) => {
        // A dedicated server must never let one client stop the world for everyone;
        // single-player wants exactly that from its ESC menu. Same code, one config
        // flag (spec section 12).
        if (!ctx.config.mode.pauseWhenClientPaused) {
          ctx.events.emit({
            type: 'commandRejected',
            playerId: player.id,
            command: 'setPaused',
            reason: 'pausing is not allowed on this server',
          });
          return;
        }
        if (typeof command.paused !== 'boolean') {
          ctx.events.emit({
            type: 'commandRejected',
            playerId: player.id,
            command: 'setPaused',
            reason: 'paused must be a boolean',
          });
          return;
        }
        ctx.state.paused = command.paused;
      });
    },

    update(ctx: SimContext): void {
      // A pause requested this tick is dispatched before the systems run, so without
      // this the pausing tick would still take one movement step - the one frame the
      // player did not intend to spend.
      if (ctx.state.paused) return;

      const dt = ctx.clock.dt;
      // Sorted: footstep noises are consumed by the AI in emission order, so the order
      // players are stepped in is observable.
      for (const playerId of Object.keys(ctx.state.players).sort()) {
        const player = ctx.state.players[playerId];
        if (!player || !player.alive) continue;
        stepPlayer(ctx, player, dt);
      }
    },
  };
}

function stepPlayer(ctx: SimContext, player: PlayerState, dt: number): void {
  const published = ctx.inputs.get(player.id);
  const frame = published ?? idleFrame(player);
  const staggered = player.actionLockedUntilTick > ctx.state.tick;
  const intended = staggered ? withoutMovement(frame) : frame;

  const startX = player.x;
  const startY = player.y;
  const startVx = player.vx;
  const startVy = player.vy;
  const startFacing = player.facing;
  const startStamina = player.stamina;
  const startMode = player.moveMode;

  stepPlayerMovement(ctx.world, player, intended, ctx.data, dt);
  // A non-finite position is unrecoverable once it is written: it survives clamping
  // (see `clampIntoWorld`), it serialises into the save, and it makes every distance
  // test downstream - AOI, spatial index, collision - answer false. Input frames are
  // already scrubbed, so the only way one arrives is a bad impulse from another
  // system; rewinding to where the player stood costs them one step and keeps the
  // world intact. Deliberately not silent: this is a bug somewhere, not a game event.
  if (!Number.isFinite(player.x) || !Number.isFinite(player.y)) {
    ctx.log.error('non-finite player position after movement step; rewinding', {
      playerId: player.id,
      x: player.x,
      y: player.y,
      vx: startVx,
      vy: startVy,
    });
    player.x = startX;
    player.y = startY;
    player.vx = 0;
    player.vy = 0;
  }
  if (!Number.isFinite(player.vx)) player.vx = 0;
  if (!Number.isFinite(player.vy)) player.vy = 0;
  clampIntoWorld(player);

  const moved = Math.hypot(player.x - startX, player.y - startY);
  if (moved > 0) {
    // Measured post-clamp, so the counter records ground actually covered rather than
    // what the step asked for.
    const before = player.stats.distanceTravelled;
    player.stats.distanceTravelled = before + moved;
    if (!staggered) emitFootsteps(ctx, player, before, player.stats.distanceTravelled);
  }

  const changed =
    player.x !== startX ||
    player.y !== startY ||
    player.vx !== startVx ||
    player.vy !== startVy ||
    player.facing !== startFacing ||
    player.stamina !== startStamina ||
    player.moveMode !== startMode;
  // Gated rather than unconditional: an idle player at full stamina changes nothing,
  // and bumping them anyway would put every standing player in every snapshot.
  if (changed) bump(player);
}

/**
 * Emit a footstep whenever the player's lifetime distance crosses a stride boundary.
 *
 * Deriving the stride phase from `stats.distanceTravelled` - state that is already
 * persisted with the player - rather than from a counter held inside this system is
 * what makes footsteps survive a save/load unchanged. A system-local accumulator would
 * reset on load, and because footsteps pull zombies, that would be a real (if small)
 * determinism hole between a fresh session and a resumed one.
 *
 * The grid is fixed and stance-independent; see {@link FOOTSTEP_STRIDE_PX} for why that
 * is what stops a client silencing itself.
 *
 * At most one noise leaves here per tick, even when a knockback threw the player across
 * several strides in a single step: the AI treats each noise as a separate thing to
 * investigate, and a shove is one event, not four. Nothing a player can do under their
 * own power covers a stride in one tick - a sprint on the fastest terrain is about
 * 12 px - so the cap only ever fires for impulses.
 */
function emitFootsteps(
  ctx: SimContext,
  player: PlayerState,
  fromDistance: number,
  toDistance: number,
): void {
  if (
    Math.floor(toDistance / FOOTSTEP_STRIDE_PX) === Math.floor(fromDistance / FOOTSTEP_STRIDE_PX)
  ) {
    return;
  }
  const mode = player.moveMode;

  // Terrain decides how much a step gives away: gravel and shallow water are loud,
  // fresh snow and grass swallow the sound.
  const tile = tileProps(ctx.world.getTileAt(player.x, player.y));
  emitNoise(
    ctx,
    player.x,
    player.y,
    footstepRadius(mode, tile.noise),
    FOOTSTEP_LOUDNESS[mode] * tile.noise,
    player.id,
  );
}
