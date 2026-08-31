import { describe, expect, it } from 'vitest';
import {
  Tile,
  pixelToTile,
  tileCenter,
  type ItemStack,
  type PlayerState,
  type ResourceNodeState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { createStack } from '../../core/items';
import {
  GATHER_BASE_DAMAGE,
  GATHER_COOLDOWN_TICKS,
  createGatheringSystem,
  canFillWith,
  harvestNode,
  harvestRange,
  selectGatherTool,
  toolEffectiveness,
} from './gathering';

/**
 * Gathering, driven through commands exactly as a client would.
 *
 * Numbers come from the real content tables, because the rules under test are mostly
 * *about* those numbers: `tree_pine` has 120 health and demands an axe,
 * `rock_boulder`'s `wrongToolMultiplier` of 0 is what makes it impossible bare-handed,
 * and `plant_fiber_patch` regrows in a day and a half. A test that invented its own
 * node would prove the arithmetic and miss the design.
 */

interface Fixture {
  sim: TestSimulation;
  player: PlayerState;
  tileX: number;
  tileY: number;
}

/** A player standing in the middle of a known tile, with only gathering running. */
function fixture(options: { seed?: number; xpRate?: number } = {}): Fixture {
  const sim = createTestSimulation({
    seed: options.seed,
    systems: [createGatheringSystem()],
    config: (config) => {
      if (options.xpRate !== undefined) config.tuning.xpRate = options.xpRate;
    },
  });
  const tileX = pixelToTile(sim.spawn.x);
  const tileY = pixelToTile(sim.spawn.y);
  const player = sim.addPlayer({ x: tileCenter(tileX), y: tileCenter(tileY) });
  return { sim, player, tileX, tileY };
}

/** Place a node one tile east of the player: well inside every node's reach. */
function nodeBeside(fix: Fixture, defId: string, offset = 1): ResourceNodeState {
  const node = fix.sim.placeNode(defId, fix.tileX + offset, fix.tileY);
  if (!node) throw new Error(`placeNode failed for ${defId}`);
  return node;
}

/** Place a node on a specific neighbouring tile. */
function nodeAt(fix: Fixture, defId: string, dx: number, dy: number): ResourceNodeState {
  const node = fix.sim.placeNode(defId, fix.tileX + dx, fix.tileY + dy);
  if (!node) throw new Error(`placeNode failed for ${defId}`);
  return node;
}

/** The eight tiles touching the player's, all comfortably within gathering reach. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** One harvest command, then enough idle ticks to clear the use cooldown. */
function swing(fix: Fixture, node: ResourceNodeState): void {
  fix.sim.run(fix.player, { type: 'gather', nodeId: node.id });
  fix.sim.step(GATHER_COOLDOWN_TICKS);
}

/** Keep swinging until the node depletes, with a bound so a bug cannot hang the run. */
function swingUntilDepleted(fix: Fixture, node: ResourceNodeState, limit = 60): number {
  for (let i = 1; i <= limit; i++) {
    swing(fix, node);
    if (node.depleted || !fix.sim.sim.state.nodes[node.id]) return i;
  }
  throw new Error(`node ${node.defId} still standing after ${limit} swings`);
}

/**
 * The live stack in the player's pack.
 *
 * `giveItem` hands back the stack it *built*, not the copy it filed away, so a test
 * that wants to watch a canteen fill has to look in the inventory.
 */
function stackIn(player: PlayerState, defId: string): ItemStack {
  for (const slot of player.inventory.slots) {
    if (slot?.defId === defId) return slot;
  }
  throw new Error(`no ${defId} in the player's inventory`);
}

function countIn(player: PlayerState, defId: string): number {
  let total = 0;
  for (const slot of player.inventory.slots) {
    if (slot?.defId === defId) total += slot.count;
  }
  return total;
}

describe('harvesting a node', () => {
  it('yields wood from a pine and eventually fells it', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    const node = nodeBeside(fix, 'tree_pine');

    // 120 health at 12 damage a swing would be ten blows with a perfect axe. A stone
    // hatchet loses a little `conditionMultiplier` with every hit, so the last blow or
    // two come up short and it takes eleven - the tool wearing out mid-tree is the
    // mechanic, not an off-by-one.
    const swings = swingUntilDepleted(fix, node);
    const ideal = Math.ceil(120 / GATHER_BASE_DAMAGE);
    expect(swings).toBe(ideal + 1);

    expect(node.depleted).toBe(true);
    expect(node.health).toBe(0);
    // `yields` guarantees 3-5 logs; the per-hit table only ever gives sticks.
    expect(countIn(fix.player, 'wood_log')).toBeGreaterThanOrEqual(3);
    expect(fix.sim.lastEvent('nodeDepleted')?.nodeId).toBe(node.id);
  });

  it('reports remaining health on every hit', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    const node = nodeBeside(fix, 'tree_pine');

    swing(fix, node);
    const first = fix.sim.lastEvent('nodeHarvested');
    expect(first?.nodeId).toBe(node.id);
    expect(first?.playerId).toBe(fix.player.id);
    expect(first?.remainingHealth).toBeCloseTo(120 - GATHER_BASE_DAMAGE, 5);
    expect(node.harvests).toBe(1);
  });

  it('counts the harvest against the player and bumps their revision', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');
    const revBefore = fix.player.rev;

    swingUntilDepleted(fix, node);
    expect(fix.player.stats.resourcesGathered).toBeGreaterThan(0);
    expect(fix.player.rev).toBeGreaterThan(revBefore);
  });

  it('bare hands cannot touch a boulder', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'rock_boulder');

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.lastEvent('toolIneffective')).toMatchObject({
      nodeId: node.id,
      playerId: fix.player.id,
      requiredTool: 'pickaxe',
    });
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('toolIneffective');
  });

  it('the wrong tool is as useless as no tool on an impossible node', () => {
    const fix = fixture();
    // An axe is a fine tool and completely the wrong one for granite.
    fix.sim.equip(fix.player, 'stone_hatchet');
    const node = nodeBeside(fix, 'rock_boulder');

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.eventsOf('toolIneffective')).toHaveLength(1);
  });

  it('a tool below the required tier cannot work an iron vein', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_pickaxe');
    const node = nodeBeside(fix, 'ore_iron');

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.eventsOf('toolIneffective')).toHaveLength(1);

    // The same vein, one tier up, gives way.
    fix.sim.equip(fix.player, 'iron_pickaxe');
    fix.sim.clearEvents();
    swing(fix, node);
    expect(node.health).toBeLessThan(node.maxHealth);
  });

  it('bare hands do work a node that expects them', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'plant_fiber_patch');

    swing(fix, node);
    expect(node.depleted).toBe(true);
    expect(countIn(fix.player, 'plant_fiber')).toBeGreaterThanOrEqual(3);
  });

  it('a better tool is faster', () => {
    const slow = fixture();
    slow.sim.equip(slow.player, 'stone_hatchet');
    const slowNode = nodeBeside(slow, 'tree_pine');
    swing(slow, slowNode);

    const fast = fixture();
    fast.sim.equip(fast.player, 'iron_axe');
    const fastNode = nodeBeside(fast, 'tree_pine');
    swing(fast, fastNode);

    expect(fastNode.health).toBeLessThan(slowNode.health);
    // The iron axe's 1.8 efficiency, straight through.
    expect(120 - fastNode.health).toBeCloseTo((120 - slowNode.health) * 1.8, 5);
  });

  it('a worn tool works worse than a fresh one', () => {
    const fix = fixture();
    const fresh = fix.sim.equip(fix.player, 'stone_hatchet');
    const node = nodeBeside(fix, 'tree_pine');
    swing(fix, node);
    const freshDamage = 120 - node.health;

    const worn = fixture();
    const wornAxe = worn.sim.equip(worn.player, 'stone_hatchet');
    wornAxe.durability = 6;
    const wornNode = nodeBeside(worn, 'tree_pine');
    swing(worn, wornNode);

    expect(fresh.durability).toBeLessThan(60);
    expect(120 - wornNode.health).toBeLessThan(freshDamage);
  });

  it('spends tool durability per swing', () => {
    const fix = fixture();
    const axe = fix.sim.equip(fix.player, 'stone_hatchet');
    const before = axe.durability ?? 0;
    const node = nodeBeside(fix, 'tree_pine');

    swing(fix, node);
    swing(fix, node);
    expect(axe.durability).toBeLessThan(before);
    // `durabilityPerUse` is 1, scaled by the 0.5 default quality.
    expect(before - (axe.durability ?? 0)).toBeCloseTo(2, 5);
  });

  it('drops a tool that wears out mid-job and says so', () => {
    const fix = fixture();
    const axe = fix.sim.equip(fix.player, 'stone_hatchet');
    axe.durability = 1;
    const node = nodeBeside(fix, 'tree_pine');

    swing(fix, node);
    // The last swing still lands: a tool breaking does not eat the blow.
    expect(node.health).toBeLessThan(node.maxHealth);
    expect(fix.player.equipment.mainHand).toBeNull();
    expect(fix.sim.lastEvent('weaponBroke')?.defId).toBe('stone_hatchet');
  });

  it('reaches for a stowed axe rather than refusing', () => {
    const fix = fixture();
    fix.sim.giveItem(fix.player, 'stone_hatchet');
    expect(fix.player.equipment.mainHand).toBeNull();
    const node = nodeBeside(fix, 'tree_pine');

    swing(fix, node);
    expect(node.health).toBeCloseTo(120 - GATHER_BASE_DAMAGE, 5);
    expect(fix.sim.eventsOf('toolIneffective')).toHaveLength(0);
  });

  it('grants per-hit XP and a lump on depletion', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');

    swingUntilDepleted(fix, node);
    const awarded = fix.sim.eventsOf('skillXp').filter((event) => event.skill === 'foraging');
    expect(awarded.length).toBeGreaterThanOrEqual(2);
    // `xpOnDeplete` (4) dwarfs `xpPerHit` (1), so the last award is the biggest.
    expect(Math.max(...awarded.map((event) => event.amount))).toBe(4);
  });

  it('scales XP by the xpRate tuning knob', () => {
    const plain = fixture();
    swingUntilDepleted(plain, nodeBeside(plain, 'bush_berry'));
    const plainXp = plain.sim.eventsOf('skillXp').reduce((total, event) => total + event.amount, 0);

    const generous = fixture({ xpRate: 3 });
    swingUntilDepleted(generous, nodeBeside(generous, 'bush_berry'));
    const generousXp = generous.sim
      .eventsOf('skillXp')
      .reduce((total, event) => total + event.amount, 0);

    expect(generousXp).toBeCloseTo(plainXp * 3, 5);
  });

  it('chopping is loud enough to pull zombies', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    const tree = nodeBeside(fix, 'tree_pine');
    swing(fix, tree);
    const chop = fix.sim.lastEvent('noise');
    expect(chop).toMatchObject({ radius: 240, x: tree.x, y: tree.y, sourceId: fix.player.id });

    // Foraging a bush is a fraction of the racket, which is the whole trade-off.
    const quiet = fixture();
    swing(quiet, nodeBeside(quiet, 'bush_berry'));
    expect(quiet.sim.lastEvent('noise')?.radius).toBe(60);
  });

  it('spills the yield on the ground when the pack is full', () => {
    const fix = fixture();
    for (let i = 0; i < fix.player.inventory.slots.length; i++) {
      // Hatchets carry durability, so every one of them occupies a whole slot.
      fix.player.inventory.slots[i] = createStack(fix.sim.data, 'stone_hatchet', 1);
    }
    const node = nodeBeside(fix, 'plant_fiber_patch');

    swingUntilDepleted(fix, node);
    const dropped = Object.values(fix.sim.sim.state.items).filter(
      (item) => item.stack.defId === 'plant_fiber',
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]?.droppedBy).toBe(fix.player.id);
  });
});

