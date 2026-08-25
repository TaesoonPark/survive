import type { PlayerState, StatusEffectId, StatusEffectState } from '@survive/protocol';
import type { SimContext } from './context';

/**
 * Status effect bookkeeping.
 *
 * Effects are timed modifiers on a player: painkillers, fever, hypothermia,
 * overencumbrance. They are stored as plain records so they serialize with the
 * player, and they are additive rather than stacking - reapplying an effect refreshes
 * its duration and takes the stronger magnitude.
 */

/** Duration meaning "until something removes it". */
export const PERMANENT = -1;

export function findEffect(player: PlayerState, id: StatusEffectId): StatusEffectState | undefined {
  return player.effects.find((effect) => effect.id === id);
}

export function hasEffect(player: PlayerState, id: StatusEffectId): boolean {
  return player.effects.some((effect) => effect.id === id);
}

/** Magnitude of an effect, or 0 when it is not active. */
export function effectMagnitude(player: PlayerState, id: StatusEffectId): number {
  return findEffect(player, id)?.magnitude ?? 0;
}

/**
 * Apply an effect, refreshing an existing one rather than stacking duplicates.
 * Emits `effectApplied` only when the effect is new or grew stronger, so the client
 * does not flash a toast every tick for a continuously reapplied condition.
 */
export function addEffect(
  ctx: SimContext,
  player: PlayerState,
  id: StatusEffectId,
  durationTicks: number,
  magnitude: number,
  sourceId?: string,
): void {
  const endsTick = durationTicks === PERMANENT ? PERMANENT : ctx.state.tick + durationTicks;
  const existing = findEffect(player, id);
  if (existing) {
    const grew = magnitude > existing.magnitude;
    existing.magnitude = Math.max(existing.magnitude, magnitude);
    existing.endsTick =
      existing.endsTick === PERMANENT || endsTick === PERMANENT
        ? PERMANENT
        : Math.max(existing.endsTick, endsTick);
    if (sourceId) existing.sourceId = sourceId;
    if (grew) {
      ctx.events.emit({
        type: 'effectApplied',
        entityId: player.id,
        effect: id,
        magnitude: existing.magnitude,
        durationTicks,
      });
    }
    player.rev++;
    return;
  }
  const effect: StatusEffectState = {
    id,
    startedTick: ctx.state.tick,
    endsTick,
    magnitude,
  };
  if (sourceId) effect.sourceId = sourceId;
  player.effects.push(effect);
  player.rev++;
  ctx.events.emit({
    type: 'effectApplied',
    entityId: player.id,
    effect: id,
    magnitude,
    durationTicks,
  });
}

/** Remove an effect if present. Returns true when something was removed. */
export function removeEffect(ctx: SimContext, player: PlayerState, id: StatusEffectId): boolean {
  const index = player.effects.findIndex((effect) => effect.id === id);
  if (index < 0) return false;
  player.effects.splice(index, 1);
  player.rev++;
  ctx.events.emit({ type: 'effectExpired', entityId: player.id, effect: id });
  return true;
}

/**
 * Drop expired effects. Called once per tick by the survival system; every other
 * system can then treat the effect list as current.
 */
export function expireEffects(ctx: SimContext, player: PlayerState): void {
  if (player.effects.length === 0) return;
  const tick = ctx.state.tick;
  for (let i = player.effects.length - 1; i >= 0; i--) {
    const effect = player.effects[i];
    if (!effect) continue;
    if (effect.endsTick === PERMANENT || effect.endsTick > tick) continue;
    player.effects.splice(i, 1);
    player.rev++;
    ctx.events.emit({ type: 'effectExpired', entityId: player.id, effect: effect.id });
  }
}

/**
 * Ensure an effect is present exactly while a condition holds.
 *
 * Used for the continuous conditions - cold, overencumbered, exhausted - where the
 * survival system re-evaluates every tick and wants the effect list to follow along
 * without emitting a stream of events.
 */
export function setConditionEffect(
  ctx: SimContext,
  player: PlayerState,
  id: StatusEffectId,
  active: boolean,
  magnitude = 1,
): void {
  if (active) {
    const existing = findEffect(player, id);
    if (existing) {
      existing.magnitude = magnitude;
      existing.endsTick = PERMANENT;
      return;
    }
    addEffect(ctx, player, id, PERMANENT, magnitude);
  } else {
    removeEffect(ctx, player, id);
  }
}
