import { describe, expect, it } from 'vitest';
import {
  Button,
  SIM_HZ,
  bodyHealthFraction,
  pixelToTile,
  type PlayerState,
  type SimEvent,
} from '@survive/protocol';
import {
  createTestSimulation,
  type TestSimulation,
  type TestSimulationOptions,
} from '@survive/test-utils';
import type { System } from '../../core/context';
import { createStack } from '../../core/items';
import { createBuildingSystem } from '../building/building';
import { bindInputSource, createInputSystem } from '../movement/input';
import { createGatheringSystem } from '../world/gathering';
import { resolveIncomingAttack } from './blocking';
import { createCombatSystem, DRY_FIRE_TICKS, EXHAUSTED_RETRY_TICKS, spreadRadians } from './combat';
import { createProjectileSystem } from './projectiles';
import { UNARMED, attackCooldownTicks, resolveWeapon } from './weapons';

/**
 * Combat is the most bug-prone system in the game, so these tests are written against
 * observable outcomes only - events, health, ammunition, inventory - and never against
 * how the swing was resolved internally.
 *
 * Every test drives combat the way a client does: an input frame per tick, with the
 * attack button edge-detected. That is deliberate. A test that reached in and called
 * the resolver directly would pass while the button handling was broken.
 */

function makeSim(
  options: Omit<TestSimulationOptions, 'systems'> = {},
  extra: System[] = [],
): TestSimulation {
  const sim = createTestSimulation({
    ...options,
    systems: [createInputSystem(), createCombatSystem(), createProjectileSystem(), ...extra],
  });
  bindInputSource(sim.sim);
  return sim;
}

/** One press-and-release of the attack button. Returns the events from the press. */
function swing(sim: TestSimulation, player: PlayerState, aimAngle = 0): SimEvent[] {
  sim.input(player, { buttons: Button.Primary, aimAngle });
  const events = sim.step(1);
  sim.input(player, { buttons: 0, aimAngle });
  sim.step(1);
  return events;
}

/** Idle until the player's attack cooldown has expired. */
function waitForReady(sim: TestSimulation, player: PlayerState, aimAngle = 0): void {
  let guard = 0;
  while (sim.sim.state.tick < player.attackReadyTick && guard++ < 400) {
    sim.input(player, { buttons: 0, aimAngle });
    sim.step(1);
  }
}

/**
 * Swing until the target stops being a problem.
 *
 * Stamina is topped up between swings on purpose: this helper exists to reach a kill,
 * and the stamina gate has its own test. Leaving it in would make every kill test also
 * a test of the exhaustion rule, and fail for the wrong reason.
 */
function swingUntil(
  sim: TestSimulation,
  player: PlayerState,
  done: () => boolean,
  aimAngle = 0,
  maxSwings = 30,
): void {
  for (let i = 0; i < maxSwings && !done(); i++) {
    player.stamina = player.maxStamina;
    swing(sim, player, aimAngle);
    waitForReady(sim, player, aimAngle);
  }
}

/** Total damage dealt to one target across the collected events. */
function damageTo(sim: TestSimulation, targetId: string): number {
  return sim
    .eventsOf('damage')
    .filter((event) => event.targetId === targetId)
    .reduce((sum, event) => sum + event.amount, 0);
}

/** Load a firearm and step until the reload lands. */
function reload(sim: TestSimulation, player: PlayerState): void {
  sim.command(player, { type: 'reload' });
  for (let i = 0; i < 200; i++) {
    sim.input(player, { buttons: 0 });
    sim.step(1);
    if (sim.lastEvent('reloaded')) return;
    if (sim.lastEvent('commandRejected')) return;
  }
}

// ---------------------------------------------------------------------------
// Melee arcs
// ---------------------------------------------------------------------------