describe('depletion', () => {
  it('leaves a wall on the same tile still blocking sight', () => {
    // A node that blocks sight used to raise `StructureOpaque` - the *structure* bit -
    // because nodes had none of their own. Felling it therefore cleared the sight blocking
    // of a wall standing on the same tile: still solid, but see-through. A tile's bits have
    // to be owned by whatever contributes them.
    const fix = fixture();
    fix.sim.equip(fix.player, 'steel_axe');
    const node = nodeBeside(fix, 'tree_pine');

    // A wall on the tree's own tile. Both contribute sight blocking.
    const wall = fix.sim.placeStructure('wall_wood', node.tileX, node.tileY);
    expect(wall, 'could not place the wall').not.toBeNull();
    wall!.progress = 1;
    fix.sim.step(1);
    expect(fix.sim.world.isOpaqueTile(node.tileX, node.tileY)).toBe(true);

    swingUntilDepleted(fix, node);

    // The tree is gone; the wall is not.
    expect(fix.sim.sim.state.structures[wall!.id]).toBeDefined();
    expect(fix.sim.world.isOpaqueTile(node.tileX, node.tileY)).toBe(true);
    expect(fix.sim.world.isSolidTile(node.tileX, node.tileY)).toBe(true);
  });

  it('clears the collision a standing tree had', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'steel_axe');
    const node = nodeBeside(fix, 'tree_pine');
    expect(fix.sim.world.isSolidTile(node.tileX, node.tileY)).toBe(true);

    swingUntilDepleted(fix, node);
    expect(fix.sim.world.isSolidTile(node.tileX, node.tileY)).toBe(false);
  });

  it('schedules a respawn that later fires and restores the node', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'plant_fiber_patch');
    swingUntilDepleted(fix, node);

    // `respawnTicks` is days(1.5) for fiber grass.
    expect(node.respawnAtTick).toBeGreaterThan(fix.sim.sim.state.tick);
    fix.sim.clearEvents();

    fix.sim.advanceGameDays(1.6);
    expect(fix.sim.lastEvent('nodeRespawned')?.nodeId).toBe(node.id);
    expect(node.depleted).toBe(false);
    expect(node.health).toBe(node.maxHealth);
    expect(node.harvests).toBe(0);
    expect(node.respawnAtTick).toBe(-1);

    // And it can be worked again, which is the point of regrowth.
    swing(fix, node);
    expect(node.depleted).toBe(true);
  });

  it('restores the collision of a regrown tree', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'steel_axe');
    const node = nodeBeside(fix, 'tree_birch');
    swingUntilDepleted(fix, node);
    expect(fix.sim.world.isSolidTile(node.tileX, node.tileY)).toBe(false);

    // Birch regrows in five days.
    fix.sim.advanceGameDays(5.1);
    expect(node.depleted).toBe(false);
    expect(fix.sim.world.isSolidTile(node.tileX, node.tileY)).toBe(true);
  });

  it('removes a node that never comes back', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'iron_pickaxe');
    const node = nodeBeside(fix, 'rock_boulder');

    swingUntilDepleted(fix, node);
    // `respawnTicks` is -1: a quarried boulder is gone for good.
    expect(fix.sim.sim.state.nodes[node.id]).toBeUndefined();
    expect(fix.sim.world.isSolidTile(node.tileX, node.tileY)).toBe(false);
    expect(countIn(fix.player, 'stone')).toBeGreaterThanOrEqual(8);
  });

  it('marks the chunk dirty so regrowth survives a save', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');
    for (const runtime of Object.values(fix.sim.sim.state.chunks)) runtime.dirty = false;

    swingUntilDepleted(fix, node);
    const key = `${Math.floor(node.tileX / 32)},${Math.floor(node.tileY / 32)}`;
    expect(fix.sim.sim.state.chunks[key]?.dirty).toBe(true);
  });
});

