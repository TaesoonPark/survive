import {
  BODY_PART_IDS,
  BODY_PART_LABELS,
  clamp,
  totalPain,
  type BodyPartId,
  type PlayerState,
} from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { syncHealthFromBody } from '../../core/damage';
import { killPlayer } from '../../core/death';
import { effectMagnitude, hasEffect, setConditionEffect } from '../../core/effects';
import { applyAttrition, crossedDown, notify } from './attrition';
import type { SurvivalTick } from './tick';
import {
  ANTIBIOTIC_CURE_PER_SECOND,
  BANDAGED_CLOT_SCALE,
  BLACKOUT_CHANCE_PER_SECOND,
  BLACKOUT_PAIN,
  BLACKOUT_SECONDS,
  BLEED_CLOT_PER_SECOND,
  BLOOD_LOSS_DAMAGE_PER_SECOND,
  BLOOD_LOSS_SCALE,
  BLOOD_REGEN_NEED_MAX,
  BLOOD_REGEN_PER_SECOND,
  BURN_HEAL_PER_SECOND,
  CRITICAL_BLOOD,
  FEVER_THRESHOLD,
  FRACTURE_PAIN_FLOOR,
  HEAL_BLOOD_MIN,
  HEAL_NEED_MAX,
  HEAL_PER_SECOND,
  INFECTION_ANTISEPTIC_SCALE,
  INFECTION_BANDAGE_BASE,
  INFECTION_BANDAGE_PER_CLEANLINESS,
  INFECTION_DISINFECTED_SCALE,
  INFECTION_EVENT_STEP,
  INFECTION_MALNOURISHED_NEED,
  INFECTION_MALNOURISHED_SCALE,
  INFECTION_OPEN_SCALE,
  INFECTION_PER_SECOND,
  INFECTION_STITCHED_SCALE,
  LOW_BLOOD,
  MINOR_BLEED_CAP,
  PAINKILLER_DECAY_SCALE,
  PAIN_DECAY_PER_SECOND,
  SEPSIS_DAMAGE_PER_SECOND,
  SEPSIS_THRESHOLD,
  SLEEP_HEAL_SCALE,
  SPLINTED_PAIN_FLOOR,
  STITCHED_CLOT_SCALE,
  ZOMBIFICATION_THRESHOLD,
} from './tuning';

/**
 * Wounds over time: bleeding, infection, pain and the slow business of healing.
 *
 * The body model in `@survive/protocol` holds the per-part facts; this file is the
 * only thing that moves them on its own. Combat writes wounds, medicine treats
 * them, and these four steps decide what an untreated wound does to you between
 * those two events.
 */

/** Whether an infection value change is worth an event. */
function infectionChangeIsMeaningful(before: number, after: number): boolean {
  if (before === after) return false;
  if (after <= 0 || after >= 100) return true;
  return Math.floor(before / INFECTION_EVENT_STEP) !== Math.floor(after / INFECTION_EVENT_STEP);
}

/**
 * Drain blood through open wounds, clot what will clot, and refill what the body can.
 *
 * A wound above {@link MINOR_BLEED_CAP} does **not** clot on its own: grazes stop by
 * themselves, arterial bleeds do not, and that difference is the reason to carry
 * bandages. Returns true when the player bled out.
 */
export function stepBleeding(ctx: SimContext, player: PlayerState, tick: SurvivalTick): boolean {
  const { dt } = tick;
  const bloodBefore = player.blood;
  let totalRate = 0;

  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    if (part.bleeding <= 0) continue;
    totalRate += part.bleeding;

    const dressed = part.stitched || part.bandaged;
    if (part.bleeding > MINOR_BLEED_CAP && !dressed) continue;
    const clotScale = part.stitched ? STITCHED_CLOT_SCALE : part.bandaged ? BANDAGED_CLOT_SCALE : 1;
    part.bleeding = Math.max(0, part.bleeding - BLEED_CLOT_PER_SECOND * clotScale * dt);
    if (part.bleeding <= 0) {
      ctx.events.emit({ type: 'bleedingStopped', entityId: player.id, bodyPart: id });
    }
  }

  if (totalRate > 0) {
    player.blood = Math.max(0, player.blood - totalRate * BLOOD_LOSS_SCALE * dt);
  } else if (
    player.blood < 100 &&
    player.hunger < BLOOD_REGEN_NEED_MAX &&
    player.thirst < BLOOD_REGEN_NEED_MAX
  ) {
    // The body rebuilds blood volume out of surplus food and water, and only then.
    player.blood = Math.min(100, player.blood + BLOOD_REGEN_PER_SECOND * dt);
  }

  // Two warnings on the way down, each fired once on the crossing rather than every
  // tick below the line: the HUD already shows the number, this is the interruption.
  if (crossedDown(bloodBefore, player.blood, LOW_BLOOD)) {
    notify(ctx, player, 'warn', 'notify.bloodLossWarn');
  }
  if (crossedDown(bloodBefore, player.blood, CRITICAL_BLOOD)) {
    notify(ctx, player, 'error', 'notify.bleedingOut');
  }

  if (player.blood <= 0) {
    killPlayer(ctx, player, 'bleed');
    return true;
  }
  if (player.blood < CRITICAL_BLOOD) {
    const severity = (CRITICAL_BLOOD - player.blood) * BLOOD_LOSS_DAMAGE_PER_SECOND;
    if (applyAttrition(ctx, player, severity, 'bleed', 'blood loss')) return true;
  }
  return false;
}