describe('melee swings', () => {
  it('hits a zombie in the arc and ignores one standing behind the player', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    const front = sim.spawnZombie('walker', player.x + 40, player.y);
    const behind = sim.spawnZombie('walker', player.x - 40, player.y);

    swing(sim, player, 0);

    expect(sim.lastEvent('attackSwing')?.hit).toBe(true);
    expect(front.health).toBeLessThan(front.maxHealth);
    expect(behind.health).toBe(behind.maxHealth);
  });

  it('hits a zombie standing on top of the player whichever way the swing is aimed', () => {
    // A cone is a statement about direction, and direction means nothing at zero
    // distance: `angleBetween` of a point on the origin is 0, so without the engulfing
    // case a walker that had shoved onto the player's exact position could only be hit
    // by a swing aimed at due east. Aimed at due west here, on purpose.
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    const inside = sim.spawnZombie('walker', player.x, player.y);

    swing(sim, player, Math.PI);

    expect(sim.lastEvent('attackSwing')?.hit).toBe(true);
    expect(inside.health).toBeLessThan(inside.maxHealth);
  });

  it('reports a miss and leaves nothing damaged when the arc is empty', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');

    swing(sim, player, 0);

    expect(sim.lastEvent('attackSwing')?.hit).toBe(false);
    expect(sim.eventsOf('damage')).toHaveLength(0);
  });

  it('respects the weapon reach', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // Bat reach is 52 px; 140 px away is well outside it even allowing for the
    // target's own radius.
    sim.equip(player, 'baseball_bat');
    const far = sim.spawnZombie('walker', player.x + 140, player.y);

    swing(sim, player, 0);

    expect(far.health).toBe(far.maxHealth);
    expect(sim.lastEvent('attackSwing')?.hit).toBe(false);
  });

  it('reaches further with a longer weapon', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // The spear's 74 px is the whole point of the weapon.
    sim.equip(player, 'spear');
    const target = sim.spawnZombie('walker', player.x + 70, player.y);

    swing(sim, player, 0);

    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('hits no more targets than the weapon allows', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // The club is strictly single-target.
    sim.equip(player, 'wooden_club');
    const near = sim.spawnZombie('walker', player.x + 26, player.y);
    const alsoNear = sim.spawnZombie('walker', player.x + 34, player.y + 6);

    swing(sim, player, 0);

    const hurt = [near, alsoNear].filter((zombie) => zombie.health < zombie.maxHealth);
    expect(hurt).toHaveLength(1);
    expect(hurt[0]).toBe(near);
  });

  it('sweeps several targets with a wide weapon', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // The sword's 95-degree arc takes three.
    sim.equip(player, 'iron_sword');
    const targets = [
      sim.spawnZombie('walker', player.x + 40, player.y),
      sim.spawnZombie('walker', player.x + 34, player.y - 20),
      sim.spawnZombie('walker', player.x + 34, player.y + 20),
    ];

    swing(sim, player, 0);

    for (const target of targets) expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('cannot reach through a wall', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'spear');
    const tileX = pixelToTile(player.x);
    const tileY = pixelToTile(player.y);
    // A wall in the tile between the two of them: 52 px is inside the spear's reach,
    // but the sightline is not.
    sim.wall(tileX + 1, tileY - 2, tileX + 1, tileY + 2);
    const target = sim.spawnZombie('walker', player.x + 52, player.y);

    swing(sim, player, 0);

    expect(target.health).toBe(target.maxHealth);
    expect(sim.lastEvent('attackSwing')?.hit).toBe(false);
  });

  it('reaches the same target once the wall is gone', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'spear');
    const target = sim.spawnZombie('walker', player.x + 52, player.y);

    swing(sim, player, 0);

    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('punches for real damage when the hands are empty', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    expect(player.equipment.mainHand).toBeNull();
    const target = sim.spawnZombie('walker', player.x + 20, player.y);
    const before = bodyHealthFraction(target.body);

    swing(sim, player, 0);

    expect(sim.lastEvent('attackSwing')?.hit).toBe(true);
    // Aggregate `health` is a rounded projection of the body, so a single punch to a
    // limb can round away entirely: the wound itself is what proves the hit landed.
    expect(damageTo(sim, target.id)).toBeGreaterThan(0);
    expect(bodyHealthFraction(target.body)).toBeLessThan(before);
    expect(sim.lastEvent('damage')?.damageType).toBe(UNARMED.damageType);
    // Fists have no item behind them, so nothing is reported as the weapon.
    expect(sim.lastEvent('attackSwing')?.weaponDefId).toBeUndefined();
  });

  it('beats a walker to death bare-handed, given long enough', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const target = sim.spawnZombie('walker', player.x + 20, player.y);

    // Miserable but possible, which is exactly the intent behind the UNARMED numbers.
    swingUntil(sim, player, () => target.ai === 'dead', 0, 200);

    expect(target.ai).toBe('dead');
    expect(sim.lastEvent('death')).toMatchObject({ entityId: target.id, killerId: player.id });
  });

  it('falls back to fists when the held item is not a weapon at all', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    player.equipment.mainHand = { defId: 'wood_log', count: 1 };
    expect(resolveWeapon(player, sim.data).weapon).toBe(UNARMED);
    const target = sim.spawnZombie('walker', player.x + 20, player.y);
    const before = bodyHealthFraction(target.body);

    swing(sim, player, 0);

    expect(damageTo(sim, target.id)).toBeGreaterThan(0);
    expect(bodyHealthFraction(target.body)).toBeLessThan(before);
  });

  it('cannot be swung by a corpse', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);
    player.alive = false;

    swing(sim, player, 0);

    expect(target.health).toBe(target.maxHealth);
    expect(sim.eventsOf('attackSwing')).toHaveLength(0);
  });

  it('leaves other players alone when PvP is off, and hits them when it is on', () => {
    const peaceful = makeSim();
    const a = peaceful.addPlayer({ id: 'p1' });
    const b = peaceful.addPlayer({ id: 'p2', x: peaceful.spawn.x + 40, y: peaceful.spawn.y });
    peaceful.equip(a, 'iron_sword');
    swing(peaceful, a, 0);
    expect(b.health).toBe(b.maxHealth);

    const hostile = makeSim({ config: (config) => void (config.mode.pvp = true) });
    const c = hostile.addPlayer({ id: 'p1' });
    const d = hostile.addPlayer({ id: 'p2', x: hostile.spawn.x + 40, y: hostile.spawn.y });
    hostile.equip(c, 'iron_sword');
    swing(hostile, c, 0);
    expect(d.health).toBeLessThan(d.maxHealth);
  });
});

