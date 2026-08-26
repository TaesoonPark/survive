import type { BodyPartId, DamageType, PlayerState } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { damagePlayer } from '../../core/damage';
import { killPlayer } from '../../core/death';

/**
 * How the survival system hurts you, and how it tells you.
 *
 * Environmental attrition is applied through the one damage pipeline in
 * `core/damage` so armour rules, body-part bookkeeping and death stay identical to
 * a sword blow - but with two flags that matter:
 *
 * - `ignoreArmor`, because a kevlar vest does nothing about dehydration; and
 * - `silent`, because a `damage` event every tick for twenty ticks a second would
 *   drown the event feed and the client's floating-number layer.
 *
 * The player is told what is happening with a `notification` on crossing a
 * threshold instead, which is one event per meaningful change rather than per tick.
 */

/**
 * Apply one tick of attrition. Returns true when this killed the player, in which
 * case the caller must stop processing them for the tick.
 *
 * Environmental damage goes to the torso: starving, freezing and going septic are
 * organ failure, not a wound on a limb, and spreading it around the body would let
 * a player survive starvation with a scratched forearm.
 */
export function applyAttrition(
  ctx: SimContext,
  player: PlayerState,
  amountPerSecond: number,
  type: DamageType,
  cause: string,
  bodyPart: BodyPartId = 'torso',
): boolean {
  const amount = amountPerSecond * ctx.clock.dt;
  if (amount <= 0) return false;
  const result = damagePlayer(ctx, player, {
    amount,
    type,
    bodyPart,
    ignoreArmor: true,
    silent: true,
    bleedFactor: 0,
    fractureChance: 0,
    cause,
  });
  if (!result.killed) return false;
  killPlayer(ctx, player, cause);
  return true;
}

/** Private feedback to one player. The UI turns these into toasts. */
export function notify(
  ctx: SimContext,
  player: PlayerState,
  severity: 'info' | 'warn' | 'error' | 'success',
  code: string,
  params?: Record<string, string | number>,
): void {
  ctx.events.emit({
    type: 'notification',
    playerId: player.id,
    severity,
    message: params ? { code, params } : { code },
  });
}

/** Tell a client its command was refused, and why. */
export function reject(
  ctx: SimContext,
  player: PlayerState,
  command: string,
  reason: string,
): void {
  ctx.events.emit({ type: 'commandRejected', playerId: player.id, command, reason });
}

/**
 * Whether a value crossed a threshold upwards this tick.
 *
 * Lets the thresholds be stateless: the system already knows the value before and
 * after, so it does not need a per-player "last warned at" field in replicated state.
 */
export function crossedUp(before: number, after: number, threshold: number): boolean {
  return before < threshold && after >= threshold;
}

/**
 * Whether a value crossed a threshold downwards this tick.
 *
 * The mirror of {@link crossedUp}, for the stats that run the other way: blood,
 * stamina and body-part health are all "0 is bad".
 */
export function crossedDown(before: number, after: number, threshold: number): boolean {
  return before > threshold && after <= threshold;
}