/** Blood volume low enough that the client greys the screen out. */
export function isBloodCritical(player: PlayerState): boolean {
  return player.blood < LOW_BLOOD;
}

/**
 * Advance every infected wound, then apply the systemic consequences.
 *
 * The rate is a product of modifiers so each one reads on its own: an open wound is
 * worse than a dressed one, a filthy rag is worse than an open wound, disinfectant
 * and antiseptic cut it down, and antibiotics reverse it outright. Being starved or
 * parched makes all of it worse, because the immune system runs on the same
 * calories everything else does.
 *
 * Returns true when the infection killed the player.
 */
export function stepInfection(ctx: SimContext, player: PlayerState, tick: SurvivalTick): boolean {
  const { dt } = tick;
  const antibiotic = hasEffect(player, 'antibiotic');
  const antiseptic = hasEffect(player, 'antiseptic');
  const malnourished =
    player.hunger > INFECTION_MALNOURISHED_NEED || player.thirst > INFECTION_MALNOURISHED_NEED;

  let worst = 0;
  let worstIsBite = false;

  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    if (part.disinfectedTicks > 0) part.disinfectedTicks = Math.max(0, part.disinfectedTicks - 1);
    if (part.infection <= 0) continue;

    let delta: number;
    if (antibiotic) {
      delta = -ANTIBIOTIC_CURE_PER_SECOND * dt;
    } else {
      let rate = INFECTION_PER_SECOND;
      if (part.bandaged) {
        // Cleanliness 1 gives 0.4, a filthy 0.15 rag gives ~1.9.
        rate *= Math.max(
          0.3,
          INFECTION_BANDAGE_BASE - part.bandageQuality * INFECTION_BANDAGE_PER_CLEANLINESS,
        );
      } else {
        rate *= INFECTION_OPEN_SCALE;
      }
      if (part.stitched) rate *= INFECTION_STITCHED_SCALE;
      if (part.disinfectedTicks > 0) rate *= INFECTION_DISINFECTED_SCALE;
      if (antiseptic) rate *= INFECTION_ANTISEPTIC_SCALE;
      if (malnourished) rate *= INFECTION_MALNOURISHED_SCALE;
      delta = rate * dt;
    }

    const before = part.infection;
    part.infection = clamp(before + delta, 0, 100);
    if (part.infection <= 0) {
      // Cured: the bite is a healed scar now, not an open door.
      part.bitten = false;
    }
    if (infectionChangeIsMeaningful(before, part.infection)) {
      ctx.events.emit({
        type: 'infectionChanged',
        entityId: player.id,
        bodyPart: id,
        value: part.infection,
      });
    }

    if (part.infection > worst) {
      worst = part.infection;
      worstIsBite = part.bitten;
    }
  }

  // Fever, sepsis and turning are all read off the worst wound rather than summed:
  // one bad wound is what kills you, not the total of several minor ones.
  const hadFever = hasEffect(player, 'fever');
  const hadSepsis = hasEffect(player, 'sepsis');
  const wasTurning = hasEffect(player, 'zombification');
  setConditionEffect(ctx, player, 'fever', worst >= FEVER_THRESHOLD, worst / 100);
  setConditionEffect(ctx, player, 'sepsis', worst >= SEPSIS_THRESHOLD, worst / 100);
  setConditionEffect(
    ctx,
    player,
    'zombification',
    worstIsBite && worst >= ZOMBIFICATION_THRESHOLD,
    worst / 100,
  );
  // Onset only. Each of these is an escalation the player has to act on, and the
  // window to act on it closes.
  if (!hadFever && hasEffect(player, 'fever')) {
    notify(ctx, player, 'warn', 'notify.woundInfected');
  }
  if (!hadSepsis && hasEffect(player, 'sepsis')) {
    notify(ctx, player, 'error', 'notify.infectionSystemic');
  }
  if (!wasTurning && hasEffect(player, 'zombification')) {
    notify(ctx, player, 'error', 'notify.biteTurning');
  }

  if (worst >= 100 && worstIsBite) {
    // The bite won. This is the one death the player can see coming for hours.
    killPlayer(ctx, player, 'zombieBite');
    return true;
  }
  if (worst >= SEPSIS_THRESHOLD) {
    const severity = (worst - SEPSIS_THRESHOLD) * SEPSIS_DAMAGE_PER_SECOND;
    if (applyAttrition(ctx, player, severity, 'infection', 'sepsis')) return true;
  }
  return false;
}