// ---------------------------------------------------------------------------
// Cadence, stamina and wear
// ---------------------------------------------------------------------------

describe('attack cadence', () => {
  it('does not auto-fire a melee weapon while the button is held', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    sim.spawnZombie('walker', player.x + 40, player.y);

    // Long enough for three swings' worth of cooldown to expire.
    sim.hold(player, { buttons: Button.Primary, aimAngle: 0 }, 60);

    expect(sim.eventsOf('attackSwing')).toHaveLength(1);
  });

  it('refuses a fresh press that arrives inside the cooldown', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    sim.spawnZombie('walker', player.x + 40, player.y);

    swing(sim, player, 0);
    expect(sim.eventsOf('attackSwing')).toHaveLength(1);
    const readyAt = player.attackReadyTick;
    expect(readyAt).toBeGreaterThan(sim.sim.state.tick);

    // A second press, still inside the window.
    swing(sim, player, 0);
    expect(sim.eventsOf('attackSwing')).toHaveLength(1);

    waitForReady(sim, player, 0);
    player.stamina = player.maxStamina;
    swing(sim, player, 0);
    expect(sim.eventsOf('attackSwing')).toHaveLength(2);
  });

  it('cycles faster with a faster weapon', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const knife = attackCooldownTicks(player, sim.data.items.require('kitchen_knife').weapon!);
    const sledge = attackCooldownTicks(player, sim.data.items.require('sledgehammer').weapon!);
    expect(knife).toBeLessThan(sledge);
  });

  it('does not keep swinging when the client goes quiet', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);

    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);
    expect(sim.eventsOf('attackSwing')).toHaveLength(1);

    // No further frames at all: a starved input must release the button rather than
    // repeat it, or going silent would be a free attack loop.
    sim.step(80);

    expect(sim.eventsOf('attackSwing')).toHaveLength(1);
    expect(target.health).toBeGreaterThan(0);
  });

  it('will not swing while staggered by a hit', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);
    player.actionLockedUntilTick = sim.sim.state.tick + 20;

    swing(sim, player, 0);

    expect(target.health).toBe(target.maxHealth);
  });
});

describe('stamina', () => {
  it('spends stamina on every swing', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    const before = player.stamina;

    swing(sim, player, 0);

    expect(player.stamina).toBeLessThan(before);
  });

  it('refuses an attack the player cannot afford, and says so', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'sledgehammer');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);
    player.stamina = 1;

    swing(sim, player, 0);

    expect(target.health).toBe(target.maxHealth);
    expect(sim.lastEvent('notification')?.severity).toBe('warn');
    expect(sim.eventsOf('attackSwing')).toHaveLength(0);
    // The refusal costs a short pause rather than letting the client retry every tick.
    expect(player.attackReadyTick).toBeGreaterThanOrEqual(EXHAUSTED_RETRY_TICKS);
  });

  it('lets a cheap weapon swing where an expensive one cannot', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'kitchen_knife');
    const target = sim.spawnZombie('walker', player.x + 24, player.y);
    player.stamina = 5;

    swing(sim, player, 0);

    expect(target.health).toBeLessThan(target.maxHealth);
  });
});

