import { describe, expect, it } from 'vitest';
import { Button, SIM_DT, type InputFrame } from '@survive/protocol';
import {
  CROUCH_SPEED,
  PLAYER_RADIUS,
  RUN_SPEED,
  SPRINT_STAMINA_FLOOR,
  WALK_SPEED,
  baseSpeedFor,
  conditionSpeedMultiplier,
  intentFromFrame,
  resolveMoveMode,
  stepMovement,
  stepPlayerMovement,
} from './movement';
import { createStack } from './items';
import { createPlayerState } from './player';
import { createTestContext } from './testing';

function frame(partial: Partial<InputFrame> = {}): InputFrame {
  return { seq: 1, moveX: 0, moveY: 0, aimAngle: 0, buttons: 0, ...partial };
}

function setup(seed = 1) {
  const harness = createTestContext({ seed });
  const player = createPlayerState(harness.ctx.data, harness.config, {
    id: 'p1',
    name: 'Runner',
    x: 500,
    y: 500,
    withoutKit: true,
  });
  harness.state.players[player.id] = player;
  return { ...harness, player };
}

describe('intent decoding', () => {
  it('clamps analogue input into range', () => {
    const intent = intentFromFrame(frame({ moveX: 5, moveY: -9 }));
    expect(intent.moveX).toBe(1);
    expect(intent.moveY).toBe(-1);
  });

  it('reads sprint and crouch from the button mask', () => {
    const intent = intentFromFrame(frame({ buttons: Button.Sprint | Button.Crouch }));
    expect(intent.sprint).toBe(true);
    expect(intent.crouch).toBe(true);
  });

  it('lets crouch win over sprint', () => {
    expect(resolveMoveMode({ moveX: 1, moveY: 0, sprint: true, crouch: true }, true)).toBe(
      'crouch',
    );
    expect(resolveMoveMode({ moveX: 1, moveY: 0, sprint: true, crouch: false }, true)).toBe('run');
    expect(resolveMoveMode({ moveX: 1, moveY: 0, sprint: true, crouch: false }, false)).toBe(
      'walk',
    );
  });

  it('orders the base speeds sensibly', () => {
    expect(baseSpeedFor('crouch')).toBe(CROUCH_SPEED);
    expect(baseSpeedFor('walk')).toBe(WALK_SPEED);
    expect(baseSpeedFor('run')).toBe(RUN_SPEED);
    expect(CROUCH_SPEED).toBeLessThan(WALK_SPEED);
    expect(WALK_SPEED).toBeLessThan(RUN_SPEED);
  });
});

