import {
  SIM_HZ,
  armCapabilityMultiplier,
  type EquipSlot,
  type ItemDefId,
  type ItemStack,
  type PlayerState,
} from '@survive/protocol';
import type { GameData, ItemDef, WeaponProps } from '@survive/game-data';
import { conditionMultiplier, recomputeCarryWeight, spendDurability } from '../../core/items';
import { skillCostMultiplier, skillLevel, skillMultiplier } from '../../core/skills';
import { bump } from '../../core/queries';
import type { SimContext } from '../../core/context';

/**
 * Weapon lookup and the modifiers that turn a definition into one concrete swing.
 *
 * Everything here is a pure function of `PlayerState` plus {@link GameData}, which is
 * what lets the client show an accurate damage/cadence tooltip without asking the
 * server, and lets the combat system stay readable.
 */

/**
 * Bare hands.
 *
 * Deliberately *not* an item (see the note in `game-data/defs/items.ts`): a phantom
 * `fists` entry would have to exist in every inventory and could be dropped. Numbers
 * are chosen so punching a walker to death is possible and miserable - ~90 hp of
 * walker at 4 damage a hit, two hits a second, and the walker hits back for nine.
 */
export const UNARMED: WeaponProps = {
  kind: 'melee',
  damage: 4,
  damageType: 'blunt',
  range: 26,
  arcDegrees: 60,
  attackTicks: Math.round(SIM_HZ * 0.5),
  windupTicks: Math.round(SIM_HZ * 0.15),
  staminaCost: 2.5,
  knockback: 25,
  critChance: 0.03,
  critMultiplier: 1.5,
  armorPen: 0,
  skill: 'melee',
  durabilityPerHit: 0,
  loudness: 70,
  twoHanded: false,
  maxTargets: 1,
};

/** The weapon a player is actually fighting with this tick. */
export interface ResolvedWeapon {
  weapon: WeaponProps;
  /** Backing item stack, or null when unarmed. Durability is spent on this. */
  stack: ItemStack | null;
  def: ItemDef | null;
  defId?: ItemDefId;
  /** Slot the stack lives in, so a broken weapon can be cleared. */
  slot: EquipSlot | null;
}

const UNARMED_RESOLVED: ResolvedWeapon = {
  weapon: UNARMED,
  stack: null,
  def: null,
  slot: null,
};

/**
 * What the player swings.
 *
 * Only the main hand counts: the off hand is for shields and torches. Anything held
 * that has no `weapon` block (a rag, a log) falls back to fists rather than dealing
 * zero damage, because "I am holding a plank so I cannot punch" is not a rule anybody
 * would guess.
 */
export function resolveWeapon(player: PlayerState, data: GameData): ResolvedWeapon {
  const stack = player.equipment.mainHand;
  if (!stack) return UNARMED_RESOLVED;
  const def = data.items.get(stack.defId);
  if (!def?.weapon) return UNARMED_RESOLVED;
  return { weapon: def.weapon, stack, def, defId: def.id, slot: 'mainHand' };
}

/** Ticks below which a firearm's cycle rate is treated as hold-to-fire. */
export const AUTO_FIRE_MAX_TICKS = Math.round(SIM_HZ * 0.4);

/**
 * Whether holding the attack button keeps firing.
 *
 * Melee and thrown weapons always need a fresh press - a held button must not turn
 * into a metronome of free swings. A firearm that cycles faster than
 * {@link AUTO_FIRE_MAX_TICKS} is treated as automatic-ish, which in the shipped table
 * means the 9 mm pistol and nothing else: bows, the crossbow, the shotgun and the
 * rifle all deliberately want a deliberate trigger pull.
 */
export function isAutoFire(weapon: WeaponProps): boolean {
  return weapon.kind === 'ranged' && weapon.attackTicks <= AUTO_FIRE_MAX_TICKS;
}

/** Damage multiplier from skill. Level 10 melee is +60%. */
export function weaponSkillMultiplier(player: PlayerState, weapon: WeaponProps): number {
  return skillMultiplier(player, weapon.skill, 0.06);
}

/** Wear-and-quality multiplier of the backing item. Fists never degrade. */
export function weaponConditionMultiplier(stack: ItemStack | null, data: GameData): number {
  return stack ? conditionMultiplier(stack, data) : 1;
}

/**
 * Base damage of one hit, before the damage pipeline's body-part, armour and crit
 * maths. Arm injuries only bite in melee: a shattered forearm ruins a swing but a
 * bullet does not care who pulled the trigger (that shows up as spread instead).
 */
export function swingDamage(
  player: PlayerState,
  weapon: WeaponProps,
  stack: ItemStack | null,
  data: GameData,
): number {
  let amount =
    weapon.damage * weaponSkillMultiplier(player, weapon) * weaponConditionMultiplier(stack, data);
  if (weapon.kind === 'melee') amount *= armCapabilityMultiplier(player.body);
  return amount;
}

/** Crit chance, nudged up by skill and capped so it never becomes the default. */
export function effectiveCritChance(player: PlayerState, weapon: WeaponProps): number {
  if (weapon.critChance <= 0) return 0;
  return Math.min(0.75, weapon.critChance + skillLevel(player, weapon.skill) * 0.01);
}

/** Stamina one attack costs. Practice makes the motion cheaper, never free. */
export function staminaCostFor(player: PlayerState, weapon: WeaponProps): number {
  return weapon.staminaCost * skillCostMultiplier(player, weapon.skill, 0.04, 0.6);
}

/**
 * Ticks until the next attack is allowed.
 *
 * `windupTicks` is folded into the cadence rather than delaying the hit: `PlayerState`
 * has nowhere to park a swing in flight, and adding a field would change a replicated
 * shape that this system does not own. The client animates the windup inside the
 * cooldown window it gets from `attackSwing`.
 */
export function attackCooldownTicks(player: PlayerState, weapon: WeaponProps): number {
  const cadence = skillCostMultiplier(player, weapon.skill, 0.02, 0.8);
  return Math.max(1, Math.round(weapon.attackTicks * cadence));
}

/** Half-width of the melee sweep, in radians. */
export function arcHalfAngle(weapon: WeaponProps): number {
  // A zero-degree arc would make a weapon unusable; treat it as a thrust.
  const degrees = weapon.arcDegrees > 0 ? weapon.arcDegrees : 20;
  return ((degrees / 2) * Math.PI) / 180;
}

/**
 * Spend durability on an equipped item, clearing and announcing it when it breaks.
 * Returns true when the item broke.
 */
export function wearEquipped(
  ctx: SimContext,
  player: PlayerState,
  slot: EquipSlot | null,
  stack: ItemStack | null,
  amount: number,
): boolean {
  if (!stack || !slot || amount <= 0) return false;
  if (!spendDurability(stack, amount)) {
    bump(player);
    return false;
  }
  player.equipment[slot] = null;
  recomputeCarryWeight(player, ctx.data);
  bump(player);
  ctx.events.emit({ type: 'weaponBroke', ownerId: player.id, defId: stack.defId });
  return true;
}

/** Total ammunition of one definition the player is carrying. */
export function countAmmo(player: PlayerState, defId: ItemDefId): number {
  let total = 0;
  for (const slot of player.inventory.slots) {
    if (slot?.defId === defId) total += slot.count;
  }
  return total;
}