describe('weapon wear', () => {
  it('spends durability on a hit but not on a whiff', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const stack = sim.equip(player, 'iron_sword');
    const full = stack.durability;
    expect(full).toBeGreaterThan(0);

    swing(sim, player, 0);
    expect(player.equipment.mainHand?.durability).toBe(full);

    sim.spawnZombie('walker', player.x + 40, player.y);
    waitForReady(sim, player, 0);
    player.stamina = player.maxStamina;
    swing(sim, player, 0);
    expect(player.equipment.mainHand?.durability).toBeLessThan(full as number);
  });

  it('breaks the weapon when its durability runs out, and empties the hand', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const stack = sim.equip(player, 'iron_sword');
    stack.durability = 1;
    sim.spawnZombie('walker', player.x + 40, player.y);

    swing(sim, player, 0);

    expect(sim.lastEvent('weaponBroke')).toMatchObject({
      ownerId: player.id,
      defId: 'iron_sword',
    });
    expect(player.equipment.mainHand).toBeNull();
    expect(player.carryWeight).toBe(0);
  });

  it('keeps working with fists after the weapon breaks', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const stack = sim.equip(player, 'iron_sword');
    stack.durability = 1;
    const first = sim.spawnZombie('walker', player.x + 40, player.y);
    swing(sim, player, 0);
    expect(player.equipment.mainHand).toBeNull();

    const second = sim.spawnZombie('walker', player.x + 20, player.y - 4);
    waitForReady(sim, player, 0);
    player.stamina = player.maxStamina;
    swing(sim, player, 0);

    expect(first.health).toBeLessThan(first.maxHealth);
    expect(second.health).toBeLessThan(second.maxHealth);
  });

  it('hits harder with a fresh weapon than with a nearly-dead one', () => {
    const run = (durability: number): number => {
      const sim = makeSim({ seed: 991 });
      const player = sim.addPlayer();
      const stack = sim.equip(player, 'machete');
      stack.durability = durability;
      const deer = sim.spawnAnimal('deer', player.x + 40, player.y);
      swing(sim, player, 0);
      return damageTo(sim, deer.id);
    };
    // Animals take flat damage with no body-part roll, so this compares cleanly.
    expect(run(220)).toBeGreaterThan(run(10));
  });
});

// ---------------------------------------------------------------------------
// Damage resolution
// ---------------------------------------------------------------------------

describe('damage resolution', () => {
  it('hurts far more through the head than through the torso', () => {
    // A swing never chooses where it lands; the shared incoming-attack path can be
    // told, which is how the body-part multiplier gets a deterministic test.
    const hit = (bodyPart: 'head' | 'torso'): number => {
      const sim = makeSim({ seed: 7 });
      const player = sim.addPlayer();
      const target = sim.spawnZombie('walker', player.x + 40, player.y);
      // Equalise the two parts so only the multiplier differs.
      for (const part of ['head', 'torso'] as const) {
        target.body.parts[part].maxHealth = 1000;
        target.body.parts[part].health = 1000;
      }
      resolveIncomingAttack(sim.ctx, target.id, {
        amount: 20,
        type: 'slash',
        attackerId: player.id,
        bodyPart,
      });
      return 1000 - target.body.parts[bodyPart].health;
    };
    expect(hit('head')).toBeGreaterThan(hit('torso') * 2);
  });

  it('lets armour soak a hit', () => {
    const take = (gear: string[]): { applied: number; blocked: number } => {
      const sim = makeSim({ seed: 31 });
      const defender = sim.addPlayer();
      for (const defId of gear) sim.equip(defender, defId);
      const result = resolveIncomingAttack(sim.ctx, defender.id, {
        amount: 30,
        type: 'slash',
        bodyPart: 'torso',
      });
      return { applied: result.applied, blocked: result.blocked };
    };

    const naked = take([]);
    const clad = take(['plate_carrier']);

    expect(naked.blocked).toBe(0);
    expect(clad.blocked).toBeGreaterThan(0);
    expect(clad.applied).toBeLessThan(naked.applied);
  });

  it('lets armour penetration cut through the plate', () => {
    const take = (armorPen: number): number => {
      const sim = makeSim({ seed: 32 });
      const defender = sim.addPlayer();
      sim.equip(defender, 'plate_carrier');
      return resolveIncomingAttack(sim.ctx, defender.id, {
        amount: 30,
        type: 'slash',
        bodyPart: 'torso',
        armorPen,
      }).applied;
    };
    expect(take(1)).toBeGreaterThan(take(0));
  });

  it('knocks the target back along the line of the blow', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'sledgehammer');
    const target = sim.spawnZombie('walker', player.x + 40, player.y);

    swing(sim, player, 0);

    // The sledge's 260 px/s shove points away from the attacker, which is +X here.
    expect(target.vx).toBeGreaterThan(0);
  });

  it('scales with the playerDamageDealt tuning knob', () => {
    const run = (dealt: number): number => {
      const sim = makeSim({
        seed: 505,
        config: (config) => void (config.tuning.playerDamageDealt = dealt),
      });
      const player = sim.addPlayer();
      sim.equip(player, 'iron_sword');
      const deer = sim.spawnAnimal('deer', player.x + 40, player.y);
      swing(sim, player, 0);
      return damageTo(sim, deer.id);
    };
    const single = run(1);
    expect(run(2)).toBeCloseTo(single * 2, 4);
  });
});

// ---------------------------------------------------------------------------
// Kills
// ---------------------------------------------------------------------------