describe('stepMovement', () => {
  it('moves at the requested speed', () => {
    const harness = setup();
    const body = { x: 500, y: 500, vx: 0, vy: 0, facing: 0 };
    const result = stepMovement(
      harness.world,
      body,
      { moveX: 1, moveY: 0, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    expect(body.x).toBeCloseTo(500 + 100 * SIM_DT, 6);
    expect(result.travelled).toBeCloseTo(100 * SIM_DT, 6);
  });

  it('normalises diagonals so they are not faster than cardinals', () => {
    const harness = setup();
    const straight = { x: 0, y: 0, vx: 0, vy: 0, facing: 0 };
    const diagonal = { x: 0, y: 0, vx: 0, vy: 0, facing: 0 };
    const a = stepMovement(
      harness.world,
      straight,
      { moveX: 1, moveY: 0, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    const b = stepMovement(
      harness.world,
      diagonal,
      { moveX: 1, moveY: 1, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    expect(b.travelled).toBeCloseTo(a.travelled, 6);
  });

  it('faces the direction of travel and holds facing when idle', () => {
    const harness = setup();
    const body = { x: 500, y: 500, vx: 0, vy: 0, facing: 0 };
    stepMovement(
      harness.world,
      body,
      { moveX: 0, moveY: 1, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    expect(body.facing).toBeCloseTo(Math.PI / 2, 6);
    stepMovement(
      harness.world,
      body,
      { moveX: 0, moveY: 0, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    expect(body.facing).toBeCloseTo(Math.PI / 2, 6);
  });

  it('slides along a wall instead of sticking to it', () => {
    const harness = setup();
    // Wall column immediately to the east of the player.
    for (let tileY = 10; tileY < 20; tileY++) harness.world.setSolid(17, tileY, true);
    // Stand just clear of the wall so a 10px step would overlap it.
    const body = { x: 17 * 32 - PLAYER_RADIUS - 2, y: 15 * 32 + 16, vx: 0, vy: 0, facing: 0 };
    const startY = body.y;
    const result = stepMovement(
      harness.world,
      body,
      { moveX: 1, moveY: 1, sprint: false, crouch: false },
      200,
      SIM_DT,
    );
    expect(result.blockedX).toBe(true);
    expect(result.blockedY).toBe(false);
    expect(body.y).toBeGreaterThan(startY);
  });

  it('applies knockback impulses and decays them', () => {
    const harness = setup();
    const body = { x: 500, y: 500, vx: 400, vy: 0, facing: 0 };
    stepMovement(
      harness.world,
      body,
      { moveX: 0, moveY: 0, sprint: false, crouch: false },
      0,
      SIM_DT,
    );
    expect(body.x).toBeGreaterThan(500);
    expect(body.vx).toBeLessThan(400);
    expect(body.vx).toBeGreaterThan(0);

    for (let i = 0; i < 100; i++) {
      stepMovement(
        harness.world,
        body,
        { moveX: 0, moveY: 0, sprint: false, crouch: false },
        0,
        SIM_DT,
      );
    }
    expect(body.vx).toBe(0);
  });

  it('lets a wall absorb the impulse rather than pushing forever', () => {
    const harness = setup();
    for (let tileY = 10; tileY < 20; tileY++) harness.world.setSolid(17, tileY, true);
    const body = { x: 17 * 32 - PLAYER_RADIUS - 2, y: 15 * 32 + 16, vx: 900, vy: 0, facing: 0 };
    stepMovement(
      harness.world,
      body,
      { moveX: 0, moveY: 0, sprint: false, crouch: false },
      0,
      SIM_DT,
    );
    expect(body.vx).toBe(0);
  });

  it('scales with terrain speed', () => {
    const harness = setup();
    // Shallow water is slow going.
    harness.world.setTile(16, 15, 8);
    const onGrass = { x: 500, y: 500, vx: 0, vy: 0, facing: 0 };
    const inWater = { x: 16 * 32 + 16, y: 15 * 32 + 16, vx: 0, vy: 0, facing: 0 };
    const dry = stepMovement(
      harness.world,
      onGrass,
      { moveX: 1, moveY: 0, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    const wet = stepMovement(
      harness.world,
      inWater,
      { moveX: 1, moveY: 0, sprint: false, crouch: false },
      100,
      SIM_DT,
    );
    expect(wet.speed).toBeLessThan(dry.speed);
  });

  it('respects a custom collision radius', () => {
    const harness = setup();
    for (let tileY = 10; tileY < 20; tileY++) harness.world.setSolid(17, tileY, true);
    const small = { x: 16 * 32 + 20, y: 15 * 32 + 16, vx: 0, vy: 0, facing: 0 };
    const big = { x: 16 * 32 + 20, y: 15 * 32 + 16, vx: 0, vy: 0, facing: 0 };
    const smallResult = stepMovement(
      harness.world,
      small,
      { moveX: 1, moveY: 0, sprint: false, crouch: false },
      50,
      SIM_DT,
      2,
    );
    const bigResult = stepMovement(
      harness.world,
      big,
      { moveX: 1, moveY: 0, sprint: false, crouch: false },
      50,
      SIM_DT,
      PLAYER_RADIUS,
    );
    expect(smallResult.blockedX).toBe(false);
    expect(bigResult.blockedX).toBe(true);
  });
});

describe('conditionSpeedMultiplier', () => {
  it('is 1 for a healthy, unencumbered player', () => {
    const { ctx, player } = setup();
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeCloseTo(1, 6);
  });

  it('slows a player with a broken leg', () => {
    const { ctx, player } = setup();
    player.body.parts.leftLeg.health = 0;
    player.body.parts.leftLeg.fractured = true;
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeLessThan(0.8);
  });

  it('slows a player in pain', () => {
    const { ctx, player } = setup();
    const before = conditionSpeedMultiplier(player, ctx.data);
    for (const id of ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as const) {
      player.body.parts[id].pain = 100;
    }
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeLessThan(before);
  });

  it('ignores mild hunger but bites when starving', () => {
    const { ctx, player } = setup();
    player.hunger = 50;
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeCloseTo(1, 6);
    player.hunger = 100;
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeLessThan(0.85);
  });

  it('applies armour encumbrance', () => {
    const { ctx, player } = setup();
    player.equipment.chest = createStack(ctx.data, 'vest');
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeLessThan(1);
  });

  it('penalises going over carry capacity', () => {
    const { ctx, player } = setup();
    player.carryCapacity = 10;
    player.carryWeight = 20;
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeLessThan(0.8);
  });

  it('never drops to a standstill', () => {
    const { ctx, player } = setup();
    player.hunger = 100;
    player.thirst = 100;
    player.fatigue = 100;
    player.carryCapacity = 1;
    player.carryWeight = 100;
    for (const id of ['leftLeg', 'rightLeg'] as const) {
      player.body.parts[id].health = 0;
      player.body.parts[id].fractured = true;
    }
    expect(conditionSpeedMultiplier(player, ctx.data)).toBeGreaterThanOrEqual(0.15);
  });
});

describe('stepPlayerMovement', () => {
  it('records the aim angle from the frame', () => {
    const { ctx, player, world } = setup();
    stepPlayerMovement(world, player, frame({ aimAngle: 1.25 }), ctx.data, SIM_DT);
    expect(player.aimAngle).toBeCloseTo(1.25, 6);
  });

  it('drains stamina while sprinting and regenerates it when not', () => {
    const { ctx, player, world } = setup();
    const sprint = frame({ moveX: 1, buttons: Button.Sprint });
    for (let i = 0; i < 20; i++) stepPlayerMovement(world, player, sprint, ctx.data, SIM_DT);
    expect(player.moveMode).toBe('run');
    const drained = player.stamina;
    expect(drained).toBeLessThan(player.maxStamina);

    for (let i = 0; i < 20; i++) {
      stepPlayerMovement(world, player, frame({ moveX: 1 }), ctx.data, SIM_DT);
    }
    expect(player.stamina).toBeGreaterThan(drained);
  });

  it('refuses to sprint below the stamina floor', () => {
    const { ctx, player, world } = setup();
    player.stamina = SPRINT_STAMINA_FLOOR - 1;
    stepPlayerMovement(
      world,
      player,
      frame({ moveX: 1, buttons: Button.Sprint }),
      ctx.data,
      SIM_DT,
    );
    expect(player.moveMode).toBe('walk');
  });

  it('does not sprint on the spot', () => {
    const { ctx, player, world } = setup();
    const before = player.stamina;
    stepPlayerMovement(world, player, frame({ buttons: Button.Sprint }), ctx.data, SIM_DT);
    expect(player.moveMode).toBe('walk');
    expect(player.stamina).toBeGreaterThanOrEqual(before);
  });

  it('is deterministic: identical inputs give bit-identical positions', () => {
    const a = setup(42);
    const b = setup(42);
    const frames = Array.from({ length: 60 }, (_, i) =>
      frame({
        seq: i,
        moveX: Math.sin(i / 7),
        moveY: Math.cos(i / 5),
        buttons: i % 3 === 0 ? Button.Sprint : 0,
      }),
    );
    for (const f of frames) {
      stepPlayerMovement(a.world, a.player, f, a.ctx.data, SIM_DT);
      stepPlayerMovement(b.world, b.player, f, b.ctx.data, SIM_DT);
    }
    expect(a.player.x).toBe(b.player.x);
    expect(a.player.y).toBe(b.player.y);
    expect(a.player.stamina).toBe(b.player.stamina);
  });

  it('replaying from the same start state reproduces the same result, which is what makes prediction reconcile', () => {
    const server = setup(9);
    const client = setup(9);
    const inputs = Array.from({ length: 30 }, (_, i) =>
      frame({ seq: i, moveX: 1, moveY: i % 2 === 0 ? 1 : -1 }),
    );
    for (const f of inputs)
      stepPlayerMovement(client.world, client.player, f, client.ctx.data, SIM_DT);
    for (const f of inputs)
      stepPlayerMovement(server.world, server.player, f, server.ctx.data, SIM_DT);
    expect(client.player.x).toBe(server.player.x);
    expect(client.player.y).toBe(server.player.y);
  });
});
