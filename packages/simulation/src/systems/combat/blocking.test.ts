import { describe, expect, it } from 'vitest';
import { Button, type EntityId, type PlayerState } from '@survive/protocol';
import {
  createTestSimulation,
  type TestSimulation,
  type TestSimulationOptions,
} from '@survive/test-utils';
import { SystemOrder, type System } from '../../core/context';
import type { DamageResult, DamageSpec } from '../../core/damage';
import { createStack } from '../../core/items';
import { bindInputSource, createInputSystem } from '../movement/input';
import {
  BLOCK_ARC_DEGREES,
  BLOCK_STAMINA_PER_DAMAGE,
  MAX_BLOCK_REDUCTION,
  blockReductionFor,
  blockingGear,
  blowIsGuarded,
  isGuarding,
  resolveIncomingAttack,
} from './blocking';
import { createCombatSystem } from './combat';
import { createProjectileSystem } from './projectiles';

/**
 * Blocking tests.
 *
 * Blocking is the one combat rule that has to work identically no matter who swung, so
 * most of these run the attack through a scripted stand-in for the AI system: a system
 * at {@link SystemOrder.Ai} that calls {@link resolveIncomingAttack} exactly as a
 * zombie's claw will. That is the point of the export, and testing it any other way
 * would not prove the thing that matters.
 */

interface ScriptedAttack {
  /**
   * Which *stepped* tick to land the blow on, counting from 1 for the first
   * `sim.step(1)`. Deliberately relative: a fresh world starts at
   * `WORLD_START_TICK`, not at zero, so an absolute tick number here would silently
   * never match and the test would pass while proving nothing.
   */
  atTick: number;
  defenderId: EntityId;
  spec: DamageSpec;
}

/**
 * Stands in for the AI system: lands scripted blows from inside the tick, so the
 * defender's input frame for that tick is the one the guard is read from.
 */
function scriptedAttacker(attacks: ScriptedAttack[], results: DamageResult[]): System {
  let baseTick = -1;
  return {
    id: 'test-attacker',
    order: SystemOrder.Ai,
    update(ctx) {
      if (baseTick < 0) baseTick = ctx.state.tick - 1;
      for (const attack of attacks) {
        if (baseTick + attack.atTick !== ctx.state.tick) continue;
        results.push(resolveIncomingAttack(ctx, attack.defenderId, attack.spec));
      }
    },
  };
}

function makeSim(
  extra: System[] = [],
  options: Omit<TestSimulationOptions, 'systems'> = {},
): TestSimulation {
  const sim = createTestSimulation({
    ...options,
    systems: [createInputSystem(), createCombatSystem(), createProjectileSystem(), ...extra],
  });
  bindInputSource(sim.sim);
  return sim;
}

/** East of the defender, swinging west: the blow travels along +PI. */
const FROM_THE_FRONT = Math.PI;
/** West of the defender, swinging east. */
const FROM_BEHIND = 0;

function guardedHit(
  gear: string[],
  options: {
    angle?: number;
    hold?: number;
    stamina?: number;
    amount?: number;
    knockback?: number;
    seed?: number;
  } = {},
): {
  sim: TestSimulation;
  player: PlayerState;
  result: DamageResult;
} {
  const attacks: ScriptedAttack[] = [];
  const results: DamageResult[] = [];
  const sim = makeSim([scriptedAttacker(attacks, results)], { seed: options.seed ?? 909 });
  const player = sim.addPlayer();
  for (const defId of gear) {
    const stack = createStack(sim.data, defId, 1);
    // Deliberately not `equip`: a shield-ish item belongs in the off hand, and the
    // default-slot rule would put every weapon in the main hand.
    if (player.equipment.mainHand) player.equipment.offHand = stack;
    else player.equipment.mainHand = stack;
  }
  if (options.stamina !== undefined) player.stamina = options.stamina;

  attacks.push({
    atTick: 1,
    defenderId: player.id,
    spec: {
      amount: options.amount ?? 40,
      type: 'slash',
      bodyPart: 'torso',
      angle: options.angle ?? FROM_THE_FRONT,
      ...(options.knockback !== undefined ? { knockback: options.knockback } : {}),
    },
  });

  sim.input(player, { buttons: options.hold ?? Button.Block, aimAngle: 0 });
  sim.step(1);

  const result = results[0];
  if (!result) throw new Error('guardedHit: the scripted attack never landed');
  return { sim, player, result };
}