describe('kills', () => {
  it('awards XP, counts the kill and drops loot', () => {
    const sim = makeSim({ seed: 4242 });
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    // A deer takes flat damage and its butchery table always yields meat and bone,
    // so "did the kill pay out" is a real assertion rather than a dice roll.
    const deer = sim.spawnAnimal('deer', player.x + 40, player.y);

    swingUntil(sim, player, () => deer.ai === 'dead');

    expect(deer.ai).toBe('dead');
    expect(sim.lastEvent('death')).toMatchObject({ entityId: deer.id, killerId: player.id });
    expect(player.stats.animalKills).toBe(1);
    expect(sim.eventsOf('skillXp').length).toBeGreaterThan(0);

    const dropped = Object.values(sim.sim.state.items).map((item) => item.stack.defId);
    expect(dropped).toContain('raw_meat');
    expect(dropped).toContain('bone');
  });

  it('kills a walker and credits the melee skill', () => {
    const sim = makeSim({ seed: 606 });
    const player = sim.addPlayer();
    sim.equip(player, 'iron_sword');
    const walker = sim.spawnZombie('walker', player.x + 40, player.y);

    swingUntil(sim, player, () => walker.ai === 'dead');

    expect(walker.ai).toBe('dead');
    expect(player.stats.zombieKills).toBe(1);
    expect(sim.eventsOf('skillXp').some((event) => event.skill === 'melee')).toBe(true);
  });

  it('scales XP with the xpRate tuning knob', () => {
    const run = (rate: number): number => {
      const sim = makeSim({ seed: 88, config: (config) => void (config.tuning.xpRate = rate) });
      const player = sim.addPlayer();
      sim.equip(player, 'iron_sword');
      sim.spawnZombie('walker', player.x + 40, player.y);
      swing(sim, player, 0);
      return sim.eventsOf('skillXp').reduce((sum, event) => sum + event.amount, 0);
    };
    expect(run(2)).toBeCloseTo(run(1) * 2, 4);
  });
});

// ---------------------------------------------------------------------------
// Structures and resource nodes
// ---------------------------------------------------------------------------

describe('swinging at the world', () => {
  it('breaks down a wall when nothing living is in the arc', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'sledgehammer');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const wall = sim.placeStructure('wall_wood', tileX, tileY);
    expect(wall).not.toBeNull();

    swing(sim, player, 0);

    expect(wall!.health).toBeLessThan(wall!.maxHealth);
    expect(sim.lastEvent('structureDamaged')?.structureId).toBe(wall!.id);
    expect(sim.lastEvent('attackSwing')?.hit).toBe(true);
  });

  it('finishes a wall off and frees the tile it stood on', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'sledgehammer');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const wall = sim.placeStructure('wall_wood', tileX, tileY);
    wall!.health = 5;
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(true);

    swing(sim, player, 0);

    expect(sim.lastEvent('structureDestroyed')?.structureId).toBe(wall!.id);
    expect(sim.sim.state.structures[wall!.id]).toBeUndefined();
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(false);
  });

  it('spills a container it breaks open instead of deleting the contents', () => {
    // Combat kills structures on its own path, and it used to do a shorter teardown than
    // the decay reaper: emit, make noise, delete. Everything inside a chest broken open by
    // a sledgehammer was destroyed with it, while the same chest left to rot spilled its
    // contents properly. The two paths have to agree, so this asserts the *combat* one.
    const sim = makeSim({}, [createBuildingSystem()]);
    const player = sim.addPlayer();
    sim.equip(player, 'sledgehammer');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const box = sim.placeStructure('storage_box', tileX, tileY)!;
    box.progress = 1;
    box.health = 5;
    box.container!.slots[0] = createStack(sim.data, 'wood_log', 5);

    swing(sim, player, 0);

    expect(sim.sim.state.structures[box.id]).toBeUndefined();
    const onGround = Object.values(sim.sim.state.items)
      .filter((item) => item.stack.defId === 'wood_log')
      .reduce((total, item) => total + item.stack.count, 0);
    expect(onGround).toBe(5);
  });

  it('prefers a living target over the wall behind it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'sledgehammer');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const wall = sim.placeStructure('wall_wood', tileX, tileY);
    // In front of the player but on this side of the wall, so the sightline is clear.
    const target = sim.spawnZombie('walker', player.x + 12, player.y);

    swing(sim, player, 0);

    expect(target.health).toBeLessThan(target.maxHealth);
    expect(wall!.health).toBe(wall!.maxHealth);
  });

  it('chops a tree with an axe, through the gathering payout', () => {
    const sim = makeSim({}, [createGatheringSystem()]);
    const player = sim.addPlayer();
    sim.equip(player, 'iron_axe');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const tree = sim.placeNode('tree_pine', tileX, tileY);
    expect(tree).not.toBeNull();

    swing(sim, player, 0);

    expect(tree!.health).toBeLessThan(tree!.maxHealth);
    expect(sim.lastEvent('nodeHarvested')?.nodeId).toBe(tree!.id);
    expect(sim.lastEvent('attackSwing')?.hit).toBe(true);
    // Chopping trains woodcutting, not melee: same swing, different skill.
    expect(sim.eventsOf('skillXp').some((event) => event.skill === 'woodcutting')).toBe(true);
  });

  it('refuses to fell a pine bare-handed and says which tool is wanted', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const tree = sim.placeNode('tree_pine', tileX, tileY);

    swing(sim, player, 0);

    expect(tree!.health).toBe(tree!.maxHealth);
    expect(sim.lastEvent('toolIneffective')).toMatchObject({
      playerId: player.id,
      nodeId: tree!.id,
      requiredTool: 'axe',
    });
    expect(sim.lastEvent('attackSwing')?.hit).toBe(false);
  });

  it('fells the tree and hands the logs over', () => {
    const sim = makeSim({ seed: 12345 });
    const player = sim.addPlayer();
    sim.equip(player, 'steel_axe');
    const tileX = pixelToTile(player.x) + 1;
    const tileY = pixelToTile(player.y);
    const tree = sim.placeNode('tree_pine', tileX, tileY);

    swingUntil(sim, player, () => tree!.depleted, 0, 40);

    expect(tree!.depleted).toBe(true);
    expect(sim.lastEvent('nodeDepleted')?.nodeId).toBe(tree!.id);
    const logs =
      player.inventory.slots.filter((slot) => slot?.defId === 'wood_log').length +
      Object.values(sim.sim.state.items).filter((item) => item.stack.defId === 'wood_log').length;
    expect(logs).toBeGreaterThan(0);
  });

  it('lets a custom resolver own the node payout', () => {
    const seen: string[] = [];
    const sim = createTestSimulation({
      systems: [
        createInputSystem(),
        createCombatSystem({
          onNodeHit: (_ctx, _player, node) => {
            seen.push(node.id);
            return true;
          },
        }),
        createProjectileSystem(),
      ],
    });
    bindInputSource(sim.sim);
    const player = sim.addPlayer();
    sim.equip(player, 'iron_axe');
    const tree = sim.placeNode('tree_pine', pixelToTile(player.x) + 1, pixelToTile(player.y));

    swing(sim, player, 0);

    expect(seen).toEqual([tree!.id]);
    // The injected resolver owns the damage too, so nothing touched the node here.
    expect(tree!.health).toBe(tree!.maxHealth);
  });
});

