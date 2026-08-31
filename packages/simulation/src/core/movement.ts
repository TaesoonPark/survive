import {
  Button,
  clamp,
  hasButton,
  legMobilityMultiplier,
  totalPain,
  type InputFrame,
  type MoveMode,
  type PlayerState,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import type { MoveResult } from '@survive/world';

/**
 * Shared player movement.
 *
 * The client predicts movement locally and the server replays the same input frames
 * authoritatively (spec section 17). That only reconciles if both run *identical*
 * math, so the step lives here as a pure function over minimal interfaces and is
 * called from both sides. Changing anything in this file changes prediction: keep it
 * deterministic, keep it free of state that only one side has.
 */

/** Collision radius of a player, in pixels. */
export const PLAYER_RADIUS = 11;

/** Base speeds in px/second before any modifier. */
export const WALK_SPEED = 105;
export const RUN_SPEED = 186;
export const CROUCH_SPEED = 62;

/** Stamina drained per second while sprinting. */
export const SPRINT_STAMINA_PER_SECOND = 11;
/** Stamina regained per second while not sprinting. */
export const STAMINA_REGEN_PER_SECOND = 7.5;
/** Sprinting is refused below this much stamina, to stop stutter-sprinting. */
export const SPRINT_STAMINA_FLOOR = 6;

/** How quickly knockback and other impulses bleed off, per second. */
export const IMPULSE_DAMPING = 7.5;

/** The subset of the world a movement step needs. */
export interface MovementWorld {
  speedAt(x: number, y: number): number;
  moveCircle(x: number, y: number, dx: number, dy: number, radius: number): MoveResult;
}

/** The subset of an entity a movement step mutates. */
export interface MovementBody {
  x: number;
  y: number;
  /** Residual impulse velocity (knockback), px/second. Not the walking velocity. */
  vx: number;
  vy: number;
  facing: number;
}

export interface MovementIntent {
  moveX: number;
  moveY: number;
  sprint: boolean;
  crouch: boolean;
}

export interface MovementResult {
  /** Distance actually travelled this step, px. */
  travelled: number;
  blockedX: boolean;
  blockedY: boolean;
  /** Speed used for this step, px/second, after every modifier. */
  speed: number;
}

/** Turn an input frame into a movement intent. */
export function intentFromFrame(frame: InputFrame): MovementIntent {
  return {
    moveX: clamp(frame.moveX, -1, 1),
    moveY: clamp(frame.moveY, -1, 1),
    sprint: hasButton(frame.buttons, Button.Sprint),
    crouch: hasButton(frame.buttons, Button.Crouch),
  };
}

/**
 * Whether something is stopping this player from walking on `tick`.
 *
 * Shared with the client rather than transcribed there. Prediction has to agree with the
 * server about this or it fights it: a stagger is three ticks and shows up as a twitch,
 * but raising a frame holds a player for seconds, and a client predicting movement through
 * all of it would be corrected on every single snapshot.
 */
export function movementLocked(player: { actionLockedUntilTick: number }, tick: number): boolean {
  return player.actionLockedUntilTick > tick;
}

/**
 * Strip the movement out of a frame while leaving everything else intact.
 *
 * Aim and buttons survive: being held in place stops you walking, not looking or swinging.
 * Sprint needs no special handling - `stepPlayerMovement` only sprints when there is
 * movement intent to sprint with.
 */
export function withoutMovement(frame: InputFrame): InputFrame {
  return { ...frame, moveX: 0, moveY: 0 };
}

/** Which stance an intent implies, given whether sprinting is currently allowed. */
export function resolveMoveMode(intent: MovementIntent, canSprint: boolean): MoveMode {
  if (intent.crouch) return 'crouch';
  if (intent.sprint && canSprint) return 'run';
  return 'walk';
}

export function baseSpeedFor(mode: MoveMode): number {
  switch (mode) {
    case 'run':
      return RUN_SPEED;
    case 'crouch':
      return CROUCH_SPEED;
    default:
      return WALK_SPEED;
  }
}

/**
 * Every multiplier the player's own condition applies to their speed.
 *
 * Computed from `PlayerState` alone so the client - which holds a full copy of its own
 * player state - arrives at the same number as the server without extra messages.
 */
export function conditionSpeedMultiplier(player: PlayerState, data: GameData): number {
  let multiplier = legMobilityMultiplier(player.body);

  // Pain makes you slow and clumsy.
  const pain = totalPain(player.body);
  multiplier *= 1 - Math.min(0.35, (pain / 100) * 0.35);

  // Exhaustion and starvation bite hard at the extremes but are ignorable early.
  if (player.fatigue > 70) multiplier *= 1 - ((player.fatigue - 70) / 30) * 0.25;
  if (player.hunger > 80) multiplier *= 1 - ((player.hunger - 80) / 20) * 0.2;
  if (player.thirst > 80) multiplier *= 1 - ((player.thirst - 80) / 20) * 0.2;

  // Armour encumbrance.
  let encumbrance = 0;
  for (const slot of ['head', 'face', 'chest', 'legs', 'feet', 'hands', 'back'] as const) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    if (def?.armor) encumbrance += def.armor.encumbrance;
  }
  multiplier *= 1 - Math.min(0.4, encumbrance);

  // Carrying more than you can manage.
  if (player.carryCapacity > 0 && player.carryWeight > player.carryCapacity) {
    const over = (player.carryWeight - player.carryCapacity) / player.carryCapacity;
    multiplier *= Math.max(0.35, 1 - Math.min(0.5, over * 0.5));
  }

  return Math.max(0.15, multiplier);
}

