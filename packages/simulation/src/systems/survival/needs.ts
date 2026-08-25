import { clamp, type PlayerState } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import {
  effectMagnitude,
  findEffect,
  hasEffect,
  removeEffect,
  setConditionEffect,
} from '../../core/effects';
import {
  activityScale,
  activityWarmth,
  clothingWarmth,
  nearbyFireWarmth,
  wetnessSource,
} from './environment';
import { applyAttrition, crossedUp, notify } from './attrition';
import type { SurvivalTick } from './tick';
import {
  BURNING_THRESHOLD,
  COLD_DAMAGE_PER_DEGREE_SECOND,
  COLD_HUNGER_SCALE,
  COMFORT_AMBIENT,
  CORE_TEMPERATURE,
  DEHYDRATION_DAMAGE_PER_SECOND,
  EXHAUSTION_DAMAGE_PER_SECOND,
  EXHAUSTION_STAMINA_PER_SECOND,
  FATIGUE_PER_SECOND,
  FATIGUE_RECOVERY_PER_SECOND,
  FEVER_TEMPERATURE_PUSH,
  FEVER_THIRST_SCALE,
  FREEZING_THRESHOLD,
  HEAT_DAMAGE_PER_DEGREE_SECOND,
  HOT_THIRST_SCALE,
  HUNGER_PER_SECOND,
  ILLNESS_DAMAGE_PER_SECOND,
  ILLNESS_HUNGER_SCALE,
  ILLNESS_THIRST_SCALE,
  NEED_CRITICAL,
  NEED_URGENT,
  NEED_WARN,
  SLEEP_NEED_SCALE,
  STARVATION_DAMAGE_PER_SECOND,
  TEMP_SENSITIVITY,
  TEMP_TAU_SECONDS,
  THIRST_PER_SECOND,
  WET_CHILL,
  WET_DRY_PER_SECOND,
  WET_FIRE_DRY_SCALE,
  WET_FLOOR,
  WET_GAIN_PER_SECOND,
} from './tuning';

/**
 * Hunger, thirst, fatigue and body temperature: the clock of doom.
 *
 * Needs use **need semantics** throughout - 0 is satisfied, 100 is critical - and
 * every rate here is per second of simulated time, scaled by
 * `ctx.config.tuning.needRate` so a server can run a gentler or crueller world
 * without touching the code.
 *
 * At 100 each need starts killing, through `damagePlayer` with `ignoreArmor` and
 * `silent`. The player is warned by `notification` on crossing a threshold instead,
 * because per-tick attrition events would bury everything else in the feed.
 */

/** Wording for each need's warnings, so the three arcs read consistently. */
const NEED_MESSAGES = {
  hunger: {
    warn: 'You are getting hungry.',
    urgent: 'You are famished. Find food.',
    critical: 'You are starving to death.',
  },
  thirst: {
    warn: 'Your throat is dry.',
    urgent: 'You are badly dehydrated. Find water.',
    critical: 'You are dying of thirst.',
  },
  fatigue: {
    warn: 'You are tired.',
    urgent: 'You can barely keep your eyes open.',
    critical: 'You are collapsing from exhaustion.',
  },
} as const;

function warnNeed(
  ctx: SimContext,
  player: PlayerState,
  need: keyof typeof NEED_MESSAGES,
  before: number,
  after: number,
): void {
  const messages = NEED_MESSAGES[need];
  if (crossedUp(before, after, NEED_CRITICAL)) notify(ctx, player, 'error', messages.critical);
  else if (crossedUp(before, after, NEED_URGENT)) notify(ctx, player, 'warn', messages.urgent);
  else if (crossedUp(before, after, NEED_WARN)) notify(ctx, player, 'info', messages.warn);
}

/** Illness of the gut, from spoiled food or bad water. */
function isIll(player: PlayerState): boolean {
  return hasEffect(player, 'food_poisoning') || hasEffect(player, 'poisoned');
}

/**
 * Advance hunger, thirst and fatigue, and apply the damage each does at 100.
 *
 * Returns true when the player died this tick, in which case the caller must stop
 * processing them.
 */
