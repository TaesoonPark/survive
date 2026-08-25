import { describe, expect, it } from 'vitest';
import { Button, TILE_SIZE, pixelToTile, tileCenter } from '@survive/protocol';
import { MAX_QUEUED_JOBS, damagePlayer, matureStage } from '@survive/simulation';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import type { PlayerState } from '@survive/protocol';

/**
 * Adversarial tests, one system at a time.
 *
 * `exploits.test.ts` covers the seams *between* systems. This file is the other half of
 * that pass: each system's own rule, attacked from inside a full simulation with every
 * other system running. The cases here are the ones code review cannot settle - a guard
 * is easy to read and confirm, but whether it still holds on the ninetieth repetition,
 * after the player has walked away, or once another system has moved the world underneath
 * it, is a question only a running server answers.
 *
 * Where a test could pass for the wrong reason it says so. A refusal that happens because
 * the player had no tool is not evidence that the range check works.
 */

/** Needs run 0 (satisfied) to 100 (critical); see `PlayerState.hunger`. */
const MAX_NEED = 100;

function sim(): TestSimulation {
  return createTestSimulation({ seed: 424242, flattenRadius: 40 });
}

/** One press-and-release of the attack button, then idle out the cooldown. */
function swing(harness: TestSimulation, player: PlayerState, aimAngle = 0): void {
  player.stamina = player.maxStamina;
  harness.input(player, { buttons: Button.Primary, aimAngle });
  harness.step(1);
  harness.input(player, { buttons: 0, aimAngle });
  harness.step(1);
  let guard = 0;
  while (harness.sim.state.tick < player.attackReadyTick && guard++ < 200) {
    harness.input(player, { buttons: 0, aimAngle });
    harness.step(1);
  }
}

function count(player: PlayerState, defId: string): number {
  let total = 0;
  for (const slot of player.inventory.slots) if (slot?.defId === defId) total += slot.count;
  return total;
}

