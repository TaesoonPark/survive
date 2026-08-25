import {
  Button,
  angleDelta,
  hasButton,
  type EntityId,
  type EquipSlot,
  type ItemStack,
  type PlayerState,
} from '@survive/protocol';
import type { GameData } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import { applyDamage, type DamageResult, type DamageSpec } from '../../core/damage';
import { killEntity } from '../../core/death';
import { conditionMultiplier } from '../../core/items';
import { skillLevel } from '../../core/skills';
import { bump } from '../../core/queries';
import { wearEquipped } from './weapons';

/**
 * Blocking, and the single door every incoming attack walks through.
 *
 * Zombies attack from the AI system, players attack from the combat system, traps and
 * explosions will attack from wherever they end up living. If each of those applied
 * damage itself, blocking would work against some of them and not others - so they all
 * call {@link resolveIncomingAttack} instead, which is the only place that knows about
 * guards, guard stamina and guard breaks.
 */

/** Total width of the guard, in degrees. A block covers the front, not the back. */
export const BLOCK_ARC_DEGREES = 150;

/** Stamina burned per point of damage a guard absorbs. */
export const BLOCK_STAMINA_PER_DAMAGE = 0.7;

/** Hard ceiling on block reduction, so no loadout makes a player immune. */
export const MAX_BLOCK_REDUCTION = 0.8;

/** Durability spent by the guarding item each time it eats a hit. */
export const BLOCK_DURABILITY_PER_HIT = 1;

/** The item currently doing the guarding, and how much it stops. */
export interface BlockingGear {
  slot: EquipSlot;
  stack: ItemStack;
  /** Fraction of incoming damage this guard can absorb, 0..1. */
  reduction: number;
}

/**
 * Which held item is capable of blocking, and how well.
 *
 * `blockReduction` is opt-in per weapon in the item table: a bat, machete, sword and
 * crowbar can be interposed, an axe or a rifle cannot. Off hand wins ties because a
 * shield-ish item there is what you would actually raise. Condition matters - a
 * battered sword is a worse guard - and skill adds a point per level for the muscle
 * memory of taking a hit on the flat of the blade.
 */
export function blockingGear(player: PlayerState, data: GameData): BlockingGear | null {
  let best: BlockingGear | null = null;
  for (const slot of ['offHand', 'mainHand'] as const) {
    const stack = player.equipment[slot];
    if (!stack) continue;
    const def = data.items.get(stack.defId);
    const base = def?.weapon?.blockReduction ?? 0;
    if (base <= 0) continue;
    const reduction = Math.min(
      MAX_BLOCK_REDUCTION,
      base * conditionMultiplier(stack, data) + skillLevel(player, 'melee') * 0.01,
    );
    if (reduction <= 0) continue;
    if (!best || reduction > best.reduction) best = { slot, stack, reduction };
  }
  return best;
}

/**
 * Fraction of incoming damage the player's gear could absorb if they are guarding.
 *
 * Pure gear maths: it says nothing about whether the block button is down. Combine it
 * with {@link isGuarding} to decide whether a guard is actually up.
 */
export function blockReductionFor(player: PlayerState, data: GameData): number {
  return blockingGear(player, data)?.reduction ?? 0;
}

/** Direction the player is currently guarding towards. */
function guardAngle(ctx: SimContext, player: PlayerState): number {
  // The current input frame is fresher than the replicated aim angle, which the input
  // system only writes once per tick and which lags by a tick for remote players.
  return ctx.inputs.get(player.id)?.aimAngle ?? player.aimAngle;
}

/**
 * True while the player is holding the block button with something worth blocking with.
 * A dead player never blocks; neither does one who is out of stamina.
 */
export function isGuarding(ctx: SimContext, player: PlayerState): boolean {
  if (!player.alive) return false;
  if (player.stamina <= 0) return false;
  const frame = ctx.inputs.get(player.id);
  if (!frame || !hasButton(frame.buttons, Button.Block)) return false;
  return blockReductionFor(player, ctx.data) > 0;
}

/**
 * Whether a blow arriving along `angle` (attacker -> defender) came from inside the
 * guard. Attacks with no direction at all - poison, starvation - are never blockable.
 */
export function blowIsGuarded(ctx: SimContext, player: PlayerState, spec: DamageSpec): boolean {
  if (spec.angle === undefined) return false;
  // `spec.angle` points away from the attacker, so the attacker lies the other way.
  const towardsAttacker = spec.angle + Math.PI;
  const half = ((BLOCK_ARC_DEGREES / 2) * Math.PI) / 180;
  return Math.abs(angleDelta(guardAngle(ctx, player), towardsAttacker)) <= half;
}

/**
 * Apply one attack to one target, honouring blocks, and handle the death that follows.
 *
 * This is the function every attacker should call - melee swings, projectile impacts
 * and zombie claws alike - so that "I had my guard up" means the same thing whoever
 * swung. Returns the {@link DamageResult} of the (possibly reduced) hit; the caller
 * does *not* need to call `killEntity` afterwards.
 */
export function resolveIncomingAttack(
  ctx: SimContext,
  defenderId: EntityId,
  spec: DamageSpec,
): DamageResult {
  const defender = ctx.state.players[defenderId];
  let effective = spec;

  if (
    defender &&
    spec.amount > 0 &&
    isGuarding(ctx, defender) &&
    blowIsGuarded(ctx, defender, spec)
  ) {
    const gear = blockingGear(defender, ctx.data);
    if (gear) {
      let absorbed = spec.amount * gear.reduction;
      // A guard is only as good as the legs behind it: if the hit costs more stamina
      // than is left, the guard partially collapses and the rest gets through.
      const wanted = absorbed * BLOCK_STAMINA_PER_DAMAGE;
      if (wanted > defender.stamina) {
        const affordable = wanted > 0 ? defender.stamina / wanted : 0;
        absorbed *= affordable;
      }
      defender.stamina = Math.max(0, defender.stamina - absorbed * BLOCK_STAMINA_PER_DAMAGE);

      effective = {
        ...spec,
        amount: Math.max(0, spec.amount - absorbed),
        // Bracing kills most of the shove even when it does not stop the blade.
        knockback: (spec.knockback ?? 0) * Math.max(0, 1 - gear.reduction),
      };

      bump(defender);
      ctx.events.emit({
        type: 'block',
        defenderId: defender.id,
        ...(spec.attackerId ? { attackerId: spec.attackerId } : {}),
        absorbed,
      });
      wearEquipped(ctx, defender, gear.slot, gear.stack, BLOCK_DURABILITY_PER_HIT);
    }
  }

  const result = applyDamage(ctx, defenderId, effective);
  if (result.killed) killEntity(ctx, defenderId, spec.cause ?? spec.type, spec.attackerId);
  return result;
}