/**
 * Shed pain, and occasionally black out from what is left.
 *
 * Painkillers do not touch the injury; they make the stored pain drain far faster
 * and dull the floor an unset fracture would otherwise hold. That is why morphine
 * lets a player with a shattered leg keep walking, and why it wears off badly.
 */
export function stepPain(ctx: SimContext, player: PlayerState, tick: SurvivalTick): void {
  const { dt } = tick;
  const relief = effectMagnitude(player, 'painkiller');
  const decay = PAIN_DECAY_PER_SECOND * (1 + relief * PAINKILLER_DECAY_SCALE);
  const dulling = Math.max(0, 1 - relief / 100);

  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    if (part.pain <= 0) continue;
    const floor = part.fractured
      ? (part.splinted ? SPLINTED_PAIN_FLOOR : FRACTURE_PAIN_FLOOR) * dulling
      : 0;
    part.pain = Math.max(floor, part.pain - decay * dt);
  }

  const pain = totalPain(player.body);
  if (pain < BLACKOUT_PAIN) return;
  if (ctx.state.tick < player.actionLockedUntilTick) return;
  const rng = ctx.rng.fork(`survival:blackout:${player.id}:${ctx.state.tick}`);
  if (!rng.chance(BLACKOUT_CHANCE_PER_SECOND * dt * (pain / 100))) return;
  player.actionLockedUntilTick = ctx.state.tick + Math.max(1, Math.round(BLACKOUT_SECONDS / dt));
  notify(ctx, player, 'error', 'notify.painBlackout');
}

/** Whether a part is in a state where new tissue can grow. */
function canRegenerate(part: {
  bleeding: number;
  infection: number;
  fractured: boolean;
  splinted: boolean;
}): boolean {
  if (part.bleeding > 0) return false;
  if (part.infection > 0) return false;
  // A break has to be set before it can knit, which is what makes splints matter.
  if (part.fractured && !part.splinted) return false;
  return true;
}

/**
 * Regenerate body parts.
 *
 * Healing has real preconditions - fed, watered, not bleeding, not infected, and
 * resting - because "wait and it comes back" is what makes injury free. Sleep is
 * when the body actually does the work, hence the large multiplier.
 */
export function stepHealing(ctx: SimContext, player: PlayerState, tick: SurvivalTick): void {
  if (!tick.resting) return;
  if (player.hunger >= HEAL_NEED_MAX || player.thirst >= HEAL_NEED_MAX) return;
  if (player.blood < HEAL_BLOOD_MIN) return;

  const scale = tick.asleep ? SLEEP_HEAL_SCALE * tick.sleepScale : 1;
  const amount = HEAL_PER_SECOND * scale * tick.dt;
  let healed = 0;
  const mended: BodyPartId[] = [];

  for (const id of BODY_PART_IDS) {
    const part = player.body.parts[id];
    if (part.burned > 0) {
      part.burned = Math.max(0, part.burned - BURN_HEAL_PER_SECOND * scale * tick.dt);
    }
    // A splinted break knits as the tissue around it does, so "back to full health"
    // *is* the mend condition rather than a second timer. That coupling is safe
    // because the damage pipeline only fractures a part at severity > 0.18: a real
    // fracture always arrives with a fifth of the limb's health gone, which is what
    // makes this the slow arc the splint exists for.
    if (part.health >= part.maxHealth) {
      if (part.fractured && part.splinted) {
        part.fractured = false;
        part.splinted = false;
        mended.push(id);
      }
      continue;
    }
    if (!canRegenerate(part)) continue;
    // A knitting bone repairs far slower than torn muscle.
    const before = part.health;
    part.health = Math.min(part.maxHealth, part.health + amount * (part.fractured ? 0.35 : 1));
    healed += part.health - before;
  }

  for (const id of mended) {
    ctx.events.emit({ type: 'heal', targetId: player.id, amount: 0, bodyPart: id });
    notify(ctx, player, 'success', 'notify.partMended', { part: BODY_PART_LABELS[id] });
  }
  if (healed > 0 || mended.length > 0) syncHealthFromBody(player);
}
