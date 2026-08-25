import { describe, expect, it } from 'vitest';
import { type PlayerState } from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { addEffect } from '../../core/effects';
import { createSurvivalSystem } from './survivalSystem';
import { bestTreatmentTarget, consumeItem, resolveConsumable, treatBodyPart } from './consumption';
import {
  DIRTY_BANDAGE_CLEANLINESS,
  HYDRATED_THIRST,
  SICKNESS_TICKS,
  WELL_FED_HUNGER,
} from './tuning';

/**
 * Eating, drinking and first aid.
 *
 * `consumeItem` is called directly where a test is about nutrition or medicine, because
 * the generic `useItem` routing belongs to the inventory system and coupling these tests
 * to it would make them fail for reasons that have nothing to do with survival. The
 * `treat` command *is* driven through the router, because that command is ours.
 *
 * Every sickness roll is exercised across a span of seeds rather than on one: asserting
 * a 45% chance fired on seed 20260824 tests the seed, whereas counting how many of
 * sixteen seeded worlds produced food poisoning tests the rule - and, because the roll
 * goes through the seeded RNG, that count is itself perfectly reproducible.
 */

function sim(seed?: number): TestSimulation {
  return createTestSimulation({
    ...(seed === undefined ? {} : { seed }),
    systems: [createSurvivalSystem()],
  });
}

/** A player who is hungry and thirsty enough for a meal to show up in the numbers. */
function peckish(harness: TestSimulation): PlayerState {
  const player = harness.addPlayer();
  player.hunger = 60;
  player.thirst = 60;
  return player;
}

