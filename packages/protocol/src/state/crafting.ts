import type { CraftJobId, EntityId, RecipeDefId } from './ids';
import type { ItemStack } from './item';

/** A crafting job in progress, either in a player's hands or at a station. */
export interface CraftJobState {
  jobId: CraftJobId;
  recipeId: RecipeDefId;
  /** How many more outputs this job will produce (including the one in progress). */
  remaining: number;
  /** Ticks left on the current output. */
  ticksLeft: number;
  /** Ticks one output takes, after skill and station modifiers. */
  ticksPerUnit: number;
  /** Player who queued it (XP and output ownership). */
  crafterId: EntityId;
  /** Station structure the job is bound to, if any. */
  stationId?: EntityId;
  /** Set when the job is blocked (missing fuel, station unlit, output full). */
  blockedReason?: string;
  /**
   * The exact stacks this job took out of the pack, worst-first.
   *
   * A refund has to give back what was taken. Rebuilding the inputs from their
   * definitions instead hands back full durability and full freshness, so queueing a job
   * and cancelling it repaired tools and un-rotted food - and the units consumed are the
   * *worst* the player held, which is what made it worth doing. Absent on jobs from a save
   * written before this was recorded; the refund falls back to minting in that case.
   */
  reserved?: ItemStack[];
}
