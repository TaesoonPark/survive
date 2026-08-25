import type { PlayerState, StructureState } from '@survive/protocol';
import type { SimContext } from '../../core/context';
import { isResting } from './environment';
import { SINGLE_PLAYER_SLEEP_SCALE } from './tuning';

/**
 * Per-tick derived facts about one player.
 *
 * Computed once at the top of the player's turn and threaded through the needs,
 * injury and healing steps. Without it every step would re-derive "is this player
 * asleep, and how well" from the structure table, and the four answers could drift.
 */
export interface SurvivalTick {
  /** The fixed timestep in seconds. Every rate in `tuning` is per second. */
  readonly dt: number;
  readonly asleep: boolean;
  /** Resting is the precondition for regeneration. Sleeping always counts. */
  readonly resting: boolean;
  /**
   * Recovery multiplier from sleeping: 1 while awake, otherwise bed comfort times
   * the mode scaling. See {@link SINGLE_PLAYER_SLEEP_SCALE} for why single-player
   * gets more.
   */
  readonly sleepScale: number;
}

/**
 * Build the per-tick context.
 *
 * `bed` is the structure the player is asleep in, or undefined when awake. Comfort
 * comes from the bed definition, so a bedroll genuinely rests you less than a real
 * bed and the difference is a content decision rather than a code branch.
 */
export function createSurvivalTick(
  ctx: SimContext,
  player: PlayerState,
  bed: StructureState | undefined,
): SurvivalTick {
  const asleep = bed !== undefined;
  let sleepScale = 1;
  if (bed) {
    const def = ctx.data.structures.get(bed.defId);
    const comfort = def?.bed?.comfort ?? 0.5;
    // Comfort spans 0.45 (bedroll) to 0.85 (wood bed); map it onto 0.6..1.
    const quality = 0.6 + comfort * 0.47;
    sleepScale = quality * (ctx.config.mode.singlePlayer ? SINGLE_PLAYER_SLEEP_SCALE : 1);
  }
  return {
    dt: ctx.clock.dt,
    asleep,
    resting: isResting(ctx, player, asleep),
    sleepScale,
  };
}