// ---------------------------------------------------------------------------
// Ranged
// ---------------------------------------------------------------------------

describe('firearms', () => {
  it('consumes a round, spawns a projectile and wakes the neighbourhood', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 30);
    reload(sim, player);
    expect(player.equipment.mainHand?.ammo).toBe(15);

    sim.clearEvents();
    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);

    expect(player.equipment.mainHand?.ammo).toBe(14);
    expect(sim.eventsOf('projectileFired')).toHaveLength(1);
    const noise = sim.lastEvent('noise');
    expect(noise).toBeDefined();
    // A gunshot is the game's aggro currency: four chunks wide.
    expect(noise!.radius).toBeGreaterThan(4000);
  });

  it('is far quieter with a bat than with a pistol', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    swing(sim, player, 0);
    const melee = sim.lastEvent('noise');
    expect(melee).toBeDefined();
    expect(melee!.radius).toBeLessThan(400);
  });

  it('fires nothing on an empty chamber and reports it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    expect(player.equipment.mainHand?.ammo).toBe(0);

    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);

    expect(sim.eventsOf('projectileFired')).toHaveLength(0);
    expect(Object.keys(sim.sim.state.projectiles)).toHaveLength(0);
    expect(sim.lastEvent('outOfAmmo')).toMatchObject({
      ownerId: player.id,
      weaponDefId: 'pistol_9mm',
    });
    expect(player.attackReadyTick).toBe(sim.sim.state.tick + DRY_FIRE_TICKS);
    // A dry fire is not an attack: it costs no stamina.
    expect(player.stamina).toBe(player.maxStamina);
  });

  it('throws one round of buckshot as several pellets', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'shotgun');
    sim.giveItem(player, 'ammo_shell', 12);
    reload(sim, player);
    const loaded = player.equipment.mainHand?.ammo ?? 0;
    expect(loaded).toBeGreaterThan(0);

    sim.clearEvents();
    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);

    expect(sim.eventsOf('projectileFired')).toHaveLength(8);
    // Eight pellets, one shell.
    expect(player.equipment.mainHand?.ammo).toBe(loaded - 1);
  });

  it('keeps firing a pistol while the trigger is held', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 30);
    reload(sim, player);

    sim.clearEvents();
    sim.hold(player, { buttons: Button.Primary, aimAngle: 0 }, 30);

    expect(sim.eventsOf('projectileFired').length).toBeGreaterThan(2);
  });

  it('needs a fresh trigger pull for a bolt-action rifle', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'rifle_308');
    sim.giveItem(player, 'ammo_308', 20);
    reload(sim, player);

    sim.clearEvents();
    sim.hold(player, { buttons: Button.Primary, aimAngle: 0 }, 60);

    expect(sim.eventsOf('projectileFired')).toHaveLength(1);
  });

  it('narrows the spread as the ranged skill grows', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const rifle = sim.data.items.require('rifle_308').weapon!;
    const novice = spreadRadians(player, rifle);
    player.skills.ranged.level = 10;
    const expert = spreadRadians(player, rifle);

    expect(novice).toBeGreaterThan(0);
    expect(expert).toBeLessThan(novice);
    // Ten levels is worth roughly a factor of four.
    expect(expert).toBeLessThan(novice * 0.5);
  });

  it('steadies the shot when crouched and ruins it at a sprint', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const rifle = sim.data.items.require('rifle_308').weapon!;
    player.moveMode = 'walk';
    const standing = spreadRadians(player, rifle);
    player.moveMode = 'crouch';
    const crouched = spreadRadians(player, rifle);
    player.moveMode = 'run';
    const running = spreadRadians(player, rifle);

    expect(crouched).toBeLessThan(standing);
    expect(running).toBeGreaterThan(standing);
  });

  it('has no spread at all for a weapon that does not define one', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    expect(spreadRadians(player, sim.data.items.require('iron_sword').weapon!)).toBe(0);
  });

  it('widens the spread when the shooting arm is wrecked', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const rifle = sim.data.items.require('rifle_308').weapon!;
    const healthy = spreadRadians(player, rifle);
    player.body.parts.leftArm.health = 0;
    player.body.parts.rightArm.health = 0;
    expect(spreadRadians(player, rifle)).toBeGreaterThan(healthy);
  });
});

