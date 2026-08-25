import type { StructureState } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { damageStructure, type DamageResult, type DamageSpec } from '../../core/damage';
import { destroyStructure } from '../building/building';

/**
 * Structure impacts.
 *
 * Both halves of combat can break a building - a sledgehammer on a door, a rifle round
 * through a window - so the "and now it falls down" half lives here rather than being
 * written twice. Removal is done by whoever lands the killing blow because it has to
 * happen in the same tick as the damage: leaving a zero-health wall standing until some
 * later system reaps it would let a player walk into collision that is no longer there.
 *
 * *How* it comes apart is the building system's business, not combat's, in the same way
 * that `nodes.ts` hands a felled tree to `world/gathering`. Combat once did its own
 * shorter teardown - emit, make noise, delete - which skipped spilling the container,
 * dropping rubble, releasing player references and re-asserting the tile index. A chest
 * broken open by a sledgehammer or a zombie therefore deleted its contents, while the
 * same chest left to rot spilled them.
 */

/** Damage a structure and destroy it when the blow finishes it off. */
export function hitStructure(
  ctx: SimContext,
  structure: StructureState,
  spec: DamageSpec,
): DamageResult {
  const result = damageStructure(ctx, structure, spec);
  if (!result.killed) return result;

  // Spills the container, drops rubble, releases every player reference and repairs the
  // tile index - then emits `structureDestroyed` and the collapse noise, which is one of
  // the loudest things in the game because breaching a base should not be a quiet way in.
  destroyStructure(ctx, structure, spec.attackerId);
  return result;
}