export function stepNeeds(ctx: SimContext, player: PlayerState, tick: SurvivalTick): boolean {
  const { dt } = tick;
  const rate = ctx.config.tuning.needRate;
  const activity = activityScale(ctx, player);
  const sleeping = tick.asleep ? SLEEP_NEED_SCALE : 1;

  // Shivering burns calories and sweating costs water, both capped so a single bad
  // afternoon cannot double the whole arc.
  const chill = Math.min(1, Math.max(0, CORE_TEMPERATURE - player.temperature) / 4);
  const swelter = Math.min(1, Math.max(0, player.temperature - CORE_TEMPERATURE) / 4);
  const ill = isIll(player);
  const fever = hasEffect(player, 'fever');

  let hungerScale = activity * sleeping * (1 + chill * COLD_HUNGER_SCALE);
  let thirstScale = activity * sleeping * (1 + swelter * HOT_THIRST_SCALE);
  if (fever) thirstScale *= FEVER_THIRST_SCALE;
  if (ill) {
    thirstScale *= ILLNESS_THIRST_SCALE;
    hungerScale *= ILLNESS_HUNGER_SCALE;
  }

  const hungerBefore = player.hunger;
  const thirstBefore = player.thirst;
  const fatigueBefore = player.fatigue;

  player.hunger = clamp(player.hunger + HUNGER_PER_SECOND * hungerScale * rate * dt, 0, 100);
  player.thirst = clamp(player.thirst + THIRST_PER_SECOND * thirstScale * rate * dt, 0, 100);

  if (tick.asleep) {
    player.fatigue = clamp(
      player.fatigue - FATIGUE_RECOVERY_PER_SECOND * tick.sleepScale * dt,
      0,
      100,
    );
  } else {
    // Caffeine and a good night's sleep both leave you accumulating fatigue slower.
    const rested = 1 - Math.min(0.8, effectMagnitude(player, 'well_rested'));
    player.fatigue = clamp(
      player.fatigue + FATIGUE_PER_SECOND * activity * rested * rate * dt,
      0,
      100,
    );
  }

  warnNeed(ctx, player, 'hunger', hungerBefore, player.hunger);
  warnNeed(ctx, player, 'thirst', thirstBefore, player.thirst);
  warnNeed(ctx, player, 'fatigue', fatigueBefore, player.fatigue);

  if (player.thirst >= NEED_CRITICAL) {
    if (applyAttrition(ctx, player, DEHYDRATION_DAMAGE_PER_SECOND, 'dehydration', 'dehydration')) {
      return true;
    }
  }
  if (player.hunger >= NEED_CRITICAL) {
    if (applyAttrition(ctx, player, STARVATION_DAMAGE_PER_SECOND, 'starvation', 'starvation')) {
      return true;
    }
  }
  if (player.fatigue >= NEED_CRITICAL) {
    player.stamina = Math.max(0, player.stamina - EXHAUSTION_STAMINA_PER_SECOND * dt);
    if (applyAttrition(ctx, player, EXHAUSTION_DAMAGE_PER_SECOND, 'exhaustion', 'exhaustion')) {
      return true;
    }
  }
  if (ill && applyAttrition(ctx, player, ILLNESS_DAMAGE_PER_SECOND, 'poison', 'illness')) {
    return true;
  }

  return false;
}

/**
 * Update how soaked the player is.
 *
 * `wet` is carried as a status effect with a hand-managed magnitude rather than a
 * fixed duration, because getting wet is fast and drying out is slow - and drying
 * out next to a fire is fast again. A fixed `endsTick` could express none of that.
 */
function stepWetness(
  ctx: SimContext,
  player: PlayerState,
  source: number,
  fireWarmth: number,
  dt: number,
): number {
  const existing = findEffect(player, 'wet');
  const current = existing?.magnitude ?? 0;
  const dryRate = WET_DRY_PER_SECOND * (1 + fireWarmth * WET_FIRE_DRY_SCALE);
  const next = clamp(
    source > current
      ? Math.min(source, current + WET_GAIN_PER_SECOND * dt)
      : Math.max(source, current - dryRate * dt),
    0,
    1,
  );
  // The floor only applies on the way *down*. Getting soaked starts from zero and
  // climbs by a fraction of a point per tick, so snapping in both directions would
  // mean standing in a downpour never made anyone wet.
  if (next <= WET_FLOOR && source <= next) {
    if (existing) removeEffect(ctx, player, 'wet');
    return 0;
  }
  setConditionEffect(ctx, player, 'wet', true, next);
  return next;
}

/**
 * Drift body temperature towards what the environment implies, then punish the
 * extremes. Returns true when the player died this tick.
 *
 * The core is a good regulator, so the target is only nudged off 37 by a fraction
 * of the effective-ambient deviation ({@link TEMP_SENSITIVITY}). What actually
 * decides your fate is the *effective* ambient: air temperature plus clothing, plus
 * whatever fire you are standing next to, plus the heat of working, minus the chill
 * of being soaked.
 */
export function stepTemperature(ctx: SimContext, player: PlayerState, tick: SurvivalTick): boolean {
  const { dt } = tick;
  const fireWarmth = nearbyFireWarmth(ctx, player);
  const wet = stepWetness(ctx, player, wetnessSource(ctx, player), fireWarmth, dt);

  const effectiveAmbient =
    ctx.state.weather.temperature +
    clothingWarmth(ctx, player) +
    fireWarmth +
    activityWarmth(ctx, player) -
    wet * WET_CHILL;

  let target = CORE_TEMPERATURE + (effectiveAmbient - COMFORT_AMBIENT) * TEMP_SENSITIVITY;
  if (hasEffect(player, 'fever')) target += FEVER_TEMPERATURE_PUSH;

  // Exponential approach, framerate independent.
  player.temperature += (target - player.temperature) * (1 - Math.exp(-dt / TEMP_TAU_SECONDS));

  if (player.temperature < FREEZING_THRESHOLD) {
    const severity = (FREEZING_THRESHOLD - player.temperature) * COLD_DAMAGE_PER_DEGREE_SECOND;
    if (applyAttrition(ctx, player, severity, 'cold', 'hypothermia')) return true;
  } else if (player.temperature > BURNING_THRESHOLD) {
    const severity = (player.temperature - BURNING_THRESHOLD) * HEAT_DAMAGE_PER_DEGREE_SECOND;
    if (applyAttrition(ctx, player, severity, 'heat', 'heatstroke')) return true;
  }

  return false;
}
