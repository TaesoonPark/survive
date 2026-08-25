import { describe, expect, it } from 'vitest';
import {
  BODY_PART_IDS,
  createBody,
  type AnimalState,
  type SimEvent,
  type ZombieState,
} from '@survive/protocol';
import {
  applyDamage,
  armorAt,
  damageAnimal,
  damagePlayer,
  damageStructure,
  damageZombie,
  isInternal,
  isPhysical,
  rollBodyPart,
  syncHealthFromBody,
} from './damage';
import { killEntity, killPlayer, killZombie } from './death';
import { createStack } from './items';
import { createPlayerState } from './player';
import { spawnStructure } from './structures';
import { createTestContext } from './testing';

function setup(seed = 7) {
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

function spawnZombie(
  harness: ReturnType<typeof setup>,
  defId = 'walker',
  x = 520,
  y = 500,
): ZombieState {
  const def = harness.ctx.data.zombies.require(defId);
  const zombie: ZombieState = {
    id: harness.ctx.ids.zombie(),
    defId,
    x,
    y,
    vx: 0,
    vy: 0,
    facing: 0,
    health: def.maxHealth,
    maxHealth: def.maxHealth,
    ai: 'idle',
    lod: 0,
    nextThinkTick: 0,
    loseInterestTick: 0,
    attackReadyTick: 0,
    staggerUntilTick: 0,
    homeChunk: '0,0',
    homeX: x,
    homeY: y,
    body: createBody(def.bodyScale),
    crawling: false,
    path: [],
    pathIndex: 0,
    pathTick: 0,
    rev: 1,
  };
  harness.state.zombies[zombie.id] = zombie;
  return zombie;
}

describe('damage classification', () => {
  it('separates armour-stoppable damage from internal damage', () => {
    expect(isPhysical('slash')).toBe(true);
    expect(isPhysical('bullet')).toBe(true);
    expect(isPhysical('starvation')).toBe(false);
    expect(isInternal('bleed')).toBe(true);
    expect(isInternal('infection')).toBe(true);
    expect(isInternal('slash')).toBe(false);
  });
});

describe('rollBodyPart', () => {
  it('is deterministic for the same tick and label', () => {
    const a = setup(99);
    const b = setup(99);
    expect(rollBodyPart(a.ctx, 'x')).toBe(rollBodyPart(b.ctx, 'x'));
  });

  it('covers every part over many rolls, with the torso most common', () => {
    const harness = setup(5);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      harness.advance();
      const part = rollBodyPart(harness.ctx, 'spread');
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
    for (const id of BODY_PART_IDS) expect(counts.get(id) ?? 0).toBeGreaterThan(0);
    const torso = counts.get('torso') ?? 0;
    for (const id of BODY_PART_IDS) {
      if (id === 'torso') continue;
      expect(torso).toBeGreaterThan(counts.get(id) ?? 0);
    }
  });
});

describe('damagePlayer', () => {
  it('applies damage to the named body part and lowers aggregate health', () => {
    const { ctx, player } = setup();
    const result = damagePlayer(ctx, player, {
      amount: 20,
      type: 'slash',
      bodyPart: 'leftArm',
      bleedFactor: 0,
    });
    expect(result.applied).toBeGreaterThan(0);
    expect(result.bodyPart).toBe('leftArm');
    expect(player.body.parts.leftArm.health).toBeLessThan(player.body.parts.leftArm.maxHealth);
    expect(player.body.parts.torso.health).toBe(player.body.parts.torso.maxHealth);
    expect(player.health).toBeLessThan(player.maxHealth);
  });

  it('multiplies damage by the body-part multiplier, so headshots hurt more', () => {
    const head = setup();
    const torso = setup();
    damagePlayer(head.ctx, head.player, {
      amount: 10,
      type: 'bullet',
      bodyPart: 'head',
      bleedFactor: 0,
    });
    damagePlayer(torso.ctx, torso.player, {
      amount: 10,
      type: 'bullet',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    const headLost = head.player.body.parts.head.maxHealth - head.player.body.parts.head.health;
    const torsoLost =
      torso.player.body.parts.torso.maxHealth - torso.player.body.parts.torso.health;
    expect(headLost).toBeGreaterThan(torsoLost);
  });

  it('cannot take a body part below zero', () => {
    const { ctx, player } = setup();
    const result = damagePlayer(ctx, player, {
      amount: 10_000,
      type: 'explosive',
      bodyPart: 'leftLeg',
    });
    expect(player.body.parts.leftLeg.health).toBe(0);
    expect(result.applied).toBeLessThanOrEqual(player.body.parts.leftLeg.maxHealth);
  });

  it('reports a fatal hit when the torso is destroyed', () => {
    const { ctx, player } = setup();
    const result = damagePlayer(ctx, player, {
      amount: 10_000,
      type: 'explosive',
      bodyPart: 'torso',
    });
    expect(result.killed).toBe(true);
    // The pipeline reports it; the death handler is what actually kills.
    expect(player.alive).toBe(true);
  });

  it('lets armour absorb damage and wears it in the process', () => {
    const bare = setup();
    const armoured = setup();
    armoured.player.equipment.chest = createStack(armoured.ctx.data, 'vest');
    const before = armoured.player.equipment.chest.durability;

    damagePlayer(bare.ctx, bare.player, {
      amount: 20,
      type: 'slash',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    const result = damagePlayer(armoured.ctx, armoured.player, {
      amount: 20,
      type: 'slash',
      bodyPart: 'torso',
      bleedFactor: 0,
    });

    expect(result.blocked).toBeGreaterThan(0);
    expect(armoured.player.body.parts.torso.health).toBeGreaterThan(
      bare.player.body.parts.torso.health,
    );
    expect(armoured.player.equipment.chest!.durability!).toBeLessThan(before!);
  });

  it('does not apply armour to a part it does not cover', () => {
    const { ctx, player } = setup();
    player.equipment.chest = createStack(ctx.data, 'vest');
    expect(armorAt(ctx, player.equipment, 'torso', 'slash')).toBeGreaterThan(0);
    expect(armorAt(ctx, player.equipment, 'head', 'slash')).toBe(0);
  });

  it('lets armour penetration cut through protection', () => {
    const blunt = setup();
    const piercing = setup();
    blunt.player.equipment.chest = createStack(blunt.ctx.data, 'vest');
    piercing.player.equipment.chest = createStack(piercing.ctx.data, 'vest');

    const noPen = damagePlayer(blunt.ctx, blunt.player, {
      amount: 20,
      type: 'slash',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    const withPen = damagePlayer(piercing.ctx, piercing.player, {
      amount: 20,
      type: 'slash',
      bodyPart: 'torso',
      armorPen: 1,
      bleedFactor: 0,
    });
    expect(withPen.blocked).toBe(0);
    expect(withPen.applied).toBeGreaterThan(noPen.applied);
  });

  it('never lets armour block everything', () => {
    const { ctx, player } = setup();
    player.equipment.chest = createStack(ctx.data, 'vest');
    const result = damagePlayer(ctx, player, {
      amount: 1,
      type: 'zombieBite',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    expect(result.applied).toBeGreaterThan(0);
  });

  it('ignores armour for internal damage such as starvation', () => {
    const { ctx, player } = setup();
    player.equipment.chest = createStack(ctx.data, 'vest');
    const result = damagePlayer(ctx, player, {
      amount: 5,
      type: 'starvation',
      bodyPart: 'torso',
      ignoreArmor: true,
      silent: true,
    });
    expect(result.blocked).toBe(0);
    expect(result.applied).toBeGreaterThan(0);
  });

  it('starts bleeding on a slashing wound and emits the event once', () => {
    const { ctx, player, events } = setup(3);
    let bleedStarts = 0;
    events.subscribe((event: SimEvent) => {
      if (event.type === 'bleedingStarted') bleedStarts++;
    });
    for (let i = 0; i < 6; i++) {
      damagePlayer(ctx, player, {
        amount: 12,
        type: 'slash',
        bodyPart: 'rightLeg',
        bleedFactor: 3,
      });
    }
    expect(player.body.parts.rightLeg.bleeding).toBeGreaterThan(0);
    expect(bleedStarts).toBe(1);
  });

  it('does not bleed from blunt trauma when the factor is zero', () => {
    const { ctx, player } = setup();
    damagePlayer(ctx, player, {
      amount: 20,
      type: 'blunt',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    expect(player.body.parts.torso.bleeding).toBe(0);
  });

  it('fractures limbs under heavy blunt force', () => {
    const { ctx, player } = setup(11);
    let attempts = 0;
    while (!player.body.parts.leftLeg.fractured && attempts < 30) {
      player.body.parts.leftLeg.health = player.body.parts.leftLeg.maxHealth;
      damagePlayer(ctx, player, {
        amount: 30,
        type: 'blunt',
        bodyPart: 'leftLeg',
        fractureChance: 1,
      });
      ctx.clock.advance();
      ctx.state.tick = ctx.clock.tick;
      attempts++;
    }
    expect(player.body.parts.leftLeg.fractured).toBe(true);
  });

  it('marks a bite and can start an infection', () => {
    const { ctx, player } = setup(21);
    let infected = false;
    for (let i = 0; i < 40 && !infected; i++) {
      player.body.parts.rightArm.health = player.body.parts.rightArm.maxHealth;
      damagePlayer(ctx, player, {
        amount: 8,
        type: 'zombieBite',
        bodyPart: 'rightArm',
        bite: true,
        infectionChance: 1,
      });
      infected = player.body.parts.rightArm.infection > 0;
      ctx.clock.advance();
      ctx.state.tick = ctx.clock.tick;
    }
    expect(player.body.parts.rightArm.bitten).toBe(true);
    expect(infected).toBe(true);
  });

  it('applies knockback along the given angle', () => {
    const { ctx, player } = setup();
    damagePlayer(ctx, player, {
      amount: 5,
      type: 'blunt',
      bodyPart: 'torso',
      knockback: 100,
      angle: 0,
      bleedFactor: 0,
    });
    expect(player.vx).toBeCloseTo(100, 3);
    expect(player.vy).toBeCloseTo(0, 6);
  });

  it('scales with the playerDamageTaken tuning knob', () => {
    const normal = setup();
    const brutal = setup();
    brutal.config.tuning.playerDamageTaken = 2;
    const a = damagePlayer(normal.ctx, normal.player, {
      amount: 10,
      type: 'blunt',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    const b = damagePlayer(brutal.ctx, brutal.player, {
      amount: 10,
      type: 'blunt',
      bodyPart: 'torso',
      bleedFactor: 0,
    });
    expect(b.applied).toBeCloseTo(a.applied * 2, 4);
  });

  it('ignores dead players and non-positive amounts', () => {
    const { ctx, player } = setup();
    expect(damagePlayer(ctx, player, { amount: 0, type: 'blunt' }).applied).toBe(0);
    player.alive = false;
    expect(damagePlayer(ctx, player, { amount: 50, type: 'blunt' }).applied).toBe(0);
  });

  it('suppresses the damage event when asked', () => {
    const { ctx, player, events } = setup();
    let seen = 0;
    events.subscribe((event) => {
      if (event.type === 'damage') seen++;
    });
    damagePlayer(ctx, player, { amount: 5, type: 'blunt', bodyPart: 'torso', silent: true });
    expect(seen).toBe(0);
    damagePlayer(ctx, player, { amount: 5, type: 'blunt', bodyPart: 'torso' });
    expect(seen).toBe(1);
  });

  it('bumps the revision so the change reaches clients', () => {
    const { ctx, player } = setup();
    const before = player.rev;
    damagePlayer(ctx, player, { amount: 5, type: 'blunt', bodyPart: 'torso' });
    expect(player.rev).toBeGreaterThan(before);
  });
});

describe('damageZombie', () => {
  it('reduces health and aggros onto the attacker', () => {
    const harness = setup();
    const zombie = spawnZombie(harness);
    damageZombie(harness.ctx, zombie, {
      amount: 15,
      type: 'slash',
      attackerId: 'p1',
      bodyPart: 'torso',
    });
    expect(zombie.health).toBeLessThan(zombie.maxHealth);
    expect(zombie.ai).toBe('pursue');
    expect(zombie.targetId).toBe('p1');
    expect(zombie.lastSeenX).toBe(harness.player.x);
  });

  it('respects per-type armour on armoured zombies', () => {
    const soft = setup();
    const hard = setup();
    const walker = spawnZombie(soft, 'walker');
    const armoured = spawnZombie(hard, 'armored');
    const a = damageZombie(soft.ctx, walker, {
      amount: 20,
      type: 'slash',
      bodyPart: 'torso',
    });
    const b = damageZombie(hard.ctx, armoured, {
      amount: 20,
      type: 'slash',
      bodyPart: 'torso',
    });
    expect(b.blocked).toBeGreaterThan(0);
    expect(a.blocked).toBe(0);
    expect(b.applied).toBeLessThan(a.applied);
  });

  it('turns a zombie into a crawler when both legs are destroyed', () => {
    const harness = setup();
    const zombie = spawnZombie(harness);
    damageZombie(harness.ctx, zombie, { amount: 999, type: 'bullet', bodyPart: 'leftLeg' });
    expect(zombie.crawling).toBe(false);
    damageZombie(harness.ctx, zombie, { amount: 999, type: 'bullet', bodyPart: 'rightLeg' });
    expect(zombie.crawling).toBe(true);
  });

  it('staggers on a solid hit, less so for stagger-resistant types', () => {
    const soft = setup();
    const hard = setup();
    const walker = spawnZombie(soft, 'walker');
    const armoured = spawnZombie(hard, 'armored');
    damageZombie(soft.ctx, walker, { amount: 25, type: 'blunt', bodyPart: 'torso' });
    damageZombie(hard.ctx, armoured, { amount: 25, type: 'blunt', bodyPart: 'torso' });
    expect(walker.staggerUntilTick).toBeGreaterThan(0);
    expect(armoured.staggerUntilTick).toBeLessThan(walker.staggerUntilTick);
  });

  it('scales player damage by the playerDamageDealt knob only for player attackers', () => {
    const normal = setup();
    const strong = setup();
    strong.config.tuning.playerDamageDealt = 3;
    const a = damageZombie(normal.ctx, spawnZombie(normal), {
      amount: 10,
      type: 'slash',
      attackerId: 'p1',
      bodyPart: 'torso',
    });
    const b = damageZombie(strong.ctx, spawnZombie(strong), {
      amount: 10,
      type: 'slash',
      attackerId: 'p1',
      bodyPart: 'torso',
    });
    expect(b.applied).toBeGreaterThan(a.applied * 2.5);

    const env = setup();
    env.config.tuning.playerDamageDealt = 3;
    const c = damageZombie(env.ctx, spawnZombie(env), {
      amount: 10,
      type: 'fire',
      bodyPart: 'torso',
    });
    expect(c.applied).toBeLessThan(b.applied);
  });

  it('ignores dead zombies', () => {
    const harness = setup();
    const zombie = spawnZombie(harness);
    zombie.ai = 'dead';
    expect(damageZombie(harness.ctx, zombie, { amount: 50, type: 'slash' }).applied).toBe(0);
  });
});

describe('damageAnimal', () => {
  it('makes skittish animals flee and aggressive ones fight', () => {
    const harness = setup();
    const rabbit: AnimalState = {
      id: 'a1',
      defId: 'rabbit',
      x: 400,
      y: 400,
      vx: 0,
      vy: 0,
      facing: 0,
      health: 14,
      maxHealth: 14,
      ai: 'graze',
      lod: 0,
      nextThinkTick: 0,
      fleeUntilTick: 0,
      attackReadyTick: 0,
      homeChunk: '0,0',
      homeX: 400,
      homeY: 400,
      wanderX: 400,
      wanderY: 400,
      rev: 1,
    };
    harness.state.animals[rabbit.id] = rabbit;
    damageAnimal(harness.ctx, rabbit, { amount: 3, type: 'blunt', attackerId: 'p1' });
    expect(rabbit.ai).toBe('flee');

    const wolf: AnimalState = { ...rabbit, id: 'a2', defId: 'wolf', health: 45, maxHealth: 45 };
    harness.state.animals[wolf.id] = wolf;
    damageAnimal(harness.ctx, wolf, { amount: 3, type: 'blunt', attackerId: 'p1' });
    expect(wolf.ai).toBe('attack');
    expect(wolf.targetId).toBe('p1');
  });
});

describe('damageStructure', () => {
  it('takes reduced damage from cuts and extra from explosives', () => {
    const slashHarness = setup();
    const boomHarness = setup();
    const a = spawnStructure(slashHarness.ctx, 'test_wall', 10, 10, 0)!;
    const b = spawnStructure(boomHarness.ctx, 'test_wall', 10, 10, 0)!;
    const slash = damageStructure(slashHarness.ctx, a, { amount: 40, type: 'slash' });
    const boom = damageStructure(boomHarness.ctx, b, { amount: 40, type: 'explosive' });
    expect(slash.applied).toBeCloseTo(14, 5);
    expect(boom.applied).toBeCloseTo(80, 5);
  });

  it('multiplies zombie damage by the structure definition', () => {
    const harness = setup();
    const zombie = spawnZombie(harness);
    const door = spawnStructure(harness.ctx, 'test_door', 12, 12, 0)!;
    const result = damageStructure(harness.ctx, door, {
      amount: 10,
      type: 'blunt',
      attackerId: zombie.id,
    });
    expect(result.applied).toBeCloseTo(15, 5);
  });

  it('reports a kill when health reaches zero', () => {
    const harness = setup();
    const wall = spawnStructure(harness.ctx, 'test_wall', 5, 5, 0)!;
    const result = damageStructure(harness.ctx, wall, { amount: 9999, type: 'blunt' });
    expect(result.killed).toBe(true);
    expect(wall.health).toBe(0);
  });
});

describe('applyDamage dispatch', () => {
  it('routes by entity id and returns nothing for unknown ids', () => {
    const harness = setup();
    const zombie = spawnZombie(harness);
    expect(
      applyDamage(harness.ctx, zombie.id, { amount: 5, type: 'slash' }).applied,
    ).toBeGreaterThan(0);
    expect(applyDamage(harness.ctx, 'p1', { amount: 5, type: 'slash' }).applied).toBeGreaterThan(0);
    expect(applyDamage(harness.ctx, 'nope', { amount: 5, type: 'slash' }).applied).toBe(0);
  });
});

describe('syncHealthFromBody', () => {
  it('mirrors the weighted body fraction onto aggregate health', () => {
    const entity = { health: 100, maxHealth: 100, body: createBody() };
    expect(syncHealthFromBody(entity)).toBe(false);
    expect(entity.health).toBe(100);
    entity.body.parts.head.health = 0;
    expect(syncHealthFromBody(entity)).toBe(true);
  });
});

describe('death handling', () => {
  it('kills a zombie once, drops loot and awards XP to the killer', () => {
    const harness = setup(77);
    const zombie = spawnZombie(harness);
    const before = Object.keys(harness.state.items).length;
    killZombie(harness.ctx, zombie, 'slash', 'p1');
    expect(zombie.ai).toBe('dead');
    expect(harness.player.stats.zombieKills).toBe(1);
    expect(Object.keys(harness.state.items).length).toBeGreaterThan(before);

    killZombie(harness.ctx, zombie, 'slash', 'p1');
    expect(harness.player.stats.zombieKills).toBe(1);
  });

  it('drops the player inventory and equipment on death', () => {
    const harness = setup(4);
    const { ctx, player } = harness;
    player.inventory.slots[0] = createStack(ctx.data, 'wood', 10);
    player.equipment.chest = createStack(ctx.data, 'vest');
    killPlayer(ctx, player, 'zombieBite', 'z1');

    expect(player.alive).toBe(false);
    expect(player.deathCause).toBe('zombieBite');
    expect(player.respawnAtTick).toBeGreaterThan(ctx.state.tick);
    expect(player.inventory.slots.every((slot) => slot === null)).toBe(true);
    expect(player.equipment.chest).toBeNull();
    const dropped = Object.values(harness.state.items);
    expect(dropped.some((item) => item.stack.defId === 'wood')).toBe(true);
    expect(dropped.some((item) => item.stack.defId === 'vest')).toBe(true);
  });

  it('can keep the inventory when the server says so', () => {
    const harness = setup();
    harness.player.inventory.slots[0] = createStack(harness.ctx.data, 'wood', 4);
    killPlayer(harness.ctx, harness.player, 'starvation', undefined, false);
    expect(harness.player.inventory.slots[0]).not.toBeNull();
  });

  it('dispatches by id through killEntity', () => {
    const harness = setup();
    const zombie = spawnZombie(harness);
    killEntity(harness.ctx, zombie.id, 'slash', 'p1');
    expect(zombie.ai).toBe('dead');
    killEntity(harness.ctx, 'p1', 'starvation');
    expect(harness.player.alive).toBe(false);
    // Unknown ids are a no-op rather than a throw.
    expect(() => killEntity(harness.ctx, 'ghost', 'slash')).not.toThrow();
  });
});