// ---------------------------------------------------------------------------
// Which gear can block
// ---------------------------------------------------------------------------

describe('blocking gear', () => {
  it('reports nothing to block with when the hands are empty', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    expect(blockReductionFor(player, sim.data)).toBe(0);
    expect(blockingGear(player, sim.data)).toBeNull();
  });

  it('blocks with a weapon that can be interposed, and not with one that cannot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();

    sim.equip(player, 'iron_sword');
    expect(blockReductionFor(player, sim.data)).toBeGreaterThan(0);

    player.equipment.mainHand = createStack(sim.data, 'rifle_308', 1);
    expect(blockReductionFor(player, sim.data)).toBe(0);

    player.equipment.mainHand = createStack(sim.data, 'iron_axe', 1);
    expect(blockReductionFor(player, sim.data)).toBe(0);
  });

  it('guards better with a sword than with a crowbar', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.mainHand = createStack(sim.data, 'crowbar', 1);
    const crowbar = blockReductionFor(player, sim.data);
    player.equipment.mainHand = createStack(sim.data, 'iron_sword', 1);
    expect(blockReductionFor(player, sim.data)).toBeGreaterThan(crowbar);
  });

  it('prefers the off hand on a tie, because that is the hand you would raise', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.mainHand = createStack(sim.data, 'crowbar', 1);
    player.equipment.offHand = createStack(sim.data, 'crowbar', 1);
    expect(blockingGear(player, sim.data)?.slot).toBe('offHand');
  });

  it('takes the better of the two hands', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.mainHand = createStack(sim.data, 'iron_sword', 1);
    player.equipment.offHand = createStack(sim.data, 'crowbar', 1);
    expect(blockingGear(player, sim.data)?.slot).toBe('mainHand');
  });

  it('guards worse with a battered weapon', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const stack = createStack(sim.data, 'iron_sword', 1);
    player.equipment.mainHand = stack;
    const fresh = blockReductionFor(player, sim.data);
    stack.durability = 5;
    expect(blockReductionFor(player, sim.data)).toBeLessThan(fresh);
  });

  it('guards better as the melee skill grows, but never past the cap', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.mainHand = createStack(sim.data, 'iron_sword', 1);
    const novice = blockReductionFor(player, sim.data);
    player.skills.melee.level = 10;
    const expert = blockReductionFor(player, sim.data);

    expect(expert).toBeGreaterThan(novice);
    expect(expert).toBeLessThanOrEqual(MAX_BLOCK_REDUCTION);
  });
});

// ---------------------------------------------------------------------------
// Is the guard up
// ---------------------------------------------------------------------------

