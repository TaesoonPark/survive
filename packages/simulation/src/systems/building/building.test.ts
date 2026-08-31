import { describe, expect, it } from 'vitest';
import {
  SIM_HZ,
  TILE_SIZE,
  Tile,
  pixelToTile,
  tileCenter,
  type PlayerState,
  type SimulationConfig,
  type StructureState,
} from '@survive/protocol';
import {
  createGameData,
  STRUCTURE_DEFS,
  type GameData,
  type StructureDef,
} from '@survive/game-data';
import { CollisionFlag } from '@survive/world';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { countItem } from '../../core/items';
import { tileKey } from '../../core/state';
import {
  BUILD_ACTION_TICKS,
  DECAY_INTERVAL_TICKS,
  LIGHT_TICK_INTERVAL,
  REPAIR_COST_FRACTION,
  RUBBLE_RATIO,
  TRAP_SPECS,
  createBuildingSystem,
  lightFuelBudget,
  repairCost,
} from './building';
import {
  BUILD_RANGE,
  STRUCTURE_REACH,
  canPlace,
  scaleCost,
  type PlacementRejection,
} from './placement';

/**
 * Building tests.
 *
 * Two things get hammered hardest here, because they are the two that cost the most
 * when they are wrong:
 *
 * - **Every rejection path is exercised, and each one is asserted to charge nothing.**
 *   `build` is the command players will try to abuse, and a validation gap that eats the
 *   materials anyway is worse than one that lets the wall through.
 * - **`canPlace` is asserted to agree with `build` at every one of those paths.** The
 *   client's placement ghost calls `canPlace`; if the two ever disagreed the symptom
 *   would be a green ghost that refuses to build, so the agreement is a test, not a
 *   comment.
 */

const SEED = 987654;

interface Fixture {
  sim: TestSimulation;
  player: PlayerState;
  /** Tile the player is standing on. */
  tx: number;
  ty: number;
}

function fixture(
  options: { config?: (config: SimulationConfig) => void; data?: GameData } = {},
): Fixture {
  const sim = createTestSimulation({
    seed: SEED,
    systems: [createBuildingSystem()],
    ...(options.config ? { config: options.config } : {}),
    ...(options.data ? { data: options.data } : {}),
  });
  const player = sim.addPlayer();
  return { sim, player, tx: pixelToTile(player.x), ty: pixelToTile(player.y) };
}

/** Put exactly one structure's build cost into a player's pack. */
function stock(sim: TestSimulation, player: PlayerState, defId: string): void {
  for (const entry of sim.data.structures.require(defId).cost) {
    sim.giveItem(player, entry.defId, entry.count);
  }
}

/** Total item count across the pack, so "charged nothing" can be asserted in one line. */
function carried(player: PlayerState): number {
  return player.inventory.slots.reduce((total, slot) => total + (slot?.count ?? 0), 0);
}

function structuresAt(
  sim: TestSimulation,
  tileX: number,
  tileY: number,
): StructureState | undefined {
  const id = sim.sim.state.structureTiles[tileKey(tileX, tileY)];
  return id ? sim.sim.state.structures[id] : undefined;
}

function structureCount(sim: TestSimulation): number {
  return Object.keys(sim.sim.state.structures).length;
}

/**
 * Build, expect a specific refusal, and expect nothing at all to have happened - and
 * expect `canPlace` to have named the same reason.
 */
function expectRejected(
  fx: Fixture,
  defId: string,
  tileX: number,
  tileY: number,
  reason: PlacementRejection,
  rotation = 0,
): void {
  const { sim, player } = fx;
  const before = { items: carried(player), structures: structureCount(sim) };
  const preview = canPlace(sim.ctx, player, defId, tileX, tileY, rotation);
  sim.clearEvents();
  sim.run(player, { type: 'build', defId, tileX, tileY, rotation });

  expect(sim.lastEvent('buildRejected')?.reason).toBe(reason);
  expect(preview.ok).toBe(false);
  expect(preview.reason).toBe(reason);
  expect(carried(player)).toBe(before.items);
  expect(structureCount(sim)).toBe(before.structures);
  expect(sim.lastEvent('structurePlaced')).toBeUndefined();
}

// ---------------------------------------------------------------------------
// build: the happy path
// ---------------------------------------------------------------------------

