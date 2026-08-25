import {
  type EntityId,
  type ItemStack,
  type LootTableId,
  type PlayerId,
  type Rng,
} from '@survive/protocol';
import type { LootEntry } from '@survive/game-data';
import type { SimContext } from './context';
import { createStack } from './items';
import { markDirtyAt } from './queries';

/**
 * Loot rolling and ground items.
 *
 * Every drop in the game funnels through here: container loot, corpse loot, node
 * yields and player death piles. One implementation means `lootAbundance` tuning and
 * the seeded RNG apply everywhere consistently.
 */

/** Roll one loot entry into a stack, or null when the chance roll fails. */
export function rollEntry(
  ctx: SimContext,
  rng: Rng,
  entry: LootEntry,
  chanceScale = 1,
): ItemStack | null {
  if (!ctx.data.items.has(entry.defId)) {
    ctx.log.warn('loot entry references unknown item', { defId: entry.defId });
    return null;
  }
  const chance = Math.min(1, entry.chance * chanceScale);
  if (!rng.chance(chance)) return null;
  const count = rng.int(Math.max(0, entry.min), Math.max(entry.min, entry.max));
  if (count <= 0) return null;
  const stack = createStack(ctx.data, entry.defId, count);
  if (entry.condition && stack.durability !== undefined) {
    const def = ctx.data.items.require(entry.defId);
    const max = def.maxDurability ?? 0;
    const [low, high] = entry.condition;
    stack.durability = Math.max(1, Math.round(max * rng.float(low, high)));
  }
  return stack;
}

/**
 * Roll a whole loot table.
 *
 * `guaranteed` entries always roll; the weighted pool is sampled `rolls` times.
 * `lootAbundance` scales both the number of rolls and each entry's chance, so a
 * generous server is generous everywhere.
 */
export function rollLootTable(
  ctx: SimContext,
  tableId: LootTableId,
  rngLabel = 'loot',
): ItemStack[] {
  const table = ctx.data.lootTables.get(tableId);
  if (!table) {
    ctx.log.warn('unknown loot table', { tableId });
    return [];
  }
  const rng = ctx.rng.fork(`${rngLabel}:${tableId}`);
  const abundance = table.abundanceScaling === false ? 1 : ctx.config.world.lootAbundance;
  const out: ItemStack[] = [];

  for (const entry of table.guaranteed ?? []) {
    const stack = rollEntry(ctx, rng, entry, abundance);
    if (stack) out.push(stack);
  }

  const [minRolls, maxRolls] = table.rolls;
  const rolls = Math.round(rng.int(minRolls, maxRolls) * abundance);
  for (let i = 0; i < rolls; i++) {
    const entry = rng.pickWeighted(table.entries, (candidate) => candidate.weight ?? 1);
    if (!entry) break;
    const stack = rollEntry(ctx, rng, entry, abundance);
    if (stack) out.push(stack);
  }
  return out;
}

/**
 * Drop a stack on the ground as an item entity.
 *
 * Scatters within a small radius so a pile of loot does not stack into a single
 * unreadable sprite, and inherits the configured despawn time.
 */
export function dropStack(
  ctx: SimContext,
  x: number,
  y: number,
  stack: ItemStack,
  droppedBy?: PlayerId,
  scatter = 10,
): EntityId | null {
  if (stack.count <= 0) return null;
  const rng = ctx.rng;
  const angle = rng.angle();
  const distance = scatter > 0 ? rng.float(0, scatter) : 0;
  const dropX = x + Math.cos(angle) * distance;
  const dropY = y + Math.sin(angle) * distance;

  const despawnTicks = ctx.config.tuning.itemDespawnTicks;
  const id = ctx.ids.item();
  ctx.state.items[id] = {
    id,
    x: dropX,
    y: dropY,
    stack,
    droppedTick: ctx.state.tick,
    despawnTick: despawnTicks < 0 ? -1 : ctx.state.tick + despawnTicks,
    ...(droppedBy ? { droppedBy } : {}),
    rev: 1,
  };
  markDirtyAt(ctx.state, dropX, dropY);
  return id;
}

/** Drop several stacks at one spot. */
export function dropStacks(
  ctx: SimContext,
  x: number,
  y: number,
  stacks: readonly ItemStack[],
  droppedBy?: PlayerId,
): void {
  for (const stack of stacks) dropStack(ctx, x, y, stack, droppedBy);
}

/**
 * Roll a loot table straight onto the ground. Returns the stacks that were dropped,
 * for the caller's event payload.
 */
export function dropLootTable(
  ctx: SimContext,
  tableId: LootTableId,
  x: number,
  y: number,
): ItemStack[] {
  const stacks = rollLootTable(ctx, tableId);
  dropStacks(ctx, x, y, stacks);
  return stacks;
}