/** Eat or drink slot 0, the way the inventory system's `useItem` would. */
function useSlot(
  harness: TestSimulation,
  player: PlayerState,
  index = 0,
): ReturnType<typeof consumeItem> {
  const found = resolveConsumable(player, { kind: 'inventory' }, index);
  if (!found) throw new Error(`useSlot: nothing in inventory slot ${index}`);
  return consumeItem(harness.ctx, player, found.stack, found.slot);
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

describe('eating', () => {
  it('feeds the player, spends the item and announces the meal', () => {
    const harness = sim();
    const player = peckish(harness);
    harness.giveItem(player, 'bread', 2);

    const result = useSlot(harness, player);

    expect(result.ok).toBe(true);
    expect(result.consumed).toBe(1);
    expect(result.busyTicks).toBeGreaterThan(0);
    expect(player.hunger).toBeLessThan(40);
    expect(player.inventory.slots[0]?.count).toBe(1);
    expect(harness.lastEvent('ateFood')?.itemDefId).toBe('bread');
    expect(harness.lastEvent('ateFood')?.nutrition).toBeGreaterThan(20);
    // Eating takes time: no chain-eating a whole loaf in one tick.
    expect(player.useReadyTick).toBeGreaterThan(harness.sim.state.tick);
  });

  it('empties the slot when the last unit is eaten', () => {
    const harness = sim();
    const player = peckish(harness);
    harness.giveItem(player, 'apple', 1);

    useSlot(harness, player);

    expect(player.inventory.slots[0]).toBeNull();
  });

  it('restores stamina and health from a proper meal', () => {
    const harness = sim();
    const player = peckish(harness);
    player.stamina = 40;
    player.body.parts.torso.health = 70;
    harness.giveItem(player, 'stew_meat', 1);

    useSlot(harness, player);

    expect(player.stamina).toBeGreaterThan(45);
    expect(player.body.parts.torso.health).toBeGreaterThan(70);
  });

  it('grants well_fed once the player is genuinely full', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.hunger = WELL_FED_HUNGER + 5;
    harness.giveItem(player, 'bread', 1);

    useSlot(harness, player);

    expect(player.hunger).toBeLessThanOrEqual(WELL_FED_HUNGER);
    expect(player.effects.map((effect) => effect.id)).toContain('well_fed');
  });

  it('makes raw meat a gamble and cooked meat a meal', () => {
    let rawSickened = 0;
    let cookedSickened = 0;
    for (let seed = 1; seed <= 16; seed++) {
      for (const defId of ['raw_meat', 'cooked_meat'] as const) {
        const harness = sim(seed);
        const player = peckish(harness);
        harness.giveItem(player, defId, 1);
        useSlot(harness, player);
        const ill = player.effects.some((effect) => effect.id === 'food_poisoning');
        if (!ill) continue;
        if (defId === 'raw_meat') rawSickened++;
        else cookedSickened++;
      }
    }

    // raw_meat carries sicknessChance 0.45; cooked_meat carries none.
    expect(rawSickened).toBeGreaterThan(3);
    expect(cookedSickened).toBe(0);
  });

  it('makes a raw mushroom risky too', () => {
    let sickened = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const harness = sim(seed);
      const player = peckish(harness);
      harness.giveItem(player, 'mushroom', 1);
      useSlot(harness, player);
      if (player.effects.some((effect) => effect.id === 'food_poisoning')) sickened++;
    }
    expect(sickened).toBeGreaterThan(0);
  });

  it('makes food poisoning hurt and dehydrate for as long as it lasts', () => {
    const harness = sim();
    const ill = harness.addPlayer({ id: 'ill' });
    const well = harness.addPlayer({ id: 'well' });
    for (const player of [ill, well]) {
      player.hunger = 20;
      player.thirst = 20;
      player.fatigue = 0;
    }
    // Applied directly rather than fished for with a seed: what is under test is what a
    // gut illness *does*, not how likely a plate of raw meat is to cause one.
    addEffect(harness.ctx, ill, 'food_poisoning', SICKNESS_TICKS, 1);

    harness.advanceSeconds(60);

    expect(ill.thirst).toBeGreaterThan(well.thirst);
    expect(ill.body.parts.torso.health).toBeLessThan(100);
    expect(well.body.parts.torso.health).toBe(100);
  });

  it('feeds a spoiled meal at a discount and a much higher risk', () => {
    const fresh = sim(7);
    const freshPlayer = peckish(fresh);
    fresh.giveItem(freshPlayer, 'cooked_meat', 1);
    // `giveItem` hands back the template it built, not the stack that landed in the
    // slot, so freshness has to be set on the inventory's own copy.
    const freshStack = freshPlayer.inventory.slots[0];
    if (freshStack) freshStack.freshness = 1;
    const freshBefore = freshPlayer.hunger;
    useSlot(fresh, freshPlayer);
    const freshGain = freshBefore - freshPlayer.hunger;

    const rotten = sim(7);
    const rottenPlayer = peckish(rotten);
    rotten.giveItem(rottenPlayer, 'cooked_meat', 1);
    const rottenStack = rottenPlayer.inventory.slots[0];
    if (rottenStack) rottenStack.freshness = 0.05;
    const rottenBefore = rottenPlayer.hunger;
    useSlot(rotten, rottenPlayer);
    const rottenGain = rottenBefore - rottenPlayer.hunger;

    expect(rottenGain).toBeGreaterThan(0);
    expect(rottenGain).toBeLessThan(freshGain);
  });
});

// ---------------------------------------------------------------------------
// Drink
// ---------------------------------------------------------------------------

describe('drinking', () => {
  it('draws one unit from a bottle without consuming the bottle', () => {
    const harness = sim();
    const player = peckish(harness);
    const bottle = harness.giveItem(player, 'water_bottle', 1);
    const fillBefore = bottle.fill ?? 0;
    expect(fillBefore).toBeGreaterThan(0);

    const result = useSlot(harness, player);

    expect(result.ok).toBe(true);
    expect(result.consumed).toBe(0);
    expect(player.inventory.slots[0]?.defId).toBe('water_bottle');
    expect(player.inventory.slots[0]?.fill).toBe(fillBefore - 1);
    expect(player.thirst).toBeLessThan(35);
    expect(harness.lastEvent('drank')?.itemDefId).toBe('water_clean');
  });

  it('refuses an empty vessel', () => {
    const harness = sim();
    const player = peckish(harness);
    const canteen = harness.giveItem(player, 'canteen', 1);
    expect(canteen.fill ?? 0).toBe(0);

    const result = useSlot(harness, player);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not consumable|empty/);
  });

  it('grants hydrated when the player has drunk their fill', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.thirst = HYDRATED_THIRST + 5;
    harness.giveItem(player, 'water_bottle', 1);

    useSlot(harness, player);

    expect(player.thirst).toBeLessThanOrEqual(HYDRATED_THIRST);
    expect(player.effects.map((effect) => effect.id)).toContain('hydrated');
  });

  it('makes dirty water a real risk and clean water safe', () => {
    let dirtyIll = 0;
    let cleanIll = 0;
    for (let seed = 1; seed <= 16; seed++) {
      for (const defId of ['water_dirty', 'water_clean'] as const) {
        const harness = sim(seed);
        const player = peckish(harness);
        harness.giveItem(player, 'water_bottle', 1);
        // Same bottle, different contents: the roll follows the water, not the vessel.
        const bottle = player.inventory.slots[0];
        if (bottle) bottle.contentDefId = defId;
        useSlot(harness, player);
        const ill = player.effects.some(
          (effect) => effect.id === 'poisoned' || effect.id === 'food_poisoning',
        );
        if (!ill) continue;
        if (defId === 'water_dirty') dirtyIll++;
        else cleanIll++;
      }
    }

    // water_dirty is sicknessChance 0.35; water_clean is 0.01.
    expect(dirtyIll).toBeGreaterThan(2);
    expect(dirtyIll).toBeGreaterThan(cleanIll);
  });

  it('applies the effects a drink declares', () => {
    const harness = sim();
    const player = peckish(harness);
    harness.giveItem(player, 'coffee', 1);

    useSlot(harness, player);

    expect(player.effects.map((effect) => effect.id)).toContain('adrenaline');
  });
});