describe('build', () => {
  it('charges the materials, creates a blueprint and finishes it over buildTicks', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood_frame');
    stock(sim, player, def.id);
    expect(canPlace(sim.ctx, player, def.id, tx + 2, ty, 0).ok).toBe(true);

    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });

    const placed = sim.lastEvent('structurePlaced');
    expect(placed?.defId).toBe(def.id);
    expect(placed?.tileX).toBe(tx + 2);
    expect(placed?.builderId).toBe(player.id);

    const structure = structuresAt(sim, tx + 2, ty);
    expect(structure).toBeDefined();
    expect(structure?.ownerId).toBe(player.id);
    expect(structure?.progress).toBeLessThan(1);
    expect(structure?.health).toBeLessThan(def.maxHealth);
    // Both cost lines are gone, and nothing else was taken.
    expect(countItem(player.inventory, 'stick')).toBe(0);
    expect(countItem(player.inventory, 'plant_fiber')).toBe(0);

    sim.step(def.buildTicks);
    expect(structure?.progress).toBe(1);
    expect(structure?.health).toBe(def.maxHealth);
    expect(player.stats.structuresBuilt).toBe(1);
    expect(sim.eventsOf('skillXp').some((event) => event.skill === 'building')).toBe(true);
  });

  it('leaves a blueprint alone while no builder is near it, and resumes when one returns', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood_frame');
    stock(sim, player, def.id);
    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });
    const structure = structuresAt(sim, tx + 2, ty);
    const progressWithBuilder = structure?.progress ?? 0;
    expect(progressWithBuilder).toBeGreaterThan(0);

    // Walk off. Nothing should move while the site is unattended.
    const homeX = player.x;
    player.x += TILE_SIZE * 40;
    sim.step(def.buildTicks);
    expect(structure?.progress).toBe(progressWithBuilder);

    player.x = homeX;
    sim.step(def.buildTicks);
    expect(structure?.progress).toBe(1);
  });

  it('holds the builder in place while the frame goes up, and lets go when it is done', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood_frame');
    stock(sim, player, def.id);
    // Free before: this is a lock the building puts on, not one the fixture arrived with.
    expect(player.actionLockedUntilTick).toBeLessThanOrEqual(sim.ctx.state.tick);

    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });
    const structure = structuresAt(sim, tx + 2, ty);
    expect(structure?.progress).toBeGreaterThan(0);
    expect(structure?.progress).toBeLessThan(1);

    // Held while the work is going on. Raising a frame used to be something that happened
    // *near* you - the bar filled while you walked off, which read as the world building
    // itself.
    expect(player.actionLockedUntilTick).toBeGreaterThan(sim.ctx.state.tick);
    // And held on the next tick too: a one-tick margin would free the player on every
    // other step, which is a stutter rather than a stop.
    sim.step(1);
    expect(player.actionLockedUntilTick).toBeGreaterThan(sim.ctx.state.tick);

    sim.step(def.buildTicks);
    expect(structure?.progress).toBe(1);
    // Let go once it is finished - and within the two ticks the lock is armed for, so a
    // player is never left standing still by a frame that is no longer being built.
    sim.step(2);
    expect(player.actionLockedUntilTick).toBeLessThanOrEqual(sim.ctx.state.tick);
  });

  it('does not hold a player standing away from the site', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood_frame');
    stock(sim, player, def.id);
    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });

    // Out of range: the frame stops advancing, so nothing is holding anyone.
    player.x += TILE_SIZE * 40;
    sim.step(3);
    expect(player.actionLockedUntilTick).toBeLessThanOrEqual(sim.ctx.state.tick);
  });

  it('scales construction speed with the craftSpeed tuning knob', () => {
    const build = (craftSpeed: number): number => {
      const fx = fixture({
        config: (config) => {
          config.tuning.craftSpeed = craftSpeed;
        },
      });
      const { sim, player, tx, ty } = fx;
      stock(sim, player, 'wall_wood_frame');
      sim.run(player, {
        type: 'build',
        defId: 'wall_wood_frame',
        tileX: tx + 2,
        tileY: ty,
        rotation: 0,
      });
      return structuresAt(sim, tx + 2, ty)?.progress ?? 0;
    };
    expect(build(4)).toBeCloseTo(build(1) * 4, 8);
  });

  it('lets a wall stack on a floor but not a floor on a wall', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'floor_wood');
    stock(sim, player, 'wall_wood_frame');

    sim.run(player, { type: 'build', defId: 'floor_wood', tileX: tx + 2, tileY: ty, rotation: 0 });
    const floor = structuresAt(sim, tx + 2, ty);
    expect(floor?.defId).toBe('floor_wood');

    sim.step(BUILD_ACTION_TICKS);
    expect(canPlace(sim.ctx, player, 'wall_wood_frame', tx + 2, ty, 0).ok).toBe(true);
    sim.run(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    // The wall takes over the tile index; the floor is still there underneath it.
    expect(structuresAt(sim, tx + 2, ty)?.defId).toBe('wall_wood_frame');
    expect(structureCount(sim)).toBe(2);

    // The reverse is not allowed: `floor_wood` only stacks over a foundation.
    sim.step(BUILD_ACTION_TICKS);
    stock(sim, player, 'floor_wood');
    expectRejected(fx, 'floor_wood', tx + 2, ty, 'occupied');
  });

  it('swaps width and height on an odd rotation', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('bed_bedroll');
    expect([def.width, def.height]).toEqual([1, 2]);

    stock(sim, player, def.id);
    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });
    const upright = structuresAt(sim, tx + 2, ty);
    expect(structuresAt(sim, tx + 2, ty + 1)).toBe(upright);
    expect(structuresAt(sim, tx + 3, ty)).toBeUndefined();

    sim.step(BUILD_ACTION_TICKS);
    stock(sim, player, def.id);
    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty + 3, rotation: 1 });
    const sideways = structuresAt(sim, tx + 2, ty + 3);
    expect(sideways?.rotation).toBe(1);
    expect(structuresAt(sim, tx + 3, ty + 3)).toBe(sideways);
    expect(structuresAt(sim, tx + 2, ty + 4)).toBeUndefined();
  });

  it('accepts a rotated footprint only when every rotated tile is clear', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    // A boulder to the east: fine for the upright bedroll, fatal for the rotated one.
    sim.placeNode('rock_small', tx + 3, ty);
    sim.step(1);
    stock(sim, player, 'bed_bedroll');
    expect(canPlace(sim.ctx, player, 'bed_bedroll', tx + 2, ty, 0).ok).toBe(true);
    expectRejected(fx, 'bed_bedroll', tx + 2, ty, 'blockedByNode', 1);
  });

  it('refuses the second of two builds aimed at one tile on the same tick', () => {
    // The classic double-spend: two clients, one tile, one tick. Commands dispatch in
    // sequence and the tile index updates immediately, so the loser must be told
    // `occupied` and must keep every stick.
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const rival = sim.addPlayer({ id: 'rival', x: player.x, y: player.y });
    stock(sim, player, 'wall_wood_frame');
    stock(sim, rival, 'wall_wood_frame');

    sim.command(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    sim.command(rival, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    sim.step(1);

    expect(structureCount(sim)).toBe(1);
    const loser = sim
      .eventsOf('buildRejected')
      .find((event) => event.playerId === rival.id || event.playerId === player.id);
    expect(loser?.reason).toBe('occupied');
    // Exactly one of them paid, and the other still has the full cost in the pack.
    const fullCost = sim.data.structures
      .require('wall_wood_frame')
      .cost.reduce((total, entry) => total + entry.count, 0);
    expect(carried(player) === 0 || carried(rival) === 0).toBe(true);
    expect(carried(player) + carried(rival)).toBe(fullCost);
  });

  it('shares one pair of hands with every other action', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'wall_wood_frame');
    stock(sim, player, 'wall_wood_frame');
    sim.command(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    sim.command(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty + 1,
      rotation: 0,
    });
    sim.step(1);

    expect(structureCount(sim)).toBe(1);
    expect(sim.lastEvent('buildRejected')?.reason).toBe('busy');
    expect(player.useReadyTick).toBe(sim.sim.state.tick + BUILD_ACTION_TICKS);
  });
});

// ---------------------------------------------------------------------------
// build: every way it can be refused
// ---------------------------------------------------------------------------