function rejections(harness: TestSimulation): string[] {
  return harness.eventsOf('commandRejected').map((event) => event.reason);
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

describe('combat', () => {
  it('cannot reach a zombie through a wall, however many times it swings', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.equip(player, 'stone_hatchet');

    // A wall one tile east, and the zombie one tile past it: inside hatchet range, but
    // with masonry in between.
    const tx = pixelToTile(player.x);
    const ty = pixelToTile(player.y);
    harness.wall(tx + 1, ty - 1, tx + 1, ty + 1);
    const zombie = harness.spawnZombie('walker', tileCenter(tx + 2), tileCenter(ty));
    zombie.health = zombie.maxHealth;

    // Sanity: the target really is inside the weapon's reach, so a miss here is the
    // line-of-sight test talking and not the range test.
    expect(Math.hypot(zombie.x - player.x, zombie.y - player.y)).toBeLessThan(TILE_SIZE * 2.5);

    const before = zombie.health;
    for (let i = 0; i < 8; i++) swing(harness, player, 0);
    expect(zombie.health).toBe(before);
  });

  it('lets the same swing hit the zombie once the wall is gone', () => {
    // The companion to the test above: without this one, a swing that never connects for
    // some unrelated reason would make the wall test pass on false pretences.
    const harness = sim();
    const player = harness.addPlayer();
    harness.equip(player, 'stone_hatchet');
    const zombie = harness.spawnZombie(
      'walker',
      tileCenter(pixelToTile(player.x) + 1),
      tileCenter(pixelToTile(player.y)),
    );
    const before = zombie.health;
    swing(harness, player, 0);
    expect(zombie.health).toBeLessThan(before);
  });

  it('drops a weapon that wears out instead of swinging it forever', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const weapon = harness.equip(player, 'stone_hatchet');
    // One hit from failure. The next connection has to be its last.
    weapon.durability = 1;

    const tree = harness.placeNode('tree_pine', pixelToTile(player.x) + 1, pixelToTile(player.y));
    expect(tree).not.toBeNull();
    for (let i = 0; i < 4; i++) swing(harness, player, 0);

    expect(player.equipment.mainHand?.defId).not.toBe('stone_hatchet');
    expect(harness.lastEvent('weaponBroke')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

describe('zombie ai', () => {
  it('never ends a chase standing inside a solid tile', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const tx = pixelToTile(player.x);
    const ty = pixelToTile(player.y);

    // Pen the player in, then put a zombie outside it and let it try for a while. The
    // collision layer, not the AI's good intentions, is what has to stop it.
    harness.wall(tx - 2, ty - 2, tx + 2, ty - 2);
    harness.wall(tx - 2, ty + 2, tx + 2, ty + 2);
    harness.wall(tx - 2, ty - 2, tx - 2, ty + 2);
    harness.wall(tx + 2, ty - 2, tx + 2, ty + 2);

    const zombie = harness.spawnZombie('walker', tileCenter(tx + 6), tileCenter(ty));
    for (let i = 0; i < 300; i++) {
      harness.step(1);
      expect(harness.world.isSolidAt(zombie.x, zombie.y)).toBe(false);
    }
  });

  it('stops attacking a player who has died, and eventually forgets them', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const zombie = harness.spawnZombie('walker', player.x + TILE_SIZE * 3, player.y);
    // Handed the chase rather than made to notice one: which way an idle walker happens
    // to be looking is the senses' business and has its own tests. What is on trial here
    // is what a zombie already locked on does when its target stops breathing.
    zombie.targetId = player.id;
    zombie.ai = 'pursue';
    zombie.loseInterestTick = harness.sim.state.tick + 40;
    harness.step(10);
    expect(zombie.targetId).toBe(player.id);

    // Killed through the damage pipeline, not by writing `health = 0`. The kill path is
    // what clears `alive`, stamps `deathTick` and emits `death`; a player with no health
    // but `alive` still true is a state the game never produces, and testing against it
    // would be testing a fiction. Repeated blows rather than one huge one, because damage
    // lands on a body part and health is derived from the body: a single oversized hit is
    // absorbed by the limb it struck instead of killing outright.
    for (let i = 0; i < 40 && player.alive; i++) {
      damagePlayer(harness.ctx, player, { amount: 40, type: 'blunt', armorPen: 1 });
      harness.step(1);
    }
    expect(player.alive).toBe(false);
    harness.step(4);
    harness.clearEvents();

    // Patience is content, not a constant: read it rather than guessing how long a
    // walker holds a grudge.
    const def = harness.sim.data.zombies.require('walker');
    harness.step(def.loseInterestTicks + 40);

    // Absence of damage is weak evidence on its own - a zombie that never got close
    // would satisfy it too. The state is the positive half: it has to stop pursuing and
    // let go of the target, not merely fail to land a hit.
    expect(harness.eventsOf('damage').filter((e) => e.targetId === player.id)).toHaveLength(0);
    expect(zombie.ai).not.toBe('attack');
    expect(zombie.ai).not.toBe('pursue');
    expect(zombie.targetId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Survival
// ---------------------------------------------------------------------------

describe('survival', () => {
  it('holds every need inside its bounds even when they are already at the limit', () => {
    // Pinned at the top rather than waited into it: the accumulation rates have their own
    // tests, and the question here is whether the clamp holds once a need is *at* 100 and
    // the systems that read it start doing damage.
    const harness = sim();
    const player = harness.addPlayer();
    player.hunger = MAX_NEED;
    player.thirst = MAX_NEED;
    player.fatigue = MAX_NEED;

    for (let i = 0; i < 400; i++) {
      harness.step(1);
      expect(player.hunger).toBeLessThanOrEqual(MAX_NEED);
      expect(player.thirst).toBeLessThanOrEqual(MAX_NEED);
      expect(player.fatigue).toBeLessThanOrEqual(MAX_NEED);
      expect(player.health).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(player.health)).toBe(true);
      if (!player.alive) break;
    }
    // At 100 across the board a player is supposed to be dying, not surviving forever.
    expect(player.health).toBeLessThan(player.maxHealth);
  });

  it('keeps every need inside its bounds across an unattended run', () => {
    const harness = sim();
    const player = harness.addPlayer();
    for (let hour = 0; hour < 6; hour++) {
      harness.advanceGameHours(1);
      if (!player.alive) break;
      expect(player.hunger).toBeGreaterThanOrEqual(0);
      expect(player.thirst).toBeGreaterThanOrEqual(0);
      expect(player.fatigue).toBeGreaterThanOrEqual(0);
      expect(player.hunger).toBeLessThanOrEqual(MAX_NEED);
      expect(player.thirst).toBeLessThanOrEqual(MAX_NEED);
      expect(player.fatigue).toBeLessThanOrEqual(MAX_NEED);
      expect(player.health).toBeLessThanOrEqual(player.maxHealth);
      expect(Number.isFinite(player.health)).toBe(true);
    }
  });

  it('cannot eat one ration more times than it holds', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.giveItem(player, 'berry', 3);
    player.hunger = MAX_NEED * 0.9;

    const slot = player.inventory.slots.findIndex((s) => s?.defId === 'berry');
    expect(slot).toBeGreaterThanOrEqual(0);

    // Twenty attempts on a stack of three. Whatever the cooldown does, the world must not
    // end up with more nutrition than the berries carried.
    for (let i = 0; i < 20; i++) {
      harness.run(player, { type: 'useItem', ref: { kind: 'inventory' }, index: slot });
      harness.step(12);
    }
    expect(count(player, 'berry')).toBe(0);
    expect(harness.eventsOf('ateFood').filter((e) => e.itemDefId === 'berry')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

describe('inventory', () => {
  it('stops serving an open container once the player walks away from it', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const chest = harness.placeStructure(
      'storage_box',
      pixelToTile(player.x) + 1,
      pixelToTile(player.y),
    );
    expect(chest).not.toBeNull();
    harness.giveItem(player, 'wood_plank', 5);

    harness.run(player, { type: 'openContainer', structureId: chest!.id });
    expect(player.openContainerId).toBe(chest!.id);

    // Teleport out of reach the way a speed-hacking client would, then try to keep using
    // the window it left open.
    player.x += TILE_SIZE * 30;
    harness.step(2);

    const slot = player.inventory.slots.findIndex((s) => s?.defId === 'wood_plank');
    harness.clearEvents();
    harness.run(player, {
      type: 'moveItem',
      from: { kind: 'inventory' },
      fromIndex: slot,
      to: { kind: 'structure', structureId: chest!.id },
      toIndex: 0,
      count: null,
    });
    expect(count(player, 'wood_plank')).toBe(5);
    expect(chest!.container?.slots.some((s) => s?.defId === 'wood_plank')).toBe(false);
    expect(rejections(harness).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------

describe('crafting', () => {
  it('refuses a station recipe when the station is out of reach', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const recipe = [...harness.sim.data.recipes.all()].find((r) => r.station === 'workbench');
    if (!recipe) return; // no station recipes in this data set

    const bench = harness.placeStructure(
      'workbench',
      pixelToTile(player.x) + 20,
      pixelToTile(player.y),
    );
    expect(bench).not.toBeNull();
    bench!.progress = 1;
    for (const input of recipe.inputs) harness.giveItem(player, input.defId, input.count * 2);

    harness.clearEvents();
    harness.run(player, { type: 'craft', recipeId: recipe.id, count: 1, stationId: bench!.id });
    expect(bench!.station?.jobs ?? []).toHaveLength(0);
    expect(player.craftQueue).toHaveLength(0);
    // Crafting reports through `craftFailed`, which carries the recipe id, and not through
    // the generic `commandRejected` - the panel needs to know *which* recipe was refused.
    expect(harness.eventsOf('craftFailed')).not.toHaveLength(0);
  });

  it('caps the hand queue instead of accepting jobs without limit', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const recipe = [...harness.sim.data.recipes.all()].find((r) => !r.station);
    expect(recipe).toBeDefined();
    for (const input of recipe!.inputs) harness.giveItem(player, input.defId, input.count * 40);

    for (let i = 0; i < MAX_QUEUED_JOBS + 6; i++) {
      harness.command(player, { type: 'craft', recipeId: recipe!.id, count: 1 });
    }
    harness.step(1);
    expect(player.craftQueue.length).toBeLessThanOrEqual(MAX_QUEUED_JOBS);
  });
});

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

describe('building', () => {
  it('does not heal a wall the player cannot pay for', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.equip(player, 'hammer');
    const wall = harness.placeStructure(
      'wall_wood',
      pixelToTile(player.x) + 1,
      pixelToTile(player.y),
    );
    expect(wall).not.toBeNull();
    wall!.progress = 1;
    wall!.health = Math.floor(wall!.maxHealth * 0.4);
    const damaged = wall!.health;

    // The premise, asserted rather than assumed: if the starting kit happened to carry
    // this wall's materials the repair would succeed and the test would "pass" by never
    // reaching the check it exists for.
    const def = harness.sim.data.structures.require('wall_wood');
    for (const entry of def.cost) expect(count(player, entry.defId)).toBe(0);

    // Hammer in hand, empty pockets: the tool check must not be the only gate.
    for (let i = 0; i < 10; i++) {
      harness.run(player, { type: 'repair', structureId: wall!.id });
      harness.step(20);
    }
    expect(wall!.health).toBe(damaged);
  });
});

// ---------------------------------------------------------------------------
// Farming
// ---------------------------------------------------------------------------

describe('farming', () => {
  it('gives nothing for re-harvesting a ratoon crop before it has regrown', () => {
    const harness = sim();
    const player = harness.addPlayer();
    const season = harness.sim.state.time.season;
    const crop = harness.sim.data.crops.all().find((c) => c.regrows && c.seasons.includes(season));
    if (!crop) return; // nothing that regrows is in season in this data set

    // A new world opens on a cold spring morning, and frost kills on contact. Wait for
    // the day to warm past this crop's frost point before planting, or the test dies of
    // the weather rather than measuring anything about harvesting.
    //
    // One tick first: `weather` on an unstepped state holds placeholders, and the
    // placeholder temperature is mild enough to walk straight past this guard.
    harness.step(1);
    for (
      let hour = 0;
      hour < 24 && harness.sim.state.weather.temperature <= crop.frostTemperature + 2;
      hour++
    ) {
      harness.advanceGameHours(1);
    }
    expect(harness.sim.state.weather.temperature).toBeGreaterThan(crop.frostTemperature + 2);

    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    harness.equip(player, 'hoe');
    harness.clearEvents();
    harness.run(player, { type: 'farm', action: 'till', tileX, tileY });
    harness.step(20);
    // Named separately so a broken hoe, an untillable tile or a missing plot each fails
    // with its own reason instead of surfacing later as "the crop is undefined".
    expect(rejections(harness)).toHaveLength(0);

    harness.giveItem(player, crop.seedDefId, 4);
    harness.clearEvents();
    harness.run(player, { type: 'farm', action: 'plant', tileX, tileY, seedDefId: crop.seedDefId });
    harness.step(20);
    expect(rejections(harness)).toHaveLength(0);

    const plot = Object.values(harness.sim.state.structures).find((s) => s.plot?.crop);
    expect(plot).toBeDefined();
    // Skip the growing: this test is about the second picking, not about ripening. Set to
    // the crop's real mature stage rather than some large number - an out-of-range stage
    // is not "very ripe", it is a crop the growth code cannot place, and it dies.
    plot!.plot!.crop!.stage = matureStage(crop);
    plot!.plot!.crop!.stageProgress = 0;
    // Watered too, or it starves before it can be picked.
    plot!.plot!.crop!.water = 100;
    plot!.plot!.moisture = 100;

    harness.run(player, { type: 'farm', action: 'harvest', tileX, tileY });
    harness.step(20);
    const afterFirst = count(player, crop.produceDefId);
    expect(afterFirst).toBeGreaterThan(0);

    // The plant is still there and still has pickings left, but it fell back a stage.
    harness.clearEvents();
    for (let i = 0; i < 6; i++) {
      harness.run(player, { type: 'farm', action: 'harvest', tileX, tileY });
      harness.step(20);
    }
    expect(count(player, crop.produceDefId)).toBe(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

describe('gathering', () => {
  it('yields nothing more from a node that has been worked out', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.equip(player, 'stone_hatchet');
    const tree = harness.placeNode('tree_pine', pixelToTile(player.x) + 1, pixelToTile(player.y));
    expect(tree).not.toBeNull();

    // Work it to nothing, then keep going.
    for (let i = 0; i < 60 && !tree!.depleted; i++) {
      player.stamina = player.maxStamina;
      harness.run(player, { type: 'gather', nodeId: tree!.id });
      harness.step(14);
    }
    expect(tree!.depleted).toBe(true);

    // A pine drops logs, not planks - planks are a crafted item. Counting the wrong id
    // here would compare 0 with 0 and call the guard proven.
    const harvested = count(player, 'wood_log');
    expect(harvested).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      player.stamina = player.maxStamina;
      harness.run(player, { type: 'gather', nodeId: tree!.id });
      harness.step(14);
    }
    expect(count(player, 'wood_log')).toBe(harvested);
  });
});