describe('gather rejections', () => {
  it('refuses an unknown node', () => {
    const fix = fixture();
    fix.sim.run(fix.player, { type: 'gather', nodeId: 'n9999' });
    expect(fix.sim.lastEvent('commandRejected')).toMatchObject({
      command: 'gather',
      reason: 'unknownNode',
    });
  });

  it('refuses a node out of reach', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    // Five tiles away is 160 px; a pine reaches 77.
    const node = nodeBeside(fix, 'tree_pine', 5);
    expect(harvestRange(fix.sim.data.nodes.require('tree_pine'))).toBeLessThan(160);

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('outOfRange');
  });

  it('refuses a node behind a wall', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    fix.sim.wall(fix.tileX + 1, fix.tileY - 1, fix.tileX + 1, fix.tileY + 1);
    const node = nodeBeside(fix, 'tree_pine', 2);

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('noLineOfSight');
  });

  it('allows a node with clear ground between, wall or no wall', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    // The wall is beside the sightline, not across it.
    fix.sim.wall(fix.tileX + 1, fix.tileY + 2, fix.tileX + 1, fix.tileY + 3);
    const node = nodeBeside(fix, 'tree_pine', 2);

    swing(fix, node);
    expect(node.health).toBeLessThan(node.maxHealth);
  });

  /**
   * Standing on the corner of a tree used to refuse every swing.
   *
   * A node registers its own tile as opaque, so the sight test stops the ray short of it.
   * The back-off used to be half a tile's *side*, which only clears the tile head-on: from
   * a corner the tile edge is half a *diagonal* away, so the ray ended inside the tree and
   * the tree blocked the sight of itself. Distance was never the problem - the assertion
   * below pins that down, so a future failure here cannot be misread as a reach change.
   *
   * Oak at 16, pine at 14 and birch at 12 all sat inside the gap, against a half-diagonal
   * of 22.63. The boulder at 22 and the car wreck at 26 cleared their own corner already;
   * they are here as guards, not as regressions.
   */
  for (const [defId, tool] of [
    ['tree_pine', 'stone_hatchet'],
    ['tree_oak', 'stone_hatchet'],
    ['tree_birch', 'stone_hatchet'],
    ['rock_boulder', 'iron_pickaxe'],
  ] as const) {
    it(`harvests ${defId} while standing diagonally against it`, () => {
      const fix = fixture();
      fix.sim.equip(fix.player, tool);
      const node = fix.sim.placeNode(defId, fix.tileX + 1, fix.tileY + 1);
      if (!node) throw new Error(`placeNode failed for ${defId}`);

      // The premise: the corner is comfortably inside reach, so anything that refuses
      // this swing is refusing it on sight, not on distance.
      const def = fix.sim.data.nodes.require(defId);
      const gap = Math.hypot(node.x - fix.player.x, node.y - fix.player.y);
      expect(gap).toBeLessThan(harvestRange(def));

      swing(fix, node);
      expect(fix.sim.lastEvent('commandRejected')).toBeUndefined();
      expect(node.health).toBeLessThan(node.maxHealth);
    });
  }

  it('still refuses a node off the diagonal with a wall between', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    // Two tiles east and one south - 71.6 px, inside a pine's 77 - screened by a wall in
    // the column between. Backing the ray off further must not cost it the ability to see
    // a wall that is genuinely in the way, and this angle is not axis-aligned, which is
    // where the old back-off was measured.
    fix.sim.wall(fix.tileX + 1, fix.tileY, fix.tileX + 1, fix.tileY + 1);
    const node = fix.sim.placeNode('tree_pine', fix.tileX + 2, fix.tileY + 1);
    if (!node) throw new Error('placeNode failed');

    const def = fix.sim.data.nodes.require('tree_pine');
    expect(Math.hypot(node.x - fix.player.x, node.y - fix.player.y)).toBeLessThan(
      harvestRange(def),
    );

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('noLineOfSight');
  });

  it('refuses a second swing inside the cooldown', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'tree_oak');
    fix.sim.equip(fix.player, 'stone_hatchet');

    fix.sim.run(fix.player, { type: 'gather', nodeId: node.id });
    const afterFirst = node.health;
    fix.sim.run(fix.player, { type: 'gather', nodeId: node.id });

    expect(node.health).toBe(afterFirst);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('cooldown');

    // ...and allows it once the cooldown has run out.
    fix.sim.step(GATHER_COOLDOWN_TICKS);
    fix.sim.run(fix.player, { type: 'gather', nodeId: node.id });
    expect(node.health).toBeLessThan(afterFirst);
  });

  it('refuses a dead player', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');
    fix.player.alive = false;

    swing(fix, node);
    expect(node.health).toBe(node.maxHealth);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('dead');
  });

  it('refuses an already depleted node', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');
    swingUntilDepleted(fix, node);
    fix.sim.clearEvents();

    swing(fix, node);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('depleted');
    expect(fix.sim.eventsOf('nodeHarvested')).toHaveLength(0);
  });
});

