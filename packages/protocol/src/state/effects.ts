/** Timed status effects applied to a player. */
export type StatusEffectId =
  | 'well_fed'
  | 'hydrated'
  | 'well_rested'
  | 'painkiller'
  | 'antibiotic'
  | 'antiseptic'
  | 'adrenaline'
  | 'bandaged'
  | 'fever'
  | 'poisoned'
  | 'food_poisoning'
  | 'bleeding'
  | 'exhausted'
  | 'overencumbered'
  | 'cold'
  | 'hypothermia'
  | 'hot'
  | 'heatstroke'
  | 'stunned'
  | 'wet'
  | 'sepsis'
  | 'zombification';

export interface StatusEffectState {
  id: StatusEffectId;
  startedTick: number;
  /** Tick at which the effect expires. Use `Infinity`-free encoding: -1 = permanent. */
  endsTick: number;
  /** Effect strength; meaning is per-effect (e.g. pain reduction, damage per second). */
  magnitude: number;
  /** Entity or item that caused it, for attribution in the kill feed. */
  sourceId?: string;
}

/** Effects the player should see as harmful in the HUD. */
export const HARMFUL_EFFECTS: readonly StatusEffectId[] = [
  'fever',
  'poisoned',
  'food_poisoning',
  'bleeding',
  'exhausted',
  'overencumbered',
  'cold',
  'hypothermia',
  'hot',
  'heatstroke',
  'stunned',
  'sepsis',
  'zombification',
];

export function findEffect(
  effects: readonly StatusEffectState[],
  id: StatusEffectId,
): StatusEffectState | undefined {
  return effects.find((effect) => effect.id === id);
}

export function hasEffect(effects: readonly StatusEffectState[], id: StatusEffectId): boolean {
  return effects.some((effect) => effect.id === id);
}
