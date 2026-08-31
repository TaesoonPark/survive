import {
  EQUIP_SLOTS,
  TILE_SIZE,
  armCapabilityMultiplier,
  distance,
  tileCenter,
  tileProps,
  type ItemStack,
  type PlayerState,
  type ResourceNodeState,
} from '@survive/protocol';
import type { ItemDef, LootEntry, ResourceNodeDef } from '@survive/game-data';
import { SystemOrder, type System } from '../../core/context';
import type { SimContext } from '../../core/context';
import { damageNode } from '../../core/damage';
import {
  conditionMultiplier,
  findTool,
  heldItem,
  recomputeCarryWeight,
  spendDurability,
  addToInventory,
} from '../../core/items';
import { dropStack, rollEntry } from '../../core/loot';
import { emitNoise } from '../../core/noise';
import { PLAYER_RADIUS } from '../../core/movement';
import { bump, markDirtyAt, structureAtTile } from '../../core/queries';
import { grantXp, skillMultiplier } from '../../core/skills';
import { attachNode, detachNode, removeNode } from '../../core/structures';

/**
 * Gathering: hitting the world until it gives you something.
 *
 * The interesting design constraint here is that a node can be worked two ways - the
 * `gather` command (click the tree) and a melee swing that happens to land on it
 * (hold attack and walk into the tree) - and the two must be indistinguishable in
 * their outcome. So {@link harvestNode} is the only place a node is ever damaged or
 * yields anything, and the combat system calls it for a swing exactly as the command
 * handler does for a click. Anything that lived in the command handler instead would
 * quietly drift out of sync with combat.
 *
 * Deliberate omission: `tuning.playerDamageDealt` is *not* folded into gathering
 * damage. It is a combat knob, and a server that doubles melee damage for PvP has no
 * business also doubling the rate at which forests fall over - `resourceDensity` is
 * the knob for that.
 */

/** Damage one bare-handed, unskilled, undamaged-arms hit does to a node. */
export const GATHER_BASE_DAMAGE = 12;

/** Extra reach beyond the player's and the node's radii, in pixels. */
export const GATHER_REACH = 52;

/** Reach for `interact` on a tile (water), in pixels from the tile centre. */
export const INTERACT_REACH = 64;

/**
 * Half the diagonal of a tile: the furthest a tile's own edge can be from its centre.
 *
 * Sight tests back off by this much so the ray stops outside the target's tile no matter
 * which way it approaches. Half the tile's *side* only clears the tile head-on.
 */
const HALF_TILE_DIAGONAL = (TILE_SIZE / 2) * Math.SQRT2;

/** Ticks between two harvest actions from the same player. */
export const GATHER_COOLDOWN_TICKS = 8;

/** What a scooped container ends up holding. Boiling it is the player's problem. */
export const DIRTY_WATER_DEF_ID = 'water_dirty';

/** Outcome of a harvest attempt. `reason` is a stable machine-readable code. */
export interface HarvestResult {
  ok: boolean;
  reason?: string;
}

const OK: HarvestResult = { ok: true };