describe('the shared harvest entry point', () => {
  it('is what a melee swing routes into, with identical results', () => {
    const command = fixture();
    command.sim.equip(command.player, 'stone_hatchet');
    const commandNode = nodeBeside(command, 'tree_pine');
    command.sim.run(command.player, { type: 'gather', nodeId: commandNode.id });

    // Same fixture, same seed, but entered the way combat enters it.
    const melee = fixture();
    const axe = melee.sim.equip(melee.player, 'stone_hatchet');
    const meleeNode = nodeBeside(melee, 'tree_pine');
    expect(harvestNode(melee.sim.ctx, melee.player, meleeNode, axe).ok).toBe(true);

    expect(meleeNode.health).toBe(commandNode.health);
    expect(meleeNode.harvests).toBe(commandNode.harvests);
    expect(axe.durability).toBe(command.player.equipment.mainHand?.durability);
  });

  it('reports failure rather than throwing on an impossible node', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'rock_boulder');
    const result = harvestNode(fix.sim.ctx, fix.player, node, null);
    expect(result).toEqual({ ok: false, reason: 'toolIneffective' });
  });

  it('refuses to work for a dead player even when called directly', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');
    fix.player.alive = false;
    expect(harvestNode(fix.sim.ctx, fix.player, node, null).reason).toBe('dead');
  });
});

