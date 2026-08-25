import type { EquipSlot, ItemStack, PlayerState, ResourceNodeState } from '@survive/protocol';
import type { ItemDef, WeaponProps } from '@survive/game-data';
import type { SimContext } from '../../core/context';
import { harvestNode } from '../world/gathering';

/**
 * Hitting a resource node with whatever is in your hand.
 *
 * A tree is felled by the same swing that kills a walker - that is the whole reason
 * melee has to consider nodes at all - so the *impact* belongs to combat. The *yield*
 * does not: gathering owns `harvestNode`, which is the only place in the game a node is
 * ever damaged or pays out, and it is deliberately shared so that "click the tree" and
 * "hold attack and walk into the tree" cannot drift apart. Combat therefore resolves
 * reach, arc, cooldown and stamina and then hands the swing over.
 *
 * The hand-over is a replaceable {@link NodeHitResolver} rather than a hard call so
 * that a combat-only test simulation can substitute its own payout (and observe
 * exactly what the swing asked for) without standing up the gathering system.
 */

/** One resolved melee swing, handed to whatever the swing landed on. */
export interface MeleeSwing {
  weapon: WeaponProps;
  /** Backing item stack of the weapon, or null when unarmed. */
  stack: ItemStack | null;
  def: ItemDef | null;
  slot: EquipSlot | null;
  /** Damage against a living target, after skill, condition and arm health. */
  damage: number;
  /** Direction of the blow in radians, attacker -> target. */
  angle: number;
}

/**
 * Handles a melee hit that landed on a resource node. Returns true when the swing
 * actually did something, which is what the combat system reports as `hit`.
 */
export type NodeHitResolver = (
  ctx: SimContext,
  player: PlayerState,
  node: ResourceNodeState,
  swing: MeleeSwing,
) => boolean;

/**
 * The default resolver: gathering's one true harvest.
 *
 * The swung item *is* the tool - a swing works with what is in the hand, not with the
 * axe stowed in the pack, which is the one place this path deliberately differs from
 * the `gather` command's more forgiving tool search. Everything else (tool fit,
 * durability, yields, XP, noise, depletion, regrowth) is gathering's business, and
 * `harvestNode` reports `ok: false` with a `toolIneffective` event when bare hands
 * meet a pine.
 */
export function applyNodeHit(
  ctx: SimContext,
  player: PlayerState,
  node: ResourceNodeState,
  swing: MeleeSwing,
): boolean {
  return harvestNode(ctx, player, node, swing.stack).ok;
}