function fail(reason: string): HarvestResult {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Tool effectiveness
// ---------------------------------------------------------------------------

/**
 * How much of a hit's damage actually lands, given the tool in hand.
 *
 * Three cases, and the content tables lean on all three (see the commentary on
 * `RESOURCE_NODE_DEFS`):
 *
 * - The node names no tools at all: hands are the intended way in, full damage.
 * - The tool fills one of the named roles *and* meets `minToolTier`: full damage.
 * - Anything else - no tool, wrong tool, or a tool below the required tier - is
 *   `wrongToolMultiplier`, and a `wrongToolMultiplier` of 0 means it cannot be done
 *   at all. That single number is what makes a boulder impossible bare-handed and a
 *   dead tree merely tedious.
 */
export function toolEffectiveness(
  def: ResourceNodeDef,
  toolDef: ItemDef | null,
): { multiplier: number; efficiency: number } {
  const tool = toolDef?.tool ?? null;
  const efficiency = tool?.efficiency ?? 1;
  if (def.toolKinds.length === 0) return { multiplier: 1, efficiency };
  if (!tool) return { multiplier: def.wrongToolMultiplier, efficiency: 1 };

  const rightKind = def.toolKinds.some((kind) => tool.kinds.includes(kind));
  if (!rightKind) return { multiplier: def.wrongToolMultiplier, efficiency };
  if (tool.tier < def.minToolTier) return { multiplier: def.wrongToolMultiplier, efficiency };
  return { multiplier: 1, efficiency };
}

/**
 * Pick the tool a player would sensibly use on a node.
 *
 * The held item wins when it fits, otherwise a stowed tool of the right role is
 * reached for (best tier first, via {@link findTool}) - a player with an axe in the
 * backpack should not have to open the inventory to chop. Falling back to the held
 * item keeps its `efficiency` in play for nodes that name no tools at all.
 */
export function selectGatherTool(
  player: PlayerState,
  def: ResourceNodeDef,
  ctx: SimContext,
): ItemStack | null {
  const held = heldItem(player);
  if (def.toolKinds.length === 0) return held;

  if (held) {
    const heldDef = ctx.data.items.get(held.defId);
    const kinds = heldDef?.tool?.kinds ?? [];
    if (def.toolKinds.some((kind) => kinds.includes(kind))) return held;
  }

  let best: { stack: ItemStack; tier: number } | null = null;
  for (const kind of def.toolKinds) {
    const found = findTool(player, kind, ctx.data);
    if (!found) continue;
    const tier = ctx.data.items.get(found.stack.defId)?.tool?.tier ?? 0;
    if (!best || tier > best.tier) best = { stack: found.stack, tier };
  }
  return best ? best.stack : held;
}

/** Drop a tool that just wore out, wherever the player was keeping it. */
function discardBrokenTool(ctx: SimContext, player: PlayerState, stack: ItemStack): void {
  for (const slot of EQUIP_SLOTS) {
    if (player.equipment[slot] === stack) {
      player.equipment[slot] = null;
      recomputeCarryWeight(player, ctx.data);
      ctx.events.emit({ type: 'weaponBroke', ownerId: player.id, defId: stack.defId });
      return;
    }
  }
  const index = player.inventory.slots.indexOf(stack);
  if (index >= 0) {
    player.inventory.slots[index] = null;
    recomputeCarryWeight(player, ctx.data);
    ctx.events.emit({ type: 'weaponBroke', ownerId: player.id, defId: stack.defId });
  }
}

/**
 * Put a rolled stack in the player's pack, spilling the remainder at their feet.
 *
 * Gathering must never silently destroy a yield: a full inventory means the wood is on
 * the ground, not gone.
 */
function collect(
  ctx: SimContext,
  player: PlayerState,
  stacks: readonly ItemStack[],
  x: number,
  y: number,
): number {
  let units = 0;
  for (const stack of stacks) {
    units += stack.count;
    const leftover = addToInventory(player.inventory, stack, ctx.data);
    if (leftover > 0) dropStack(ctx, x, y, { ...stack }, player.id);
  }
  if (units > 0) {
    recomputeCarryWeight(player, ctx.data);
    player.stats.resourcesGathered += units;
    bump(player);
  }
  return units;
}

/** Roll a node's drop list, honouring each entry's own chance. */
function rollYields(ctx: SimContext, entries: readonly LootEntry[], label: string): ItemStack[] {
  if (entries.length === 0) return [];
  const rng = ctx.rng.fork(label);
  const out: ItemStack[] = [];
  for (const entry of entries) {
    const stack = rollEntry(ctx, rng, entry);
    if (stack) out.push(stack);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The one true harvest
// ---------------------------------------------------------------------------

/**
 * Land one harvesting blow on a node.
 *
 * The single entry point for node harvesting, shared by the `gather` command and by a
 * melee swing that connects with a node. Range, line of sight and cooldowns belong to
 * the caller: a swing has already resolved its own reach, and re-checking it here
 * would make the two paths disagree at the margin.
 *
 * `toolStack` is whatever the player is working with, or null for bare hands. It is
 * mutated: durability is spent on it, and it is removed from the player if it breaks.
 */
export function harvestNode(
  ctx: SimContext,
  player: PlayerState,
  node: ResourceNodeState,
  toolStack: ItemStack | null,
): HarvestResult {
  if (!player.alive) return fail('dead');
  if (node.depleted) return fail('depleted');
  const def = ctx.data.nodes.get(node.defId);
  if (!def) {
    ctx.log.warn('harvestNode: unknown node definition', { defId: node.defId });
    return fail('unknownNode');
  }

  const toolDef = toolStack ? (ctx.data.items.get(toolStack.defId) ?? null) : null;
  const { multiplier, efficiency } = toolEffectiveness(def, toolDef);
  if (multiplier <= 0) {
    ctx.events.emit({
      type: 'toolIneffective',
      playerId: player.id,
      nodeId: node.id,
      requiredTool: def.toolKinds[0] ?? '',
    });
    return fail('toolIneffective');
  }

  const condition = toolStack ? conditionMultiplier(toolStack, ctx.data) : 1;
  const damage =
    GATHER_BASE_DAMAGE *
    multiplier *
    efficiency *
    condition *
    skillMultiplier(player, def.skill) *
    armCapabilityMultiplier(player.body);

  // Spend the tool before resolving the hit: a tool that breaks on its last swing
  // still delivers that swing, which is how every other durability path behaves.
  if (toolStack && toolDef?.tool) {
    if (spendDurability(toolStack, toolDef.tool.durabilityPerUse)) {
      discardBrokenTool(ctx, player, toolStack);
    } else {
      bump(player);
    }
  }

  // `damageNode` ignores the damage type - a node has no armour and no body parts -
  // but the pipeline still wants one, and a swing is what this is.
  const result = damageNode(ctx, node, { amount: damage, type: 'slash', attackerId: player.id });
  node.harvests++;
  bump(node);

  const perHit = rollYields(
    ctx,
    def.yieldPerHit,
    `gather:hit:${node.id}:${ctx.state.tick}:${node.harvests}`,
  );
  const harvested = perHit.map((stack) => ({ ...stack }));
  collect(ctx, player, perHit, node.x, node.y);
  grantXp(ctx, player, def.skill, def.xpPerHit);

  ctx.events.emit({
    type: 'nodeHarvested',
    nodeId: node.id,
    playerId: player.id,
    yields: harvested,
    remainingHealth: node.health,
  });
  // Chopping is loud on purpose: felling a tree in the open is how a quiet afternoon
  // becomes a fight, and that trade is the point of the mechanic.
  emitNoise(ctx, node.x, node.y, def.noise, 1, player.id);

  if (result.killed) depleteNode(ctx, player, node, def);
  return OK;
}

/**
 * Finish a node off: main yield, XP, collision, and either regrowth or removal.
 *
 * Exported because a node can also be destroyed by something other than a harvest
 * (an explosion, a falling structure) and that path wants the same drops.
 */
export function depleteNode(
  ctx: SimContext,
  player: PlayerState | null,
  node: ResourceNodeState,
  def: ResourceNodeDef,
): void {
  node.depleted = true;
  node.health = 0;

  const yields = rollYields(ctx, def.yields, `gather:deplete:${node.id}:${ctx.state.tick}`);
  if (player) {
    collect(ctx, player, yields, node.x, node.y);
    grantXp(ctx, player, def.skill, def.xpOnDeplete);
  } else {
    for (const stack of yields) dropStack(ctx, node.x, node.y, stack);
  }

  ctx.events.emit({
    type: 'nodeDepleted',
    nodeId: node.id,
    defId: node.defId,
    x: node.x,
    y: node.y,
  });
  // A felled tree stops blocking the path and the sightline immediately; leaving the
  // collision behind is the classic "invisible wall in the forest" bug.
  detachNode(ctx, node);

  if (def.respawnTicks < 0) {
    removeNode(ctx, node);
    return;
  }
  node.respawnAtTick = ctx.state.tick + def.respawnTicks;
  bump(node);
  markDirtyAt(ctx.state, node.x, node.y);
}

/** Regrow a node whose timer has come round. */
function respawnNode(ctx: SimContext, node: ResourceNodeState): void {
  const def = ctx.data.nodes.get(node.defId);
  if (!def) return;
  node.depleted = false;
  node.health = def.maxHealth;
  node.maxHealth = def.maxHealth;
  node.harvests = 0;
  node.respawnAtTick = -1;
  attachNode(ctx, node);
  bump(node);
  markDirtyAt(ctx.state, node.x, node.y);
  ctx.events.emit({ type: 'nodeRespawned', nodeId: node.id });
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/** Whether a stack is a vessel that could take a scoop of pond water right now. */
export function canFillWith(stack: ItemStack, ctx: SimContext, contentDefId: string): boolean {
  const liquid = ctx.data.items.get(stack.defId)?.liquid;
  if (!liquid?.fillable) return false;
  const fill = stack.fill ?? 0;
  if (fill >= liquid.capacity) return false;
  // Only an empty vessel, or one already holding the same thing. Topping up a canteen
  // of boiled water from a swamp would turn a careful player's supply into a gamble
  // they never agreed to.
  if (fill > 0 && stack.contentDefId !== contentDefId) return false;
  return true;
}

/** The vessel a player would fill: the one in hand first, then the pack, in order. */
export function findFillableContainer(
  player: PlayerState,
  ctx: SimContext,
  contentDefId: string,
): ItemStack | null {
  for (const slot of ['mainHand', 'offHand'] as const) {
    const stack = player.equipment[slot];
    if (stack && canFillWith(stack, ctx, contentDefId)) return stack;
  }
  for (const stack of player.inventory.slots) {
    if (stack && canFillWith(stack, ctx, contentDefId)) return stack;
  }
  return null;
}

/**
 * Fill a carried vessel from a water source at (x, y).
 *
 * Water is the one resource that is effectively infinite and the one the player needs
 * every day, so it is deliberately cheap to take and expensive to trust: what comes
 * out of a pond is always dirty, and cleaning it costs fuel.
 */
export function fillFromWater(
  ctx: SimContext,
  player: PlayerState,
  x: number,
  y: number,
): HarvestResult {
  if (!player.alive) return fail('dead');
  if (!ctx.data.items.has(DIRTY_WATER_DEF_ID)) return fail('noWaterItem');

  const container = findFillableContainer(player, ctx, DIRTY_WATER_DEF_ID);
  if (!container) {
    ctx.events.emit({
      type: 'notification',
      playerId: player.id,
      severity: 'warn',
      message: { code: 'notify.noVessel' },
    });
    return fail('noContainer');
  }

  const liquid = ctx.data.items.require(container.defId).liquid;
  if (!liquid) return fail('noContainer');
  container.fill = liquid.capacity;
  container.contentDefId = DIRTY_WATER_DEF_ID;
  bump(player);

  ctx.events.emit({
    type: 'notification',
    playerId: player.id,
    severity: 'success',
    message: { code: 'notify.filledDirtyWater' },
  });
  // Scooping is quiet, but it is not silent, and it happens at the water's edge where
  // there is nothing to hide behind.
  emitNoise(ctx, x, y, 70, 0.4, player.id);
  return OK;
}

// ---------------------------------------------------------------------------
// Validation shared by the command handlers
// ---------------------------------------------------------------------------

/** Furthest a player may stand from a node and still work it. */
export function harvestRange(def: ResourceNodeDef): number {
  return def.radius + PLAYER_RADIUS + GATHER_REACH;
}

/**
 * Sight test that stops just short of the node.
 *
 * A tree registers its own opaque *tile*, so a ray aimed at the trunk always reports
 * "blocked" - by the tree. Stopping the ray short asks the question that was actually
 * meant: is there a wall between us?
 *
 * The back-off is at least half the tile's *diagonal*, not just the node's own radius,
 * because it is the tile that carries the collision bit and the ray can arrive at any
 * angle. Backing off by the radius alone leaves the endpoint inside the node's tile for
 * anything slimmer than a boulder. Backing off by half the tile's side is enough only
 * head-on: from a corner the tile edge is 16 * sqrt(2) away, so a ray stopped 17 short
 * still ends inside the tile and the node blocks the sight of itself. That is why
 * standing diagonally against a tree used to refuse every swing while standing squarely
 * beside the same tree worked. Oak, pine and birch all sat inside the gap; a boulder, at
 * radius 22, cleared its own corner by a hair and hid how general the fault was.
 */
export function hasHarvestSight(
  ctx: SimContext,
  player: PlayerState,
  node: ResourceNodeState,
  def: ResourceNodeDef,
): boolean {
  const dx = node.x - player.x;
  const dy = node.y - player.y;
  const d = Math.hypot(dx, dy);
  const stop = d - (Math.max(def.radius, HALF_TILE_DIAGONAL) + 1);
  if (d <= 0 || stop <= 0) return true;
  return ctx.world.hasLineOfSight(
    player.x,
    player.y,
    player.x + (dx / d) * stop,
    player.y + (dy / d) * stop,
  );
}

function reject(ctx: SimContext, player: PlayerState, command: string, reason: string): void {
  ctx.events.emit({ type: 'commandRejected', playerId: player.id, command, reason });
}

/**
 * Validate and run a player-driven harvest.
 *
 * Shared by `gather` and by `interact` on a non-water node, because clicking a berry
 * bush and pressing the interact key on it are the same act as far as the rules are
 * concerned.
 */
function tryPlayerHarvest(
  ctx: SimContext,
  player: PlayerState,
  node: ResourceNodeState,
  command: string,
): void {
  if (!player.alive) {
    reject(ctx, player, command, 'dead');
    return;
  }
  const def = ctx.data.nodes.get(node.defId);
  if (!def) {
    reject(ctx, player, command, 'unknownNode');
    return;
  }
  if (node.depleted) {
    reject(ctx, player, command, 'depleted');
    return;
  }
  if (ctx.state.tick < player.useReadyTick) {
    reject(ctx, player, command, 'cooldown');
    return;
  }
  if (distance(player.x, player.y, node.x, node.y) > harvestRange(def)) {
    reject(ctx, player, command, 'outOfRange');
    return;
  }
  if (!hasHarvestSight(ctx, player, node, def)) {
    reject(ctx, player, command, 'noLineOfSight');
    return;
  }

  player.useReadyTick = ctx.state.tick + GATHER_COOLDOWN_TICKS;
  bump(player);

  const tool = selectGatherTool(player, def, ctx);
  const result = harvestNode(ctx, player, node, tool);
  if (!result.ok && result.reason) reject(ctx, player, command, result.reason);
}

/**
 * Validate and run a player-driven water fill.
 *
 * Shared by the water-*node* path and the bare-water-*tile* path so that scooping from
 * a marked spring and scooping from the shallows of a lake are subject to the same
 * cooldown. Without the shared cooldown a client could alternate between the two
 * targets and fill twice as fast, which is exactly the kind of asymmetry an
 * authoritative server exists to close.
 */
/**
 * Whether the player can see the water they are reaching for.
 *
 * Stops short of the target the way {@link hasHarvestSight} does: water is not opaque, but
 * a tile is a tile, and aiming the ray at its centre risks counting whatever sits on the
 * far edge.
 */
function hasWaterSight(ctx: SimContext, player: PlayerState, x: number, y: number): boolean {
  const dx = x - player.x;
  const dy = y - player.y;
  const d = Math.hypot(dx, dy);
  const stop = d - (TILE_SIZE / 2 + 1);
  if (d <= 0 || stop <= 0) return true;
  return ctx.world.hasLineOfSight(
    player.x,
    player.y,
    player.x + (dx / d) * stop,
    player.y + (dy / d) * stop,
  );
}

function tryWaterFill(
  ctx: SimContext,
  player: PlayerState,
  x: number,
  y: number,
  range: number,
): void {
  if (!player.alive) {
    reject(ctx, player, 'interact', 'dead');
    return;
  }
  if (ctx.state.tick < player.useReadyTick) {
    reject(ctx, player, 'interact', 'cooldown');
    return;
  }
  if (distance(player.x, player.y, x, y) > range) {
    reject(ctx, player, 'interact', 'outOfRange');
    return;
  }
  // Reach is distance *and* a clear line. The tile path allows two and a bit tiles, which
  // comfortably clears a wall, so distance alone let a player fill a canteen from the pond
  // on the other side of their own base wall. The line stops one tile short of the water so
  // the surface itself is not what blocks it.
  if (!hasWaterSight(ctx, player, x, y)) {
    reject(ctx, player, 'interact', 'noLineOfSight');
    return;
  }

  const result = fillFromWater(ctx, player, x, y);
  if (!result.ok) {
    // A failed fill costs nothing: leaving the cooldown alone means "I had no bottle"
    // does not also lock the key for half a second.
    if (result.reason) reject(ctx, player, 'interact', result.reason);
    return;
  }
  player.useReadyTick = ctx.state.tick + GATHER_COOLDOWN_TICKS;
  bump(player);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

/**
 * The gathering system.
 *
 * Owns the `gather` command outright, and shares `interact` with the building and
 * inventory systems. Sharing works by target kind: this handler acts only on resource
 * nodes and on bare water tiles, and returns without a word for anything else, so a
 * click on a door is handled once, by the system that owns doors.
 */
export function createGatheringSystem(): System {
  return {
    id: 'gathering',
    order: SystemOrder.Structure + 1,

    init(_ctx, router) {
      router.on('gather', (ctx, player, command) => {
        const node = ctx.state.nodes[command.nodeId];
        if (!node) {
          reject(ctx, player, 'gather', 'unknownNode');
          return;
        }
        tryPlayerHarvest(ctx, player, node, 'gather');
      });

      router.on('interact', (ctx, player, command) => {
        if (command.targetId !== undefined) {
          const node = ctx.state.nodes[command.targetId];
          // Not a node: structures and ground items belong to other systems, and
          // saying so out loud here would double up their rejections.
          if (!node) return;

          const def = ctx.data.nodes.get(node.defId);
          // A plain water source is a tap, not a resource to be worked: filling is the
          // only thing to do with it, and it never runs down. A fishing spot is also
          // `category: 'water'` but has `toolKinds`, so it goes down the harvest path
          // and asks for a rod like any other tool-gated node.
          if (def && def.category === 'water' && def.toolKinds.length === 0) {
            tryWaterFill(ctx, player, node.x, node.y, harvestRange(def) + INTERACT_REACH);
            return;
          }
          tryPlayerHarvest(ctx, player, node, 'interact');
          return;
        }

        if (command.tileX === undefined || command.tileY === undefined) return;
        // A tile with a structure on it is that structure's business.
        if (structureAtTile(ctx.state, command.tileX, command.tileY)) return;

        const props = tileProps(ctx.world.getTile(command.tileX, command.tileY));
        // Deep water is for swimming, not scooping: you cannot stand in it to fill
        // anything. Dry ground is nobody's business here - staying quiet is what lets
        // the building and inventory systems answer the same command.
        if (!props.water || props.deep) return;
        tryWaterFill(
          ctx,
          player,
          tileCenter(command.tileX),
          tileCenter(command.tileY),
          PLAYER_RADIUS + INTERACT_REACH,
        );
      });
    },

    update(ctx) {
      // Filter first, sort second. A loaded world holds thousands of nodes and almost
      // none of them are mid-regrowth on any given tick, so sorting every key every
      // tick - and materialising the key array to do it - is work proportional to the
      // forest to service a list that is nearly always empty. The sort still happens,
      // just over the handful that are actually due, which is all determinism needs:
      // two nodes coming back on the same tick must do so in the same order every
      // replay, or their `rev` sequences diverge.
      const due: string[] = [];
      for (const id in ctx.state.nodes) {
        const node = ctx.state.nodes[id];
        if (!node || !node.depleted) continue;
        if (node.respawnAtTick < 0 || ctx.state.tick < node.respawnAtTick) continue;
        due.push(id);
      }
      if (due.length === 0) return;
      for (const id of due.sort()) {
        const node = ctx.state.nodes[id];
        if (node) respawnNode(ctx, node);
      }
    },
  };
}