describe('tool selection and effectiveness', () => {
  it('treats a node with no tool requirement as hands-friendly', () => {
    const fix = fixture();
    const def = fix.sim.data.nodes.require('bush_berry');
    expect(toolEffectiveness(def, null)).toEqual({ multiplier: 1, efficiency: 1 });
  });

  it('keeps a held tool s efficiency on a node that names no tools', () => {
    const fix = fixture();
    const def = fix.sim.data.nodes.require('bush_berry');
    const axe = fix.sim.data.items.require('iron_axe');
    expect(toolEffectiveness(def, axe).efficiency).toBe(1.8);
  });

  it('falls back to the wrong-tool multiplier, not to zero', () => {
    const fix = fixture();
    const def = fix.sim.data.nodes.require('tree_dead');
    const axe = fix.sim.data.items.require('stone_hatchet');
    expect(toolEffectiveness(def, null).multiplier).toBe(def.wrongToolMultiplier);
    expect(toolEffectiveness(def, axe).multiplier).toBe(1);
  });

  it('prefers the best stowed tool of the right role', () => {
    const fix = fixture();
    fix.sim.giveItem(fix.player, 'stone_pickaxe');
    fix.sim.giveItem(fix.player, 'steel_pickaxe');
    const def = fix.sim.data.nodes.require('ore_iron');

    const chosen = selectGatherTool(fix.player, def, fix.sim.ctx);
    expect(chosen?.defId).toBe('steel_pickaxe');
  });

  it('prefers the item in hand when it already fits', () => {
    const fix = fixture();
    fix.sim.equip(fix.player, 'stone_hatchet');
    fix.sim.giveItem(fix.player, 'steel_axe');
    const def = fix.sim.data.nodes.require('tree_pine');
    expect(selectGatherTool(fix.player, def, fix.sim.ctx)?.defId).toBe('stone_hatchet');
  });
});