describe('build rejections', () => {
  it('refuses an unknown definition', () => {
    const fx = fixture();
    expectRejected(fx, 'not_a_structure', fx.tx + 2, fx.ty, 'unknownStructure');
  });

  it('refuses a fractional tile and an out-of-range rotation', () => {
    const fx = fixture();
    stock(fx.sim, fx.player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', fx.tx + 2.5, fx.ty, 'badTile');
    expectRejected(fx, 'wall_wood_frame', fx.tx + 2, fx.ty, 'badRotation', 7);
  });

  it('refuses a dead player', () => {
    const fx = fixture();
    stock(fx.sim, fx.player, 'wall_wood_frame');
    fx.player.alive = false;
    expectRejected(fx, 'wall_wood_frame', fx.tx + 2, fx.ty, 'dead');
  });

  it('refuses a tile outside the world', () => {
    const fx = fixture();
    const { sim, player } = fx;
    // Stand in the world's corner so tile -1 is within reach but off the map.
    player.x = tileCenter(0);
    player.y = tileCenter(0);
    sim.flatten(player.x, player.y, 4);
    stock(sim, player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', -1, 0, 'outOfWorld');
  });

  it('refuses a tile out of build range', () => {
    const fx = fixture();
    stock(fx.sim, fx.player, 'wall_wood_frame');
    const far = fx.tx + Math.ceil(BUILD_RANGE / TILE_SIZE) + 2;
    expectRejected(fx, 'wall_wood_frame', far, fx.ty, 'outOfRange');
  });

  it('refuses an unbuildable surface', () => {
    const fx = fixture();
    fx.sim.world.setTile(fx.tx + 2, fx.ty, Tile.WallConcrete);
    stock(fx.sim, fx.player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', fx.tx + 2, fx.ty, 'unbuildableSurface');
  });

  it('refuses deep water for anything not built for it', () => {
    const fx = fixture();
    fx.sim.world.setTile(fx.tx + 2, fx.ty, Tile.WaterDeep);
    stock(fx.sim, fx.player, 'foundation_wood');
    expectRejected(fx, 'foundation_wood', fx.tx + 2, fx.ty, 'deepWater');
  });

  it('refuses a floor-only piece on bare ground', () => {
    const fx = fixture();
    const { sim, player } = fx;
    player.skills.building.level = 2;
    sim.equip(player, 'hammer');
    stock(sim, player, 'hatch');
    expectRejected(fx, 'hatch', fx.tx + 2, fx.ty, 'needsFloor');
  });

  it('refuses an occupied tile', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.placeStructure('bed_bedroll', tx + 2, ty, 0, player.id);
    stock(sim, player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', tx + 2, ty, 'occupied');
  });

  it('refuses a tile a resource node stands on', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.placeNode('rock_small', tx + 2, ty);
    sim.step(1);
    stock(sim, player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', tx + 2, ty, 'blockedByNode');
  });

  it('refuses to drop a solid piece on top of a body', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.spawnZombie('walker', tileCenter(tx + 2), tileCenter(ty));
    sim.step(1);
    stock(sim, player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', tx + 2, ty, 'blockedByEntity');

    // The player's own feet count too.
    stock(sim, player, 'wall_wood_frame');
    expectRejected(fx, 'wall_wood_frame', tx, ty, 'blockedByEntity');
  });

  it('lets a flat piece be laid under a body', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.spawnZombie('walker', tileCenter(tx + 2), tileCenter(ty));
    sim.step(1);
    player.skills.building.level = 2;
    stock(sim, player, 'bear_trap');
    expect(canPlace(sim.ctx, player, 'bear_trap', tx + 2, ty, 0).ok).toBe(true);
  });

  it('refuses an unsupported piece', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'torch_wall');
    expectRejected(fx, 'torch_wall', tx + 2, ty, 'noSupport');

    // A generated brick wall next door is support, even though it is terrain and not a
    // structure - boarding up a house you found has to work.
    sim.world.setTile(tx + 3, ty, Tile.WallBrick);
    expect(canPlace(sim.ctx, player, 'torch_wall', tx + 2, ty, 0).ok).toBe(true);
  });

  it('refuses a piece the player has not levelled into', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'wall_stone');
    sim.equip(player, 'hammer');
    expectRejected(fx, 'wall_stone', tx + 2, ty, 'missingSkill');

    player.skills.building.level = 3;
    expect(canPlace(sim.ctx, player, 'wall_stone', tx + 2, ty, 0).ok).toBe(true);
  });

  it('refuses a piece whose tool the player does not carry', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'wall_wood');
    expectRejected(fx, 'wall_wood', tx + 2, ty, 'missingTool');

    // Stowed counts: a hammer in the pack is a hammer.
    sim.giveItem(player, 'hammer', 1);
    expect(canPlace(sim.ctx, player, 'wall_wood', tx + 2, ty, 0).ok).toBe(true);
  });

  it('refuses a piece the player cannot pay for', () => {
    const fx = fixture();
    expectRejected(fx, 'wall_wood_frame', fx.tx + 2, fx.ty, 'missingMaterials');

    // Short by one is still short.
    fx.sim.giveItem(fx.player, 'stick', 6);
    fx.sim.giveItem(fx.player, 'plant_fiber', 3);
    expectRejected(fx, 'wall_wood_frame', fx.tx + 2, fx.ty, 'missingMaterials');
  });

  it('names the placement reason to the ghost and the command identically', () => {
    // The two callers of canPlace agree above, case by case. This pins the *ordering*
    // of the checks, which is the part the client depends on to show one message.
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.world.setTile(tx + 2, ty, Tile.WaterDeep);
    // Missing skill, missing tool, unbuildable tile and no materials, all at once.
    const preview = canPlace(sim.ctx, player, 'wall_stone', tx + 2, ty, 0);
    expect(preview.reason).toBe('missingSkill');
    player.skills.building.level = 3;
    expect(canPlace(sim.ctx, player, 'wall_stone', tx + 2, ty, 0).reason).toBe('missingTool');
    sim.equip(player, 'hammer');
    expect(canPlace(sim.ctx, player, 'wall_stone', tx + 2, ty, 0).reason).toBe('deepWater');
    sim.world.setTile(tx + 2, ty, Tile.Grass);
    expect(canPlace(sim.ctx, player, 'wall_stone', tx + 2, ty, 0).reason).toBe('missingMaterials');
    stock(sim, player, 'wall_stone');
    expect(canPlace(sim.ctx, player, 'wall_stone', tx + 2, ty, 0).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Content the shipped table does not exercise
// ---------------------------------------------------------------------------

/**
 * A dock and a bunker wall, added to the content table for the two placement rules the
 * shipped structures do not use: `placeOn: 'water'` and `destructible: false`. Both are
 * real rules in `StructureDef`, so both get a real test rather than being trusted.
 */
function dataWithDockAndBunker(): GameData {
  const dock: StructureDef = {
    ...STRUCTURE_DEFS[0]!,
    id: 'test_dock',
    name: 'Dock',
    description: 'Planking out over the water.',
    category: 'floor',
    placeOn: 'water',
    stacksOver: [],
    cost: [{ defId: 'wood_plank', count: 2 }],
    requiresSupport: false,
    destructible: true,
    blocksMovement: false,
    sortOrder: 10_000,
  };
  const bunker: StructureDef = {
    ...STRUCTURE_DEFS[0]!,
    id: 'test_bunker_wall',
    name: 'Bunker Wall',
    description: 'Poured concrete. Nothing you own will scratch it.',
    category: 'wall',
    placeOn: 'ground',
    stacksOver: [],
    cost: [{ defId: 'stone_block', count: 2 }],
    requiresSupport: false,
    destructible: false,
    blocksMovement: true,
    sortOrder: 10_010,
  };
  delete dock.tool;
  delete dock.requiredSkill;
  delete bunker.tool;
  delete bunker.requiredSkill;
  return createGameData({ structures: [...STRUCTURE_DEFS, dock, bunker] });
}

describe('placement surfaces the shipped table does not use', () => {
  it('requires water under a dock, and accepts shallow water', () => {
    const fx = fixture({ data: dataWithDockAndBunker() });
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'test_dock');
    expectRejected(fx, 'test_dock', tx + 2, ty, 'needsWater');

    sim.world.setTile(tx + 2, ty, Tile.WaterShallow);
    expect(canPlace(sim.ctx, player, 'test_dock', tx + 2, ty, 0).ok).toBe(true);
    sim.run(player, { type: 'build', defId: 'test_dock', tileX: tx + 2, tileY: ty, rotation: 0 });
    expect(structuresAt(sim, tx + 2, ty)?.defId).toBe('test_dock');
  });

  it('accepts a dock over deep water, which every other piece refuses', () => {
    const fx = fixture({ data: dataWithDockAndBunker() });
    const { sim, player, tx, ty } = fx;
    sim.world.setTile(tx + 2, ty, Tile.WaterDeep);
    stock(sim, player, 'test_dock');
    expect(canPlace(sim.ctx, player, 'test_dock', tx + 2, ty, 0).ok).toBe(true);
  });

  it('refuses to demolish or repair an indestructible piece', () => {
    const fx = fixture({ data: dataWithDockAndBunker() });
    const { sim, player, tx, ty } = fx;
    const bunker = sim.placeStructure('test_bunker_wall', tx + 1, ty, 0, player.id);
    expect(bunker).not.toBeNull();

    sim.run(player, { type: 'demolish', structureId: bunker!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('indestructible');
    expect(sim.sim.state.structures[bunker!.id]).toBeDefined();

    bunker!.health = 1;
    sim.step(BUILD_ACTION_TICKS);
    sim.run(player, { type: 'repair', structureId: bunker!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('indestructible');
  });
});

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

describe('collision', () => {
  it('appears when a solid piece is built and goes away when it is destroyed', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    expect(sim.world.getCollision(tx + 2, ty) & CollisionFlag.StructureSolid).toBe(0);

    stock(sim, player, 'wall_wood_frame');
    sim.run(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    const wall = structuresAt(sim, tx + 2, ty);
    expect(sim.world.getCollision(tx + 2, ty) & CollisionFlag.StructureSolid).not.toBe(0);
    expect(sim.world.isSolidTile(tx + 2, ty)).toBe(true);

    wall!.health = 0;
    sim.step(1);
    expect(sim.sim.state.structures[wall!.id]).toBeUndefined();
    expect(sim.world.getCollision(tx + 2, ty) & CollisionFlag.StructureSolid).toBe(0);
    expect(sim.sim.state.structureTiles[tileKey(tx + 2, ty)]).toBeUndefined();
  });

  it('covers every tile of a multi-tile footprint, and clears every one again', () => {
    // A 2x1 gate: the bug this catches is collision or the tile index being applied to
    // the origin tile only, which looks fine until something walks through the far half.
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('gate_wood');
    expect([def.width, def.height]).toEqual([2, 1]);
    sim.equip(player, 'hammer');
    stock(sim, player, def.id);

    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });
    const gate = structuresAt(sim, tx + 2, ty);
    expect(structuresAt(sim, tx + 3, ty)).toBe(gate);
    for (const dx of [2, 3]) {
      expect(sim.world.isSolidTile(tx + dx, ty)).toBe(true);
      expect(sim.world.getCollision(tx + dx, ty) & CollisionFlag.Door).not.toBe(0);
    }

    gate!.health = 0;
    sim.step(1);
    for (const dx of [2, 3]) {
      expect(sim.world.getCollision(tx + dx, ty)).toBe(CollisionFlag.None);
      expect(sim.sim.state.structureTiles[tileKey(tx + dx, ty)]).toBeUndefined();
    }
  });

  it('opens both halves of a wide gate at once', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const gate = sim.placeStructure('gate_wood', tx + 1, ty, 0, player.id);
    expect(sim.world.isSolidTile(tx + 2, ty)).toBe(true);

    sim.run(player, { type: 'toggleDoor', structureId: gate!.id });
    expect(gate!.door?.open).toBe(true);
    // Both tiles have to give way, or the gate is a doorway you can only half walk through.
    for (const dx of [1, 2]) {
      expect(sim.world.isSolidTile(tx + dx, ty)).toBe(false);
      expect(sim.world.getCollision(tx + dx, ty) & CollisionFlag.Door).not.toBe(0);
    }
  });

  it('leaves a stacked floor registered when the wall over it is destroyed', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const floor = sim.placeStructure('floor_wood', tx + 2, ty, 0, player.id);
    const wall = sim.placeStructure('wall_wood_frame', tx + 2, ty, 0, player.id);
    expect(sim.sim.state.structureTiles[tileKey(tx + 2, ty)]).toBe(wall!.id);

    wall!.health = 0;
    sim.step(1);
    // The floor survives, and it is the tile's owner again - not an orphan you would
    // walk straight through.
    expect(sim.sim.state.structures[floor!.id]).toBeDefined();
    expect(sim.sim.state.structureTiles[tileKey(tx + 2, ty)]).toBe(floor!.id);
    expect(sim.world.getCollision(tx + 2, ty) & CollisionFlag.StructureSolid).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

describe('toggleDoor', () => {
  function withDoor(): Fixture & { door: StructureState } {
    const fx = fixture();
    const door = fx.sim.placeStructure('door_wood', fx.tx + 1, fx.ty, 0, fx.player.id);
    if (!door) throw new Error('door_wood failed to spawn');
    return { ...fx, door };
  }

  it('opens, closes, and drags collision and line of sight with it', () => {
    const { sim, player, tx, ty, door } = withDoor();
    const closed = sim.world.getCollision(tx + 1, ty);
    expect(closed & CollisionFlag.StructureSolid).not.toBe(0);
    expect(closed & CollisionFlag.StructureOpaque).not.toBe(0);
    expect(closed & CollisionFlag.Door).not.toBe(0);

    const west = { x: tileCenter(tx - 1), y: tileCenter(ty) };
    const east = { x: tileCenter(tx + 3), y: tileCenter(ty) };
    expect(sim.world.hasLineOfSight(west.x, west.y, east.x, east.y)).toBe(false);

    sim.run(player, { type: 'toggleDoor', structureId: door.id });
    expect(sim.lastEvent('doorToggled')).toMatchObject({ structureId: door.id, open: true });
    expect(door.door?.open).toBe(true);

    const open = sim.world.getCollision(tx + 1, ty);
    expect(open & CollisionFlag.StructureSolid).toBe(0);
    expect(open & CollisionFlag.StructureOpaque).toBe(0);
    // Still a door: the tile has to keep saying so, or a zombie cannot decide to bash it.
    expect(open & CollisionFlag.Door).not.toBe(0);
    expect(sim.world.hasLineOfSight(west.x, west.y, east.x, east.y)).toBe(true);

    sim.step(SIM_HZ);
    sim.run(player, { type: 'toggleDoor', structureId: door.id });
    expect(door.door?.open).toBe(false);
    expect(sim.world.isSolidTile(tx + 1, ty)).toBe(true);
  });

  it('refuses a door out of reach, a door that is still a frame, and a piece that is not a door', () => {
    const { sim, player, tx, ty, door } = withDoor();

    door.progress = 0.4;
    sim.run(player, { type: 'toggleDoor', structureId: door.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('blueprint');
    door.progress = 1;

    const wall = sim.placeStructure('wall_wood_frame', tx + 2, ty, 0, player.id);
    sim.step(SIM_HZ);
    sim.run(player, { type: 'toggleDoor', structureId: wall!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('notADoor');

    sim.step(SIM_HZ);
    player.x += STRUCTURE_REACH + TILE_SIZE * 2;
    sim.run(player, { type: 'toggleDoor', structureId: door.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('outOfRange');
    expect(door.door?.open).toBe(false);

    sim.step(SIM_HZ);
    sim.run(player, { type: 'toggleDoor', structureId: 'sNope' });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('unknownStructure');
  });

  it('honours a lock and its code', () => {
    const fx = fixture();
    const { sim, tx, ty } = fx;
    const owner = fx.player;
    const stranger = sim.addPlayer({ id: 'stranger', x: owner.x, y: owner.y });
    const door = sim.placeStructure('door_reinforced', tx + 1, ty, 0, owner.id);
    door!.door = { open: false, locked: true, code: '4071' };

    sim.run(stranger, { type: 'toggleDoor', structureId: door!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('locked');
    expect(door!.door?.open).toBe(false);

    sim.step(SIM_HZ);
    sim.run(stranger, { type: 'toggleDoor', structureId: door!.id, code: '0000' });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('locked');

    sim.step(SIM_HZ);
    sim.run(stranger, { type: 'toggleDoor', structureId: door!.id, code: '4071' });
    expect(door!.door?.open).toBe(true);

    // The owner never needs the code.
    sim.step(SIM_HZ);
    sim.run(owner, { type: 'toggleDoor', structureId: door!.id });
    expect(door!.door?.open).toBe(false);
  });

  it('opens on a plain interact, by entity id or by tile, and ignores anything else', () => {
    const { sim, player, tx, ty, door } = withDoor();

    sim.run(player, { type: 'interact', targetId: door.id });
    expect(door.door?.open).toBe(true);

    sim.step(SIM_HZ);
    sim.run(player, { type: 'interact', tileX: tx + 1, tileY: ty });
    expect(door.door?.open).toBe(false);

    // A click on empty ground, on a wall, and on a node id is not this system's business:
    // it must not answer at all, or it would double up another system's rejection.
    const wall = sim.placeStructure('wall_wood_frame', tx + 2, ty, 0, player.id);
    sim.step(SIM_HZ);
    sim.clearEvents();
    sim.run(player, { type: 'interact', targetId: wall!.id });
    sim.run(player, { type: 'interact', tileX: tx + 5, tileY: ty + 5 });
    sim.run(player, { type: 'interact' });
    expect(sim.eventsOf('commandRejected')).toHaveLength(0);
    expect(sim.eventsOf('doorToggled')).toHaveLength(0);
  });

  it('keeps a codeless lock owner-only', () => {
    const fx = fixture();
    const { sim, tx, ty } = fx;
    const stranger = sim.addPlayer({ id: 'stranger', x: fx.player.x, y: fx.player.y });
    const door = sim.placeStructure('door_reinforced', tx + 1, ty, 0, fx.player.id);
    door!.door = { open: false, locked: true };

    // `undefined === undefined` must not be a key.
    sim.run(stranger, { type: 'toggleDoor', structureId: door!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('locked');
    sim.step(SIM_HZ);
    sim.run(fx.player, { type: 'toggleDoor', structureId: door!.id });
    expect(door!.door?.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Demolish
// ---------------------------------------------------------------------------

describe('demolish', () => {
  it('refunds at least one unit of a single-item cost', () => {
    // Every kit-built structure costs exactly one kit, and the refund floored
    // `1 * refundRatio` to zero - so taking your own storage box down returned nothing
    // while its definition advertised getting most of it back. Rubble still floors; a
    // voluntary demolish does not.
    const { sim, player, tx, ty } = fixture();
    sim.equip(player, 'hammer');

    const def = sim.data.structures.require('storage_box');
    expect(def.refundRatio, 'the premise: it advertises a refund').toBeGreaterThan(0);
    expect(def.cost.every((entry) => entry.count === 1)).toBe(true);

    const box = sim.placeStructure('storage_box', tx + 1, ty, 0, player.id);
    expect(box).not.toBeNull();
    box!.progress = 1;

    const held = (defId: string): number =>
      player.inventory.slots.reduce<number>(
        (sum, slot) => sum + (slot?.defId === defId ? slot.count : 0),
        0,
      );
    const before = def.cost.map((entry) => held(entry.defId));

    sim.run(player, { type: 'demolish', structureId: box!.id });
    sim.step(2);

    expect(sim.sim.state.structures[box!.id]).toBeUndefined();
    def.cost.forEach((entry, i) => {
      const gained = held(entry.defId) - (before[i] ?? 0);
      const onGround = Object.values(sim.sim.state.items)
        .filter((item) => item.stack.defId === entry.defId)
        .reduce<number>((sum, item) => sum + item.stack.count, 0);
      expect(gained + onGround, `${entry.defId} was not refunded`).toBeGreaterThan(0);
    });
  });

  it('refunds the cost times refundRatio, rounded down, and removes the piece', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood');
    const wall = sim.placeStructure(def.id, tx + 1, ty, 0, player.id);
    sim.equip(player, 'hammer');

    sim.run(player, { type: 'demolish', structureId: wall!.id });

    const expected = scaleCost(def.cost, def.refundRatio);
    expect(expected).toEqual([
      { defId: 'wood_plank', count: 3 },
      { defId: 'nail', count: 3 },
    ]);
    for (const entry of expected) {
      expect(countItem(player.inventory, entry.defId)).toBe(entry.count);
    }
    const event = sim.lastEvent('structureDemolished');
    expect(event?.structureId).toBe(wall!.id);
    expect(event?.refund.map((stack) => [stack.defId, stack.count])).toEqual([
      ['wood_plank', 3],
      ['nail', 3],
    ]);
    expect(sim.sim.state.structures[wall!.id]).toBeUndefined();
    expect(sim.world.getCollision(tx + 1, ty) & CollisionFlag.StructureSolid).toBe(0);
  });

  it('returns everything when the piece was only ever a frame', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood');
    const wall = sim.placeStructure(def.id, tx + 1, ty, 0, player.id);
    wall!.progress = 0.2;
    sim.equip(player, 'hammer');

    sim.run(player, { type: 'demolish', structureId: wall!.id });
    expect(countItem(player.inventory, 'wood_plank')).toBe(6);
    expect(countItem(player.inventory, 'nail')).toBe(6);
  });

  it('refuses somebody else’s wall on a co-op server, and allows it on a pvp one', () => {
    const coop = fixture();
    const stranger = coop.sim.addPlayer({
      id: 'stranger',
      x: coop.player.x,
      y: coop.player.y,
    });
    coop.sim.equip(stranger, 'hammer');
    const wall = coop.sim.placeStructure('wall_wood', coop.tx + 1, coop.ty, 0, coop.player.id);
    coop.sim.run(stranger, { type: 'demolish', structureId: wall!.id });
    expect(coop.sim.lastEvent('commandRejected')?.reason).toBe('notOwner');
    expect(coop.sim.sim.state.structures[wall!.id]).toBeDefined();
    expect(carried(stranger)).toBe(0);

    const pvp = fixture({
      config: (config) => {
        config.mode.pvp = true;
      },
    });
    const raider = pvp.sim.addPlayer({ id: 'raider', x: pvp.player.x, y: pvp.player.y });
    pvp.sim.equip(raider, 'hammer');
    const target = pvp.sim.placeStructure('wall_wood', pvp.tx + 1, pvp.ty, 0, pvp.player.id);
    pvp.sim.run(raider, { type: 'demolish', structureId: target!.id });
    expect(pvp.sim.sim.state.structures[target!.id]).toBeUndefined();
  });

  it('lets anyone clear a world-generated structure', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const found = sim.placeStructure('wall_wood', tx + 1, ty);
    expect(found?.ownerId).toBeUndefined();
    sim.equip(player, 'hammer');
    sim.run(player, { type: 'demolish', structureId: found!.id });
    expect(sim.sim.state.structures[found!.id]).toBeUndefined();
  });

  it('refuses out of reach, without the tool, and when dead', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const wall = sim.placeStructure('wall_wood', tx + 1, ty, 0, player.id);

    sim.run(player, { type: 'demolish', structureId: wall!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('missingTool');

    sim.equip(player, 'hammer');
    sim.step(BUILD_ACTION_TICKS);
    const homeX = player.x;
    player.x += STRUCTURE_REACH + TILE_SIZE * 2;
    sim.run(player, { type: 'demolish', structureId: wall!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('outOfRange');
    player.x = homeX;

    sim.step(BUILD_ACTION_TICKS);
    player.alive = false;
    sim.run(player, { type: 'demolish', structureId: wall!.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('dead');
    expect(sim.sim.state.structures[wall!.id]).toBeDefined();
  });

  it('spills a container it tears down and drops the player’s references to it', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const box = sim.placeStructure('storage_box', tx + 1, ty, 0, player.id);
    box!.container!.slots[0] = { defId: 'iron_ingot', count: 4 };
    player.openContainerId = box!.id;

    sim.run(player, { type: 'demolish', structureId: box!.id });
    expect(player.openContainerId).toBeUndefined();
    const dropped = Object.values(sim.sim.state.items).filter(
      (item) => item.stack.defId === 'iron_ingot',
    );
    expect(dropped.reduce((total, item) => total + item.stack.count, 0)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

describe('repair', () => {
  function damagedWall(): Fixture & { wall: StructureState } {
    const fx = fixture();
    const wall = fx.sim.placeStructure('wall_wood', fx.tx + 1, fx.ty, 0, fx.player.id);
    if (!wall) throw new Error('wall_wood failed to spawn');
    wall.health = 40;
    return { ...fx, wall };
  }

  it('restores health in steps, charging a fraction of the build cost each swing', () => {
    const { sim, player, wall } = damagedWall();
    const def = sim.data.structures.require('wall_wood');
    sim.equip(player, 'hammer');
    const cost = repairCost(def);
    expect(cost).toEqual([
      { defId: 'wood_plank', count: 2 },
      { defId: 'nail', count: 2 },
    ]);
    for (const entry of cost) sim.giveItem(player, entry.defId, entry.count * 2);

    sim.run(player, { type: 'repair', structureId: wall.id });
    const first = sim.lastEvent('structureRepaired');
    expect(first?.amount).toBe(Math.round(def.maxHealth * 0.5));
    expect(wall.health).toBe(40 + first!.amount);
    expect(wall.health).toBeLessThan(def.maxHealth);
    expect(countItem(player.inventory, 'wood_plank')).toBe(2);
    expect(sim.eventsOf('skillXp').some((event) => event.skill === 'building')).toBe(true);

    // A second swing tops it up and never overshoots.
    sim.step(SIM_HZ);
    sim.run(player, { type: 'repair', structureId: wall.id });
    expect(wall.health).toBe(def.maxHealth);
    expect(countItem(player.inventory, 'wood_plank')).toBe(0);
    expect(REPAIR_COST_FRACTION).toBeLessThan(1);
  });

  it('refuses without a hammer, without materials, at full health and out of reach', () => {
    const { sim, player, wall } = damagedWall();

    sim.run(player, { type: 'repair', structureId: wall.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('missingTool');

    sim.equip(player, 'hammer');
    sim.step(SIM_HZ);
    sim.run(player, { type: 'repair', structureId: wall.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('missingMaterials');
    expect(wall.health).toBe(40);

    for (const entry of repairCost(sim.data.structures.require('wall_wood'))) {
      sim.giveItem(player, entry.defId, entry.count);
    }
    sim.step(SIM_HZ);
    const homeX = player.x;
    player.x += STRUCTURE_REACH + TILE_SIZE * 2;
    sim.run(player, { type: 'repair', structureId: wall.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('outOfRange');
    player.x = homeX;

    sim.step(SIM_HZ);
    wall.health = wall.maxHealth;
    sim.run(player, { type: 'repair', structureId: wall.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('notDamaged');
    expect(carried(player)).toBe(4);
  });

  it('refuses an unfinished frame: that is a job for standing next to it', () => {
    const { sim, player, wall } = damagedWall();
    sim.equip(player, 'hammer');
    for (const entry of repairCost(sim.data.structures.require('wall_wood'))) {
      sim.giveItem(player, entry.defId, entry.count);
    }
    wall.progress = 0.5;
    sim.run(player, { type: 'repair', structureId: wall.id });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('blueprint');
  });
});

// ---------------------------------------------------------------------------
// setBuildSelection
// ---------------------------------------------------------------------------

describe('setBuildSelection', () => {
  it('stores the selection and wraps the rotation', () => {
    const fx = fixture();
    const { sim, player } = fx;
    sim.run(player, { type: 'setBuildSelection', defId: 'wall_wood', rotation: 5 });
    expect(player.buildDefId).toBe('wall_wood');
    expect(player.buildRotation).toBe(1);

    sim.run(player, { type: 'setBuildSelection', defId: 'wall_wood', rotation: -1 });
    expect(player.buildRotation).toBe(3);
  });

  it('clears the selection on null', () => {
    const fx = fixture();
    const { sim, player } = fx;
    sim.run(player, { type: 'setBuildSelection', defId: 'wall_wood', rotation: 2 });
    sim.run(player, { type: 'setBuildSelection', defId: null, rotation: 0 });
    expect(player.buildDefId).toBeUndefined();
    expect(player.buildRotation).toBe(0);
  });

  it('refuses an unknown definition and a nonsense rotation', () => {
    const fx = fixture();
    const { sim, player } = fx;
    sim.run(player, { type: 'setBuildSelection', defId: 'nope', rotation: 0 });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('unknownStructure');
    expect(player.buildDefId).toBeUndefined();

    sim.run(player, { type: 'setBuildSelection', defId: 'wall_wood', rotation: 1.5 });
    expect(sim.lastEvent('commandRejected')?.reason).toBe('badRotation');
    expect(player.buildDefId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Destruction and decay
// ---------------------------------------------------------------------------

describe('destruction', () => {
  it('drops a fraction of the materials as rubble and reports the loss', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('wall_wood');
    const wall = sim.placeStructure(def.id, tx + 2, ty, 0, player.id);

    wall!.health = 0;
    sim.step(1);

    const destroyed = sim.lastEvent('structureDestroyed');
    expect(destroyed).toMatchObject({ structureId: wall!.id, defId: def.id, tileX: tx + 2 });

    const rubble = scaleCost(def.cost, RUBBLE_RATIO);
    expect(rubble).toEqual([
      { defId: 'wood_plank', count: 1 },
      { defId: 'nail', count: 1 },
    ]);
    for (const entry of rubble) {
      const onGround = Object.values(sim.sim.state.items)
        .filter((item) => item.stack.defId === entry.defId)
        .reduce((total, item) => total + item.stack.count, 0);
      expect(onGround).toBe(entry.count);
    }
  });

  it('spills a destroyed container and forgets a burned-down bed', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const box = sim.placeStructure('storage_box', tx + 2, ty, 0, player.id);
    box!.container!.slots[0] = { defId: 'bandage', count: 3 };
    const bed = sim.placeStructure('bed_bedroll', tx + 3, ty, 0, player.id);
    player.bedStructureId = bed!.id;
    player.openContainerId = box!.id;

    box!.health = 0;
    bed!.health = 0;
    sim.step(1);

    expect(player.openContainerId).toBeUndefined();
    expect(player.bedStructureId).toBeUndefined();
    const bandages = Object.values(sim.sim.state.items).filter(
      (item) => item.stack.defId === 'bandage',
    );
    expect(bandages.reduce((total, item) => total + item.stack.count, 0)).toBe(3);
  });
});

describe('decay', () => {
  it('rots an abandoned player structure', () => {
    const fx = fixture();
    const { sim, player } = fx;
    const farTile = pixelToTile(player.x) + 200;
    const wall = sim.placeStructure('wall_wood', farTile, pixelToTile(player.y), 0, player.id);
    expect(wall!.health).toBe(wall!.maxHealth);

    sim.step(DECAY_INTERVAL_TICKS);
    expect(wall!.health).toBeLessThan(wall!.maxHealth);
    expect(sim.lastEvent('structureDamaged')?.structureId).toBe(wall!.id);
  });

  it('never rots a structure somebody lives near, or one the world built', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const home = sim.placeStructure('wall_wood', tx + 2, ty, 0, player.id);
    const farTile = tx + 200;
    const ruin = sim.placeStructure('wall_wood', farTile, ty);

    sim.step(DECAY_INTERVAL_TICKS * 3);
    expect(home!.health).toBe(home!.maxHealth);
    expect(ruin!.health).toBe(ruin!.maxHealth);
  });

  it('eventually returns an abandoned base to the world', () => {
    const fx = fixture();
    const { sim, player } = fx;
    const farTile = pixelToTile(player.x) + 200;
    const wall = sim.placeStructure('wall_wood', farTile, pixelToTile(player.y), 0, player.id);
    // Start it most of the way gone rather than stepping the hundred game hours the full
    // 260 HP would take: the last few hours are the same code as the first.
    wall!.health = 2;

    sim.step(DECAY_INTERVAL_TICKS * 2);
    expect(sim.lastEvent('structureDestroyed')?.structureId).toBe(wall!.id);
    expect(sim.sim.state.structures[wall!.id]).toBeUndefined();
  });

  it('rots an abandoned frame too, so a misclick is not permanent litter', () => {
    const fx = fixture();
    const { sim, player } = fx;
    const farTile = pixelToTile(player.x) + 200;
    const frame = sim.placeStructure('wall_wood', farTile, pixelToTile(player.y), 0, player.id);
    frame!.progress = 0.5;
    frame!.health = 2;

    sim.step(DECAY_INTERVAL_TICKS * 2);
    expect(sim.lastEvent('structureDestroyed')?.structureId).toBe(frame!.id);
    expect(sim.sim.state.structures[frame!.id]).toBeUndefined();
  });

  it('does not advance or rot a frame while its builder is standing over it', () => {
    // The two per-tick jobs a frame is subject to have opposite signs, and the safe
    // radius is what stops them fighting: near a player, only progress moves.
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    stock(sim, player, 'wall_wood_frame');
    sim.run(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    const frame = structuresAt(sim, tx + 2, ty);
    const health = frame!.health;

    sim.step(DECAY_INTERVAL_TICKS);
    expect(frame!.progress).toBe(1);
    // Finishing sets full health; the point is that no decay tick ever bit into it.
    expect(frame!.health).toBe(frame!.maxHealth);
    expect(frame!.health).toBeGreaterThan(health);
    expect(sim.eventsOf('structureDamaged')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lights and beds
// ---------------------------------------------------------------------------

describe('lights', () => {
  it('lights a finished torch from the torch that went into it, then burns it out', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const def = sim.data.structures.require('torch_wall');
    sim.world.setTile(tx + 3, ty, Tile.WallBrick);
    stock(sim, player, def.id);

    sim.run(player, { type: 'build', defId: def.id, tileX: tx + 2, tileY: ty, rotation: 0 });
    const torch = structuresAt(sim, tx + 2, ty);
    expect(torch?.light?.on).toBe(false);

    sim.step(def.buildTicks);
    expect(torch?.progress).toBe(1);
    expect(torch?.light?.on).toBe(true);
    // A torch's `fuel.burnTicks` is 1200, which is what the socket is filled with.
    expect(torch?.light?.fuel).toBe(lightFuelBudget(sim.ctx, def));
    expect(torch?.light?.fuel).toBe(1200);

    const before = torch!.light!.fuel;
    sim.step(LIGHT_TICK_INTERVAL);
    expect(torch!.light!.fuel).toBeCloseTo(
      before - def.light!.fuelPerTick * LIGHT_TICK_INTERVAL,
      8,
    );

    torch!.light!.fuel = def.light!.fuelPerTick;
    sim.clearEvents();
    sim.step(LIGHT_TICK_INTERVAL * 2);
    expect(torch!.light!.on).toBe(false);
    expect(torch!.light!.fuel).toBe(0);
    expect(sim.eventsOf('stationLit').some((event) => event.lit === false)).toBe(true);
  });

  it('gives a lantern post a longer life than a torch, as its description promises', () => {
    const fx = fixture();
    const torch = fx.sim.data.structures.require('torch_wall');
    const lantern = fx.sim.data.structures.require('lantern_post');
    const burn = (def: StructureDef): number =>
      lightFuelBudget(fx.sim.ctx, def) / def.light!.fuelPerTick;
    expect(burn(lantern)).toBeGreaterThan(burn(torch) * 2);
  });

  it('lets a station’s fire drive its light rather than burning a second budget', () => {
    const fx = fixture();
    const { sim, tx, ty } = fx;
    const campfire = sim.placeStructure('campfire', tx + 2, ty, 0, fx.player.id);
    expect(campfire!.light?.on).toBe(false);

    campfire!.station!.lit = true;
    campfire!.light!.fuel = 0;
    sim.step(LIGHT_TICK_INTERVAL);
    // Mirrored from the station, and its own `fuel` is left alone: the fire is one fire.
    expect(campfire!.light?.on).toBe(true);
    expect(campfire!.light?.fuel).toBe(0);

    campfire!.station!.lit = false;
    sim.step(LIGHT_TICK_INTERVAL);
    expect(campfire!.light?.on).toBe(false);
  });
});

describe('beds', () => {
  it('keeps an occupant while they are in it', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const bed = sim.placeStructure('bed_bedroll', pixelToTile(player.x), ty, 0, player.id);
    bed!.bed = { occupantId: player.id, sleepStartTick: sim.sim.state.tick };
    sim.step(SIM_HZ);
    expect(bed!.bed?.occupantId).toBe(player.id);
    expect(tx).toBe(pixelToTile(player.x));
  });

  it('empties itself when the occupant walks off, dies, or disappears', () => {
    const fx = fixture();
    const { sim, player, ty } = fx;
    const bed = sim.placeStructure('bed_bedroll', pixelToTile(player.x), ty, 0, player.id);

    bed!.bed = { occupantId: player.id, sleepStartTick: 0 };
    const homeX = player.x;
    player.x += TILE_SIZE * 10;
    sim.step(1);
    expect(bed!.bed?.occupantId).toBeUndefined();
    expect(bed!.bed?.sleepStartTick).toBe(-1);
    player.x = homeX;

    bed!.bed = { occupantId: player.id, sleepStartTick: 0 };
    player.alive = false;
    sim.step(1);
    expect(bed!.bed?.occupantId).toBeUndefined();

    bed!.bed = { occupantId: 'ghost', sleepStartTick: 0 };
    sim.step(1);
    expect(bed!.bed?.occupantId).toBeUndefined();
  });

  it('clears a stale sleep start when nobody is in it', () => {
    const fx = fixture();
    const { sim, player, ty } = fx;
    const bed = sim.placeStructure('bed_bedroll', pixelToTile(player.x), ty, 0, player.id);
    bed!.bed = { sleepStartTick: 500 };
    sim.step(1);
    expect(bed!.bed?.sleepStartTick).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Traps
// ---------------------------------------------------------------------------

describe('traps', () => {
  it('bites a zombie that steps on a spike trap, and grinds itself down doing it', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const trap = sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    const zombie = sim.spawnZombie('walker', tileCenter(tx + 4), tileCenter(ty));

    sim.step(1);
    expect(zombie.health).toBeLessThan(zombie.maxHealth);
    expect(zombie.staggerUntilTick).toBeGreaterThanOrEqual(
      sim.sim.state.tick + TRAP_SPECS.spike_trap!.holdTicks,
    );
    expect(zombie.vx).toBe(0);
    expect(trap!.health).toBe(trap!.maxHealth - TRAP_SPECS.spike_trap!.wear);
  });

  it('does not fire again while the victim is still reeling', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const trap = sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    sim.spawnZombie('walker', tileCenter(tx + 4), tileCenter(ty));

    sim.step(1);
    const afterFirst = trap!.health;
    sim.step(TRAP_SPECS.spike_trap!.holdTicks - 2);
    expect(trap!.health).toBe(afterFirst);
  });

  it('holds a bear trap’s victim for far longer than the spikes do', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.placeStructure('bear_trap', tx + 4, ty, 0, player.id);
    const zombie = sim.spawnZombie('walker', tileCenter(tx + 4), tileCenter(ty));

    sim.step(1);
    expect(zombie.ai).toBe('stagger');
    expect(zombie.staggerUntilTick - sim.sim.state.tick).toBeGreaterThanOrEqual(SIM_HZ * 8);
    expect(zombie.nextThinkTick - sim.sim.state.tick).toBeGreaterThanOrEqual(SIM_HZ * 8);
  });

  it('leaves alone anything standing off the trap', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const trap = sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    const zombie = sim.spawnZombie('walker', tileCenter(tx + 5), tileCenter(ty));
    sim.step(2);
    expect(zombie.health).toBe(zombie.maxHealth);
    expect(trap!.health).toBe(trap!.maxHealth);
  });

  it('kills a rabbit outright and drops its loot', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    const rabbit = sim.spawnAnimal('rabbit', tileCenter(tx + 4), tileCenter(ty));

    sim.step(1);
    expect(rabbit.ai).toBe('dead');
    expect(sim.lastEvent('death')?.entityId).toBe(rabbit.id);
  });

  it('does not bite the people who laid it', () => {
    // Traps are a base defence, not a hazard the owner has to remember the layout of.
    // A player standing squarely on one must be untouched, and it must not wear.
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const trap = sim.placeStructure('bear_trap', tx + 4, ty, 0, player.id);
    player.x = tileCenter(tx + 4);
    player.y = tileCenter(ty);
    const health = player.health;

    sim.step(SIM_HZ);
    expect(player.health).toBe(health);
    expect(trap!.health).toBe(trap!.maxHealth);
    expect(sim.eventsOf('structureDamaged')).toHaveLength(0);
  });

  it('does not fire while it is still a frame', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const trap = sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    trap!.progress = 0.5;
    const zombie = sim.spawnZombie('walker', tileCenter(tx + 4), tileCenter(ty));
    sim.step(2);
    expect(zombie.health).toBe(zombie.maxHealth);
  });

  it('comes apart when it has taken enough springs', () => {
    const fx = fixture();
    const { sim, player, tx, ty } = fx;
    const trap = sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    const spec = TRAP_SPECS.spike_trap!;
    trap!.health = spec.wear;
    sim.spawnZombie('walker', tileCenter(tx + 4), tileCenter(ty));

    sim.step(1);
    expect(sim.lastEvent('structureDestroyed')?.structureId).toBe(trap!.id);
    expect(sim.sim.state.structures[trap!.id]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  /** Run one identical scripted session and return the whole world as a string. */
  function session(): string {
    const sim = createTestSimulation({ seed: 31337, systems: [createBuildingSystem()] });
    const player = sim.addPlayer({ id: 'alpha' });
    const other = sim.addPlayer({ id: 'beta', x: player.x, y: player.y });
    const tx = pixelToTile(player.x);
    const ty = pixelToTile(player.y);

    for (const entry of sim.data.structures.require('wall_wood_frame').cost) {
      sim.giveItem(player, entry.defId, entry.count);
    }
    sim.run(player, {
      type: 'build',
      defId: 'wall_wood_frame',
      tileX: tx + 2,
      tileY: ty,
      rotation: 0,
    });
    sim.step(sim.data.structures.require('wall_wood_frame').buildTicks);

    // A trap trigger rolls a body part, and a collapse scatters rubble: two different
    // consumers of the RNG on the same tick.
    const trap = sim.placeStructure('spike_trap', tx + 4, ty, 0, player.id);
    const doomed = sim.placeStructure('wall_wood', tx + 5, ty + 3, 0, other.id);
    sim.spawnZombie('walker', tileCenter(tx + 4), tileCenter(ty));
    doomed!.health = 0;
    sim.step(SIM_HZ * 3);
    expect(trap!.health).toBeLessThan(trap!.maxHealth);

    sim.equip(other, 'hammer');
    sim.run(other, { type: 'demolish', structureId: structuresAt(sim, tx + 2, ty)!.id });
    sim.step(SIM_HZ);
    return JSON.stringify(sim.sim.state);
  }

  it('produces byte-identical state from the same seed and the same script', () => {
    expect(session()).toBe(session());
  });

  it('does not depend on the order structures happen to be enumerated in', () => {
    // Three walls collapse on the same tick, and each collapse scatters rubble through
    // the RNG. The update pass sorts its ids, so the draws land in the same order
    // however the records happen to be laid out in memory.
    const run = (reverseTable: boolean): string => {
      const sim = createTestSimulation({ seed: 555, systems: [createBuildingSystem()] });
      const player = sim.addPlayer();
      const tx = pixelToTile(player.x);
      const ty = pixelToTile(player.y);
      const walls: StructureState[] = [];
      for (const offset of [1, 2, 3]) {
        const wall = sim.placeStructure('wall_wood', tx + offset, ty + 4, 0, player.id);
        walls.push(wall!);
      }
      for (const wall of walls) wall.health = 0;

      if (reverseTable) {
        // JavaScript enumerates string keys in insertion order, so re-inserting the same
        // records backwards reproduces exactly the hazard `Object.keys().sort()` exists
        // to defuse - a host that loaded the same base from disk in a different order.
        const table = sim.sim.state.structures;
        for (const id of Object.keys(table).reverse()) {
          const structure = table[id];
          if (!structure) continue;
          delete table[id];
          table[id] = structure;
        }
      }

      sim.step(2);
      return Object.values(sim.sim.state.items)
        .map((item) => `${item.stack.defId}:${item.x.toFixed(6)}:${item.y.toFixed(6)}`)
        .sort()
        .join('|');
    };
    expect(run(false)).toBe(run(true));
  });
});
