import { describe, expect, it } from 'vitest';
import { MAX_SKILL_LEVEL, type SimEvent } from '@survive/protocol';
import {
  PERMANENT,
  addEffect,
  effectMagnitude,
  expireEffects,
  findEffect,
  hasEffect,
  removeEffect,
  setConditionEffect,
} from './effects';
import {
  cumulativeXp,
  grantXp,
  skillCostMultiplier,
  skillLevel,
  skillMultiplier,
  xpForLevel,
} from './skills';
import { NoiseRadius, emitNoise, heardLoudness } from './noise';
import { dropLootTable, dropStack, rollLootTable } from './loot';
import { createStack } from './items';
import { createPlayerState } from './player';
import { createTestContext } from './testing';

function setup(seed = 1) {
  const harness = createTestContext({ seed });
  const player = createPlayerState(harness.ctx.data, harness.config, {
    id: 'p1',
    name: 'Tester',
    x: 500,
    y: 500,
    withoutKit: true,
  });
  harness.state.players[player.id] = player;
  return { ...harness, player };
}

describe('status effects', () => {
  it('adds an effect with an expiry and finds it again', () => {
    const { ctx, player } = setup();
    addEffect(ctx, player, 'painkiller', 100, 0.5);
    expect(hasEffect(player, 'painkiller')).toBe(true);
    expect(effectMagnitude(player, 'painkiller')).toBe(0.5);
    expect(findEffect(player, 'painkiller')?.endsTick).toBe(ctx.state.tick + 100);
  });

  it('refreshes rather than stacking duplicates', () => {
    const { ctx, player, advance } = setup();
    const start = ctx.state.tick;
    addEffect(ctx, player, 'painkiller', 100, 0.5);
    advance(50);
    addEffect(ctx, player, 'painkiller', 100, 0.3);
    expect(player.effects.filter((e) => e.id === 'painkiller')).toHaveLength(1);
    // Keeps the stronger magnitude and the later expiry. Relative to where the world
    // actually starts: a new one opens on the morning of day 1, not at tick 0.
    expect(effectMagnitude(player, 'painkiller')).toBe(0.5);
    expect(findEffect(player, 'painkiller')?.endsTick).toBe(start + 50 + 100);
  });

  it('only announces an effect when it is new or stronger', () => {
    const { ctx, player, events } = setup();
    let applied = 0;
    events.subscribe((event: SimEvent) => {
      if (event.type === 'effectApplied') applied++;
    });
    addEffect(ctx, player, 'fever', 100, 1);
    addEffect(ctx, player, 'fever', 100, 1);
    expect(applied).toBe(1);
    addEffect(ctx, player, 'fever', 100, 2);
    expect(applied).toBe(2);
  });

  it('expires effects whose time is up and emits once', () => {
    const { ctx, player, events, advance } = setup();
    let expired = 0;
    events.subscribe((event) => {
      if (event.type === 'effectExpired') expired++;
    });
    addEffect(ctx, player, 'adrenaline', 10, 1);
    advance(5);
    expireEffects(ctx, player);
    expect(hasEffect(player, 'adrenaline')).toBe(true);
    advance(6);
    expireEffects(ctx, player);
    expect(hasEffect(player, 'adrenaline')).toBe(false);
    expireEffects(ctx, player);
    expect(expired).toBe(1);
  });

  it('never expires a permanent effect', () => {
    const { ctx, player, advance } = setup();
    addEffect(ctx, player, 'zombification', PERMANENT, 1);
    advance(100_000);
    expireEffects(ctx, player);
    expect(hasEffect(player, 'zombification')).toBe(true);
  });

  it('removeEffect reports whether anything was removed', () => {
    const { ctx, player } = setup();
    expect(removeEffect(ctx, player, 'fever')).toBe(false);
    addEffect(ctx, player, 'fever', 10, 1);
    expect(removeEffect(ctx, player, 'fever')).toBe(true);
  });

  it('setConditionEffect tracks a continuous condition without event spam', () => {
    const { ctx, player, events } = setup();
    let applied = 0;
    events.subscribe((event) => {
      if (event.type === 'effectApplied') applied++;
    });
    for (let i = 0; i < 10; i++) setConditionEffect(ctx, player, 'cold', true, 1);
    expect(applied).toBe(1);
    expect(hasEffect(player, 'cold')).toBe(true);
    setConditionEffect(ctx, player, 'cold', false);
    expect(hasEffect(player, 'cold')).toBe(false);
  });

  it('setConditionEffect updates the magnitude in place', () => {
    const { ctx, player } = setup();
    setConditionEffect(ctx, player, 'overencumbered', true, 0.2);
    setConditionEffect(ctx, player, 'overencumbered', true, 0.9);
    expect(effectMagnitude(player, 'overencumbered')).toBe(0.9);
    // And back down again, which addEffect alone would refuse to do.
    setConditionEffect(ctx, player, 'overencumbered', true, 0.1);
    expect(effectMagnitude(player, 'overencumbered')).toBe(0.1);
  });
});

