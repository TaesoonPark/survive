import { describe, expect, it } from 'vitest';
import { createGameData } from '@survive/game-data';
import { countItem } from './items';
import { STARTING_KIT, createPlayerState } from './player';
import { createTestContext } from './testing';

/**
 * A new character has to be able to *do* something.
 *
 * The starting kit used to be a hatchet, two rags, three berries and a bottle - no fibre,
 * no sticks, no stone - so the crafting panel opened onto a list of recipes the player
 * could not afford a single one of. Every hand recipe needs a material, and gathering
 * materials needs tools you have exactly one of, so the first minutes were spent chopping
 * with nothing to show for it.
 *
 * These tests are written against the recipe table rather than against a list of item ids,
 * because the thing worth protecting is "the kit affords a basic tool and a basic weapon",
 * not "the kit contains eight fibre". A cost change that breaks the promise fails here.
 */
describe('starting kit', () => {
  // The *real* item and recipe tables, not `createTestContext`'s `createMiniGameData()`.
  // The kit is filtered through `data.items.has`, so a stub table silently drops every
  // entry and hands back an empty inventory that passes any test not looking closely.
  const data = createGameData();
  const { config } = createTestContext({ seed: 1 });

  function freshPlayer() {
    return createPlayerState(data, config, { id: 'p1', name: 'Tester', x: 500, y: 500 });
  }

  /** Recipes needing no station and no skill, which is all a new character can reach. */
  const reachable = data.recipes
    .all()
    .filter((recipe) => !recipe.station && (recipe.requiredSkill?.level ?? 0) === 0);

  function affordable(category: string): string[] {
    const player = freshPlayer();
    return reachable
      .filter((recipe) => recipe.category === category)
      .filter((recipe) =>
        recipe.inputs.every((input) => countItem(player.inventory, input.defId) >= input.count),
      )
      .map((recipe) => recipe.id);
  }

  it('is delivered whole, and weighs less than the player can carry', () => {
    const player = freshPlayer();
    for (const entry of STARTING_KIT) {
      // Counted across the inventory *and* the hands: `createPlayerState` moves the hatchet
      // into mainHand on purpose, so a new player has something to swing immediately.
      const carried =
        countItem(player.inventory, entry.defId) +
        (player.equipment.mainHand?.defId === entry.defId ? player.equipment.mainHand.count : 0);
      expect(carried, entry.defId).toBeGreaterThanOrEqual(entry.count);
    }
    // Over the limit and the player starts encumbered, which reads as a broken game rather
    // than as a generous kit.
    expect(player.carryWeight).toBeLessThan(player.carryCapacity);
  });

  it('affords a tool the player does not already have', () => {
    const tools = affordable('tools');
    expect(tools.length, `affordable tool recipes: ${tools.join(', ')}`).toBeGreaterThan(0);
    // The hatchet is in the kit already, so affording only that would prove nothing.
    expect(tools.some((id) => id !== 'craft_stone_hatchet')).toBe(true);
  });

  it('affords a weapon, so the first zombie is not met bare-handed', () => {
    const weapons = affordable('weapons');
    expect(weapons.length, `affordable weapon recipes: ${weapons.join(', ')}`).toBeGreaterThan(0);
  });

  it('stops short of affording everything, so gathering still matters', () => {
    const player = freshPlayer();
    const unaffordable = reachable.filter((recipe) =>
      recipe.inputs.some((input) => countItem(player.inventory, input.defId) < input.count),
    );
    expect(unaffordable.length).toBeGreaterThan(0);
    // And the kit cannot cover a tool *and* a weapon *and* still have the materials for
    // both: spending is a choice, not a formality.
    const pickaxe = data.recipes.get('craft_stone_pickaxe');
    const spear = data.recipes.get('craft_spear');
    expect(pickaxe && spear).toBeTruthy();
    const combined = new Map<string, number>();
    for (const input of [...pickaxe!.inputs, ...spear!.inputs]) {
      combined.set(input.defId, (combined.get(input.defId) ?? 0) + input.count);
    }
    const leftovers = [...combined].map(
      ([defId, need]) => countItem(player.inventory, defId) - need,
    );
    // Affordable together, but only just - nothing is left over in quantity.
    expect(Math.min(...leftovers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...leftovers)).toBeLessThan(5);
  });
});
