import { totalBleeding, type PlayerState } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { hasEffect, setConditionEffect } from '../../core/effects';
import { notify } from './attrition';
import {
  COLD_THRESHOLD,
  EXHAUSTED_THRESHOLD,
  HEATSTROKE_THRESHOLD,
  HOT_THRESHOLD,
  HYPOTHERMIA_THRESHOLD,
} from './tuning';

/**
 * The continuous conditions.
 *
 * These are not timed effects - nothing "wears off" - they are a projection of the
 * player's current numbers into the effect list so the HUD, the movement code and
 * the AI can all read one place. {@link setConditionEffect} keeps them in step
 * without emitting an event every tick, which is exactly what it exists for.
 *
 * Infection's own conditions (`fever`, `sepsis`, `zombification`) are set in
 * `injury.ts` instead, because they are derived from the worst wound rather than
 * from a player-level number.
 */
export function applyConditionEffects(ctx: SimContext, player: PlayerState): void {
  const wasHypothermic = hasEffect(player, 'hypothermia');
  const wasHeatstruck = hasEffect(player, 'heatstroke');

  const overload = player.carryCapacity > 0 ? player.carryWeight / player.carryCapacity - 1 : 0;
  setConditionEffect(ctx, player, 'overencumbered', overload > 0, Math.min(2, overload));

  setConditionEffect(
    ctx,
    player,
    'exhausted',
    player.fatigue >= EXHAUSTED_THRESHOLD,
    Math.max(0.05, (player.fatigue - EXHAUSTED_THRESHOLD) / (100 - EXHAUSTED_THRESHOLD)),
  );

  const temperature = player.temperature;
  setConditionEffect(
    ctx,
    player,
    'cold',
    temperature < COLD_THRESHOLD,
    COLD_THRESHOLD - temperature,
  );
  setConditionEffect(
    ctx,
    player,
    'hypothermia',
    temperature < HYPOTHERMIA_THRESHOLD,
    HYPOTHERMIA_THRESHOLD - temperature,
  );
  setConditionEffect(ctx, player, 'hot', temperature > HOT_THRESHOLD, temperature - HOT_THRESHOLD);
  setConditionEffect(
    ctx,
    player,
    'heatstroke',
    temperature > HEATSTROKE_THRESHOLD,
    temperature - HEATSTROKE_THRESHOLD,
  );

  const bleedRate = totalBleeding(player.body);
  setConditionEffect(ctx, player, 'bleeding', bleedRate > 0, bleedRate);

  // The two conditions worth interrupting the player for. Everything else is
  // visible in the HUD and does not need a toast.
  if (!wasHypothermic && hasEffect(player, 'hypothermia')) {
    notify(ctx, player, 'error', 'notify.hypothermia');
  }
  if (!wasHeatstruck && hasEffect(player, 'heatstroke')) {
    notify(ctx, player, 'error', 'notify.heatstroke');
  }
}