describe('skills', () => {
  it('needs more XP for each successive level', () => {
    for (let level = 0; level < MAX_SKILL_LEVEL; level++) {
      expect(xpForLevel(level + 1)).toBeGreaterThan(xpForLevel(level));
    }
    expect(cumulativeXp(0)).toBe(0);
    expect(cumulativeXp(2)).toBe(xpForLevel(0) + xpForLevel(1));
  });

  it('levels up once enough XP is banked', () => {
    const { ctx, player } = setup();
    grantXp(ctx, player, 'woodcutting', xpForLevel(0));
    expect(skillLevel(player, 'woodcutting')).toBe(1);
    expect(player.skills.woodcutting.xp).toBe(0);
  });

  it('can level several times from one large grant', () => {
    const { ctx, player } = setup();
    grantXp(ctx, player, 'crafting', xpForLevel(0) + xpForLevel(1) + xpForLevel(2));
    expect(skillLevel(player, 'crafting')).toBe(3);
  });

  it('emits a levelUp event per level gained', () => {
    const { ctx, player, events } = setup();
    const levels: number[] = [];
    events.subscribe((event) => {
      if (event.type === 'levelUp') levels.push(event.level);
    });
    grantXp(ctx, player, 'mining', xpForLevel(0) + xpForLevel(1));
    expect(levels).toEqual([1, 2]);
  });

  it('caps at the maximum level and stops banking XP', () => {
    const { ctx, player } = setup();
    grantXp(ctx, player, 'melee', 10_000_000);
    expect(skillLevel(player, 'melee')).toBe(MAX_SKILL_LEVEL);
    expect(player.skills.melee.xp).toBe(0);
    grantXp(ctx, player, 'melee', 10_000);
    expect(skillLevel(player, 'melee')).toBe(MAX_SKILL_LEVEL);
  });

  it('scales gains by the xpRate tuning knob', () => {
    const slow = setup();
    const fast = setup();
    fast.config.tuning.xpRate = 10;
    grantXp(slow.ctx, slow.player, 'farming', 10);
    grantXp(fast.ctx, fast.player, 'farming', 10);
    expect(fast.player.skills.farming.xp).toBeGreaterThan(slow.player.skills.farming.xp);
  });

  it('ignores non-positive grants', () => {
    const { ctx, player } = setup();
    grantXp(ctx, player, 'cooking', 0);
    grantXp(ctx, player, 'cooking', -50);
    expect(player.skills.cooking.xp).toBe(0);
  });

  it('raises the stamina ceiling as athletics improves', () => {
    const { ctx, player } = setup();
    const before = player.maxStamina;
    grantXp(ctx, player, 'athletics', xpForLevel(0));
    expect(player.maxStamina).toBeGreaterThan(before);
  });

  it('turns levels into multipliers in both directions', () => {
    const { ctx, player } = setup();
    expect(skillMultiplier(player, 'melee')).toBe(1);
    expect(skillCostMultiplier(player, 'crafting')).toBe(1);
    grantXp(ctx, player, 'melee', 10_000_000);
    grantXp(ctx, player, 'crafting', 10_000_000);
    expect(skillMultiplier(player, 'melee')).toBeGreaterThan(1);
    expect(skillCostMultiplier(player, 'crafting')).toBeLessThan(1);
    expect(skillCostMultiplier(player, 'crafting')).toBeGreaterThanOrEqual(0.5);
  });
});