// ---------------------------------------------------------------------------
// Thrown
// ---------------------------------------------------------------------------

describe('thrown weapons', () => {
  it('consumes the item and empties the hand', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'throwing_rock');

    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);

    expect(sim.eventsOf('projectileFired')).toHaveLength(1);
    expect(player.equipment.mainHand).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reloading
// ---------------------------------------------------------------------------

describe('reloading', () => {
  it('moves rounds from the pack into the weapon after the reload time', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 40);

    sim.command(player, { type: 'reload' });
    sim.input(player, { buttons: 0 });
    sim.step(1);
    // Nothing moves until the reload finishes: an interrupted reload must not
    // duplicate rounds.
    expect(player.equipment.mainHand?.ammo).toBe(0);

    for (let i = 0; i < 200 && !sim.lastEvent('reloaded'); i++) {
      sim.input(player, { buttons: 0 });
      sim.step(1);
    }

    expect(sim.lastEvent('reloaded')).toMatchObject({
      ownerId: player.id,
      weaponDefId: 'pistol_9mm',
      rounds: 15,
    });
    expect(player.equipment.mainHand?.ammo).toBe(15);
    expect(player.equipment.mainHand?.ammoDefId).toBe('ammo_9mm');
    let carried = 0;
    for (const slot of player.inventory.slots) {
      if (slot?.defId === 'ammo_9mm') carried += slot.count;
    }
    expect(carried).toBe(25);
  });

  it('takes time: the weapon cannot fire mid-reload', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 40);
    reload(sim, player);
    // Empty the magazine down to one round so the second reload is legal.
    player.equipment.mainHand!.ammo = 1;

    sim.command(player, { type: 'reload' });
    sim.input(player, { buttons: 0 });
    sim.step(1);
    sim.clearEvents();

    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);
    expect(sim.eventsOf('projectileFired')).toHaveLength(0);
  });

  it('reloads from the Reload button as well as the command', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'hunting_bow');
    sim.giveItem(player, 'arrow_wooden', 10);

    sim.input(player, { buttons: Button.Reload });
    sim.step(1);
    for (let i = 0; i < 100 && !sim.lastEvent('reloaded'); i++) {
      sim.input(player, { buttons: 0 });
      sim.step(1);
    }

    expect(sim.lastEvent('reloaded')?.weaponDefId).toBe('hunting_bow');
    expect(player.equipment.mainHand?.ammo).toBe(1);
  });

  it('starts one reload however long the button is held', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 60);

    sim.hold(player, { buttons: Button.Reload }, 200);

    expect(sim.eventsOf('reloaded')).toHaveLength(1);
    expect(player.equipment.mainHand?.ammo).toBe(15);
  });

  it('rejects a reload with nothing reloadable in hand', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');

    sim.run(player, { type: 'reload' });

    expect(sim.lastEvent('commandRejected')).toMatchObject({
      playerId: player.id,
      command: 'reload',
    });
  });

  it('rejects ammunition the weapon does not take', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_308', 10);

    sim.run(player, { type: 'reload', ammoDefId: 'ammo_308' });

    expect(sim.lastEvent('commandRejected')?.reason).toContain('wrong ammunition');
    expect(player.equipment.mainHand?.ammo).toBe(0);
  });

  it('rejects a reload with no rounds in the pack, and reports it as out of ammo', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');

    sim.run(player, { type: 'reload' });

    expect(sim.lastEvent('outOfAmmo')?.weaponDefId).toBe('pistol_9mm');
    expect(sim.lastEvent('commandRejected')?.reason).toContain('no ammunition');
  });

  it('rejects a reload on a full magazine', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 40);
    reload(sim, player);
    sim.clearEvents();

    sim.run(player, { type: 'reload' });

    expect(sim.lastEvent('commandRejected')?.reason).toContain('magazine full');
  });

  it('rejects a second reload while one is already running', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 40);

    sim.run(player, { type: 'reload' });
    sim.clearEvents();
    sim.run(player, { type: 'reload' });

    expect(sim.lastEvent('commandRejected')?.reason).toContain('already reloading');
  });

  it('rejects a reload from a corpse', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 40);
    player.alive = false;

    sim.run(player, { type: 'reload' });

    expect(sim.lastEvent('commandRejected')?.reason).toBe('dead');
  });

  it('returns the wrong rounds to the pack before loading new ones', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const bow = sim.equip(player, 'hunting_bow');
    bow.ammo = 1;
    bow.ammoDefId = 'arrow_wooden';
    sim.giveItem(player, 'arrow_iron', 5);

    sim.command(player, { type: 'reload', ammoDefId: 'arrow_iron' });
    for (let i = 0; i < 100 && !sim.lastEvent('reloaded'); i++) {
      sim.input(player, { buttons: 0 });
      sim.step(1);
    }

    expect(player.equipment.mainHand?.ammoDefId).toBe('arrow_iron');
    const wooden = player.inventory.slots.find((slot) => slot?.defId === 'arrow_wooden');
    expect(wooden?.count).toBe(1);
  });

  it('loses the attempt when the weapon is swapped mid-reload', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'pistol_9mm');
    sim.giveItem(player, 'ammo_9mm', 40);

    sim.run(player, { type: 'reload' });
    const rifle = sim.equip(player, 'rifle_308');

    for (let i = 0; i < 120; i++) {
      sim.input(player, { buttons: 0 });
      sim.step(1);
    }

    expect(sim.eventsOf('reloaded')).toHaveLength(0);
    expect(rifle.ammo).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical state from identical seed and inputs', () => {
    const run = () => {
      const sim = makeSim({ seed: 20260824 });
      const player = sim.addPlayer({ id: 'p1' });
      sim.equip(player, 'iron_sword');
      sim.giveItem(player, 'ammo_9mm', 20);
      sim.spawnZombie('walker', player.x + 40, player.y);
      sim.spawnZombie('walker', player.x + 34, player.y + 22);
      sim.spawnAnimal('deer', player.x + 44, player.y - 20);

      for (let i = 0; i < 6; i++) {
        player.stamina = player.maxStamina;
        swing(sim, player, 0);
        waitForReady(sim, player, 0);
      }

      return {
        zombies: Object.keys(sim.sim.state.zombies)
          .sort()
          .map((id) => {
            const zombie = sim.sim.state.zombies[id]!;
            return { id, health: zombie.health, ai: zombie.ai, vx: zombie.vx };
          }),
        animals: Object.keys(sim.sim.state.animals)
          .sort()
          .map((id) => ({ id, health: sim.sim.state.animals[id]!.health })),
        items: Object.values(sim.sim.state.items)
          .map((item) => `${item.stack.defId}x${item.stack.count}`)
          .sort(),
        durability: player.equipment.mainHand?.durability ?? 0,
        stamina: player.stamina,
        xp: player.skills.melee.xp,
        tick: sim.sim.state.tick,
      };
    };
    expect(run()).toEqual(run());
  });

  it('picks the same single target from a tie on every run', () => {
    const run = () => {
      const sim = makeSim({ seed: 5150 });
      const player = sim.addPlayer();
      sim.equip(player, 'wooden_club');
      // Two walkers at exactly the same range: only the id can break the tie.
      const a = sim.spawnZombie('walker', player.x + 30, player.y - 8);
      const b = sim.spawnZombie('walker', player.x + 30, player.y + 8);
      swing(sim, player, 0);
      return { a: a.health, b: b.health };
    };
    const first = run();
    expect(run()).toEqual(first);
    // Exactly one of them was hit.
    expect([first.a, first.b].filter((health) => health < 90)).toHaveLength(1);
  });

  it('holds a fixed cadence independent of real time', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    sim.equip(player, 'baseball_bat');
    // The tick the swing will resolve on. Measured rather than assumed: a fresh world
    // starts at `WORLD_START_TICK`, so only the *interval* is a fixed number.
    const swingTick = sim.sim.state.tick + 1;

    swing(sim, player, 0);

    // 0.85 s at 20 Hz, and not one tick more however many ticks have gone before.
    expect(player.attackReadyTick - swingTick).toBe(Math.round(SIM_HZ * 0.85));
  });
});