/**
 * Advance one movement step.
 *
 * `dt` must be the fixed simulation timestep on both sides. The walking component is
 * applied directly (crisp, responsive controls) while impulses such as knockback live
 * in `vx`/`vy` and decay exponentially, so a hit shoves you without making normal
 * movement feel floaty.
 */
export function stepMovement(
  world: MovementWorld,
  body: MovementBody,
  intent: MovementIntent,
  speed: number,
  dt: number,
  radius = PLAYER_RADIUS,
): MovementResult {
  let dirX = intent.moveX;
  let dirY = intent.moveY;
  const length = Math.hypot(dirX, dirY);
  if (length > 1) {
    // Normalise so diagonal movement is not faster than cardinal movement.
    dirX /= length;
    dirY /= length;
  }

  const terrain = world.speedAt(body.x, body.y);
  const effectiveSpeed = speed * terrain;

  const walkX = dirX * effectiveSpeed * dt;
  const walkY = dirY * effectiveSpeed * dt;
  const impulseX = body.vx * dt;
  const impulseY = body.vy * dt;

  const startX = body.x;
  const startY = body.y;
  const result = world.moveCircle(body.x, body.y, walkX + impulseX, walkY + impulseY, radius);
  body.x = result.x;
  body.y = result.y;

  // Exponential decay, framerate independent.
  const decay = Math.exp(-IMPULSE_DAMPING * dt);
  body.vx *= decay;
  body.vy *= decay;
  if (Math.abs(body.vx) < 0.5) body.vx = 0;
  if (Math.abs(body.vy) < 0.5) body.vy = 0;
  // A wall absorbs the impulse rather than letting it push forever.
  if (result.blockedX) body.vx = 0;
  if (result.blockedY) body.vy = 0;

  if (length > 0.01) body.facing = Math.atan2(dirY, dirX);

  return {
    travelled: Math.hypot(body.x - startX, body.y - startY),
    blockedX: result.blockedX,
    blockedY: result.blockedY,
    speed: effectiveSpeed,
  };
}

/**
 * The full player movement step, stamina included.
 *
 * This is the function the client's predictor replays and the server's movement system
 * calls. It mutates `player` in place and returns what happened.
 */
export function stepPlayerMovement(
  world: MovementWorld,
  player: PlayerState,
  frame: InputFrame,
  data: GameData,
  dt: number,
): MovementResult {
  const intent = intentFromFrame(frame);
  const moving = Math.abs(intent.moveX) > 0.01 || Math.abs(intent.moveY) > 0.01;
  const canSprint = player.stamina > SPRINT_STAMINA_FLOOR && moving;

  const mode = resolveMoveMode(intent, canSprint);
  player.moveMode = mode;
  player.aimAngle = frame.aimAngle;

  const speed = baseSpeedFor(mode) * conditionSpeedMultiplier(player, data);
  const result = stepMovement(world, player, intent, speed, dt);

  if (mode === 'run' && moving) {
    player.stamina = Math.max(0, player.stamina - SPRINT_STAMINA_PER_SECOND * dt);
  } else {
    // Recovery is slower while starving or exhausted, but never fully stops.
    const penalty = 1 - Math.min(0.6, player.fatigue / 200 + player.hunger / 300);
    player.stamina = Math.min(
      player.maxStamina,
      player.stamina + STAMINA_REGEN_PER_SECOND * penalty * dt,
    );
  }

  return result;
}