describe('noise', () => {
  it('emits a noise event with a radius', () => {
    const { ctx, events } = setup();
    const heard: SimEvent[] = [];
    events.subscribe((event) => {
      if (event.type === 'noise') heard.push(event);
    });
    emitNoise(ctx, 100, 200, NoiseRadius.Gunshot, 1, 'p1');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ x: 100, y: 200, radius: NoiseRadius.Gunshot });
  });

  it('ignores a zero radius rather than emitting a useless event', () => {
    const { ctx, events } = setup();
    let count = 0;
    events.subscribe((event) => {
      if (event.type === 'noise') count++;
    });
    emitNoise(ctx, 0, 0, 0);
    expect(count).toBe(0);
  });

  it('orders loudness sensibly: a gunshot carries much further than a footstep', () => {
    expect(NoiseRadius.Gunshot).toBeGreaterThan(NoiseRadius.BowShot);
    expect(NoiseRadius.Sprint).toBeGreaterThan(NoiseRadius.Footstep);
    expect(NoiseRadius.Footstep).toBeGreaterThan(NoiseRadius.Crouch);
  });

  it('falls off with distance and returns zero beyond the radius', () => {
    const { ctx } = setup();
    const near = heardLoudness(ctx, 0, 0, 10, 0, 100);
    const far = heardLoudness(ctx, 0, 0, 90, 0, 100);
    expect(near).toBeGreaterThan(far);
    expect(heardLoudness(ctx, 0, 0, 500, 0, 100)).toBe(0);
  });

  it('is muffled but not silenced by a wall', () => {
    const harness = setup();
    const open = heardLoudness(harness.ctx, 0, 0, 60, 0, 200);
    harness.world.setSolid(1, 0, true, true);
    const walled = heardLoudness(harness.ctx, 0, 0, 60, 0, 200);
    expect(walled).toBeGreaterThan(0);
    expect(walled).toBeLessThan(open);
  });
});

describe('loot', () => {
  it('always yields the guaranteed entries', () => {
    const { ctx } = setup(5);
    for (let i = 0; i < 20; i++) {
      const stacks = rollLootTable(ctx, 'test_common', `roll${i}`);
      expect(stacks.some((stack) => stack.defId === 'apple')).toBe(true);
    }
  });

  it('is deterministic for the same seed and label', () => {
    const a = setup(31);
    const b = setup(31);
    expect(rollLootTable(a.ctx, 'test_common')).toEqual(rollLootTable(b.ctx, 'test_common'));
  });

  it('rolls a used condition onto found tools', () => {
    const { ctx } = setup(3);
    let sawWorn = false;
    for (let i = 0; i < 60 && !sawWorn; i++) {
      const stacks = rollLootTable(ctx, 'test_common', `c${i}`);
      const axe = stacks.find((stack) => stack.defId === 'axe');
      if (axe?.durability !== undefined && axe.durability < 100) sawWorn = true;
    }
    expect(sawWorn).toBe(true);
  });

  it('returns nothing for an unknown table instead of throwing', () => {
    const { ctx } = setup();
    expect(rollLootTable(ctx, 'nope')).toEqual([]);
  });

  it('scales with the lootAbundance world setting', () => {
    const lean = setup(17);
    const rich = setup(17);
    rich.config.world.lootAbundance = 4;
    const leanCount = rollLootTable(lean.ctx, 'test_common').length;
    const richCount = rollLootTable(rich.ctx, 'test_common').length;
    expect(richCount).toBeGreaterThan(leanCount);
  });

  it('drops a stack as a ground entity with a despawn deadline', () => {
    const { ctx, state } = setup();
    const id = dropStack(ctx, 400, 400, createStack(ctx.data, 'wood', 3), 'p1');
    expect(id).not.toBeNull();
    const entity = state.items[id!]!;
    expect(entity.stack).toMatchObject({ defId: 'wood', count: 3 });
    expect(entity.droppedBy).toBe('p1');
    expect(entity.despawnTick).toBeGreaterThan(ctx.state.tick);
    // Scattered near, but not exactly on, the drop point.
    expect(Math.hypot(entity.x - 400, entity.y - 400)).toBeLessThanOrEqual(10.0001);
  });

  it('honours an infinite despawn setting', () => {
    const { ctx, state, config } = setup();
    config.tuning.itemDespawnTicks = -1;
    const id = dropStack(ctx, 100, 100, createStack(ctx.data, 'wood'));
    expect(state.items[id!]!.despawnTick).toBe(-1);
  });

  it('refuses to drop an empty stack', () => {
    const { ctx } = setup();
    expect(dropStack(ctx, 0, 0, { defId: 'wood', count: 0 })).toBeNull();
  });

  it('drops a whole loot table onto the ground', () => {
    const { ctx, state } = setup(8);
    const dropped = dropLootTable(ctx, 'test_common', 200, 200);
    expect(dropped.length).toBeGreaterThan(0);
    expect(Object.keys(state.items)).toHaveLength(dropped.length);
  });
});
