/**
 * Per-body-part injury model.
 *
 * Deliberately free of any engine dependency: the whole thing is plain data plus the
 * pure helpers below, so it is unit-testable without Phaser, a server, or a clock
 * (spec section 26).
 */

export type BodyPartId = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export const BODY_PART_IDS: readonly BodyPartId[] = [
  'head',
  'torso',
  'leftArm',
  'rightArm',
  'leftLeg',
  'rightLeg',
];

/** Human-readable names, for UI and logs. */
export const BODY_PART_LABELS: Record<BodyPartId, string> = {
  head: 'Head',
  torso: 'Torso',
  leftArm: 'Left Arm',
  rightArm: 'Right Arm',
  leftLeg: 'Left Leg',
  rightLeg: 'Right Leg',
};

/**
 * Relative hit likelihood for an untargeted attack. Torso is the biggest target;
 * the head is the smallest and the most punishing.
 */
export const BODY_PART_HIT_WEIGHTS: Record<BodyPartId, number> = {
  head: 6,
  torso: 40,
  leftArm: 13,
  rightArm: 13,
  leftLeg: 14,
  rightLeg: 14,
};

/** Damage multiplier applied when a part is struck. */
export const BODY_PART_DAMAGE_MULTIPLIER: Record<BodyPartId, number> = {
  head: 2.4,
  torso: 1,
  leftArm: 0.7,
  rightArm: 0.7,
  leftLeg: 0.8,
  rightLeg: 0.8,
};

/** Maximum health of each part at full fitness. */
export const BODY_PART_MAX_HEALTH: Record<BodyPartId, number> = {
  head: 40,
  torso: 100,
  leftArm: 55,
  rightArm: 55,
  leftLeg: 65,
  rightLeg: 65,
};

/**
 * How much each part contributes to overall health. Losing an arm hurts; losing the
 * head or torso is fatal, which is handled separately in {@link isFatalBody}.
 */
export const BODY_PART_HEALTH_WEIGHT: Record<BodyPartId, number> = {
  head: 0.22,
  torso: 0.34,
  leftArm: 0.09,
  rightArm: 0.09,
  leftLeg: 0.13,
  rightLeg: 0.13,
};

export interface BodyPartState {
  health: number;
  maxHealth: number;
  /** Blood loss rate in units/second while untreated. 0 = not bleeding. */
  bleeding: number;
  /** Pain, 0..100. Drives movement/aim penalties and blackout risk. */
  pain: number;
  fractured: boolean;
  /** Burn severity, 0..100. */
  burned: number;
  /** Set by a zombie bite; the entry point for infection. */
  bitten: boolean;
  /** Wound infection, 0..100. At 100 the player is dying of sepsis. */
  infection: number;
  bandaged: boolean;
  /** Cleanliness of the applied bandage, 0..1. Dirty rags raise infection risk. */
  bandageQuality: number;
  stitched: boolean;
  splinted: boolean;
  /** Ticks of remaining disinfectant protection. */
  disinfectedTicks: number;
}

export interface BodyState {
  parts: Record<BodyPartId, BodyPartState>;
}

export function createBodyPart(maxHealth: number): BodyPartState {
  return {
    health: maxHealth,
    maxHealth,
    bleeding: 0,
    pain: 0,
    fractured: false,
    burned: 0,
    bitten: false,
    infection: 0,
    bandaged: false,
    bandageQuality: 0,
    stitched: false,
    splinted: false,
    disinfectedTicks: 0,
  };
}

export function createBody(scale = 1): BodyState {
  const parts = {} as Record<BodyPartId, BodyPartState>;
  for (const id of BODY_PART_IDS) {
    parts[id] = createBodyPart(Math.round(BODY_PART_MAX_HEALTH[id] * scale));
  }
  return { parts };
}

/** Weighted overall health fraction, 0..1. */
export function bodyHealthFraction(body: BodyState): number {
  let total = 0;
  for (const id of BODY_PART_IDS) {
    const part = body.parts[id];
    const fraction = part.maxHealth > 0 ? part.health / part.maxHealth : 0;
    total += fraction * BODY_PART_HEALTH_WEIGHT[id];
  }
  return Math.max(0, Math.min(1, total));
}

/** Destroying the head or torso kills outright, whatever the aggregate says. */
export function isFatalBody(body: BodyState): boolean {
  return body.parts.head.health <= 0 || body.parts.torso.health <= 0;
}

/** Total bleed rate across all parts, in blood units/second. */
export function totalBleeding(body: BodyState): number {
  let total = 0;
  for (const id of BODY_PART_IDS) total += body.parts[id].bleeding;
  return total;
}

/** Highest infection value across all parts. */
export function worstInfection(body: BodyState): number {
  let worst = 0;
  for (const id of BODY_PART_IDS) worst = Math.max(worst, body.parts[id].infection);
  return worst;
}

/**
 * Aggregate pain, 0..100. Weighted so a shattered leg reads as more debilitating
 * than a scraped forearm.
 */
export function totalPain(body: BodyState): number {
  let sum = 0;
  let weight = 0;
  for (const id of BODY_PART_IDS) {
    const w = BODY_PART_HEALTH_WEIGHT[id];
    sum += body.parts[id].pain * w;
    weight += w;
  }
  return weight > 0 ? Math.min(100, sum / weight) : 0;
}

/**
 * Movement speed multiplier from leg condition, 0.25..1.
 * A fractured, unsplinted leg is close to crippling.
 */
export function legMobilityMultiplier(body: BodyState): number {
  let multiplier = 1;
  for (const id of ['leftLeg', 'rightLeg'] as const) {
    const leg = body.parts[id];
    const damage = 1 - (leg.maxHealth > 0 ? leg.health / leg.maxHealth : 0);
    multiplier -= damage * 0.28;
    if (leg.fractured) multiplier -= leg.splinted ? 0.12 : 0.3;
  }
  return Math.max(0.25, multiplier);
}

/**
 * Attack/aim capability multiplier from arm condition, 0.3..1.
 * Only the better arm matters much: you swing with the good one.
 */
export function armCapabilityMultiplier(body: BodyState): number {
  let best = 0;
  for (const id of ['leftArm', 'rightArm'] as const) {
    const arm = body.parts[id];
    let value = arm.maxHealth > 0 ? arm.health / arm.maxHealth : 0;
    if (arm.fractured) value *= arm.splinted ? 0.6 : 0.3;
    best = Math.max(best, value);
  }
  return Math.max(0.3, Math.min(1, 0.3 + best * 0.7));
}

/** True when any part still needs treatment. Drives the "injured" HUD indicator. */
export function needsTreatment(body: BodyState): boolean {
  for (const id of BODY_PART_IDS) {
    const part = body.parts[id];
    if (part.bleeding > 0 || part.infection > 0 || part.fractured || part.burned > 0) return true;
    if (part.health < part.maxHealth) return true;
  }
  return false;
}