describe('water', () => {
  function waterFixture(): Fixture {
    const fix = fixture();
    fix.sim.world.setTile(fix.tileX + 1, fix.tileY, Tile.WaterShallow);
    return fix;
  }

  it('fills a canteen from a shallow-water tile', () => {
    const fix = waterFixture();
    fix.sim.giveItem(fix.player, 'canteen');
    const canteen = stackIn(fix.player, 'canteen');
    expect(canteen.fill).toBe(0);

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(canteen.fill).toBe(6);
    expect(canteen.contentDefId).toBe('water_dirty');
    expect(fix.sim.lastEvent('notification')).toMatchObject({ severity: 'success' });
  });

  it('will not fill through a wall', () => {
    // Reach is distance *and* a clear line, as it is for containers, doors and beds. The
    // tile path allows a little over two tiles, which clears a one-tile wall, so distance
    // alone let a player draw from the pond on the far side of their own base wall.
    const fix = fixture();
    fix.sim.world.setTile(fix.tileX + 2, fix.tileY, Tile.WaterShallow);
    fix.sim.wall(fix.tileX + 1, fix.tileY - 2, fix.tileX + 1, fix.tileY + 2);
    fix.sim.giveItem(fix.player, 'canteen');
    const canteen = stackIn(fix.player, 'canteen');
    expect(canteen.fill).toBe(0);

    fix.sim.clearEvents();
    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 2, tileY: fix.tileY });

    expect(canteen.fill).toBe(0);
    expect(
      fix.sim
        .eventsOf('commandRejected')
        .map((event) => event.reason)
        .join(' '),
    ).toMatch(/noLineOfSight/);

    // ...and it works once the wall is gone, so this is the line and not the distance.
    for (let ty = fix.tileY - 2; ty <= fix.tileY + 2; ty++) {
      fix.sim.world.setTile(fix.tileX + 1, ty, Tile.Grass);
    }
    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 2, tileY: fix.tileY });
    expect(canteen.fill).toBeGreaterThan(0);
  });

  it('fills from a water-source node too', () => {
    const fix = fixture();
    fix.sim.giveItem(fix.player, 'canteen');
    const canteen = stackIn(fix.player, 'canteen');
    const node = nodeBeside(fix, 'water_source');

    fix.sim.run(fix.player, { type: 'interact', targetId: node.id });
    expect(canteen.fill).toBe(6);
    expect(canteen.contentDefId).toBe('water_dirty');
  });

  it('makes a noise at the water s edge, quietly', () => {
    const fix = waterFixture();
    fix.sim.giveItem(fix.player, 'canteen');
    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });

    const scoop = fix.sim.lastEvent('noise');
    expect(scoop?.radius).toBe(70);
    expect(scoop?.loudness).toBeLessThan(1);
  });

  it('refuses when there is nothing to carry water in', () => {
    const fix = waterFixture();
    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });

    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('noContainer');
    expect(fix.sim.lastEvent('notification')).toMatchObject({ severity: 'warn' });
  });

  it('will not pollute a vessel that already holds clean water', () => {
    const fix = waterFixture();
    // A fresh bottle ships full of boiled water.
    fix.sim.giveItem(fix.player, 'water_bottle');
    const bottle = stackIn(fix.player, 'water_bottle');
    expect(bottle.contentDefId).toBe('water_clean');

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(bottle.contentDefId).toBe('water_clean');
    expect(bottle.fill).toBe(4);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('noContainer');
  });

  it('tops up a part-empty vessel of the same dirty water', () => {
    const fix = waterFixture();
    fix.sim.giveItem(fix.player, 'water_bottle');
    const bottle = stackIn(fix.player, 'water_bottle');
    bottle.fill = 1;
    bottle.contentDefId = 'water_dirty';
    expect(canFillWith(bottle, fix.sim.ctx, 'water_dirty')).toBe(true);

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(bottle.fill).toBe(4);
  });

  it('ignores deep water: you cannot stand in it to scoop', () => {
    const fix = fixture();
    fix.sim.world.setTile(fix.tileX + 1, fix.tileY, Tile.WaterDeep);
    fix.sim.giveItem(fix.player, 'canteen');

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(fix.sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(fix.sim.eventsOf('notification')).toHaveLength(0);
  });

  it('refuses water out of arm s reach', () => {
    const fix = fixture();
    fix.sim.world.setTile(fix.tileX + 4, fix.tileY, Tile.WaterShallow);
    fix.sim.giveItem(fix.player, 'canteen');

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 4, tileY: fix.tileY });
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('outOfRange');
  });

  it('shares one cooldown between the tile and the node path', () => {
    const fix = waterFixture();
    fix.sim.giveItem(fix.player, 'canteen');
    const canteen = stackIn(fix.player, 'canteen');
    const node = nodeBeside(fix, 'water_source', 2);

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    canteen.fill = 0;
    // Alternating targets must not dodge the cooldown.
    fix.sim.run(fix.player, { type: 'interact', targetId: node.id });
    expect(canteen.fill).toBe(0);
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('cooldown');
  });

  it('does not spend the cooldown on a fill that failed', () => {
    const fix = waterFixture();
    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(fix.player.useReadyTick).toBeLessThanOrEqual(fix.sim.sim.state.tick);
  });

  it('refuses a dead player', () => {
    const fix = waterFixture();
    fix.sim.giveItem(fix.player, 'canteen');
    fix.player.alive = false;

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('dead');
  });

  it('treats a fishing spot as a tool-gated node, not a tap', () => {
    const fix = fixture();
    fix.sim.giveItem(fix.player, 'canteen');
    const node = nodeBeside(fix, 'fishing_spot');

    fix.sim.run(fix.player, { type: 'interact', targetId: node.id });
    // No rod: the harvest path refuses it instead of handing over a drink.
    expect(fix.sim.lastEvent('commandRejected')?.reason).toBe('toolIneffective');
    expect(stackIn(fix.player, 'canteen').fill).toBe(0);
  });
});