describe('raising a guard', () => {
  it('is up only while the button is held', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');

    sim.input(player, { buttons: 0, aimAngle: 0 });
    sim.step(1);
    expect(isGuarding(sim.ctx, player)).toBe(false);

    sim.input(player, { buttons: Button.Block, aimAngle: 0 });
    sim.step(1);
    expect(isGuarding(sim.ctx, player)).toBe(true);
  });

  it('is never up for a corpse, or for an exhausted player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    sim.input(player, { buttons: Button.Block, aimAngle: 0 });
    sim.step(1);
    expect(isGuarding(sim.ctx, player)).toBe(true);

    player.stamina = 0;
    expect(isGuarding(sim.ctx, player)).toBe(false);

    player.stamina = 50;
    player.alive = false;
    expect(isGuarding(sim.ctx, player)).toBe(false);
  });

  it('covers the front but not the back', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    sim.input(player, { buttons: Button.Block, aimAngle: 0 });
    sim.step(1);

    const spec = (angle: number): DamageSpec => ({ amount: 10, type: 'slash', angle });
    expect(blowIsGuarded(sim.ctx, player, spec(FROM_THE_FRONT))).toBe(true);
    expect(blowIsGuarded(sim.ctx, player, spec(FROM_BEHIND))).toBe(false);
    // Just inside and just outside the guard's half-width.
    const half = ((BLOCK_ARC_DEGREES / 2) * Math.PI) / 180;
    expect(blowIsGuarded(sim.ctx, player, spec(Math.PI + half * 0.9))).toBe(true);
    expect(blowIsGuarded(sim.ctx, player, spec(Math.PI + half * 1.1))).toBe(false);
  });

  it('never guards against something with no direction, such as poison', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    sim.input(player, { buttons: Button.Block, aimAngle: 0 });
    sim.step(1);

    expect(blowIsGuarded(sim.ctx, player, { amount: 10, type: 'poison' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Taking a hit on the guard
// ---------------------------------------------------------------------------

describe('resolveIncomingAttack', () => {
  it('reduces the damage of a blow taken on the guard, and says so', () => {
    const open = guardedHit(['iron_sword'], { hold: 0 });
    const guarded = guardedHit(['iron_sword']);

    expect(guarded.result.applied).toBeLessThan(open.result.applied);
    expect(guarded.sim.lastEvent('block')).toMatchObject({ defenderId: guarded.player.id });
    expect(guarded.sim.lastEvent('block')!.absorbed).toBeGreaterThan(0);
    expect(open.sim.eventsOf('block')).toHaveLength(0);
  });

  it('does nothing for a blow that came from behind', () => {
    const front = guardedHit(['iron_sword'], { angle: FROM_THE_FRONT });
    const back = guardedHit(['iron_sword'], { angle: FROM_BEHIND });

    expect(back.result.applied).toBeGreaterThan(front.result.applied);
    expect(back.sim.eventsOf('block')).toHaveLength(0);
  });

  it('costs stamina to hold a blow', () => {
    const { player, sim } = guardedHit(['iron_sword']);
    const absorbed = sim.lastEvent('block')!.absorbed;

    expect(player.stamina).toBeLessThan(player.maxStamina);
    expect(player.maxStamina - player.stamina).toBeCloseTo(absorbed * BLOCK_STAMINA_PER_DAMAGE, 4);
  });

  it('collapses partially when there is not enough stamina behind it', () => {
    const strong = guardedHit(['iron_sword'], { stamina: 100 });
    const weak = guardedHit(['iron_sword'], { stamina: 3 });

    expect(weak.result.applied).toBeGreaterThan(strong.result.applied);
    // Some of it still got through the failing guard, but not all.
    expect(weak.sim.lastEvent('block')!.absorbed).toBeGreaterThan(0);
    expect(weak.sim.lastEvent('block')!.absorbed).toBeLessThan(
      strong.sim.lastEvent('block')!.absorbed,
    );
    // The guard spent every last point holding what it could.
    expect(weak.player.stamina).toBeCloseTo(0, 8);
  });

  it('braces away most of the shove', () => {
    const open = guardedHit(['iron_sword'], { hold: 0, knockback: 200 });
    const guarded = guardedHit(['iron_sword'], { knockback: 200 });

    expect(Math.abs(guarded.player.vx)).toBeLessThan(Math.abs(open.player.vx));
  });

  it('wears the guarding item', () => {
    const attacks: ScriptedAttack[] = [];
    const results: DamageResult[] = [];
    const sim = makeSim([scriptedAttacker(attacks, results)]);
    const player = sim.addPlayer();
    const stack = sim.equip(player, 'iron_sword');
    const before = stack.durability as number;
    attacks.push({
      atTick: 1,
      defenderId: player.id,
      spec: { amount: 30, type: 'slash', bodyPart: 'torso', angle: FROM_THE_FRONT },
    });

    sim.input(player, { buttons: Button.Block, aimAngle: 0 });
    sim.step(1);

    expect(before).toBeGreaterThan(0);
    expect(player.equipment.mainHand?.durability).toBeLessThan(before);
  });

  it('breaks a guarding item that was already on its last legs', () => {
    const attacks: ScriptedAttack[] = [];
    const results: DamageResult[] = [];
    const sim = makeSim([scriptedAttacker(attacks, results)]);
    const player = sim.addPlayer();
    const stack = sim.equip(player, 'iron_sword');
    stack.durability = 0.5;
    attacks.push({
      atTick: 1,
      defenderId: player.id,
      spec: { amount: 30, type: 'slash', bodyPart: 'torso', angle: FROM_THE_FRONT },
    });

    sim.input(player, { buttons: Button.Block, aimAngle: 0 });
    sim.step(1);

    // The block still counted; the sword did not survive it.
    expect(sim.lastEvent('block')).toBeDefined();
    expect(sim.lastEvent('weaponBroke')).toMatchObject({
      ownerId: player.id,
      defId: 'iron_sword',
    });
    expect(player.equipment.mainHand).toBeNull();
  });

  it('handles the death that follows a lethal blow, so callers need not', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const walker = sim.spawnZombie('walker', player.x + 40, player.y);

    const result = resolveIncomingAttack(sim.ctx, walker.id, {
      amount: 500,
      type: 'slash',
      attackerId: player.id,
      bodyPart: 'torso',
    });

    expect(result.killed).toBe(true);
    expect(walker.ai).toBe('dead');
    expect(sim.lastEvent('death')).toMatchObject({ entityId: walker.id, killerId: player.id });
    expect(player.stats.zombieKills).toBe(1);
  });

  it('passes a hit on a non-player straight through with no guard logic', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const walker = sim.spawnZombie('walker', player.x + 40, player.y);

    const result = resolveIncomingAttack(sim.ctx, walker.id, {
      amount: 10,
      type: 'slash',
      attackerId: player.id,
      bodyPart: 'torso',
      angle: FROM_THE_FRONT,
    });

    expect(result.applied).toBeGreaterThan(0);
    expect(sim.eventsOf('block')).toHaveLength(0);
  });

  it('ignores an unknown target instead of throwing', () => {
    const sim = makeSim();
    sim.addPlayer();
    const result = resolveIncomingAttack(sim.ctx, 'z-nobody', { amount: 50, type: 'slash' });
    expect(result.applied).toBe(0);
    expect(result.killed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A guard is a stance, not a free action
// ---------------------------------------------------------------------------

describe('guarding and attacking', () => {
  it('cannot swing from behind a raised guard', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);

    sim.hold(player, { buttons: Button.Primary | Button.Block, aimAngle: 0 }, 40);

    expect(target.health).toBe(target.maxHealth);
    expect(sim.eventsOf('attackSwing')).toHaveLength(0);
  });

  it('swings as soon as the guard drops', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);

    sim.hold(player, { buttons: Button.Primary | Button.Block, aimAngle: 0 }, 5);
    expect(target.health).toBe(target.maxHealth);

    // Release both, then press attack alone.
    sim.input(player, { buttons: 0, aimAngle: 0 });
    sim.step(1);
    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);

    expect(target.health).toBeLessThan(target.maxHealth);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('resolves a scripted exchange identically on every run', () => {
    const run = () => {
      const attacks: ScriptedAttack[] = [];
      const results: DamageResult[] = [];
      const sim = makeSim([scriptedAttacker(attacks, results)], { seed: 4711 });
      const player = sim.addPlayer({ id: 'p1' });
      sim.equip(player, 'iron_sword');
      for (let tick = 1; tick <= 10; tick++) {
        attacks.push({
          atTick: tick,
          defenderId: player.id,
          spec: { amount: 12, type: 'slash', angle: FROM_THE_FRONT },
        });
      }
      for (let tick = 1; tick <= 10; tick++) {
        sim.input(player, { buttons: Button.Block, aimAngle: 0 });
        sim.step(1);
      }
      return {
        health: player.health,
        stamina: player.stamina,
        durability: player.equipment.mainHand?.durability ?? -1,
        applied: results.map((result) => result.applied),
        parts: Object.entries(player.body.parts)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, part]) => `${id}:${part.health.toFixed(4)}`),
      };
    };
    expect(run()).toEqual(run());
  });
});