// ---------------------------------------------------------------------------
// Medicine, through the treat command
// ---------------------------------------------------------------------------

describe('the treat command', () => {
  it('bandages a bleeding wound and slows the blood loss dramatically', () => {
    const harness = sim();
    const bandaged = harness.addPlayer({ id: 'bandaged' });
    const untreated = harness.addPlayer({ id: 'untreated' });
    for (const player of [bandaged, untreated]) player.body.parts.leftArm.bleeding = 3;
    harness.giveItem(bandaged, 'bandage_clean', 1);

    harness.run(bandaged, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'leftArm',
    });
    harness.advanceSeconds(10);

    expect(bandaged.body.parts.leftArm.bandaged).toBe(true);
    expect(bandaged.body.parts.leftArm.bleeding).toBeLessThan(0.6);
    expect(100 - bandaged.blood).toBeLessThan((100 - untreated.blood) / 4);
    expect(harness.lastEvent('treated')?.success).toBe(true);
    expect(bandaged.inventory.slots[0]).toBeNull();
  });

  it('stitches a wound shut for good', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.skills.medicine.level = 4; // A suture kit needs level 3 to use reliably.
    player.body.parts.torso.bleeding = 5;
    harness.giveItem(player, 'suture_kit', 1);

    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'torso',
    });

    expect(player.body.parts.torso.stitched).toBe(true);
    expect(player.body.parts.torso.bleeding).toBe(0);
    expect(harness.eventsOf('bleedingStopped').some((e) => e.bodyPart === 'torso')).toBe(true);
    // A kit is worn, not eaten: it survives with a use spent.
    expect(player.inventory.slots[0]?.defId).toBe('suture_kit');
    expect(player.inventory.slots[0]?.durability).toBeLessThan(5);
  });

  it('sets a fracture with a splint', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.skills.medicine.level = 1; // splint_wood nominally needs level 1.
    const leg = player.body.parts.leftLeg;
    leg.fractured = true;
    // A real fracture always comes with torn tissue - the damage pipeline only breaks
    // a limb at severity > 0.18 - and the healing step knits the break as that tissue
    // closes, so a pristine limb would mend the instant the splint went on.
    leg.health = leg.maxHealth * 0.5;
    harness.giveItem(player, 'splint_wood', 1);

    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'leftLeg',
    });

    expect(leg.splinted).toBe(true);
    expect(leg.fractured).toBe(true);
    expect(harness.lastEvent('treated')?.success).toBe(true);
  });

  it('buys a bitten wound a window of disinfectant protection', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.rightArm.bitten = true;
    player.body.parts.rightArm.infection = 30;
    harness.giveItem(player, 'antiseptic', 1);

    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'rightArm',
    });

    expect(player.body.parts.rightArm.disinfectedTicks).toBeGreaterThan(0);
    expect(player.body.parts.rightArm.infection).toBeLessThan(30);
    expect(player.effects.map((effect) => effect.id)).toContain('antiseptic');
  });

  it('makes a dirty dressing far more likely to seed an infection than a sterile one', () => {
    let dirtyInfected = 0;
    let sterileInfected = 0;
    for (let seed = 1; seed <= 16; seed++) {
      for (const defId of ['bandage_dirty', 'bandage_sterile'] as const) {
        const harness = sim(seed);
        const player = harness.addPlayer();
        player.body.parts.leftLeg.bleeding = 2;
        harness.giveItem(player, defId, 1);
        harness.run(player, {
          type: 'treat',
          ref: { kind: 'inventory' },
          index: 0,
          bodyPart: 'leftLeg',
        });
        if (player.body.parts.leftLeg.infection <= 0) continue;
        if (defId === 'bandage_dirty') dirtyInfected++;
        else sterileInfected++;
      }
      // The content table is the reason this works at all.
      expect(sim(seed).data.items.require('bandage_dirty').medical?.cleanliness).toBeLessThan(
        DIRTY_BANDAGE_CLEANLINESS,
      );
    }

    expect(dirtyInfected).toBeGreaterThan(5);
    expect(sterileInfected).toBe(0);
  });

  it('makes a dirty dressing worse than a clean one over the following hours', () => {
    const harness = sim();
    const dirty = harness.addPlayer({ id: 'dirty' });
    const sterile = harness.addPlayer({ id: 'sterile' });
    for (const player of [dirty, sterile]) {
      const part = player.body.parts.torso;
      part.infection = 10;
      part.bandaged = true;
    }
    dirty.body.parts.torso.bandageQuality = 0.15;
    sterile.body.parts.torso.bandageQuality = 1;

    harness.advanceSeconds(180);

    expect(dirty.body.parts.torso.infection).toBeGreaterThan(sterile.body.parts.torso.infection);
  });

  it('lets a pill work on the whole body at once', () => {
    const harness = sim();
    const player = harness.addPlayer();
    for (const id of ['leftArm', 'rightLeg'] as const) {
      player.body.parts[id].infection = 25;
      player.body.parts[id].pain = 60;
    }
    harness.giveItem(player, 'antibiotics', 1);

    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'head',
    });

    expect(player.body.parts.leftArm.infection).toBe(0);
    expect(player.body.parts.rightLeg.infection).toBe(0);
    expect(player.effects.map((effect) => effect.id)).toContain('antibiotic');
  });

  it('takes the edge off with painkillers and keeps it off', () => {
    const harness = sim();
    const dosed = harness.addPlayer({ id: 'dosed' });
    const sober = harness.addPlayer({ id: 'sober' });
    for (const player of [dosed, sober]) player.body.parts.torso.pain = 80;
    harness.giveItem(dosed, 'painkiller', 1);

    harness.run(dosed, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'torso',
    });
    expect(dosed.body.parts.torso.pain).toBeLessThan(40);

    harness.advanceSeconds(20);
    expect(dosed.body.parts.torso.pain).toBeLessThan(sober.body.parts.torso.pain - 20);
  });

  it('earns medicine experience for a treatment that worked', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.torso.bleeding = 2;
    harness.giveItem(player, 'bandage_clean', 1);

    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'torso',
    });

    expect(harness.eventsOf('skillXp').some((event) => event.skill === 'medicine')).toBe(true);
  });

  it('can be botched below the skill the item needs, wasting it', () => {
    let botched = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const harness = sim(seed);
      const player = harness.addPlayer();
      player.skills.medicine.level = 0; // suture_kit wants 3.
      player.body.parts.torso.bleeding = 5;
      harness.giveItem(player, 'suture_kit', 1);
      harness.run(player, {
        type: 'treat',
        ref: { kind: 'inventory' },
        index: 0,
        bodyPart: 'torso',
      });
      const failure = harness.eventsOf('treated').some((event) => event.success === false);
      if (failure) {
        botched++;
        expect(player.body.parts.torso.stitched).toBe(false);
        expect(player.body.parts.torso.pain).toBeGreaterThan(0);
      }
    }
    expect(botched).toBeGreaterThan(2);
    expect(botched).toBeLessThan(16);
  });

  it('picks the obvious target when the player did not name one', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.rightLeg.fractured = true;
    player.body.parts.leftArm.bleeding = 4;

    expect(bestTreatmentTarget(player, 'splint')).toBe('rightLeg');
    expect(bestTreatmentTarget(player, 'bandage')).toBe('leftArm');
    expect(bestTreatmentTarget(harness.addPlayer({ id: 'whole' }), 'splint')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

describe('consumption rejections', () => {
  const treat = (harness: TestSimulation, player: PlayerState, index: number, part = 'torso') =>
    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index,
      bodyPart: part as 'torso',
    });

  it('refuses to treat an empty slot', () => {
    const harness = sim();
    const player = harness.addPlayer();
    treat(harness, player, 3);
    expect(harness.lastEvent('commandRejected')?.reason).toBe('no item in that slot');
  });

  it('refuses a slot index outside the inventory', () => {
    const harness = sim();
    const player = harness.addPlayer();
    treat(harness, player, 9999);
    expect(harness.lastEvent('commandRejected')?.reason).toBe('no item in that slot');
  });

  it('refuses an unknown body part', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.giveItem(player, 'bandage_clean', 1);
    harness.run(player, {
      type: 'treat',
      ref: { kind: 'inventory' },
      index: 0,
      bodyPart: 'tail' as 'torso',
    });
    expect(harness.lastEvent('commandRejected')?.reason).toBe('unknown body part');
  });

  it('refuses an item that is not medicine', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.giveItem(player, 'wood_log', 1);
    treat(harness, player, 0);
    expect(harness.lastEvent('commandRejected')?.reason).toBe('not a medical item');
  });

  it('refuses to bandage an uninjured limb', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.giveItem(player, 'bandage_clean', 1);
    treat(harness, player, 0);
    expect(harness.lastEvent('commandRejected')?.reason).toBe('nothing to treat there');
    expect(player.inventory.slots[0]?.count).toBe(1);
  });

  it('refuses to splint a limb that is not broken', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.leftLeg.health = 20;
    harness.giveItem(player, 'splint_wood', 1);
    treat(harness, player, 0, 'leftLeg');
    expect(harness.lastEvent('commandRejected')?.reason).toBe('nothing to treat there');
  });

  it('refuses while the player is still busy with the last use', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.torso.bleeding = 3;
    harness.giveItem(player, 'bandage_dirty', 2);
    player.useReadyTick = harness.sim.state.tick + 200;

    treat(harness, player, 0);

    expect(harness.lastEvent('commandRejected')?.reason).toBe('still busy');
    expect(player.body.parts.torso.bandaged).toBe(false);
  });

  it('refuses while the player is locked out of acting', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.torso.bleeding = 3;
    harness.giveItem(player, 'bandage_dirty', 1);
    player.actionLockedUntilTick = harness.sim.state.tick + 200;

    treat(harness, player, 0);

    expect(harness.lastEvent('commandRejected')?.reason).toBe('cannot act');
  });

  it('refuses everything once the player is dead', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.giveItem(player, 'bandage_clean', 1);
    player.alive = false;

    treat(harness, player, 0);

    expect(harness.lastEvent('commandRejected')?.reason).toBe('dead');
    expect(useSlot(harness, player).reason).toBe('dead');
  });

  it('refuses to eat something that is not food', () => {
    const harness = sim();
    const player = harness.addPlayer();
    harness.giveItem(player, 'wood_log', 1);
    expect(useSlot(harness, player).ok).toBe(false);
  });

  it('resolves nothing from a container ref the player does not own', () => {
    const harness = sim();
    const player = harness.addPlayer();
    expect(resolveConsumable(player, { kind: 'ground' }, 0)).toBeNull();
    expect(resolveConsumable(player, { kind: 'structure', structureId: 's1' }, 0)).toBeNull();
    expect(resolveConsumable(player, { kind: 'inventory' }, -1)).toBeNull();
  });

  it('applies medicine straight out of a hand slot', () => {
    const harness = sim();
    const player = harness.addPlayer();
    player.body.parts.torso.bleeding = 3;
    const stack = harness.giveItem(player, 'bandage_clean', 1);
    player.inventory.slots[0] = null;
    player.equipment.offHand = stack;

    const found = resolveConsumable(player, { kind: 'equipment', slot: 'offHand' }, 0);
    expect(found).not.toBeNull();
    const result = treatBodyPart(harness.ctx, player, found!.stack, 'torso', found!.slot);

    expect(result.ok).toBe(true);
    expect(player.body.parts.torso.bandaged).toBe(true);
    expect(player.equipment.offHand).toBeNull();
  });
});