describe('coexisting with the other interact handlers', () => {
  it('says nothing about a target that is not a node', () => {
    const fix = fixture();
    const structure = fix.sim.placeStructure('storage_box', fix.tileX + 1, fix.tileY);
    expect(structure).not.toBeNull();

    fix.sim.run(fix.player, { type: 'interact', targetId: structure?.id ?? 's0' });
    expect(fix.sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(fix.sim.eventsOf('notification')).toHaveLength(0);
  });

  it('leaves a tile with a structure on it to the structure s owner', () => {
    const fix = fixture();
    fix.sim.world.setTile(fix.tileX + 1, fix.tileY, Tile.WaterShallow);
    fix.sim.placeStructure('storage_box', fix.tileX + 1, fix.tileY);
    fix.sim.giveItem(fix.player, 'canteen');
    const canteen = stackIn(fix.player, 'canteen');

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(canteen.fill).toBe(0);
    expect(fix.sim.eventsOf('commandRejected')).toHaveLength(0);
  });

  it('says nothing about plain dry ground', () => {
    const fix = fixture();
    fix.sim.giveItem(fix.player, 'canteen');

    fix.sim.run(fix.player, { type: 'interact', tileX: fix.tileX + 1, tileY: fix.tileY });
    expect(fix.sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(fix.sim.eventsOf('notification')).toHaveLength(0);
  });

  it('harvests a node reached through interact, exactly as gather would', () => {
    const fix = fixture();
    const node = nodeBeside(fix, 'bush_berry');

    fix.sim.run(fix.player, { type: 'interact', targetId: node.id });
    expect(node.health).toBeCloseTo(20 - GATHER_BASE_DAMAGE, 5);
    expect(fix.sim.lastEvent('nodeHarvested')?.nodeId).toBe(node.id);
  });

  it('ignores an interact with neither a target nor a tile', () => {
    const fix = fixture();
    fix.sim.giveItem(fix.player, 'canteen');
    fix.sim.run(fix.player, { type: 'interact' });
    expect(fix.sim.eventsOf('commandRejected')).toHaveLength(0);
  });
});

describe('determinism', () => {
  it('produces an identical event stream from the same seed', () => {
    const runOnce = (): string => {
      const fix = fixture({ seed: 5150 });
      fix.sim.equip(fix.player, 'stone_hatchet');
      const node = nodeBeside(fix, 'tree_pine');
      swingUntilDepleted(fix, node);
      return JSON.stringify(fix.sim.events);
    };
    expect(runOnce()).toBe(runOnce());
  });

  it('produces identical yields from the same seed', () => {
    const runOnce = (): Record<string, number> => {
      const fix = fixture({ seed: 77 });
      const node = nodeBeside(fix, 'plant_fiber_patch');
      swingUntilDepleted(fix, node);
      const counts: Record<string, number> = {};
      for (const slot of fix.player.inventory.slots) {
        if (slot) counts[slot.defId] = (counts[slot.defId] ?? 0) + slot.count;
      }
      return counts;
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it('diverges between seeds, so the rolls are real', () => {
    const yieldsFor = (seed: number): string => {
      const fix = fixture({ seed });
      // Eight patches, one per surrounding tile so every one stays inside reach: a
      // single low-chance roll would too often agree between seeds by luck.
      const nodes = NEIGHBOURS.map(([dx, dy]) => nodeAt(fix, 'herb_patch', dx, dy));
      for (const node of nodes) swingUntilDepleted(fix, node);
      return JSON.stringify(fix.player.inventory.slots);
    };
    expect(yieldsFor(1)).not.toBe(yieldsFor(999999));
  });
});
