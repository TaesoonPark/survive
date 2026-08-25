import { describe, expect, it } from 'vitest';
import {
  SIM_HZ,
  TICKS_PER_GAME_DAY,
  TICKS_PER_GAME_HOUR,
  Tile,
  pixelToTile,
} from '@survive/protocol';
import { createFlatWorld, createTestSimulation } from '@survive/test-utils';

/**
 * The harness has to be trustworthy before anything built on it means much, so it gets
 * its own tests.
 */
describe('createTestSimulation', () => {
  it('builds a world with real content loaded', () => {
    const sim = createTestSimulation();
    expect(sim.data.items.size).toBeGreaterThan(100);
    expect(sim.data.recipes.size).toBeGreaterThan(50);
    expect(sim.data.structures.size).toBeGreaterThan(20);
    expect(sim.data.zombies.size).toBeGreaterThan(5);
    expect(sim.data.crops.size).toBeGreaterThan(5);
  });

  it('steps without waiting on real time', () => {
    const sim = createTestSimulation();
    const before = sim.sim.state.tick;
    // An in-game hour in a few milliseconds. Longer spans belong in the integration
    // project, which has the timeout for them.
    sim.step(TICKS_PER_GAME_HOUR);
    expect(sim.sim.state.tick).toBe(before + TICKS_PER_GAME_HOUR);
  });

  it('advances by real seconds when a test thinks in seconds', () => {
    const sim = createTestSimulation();
    const start = sim.sim.state.tick;
    sim.advanceSeconds(3);
    expect(sim.sim.state.tick).toBe(start + 3 * SIM_HZ);
  });

  it('starts a fresh world on the morning of day 1, not at midnight', () => {
    const sim = createTestSimulation();
    sim.step(1);
    expect(sim.sim.state.time.day).toBe(1);
    expect(sim.sim.state.time.hour).toBe(8);
    expect(sim.sim.state.time.isNight).toBe(false);
    expect(sim.sim.state.time.lightLevel).toBeGreaterThan(0.5);
  });

  it('advances by in-game hours and days', () => {
    const sim = createTestSimulation();
    const start = sim.sim.state.tick;
    sim.advanceGameHours(2);
    expect(sim.sim.state.tick).toBe(start + 2 * TICKS_PER_GAME_HOUR);
    // One in-game day is 24 game hours, which is 24 real minutes at 20 ticks/game-minute.
    expect(TICKS_PER_GAME_DAY).toBe(24 * TICKS_PER_GAME_HOUR);
  });

  it('adds players on walkable ground', () => {
    const sim = createTestSimulation();
    const player = sim.addPlayer();
    expect(sim.sim.getPlayer(player.id)).toBe(player);
    expect(sim.world.circleBlocked(player.x, player.y, 11)).toBe(false);
    expect(player.alive).toBe(true);
    expect(player.health).toBe(100);
  });

  it('gives every player a distinct id by default', () => {
    const sim = createTestSimulation();
    const a = sim.addPlayer();
    const b = sim.addPlayer();
    expect(a.id).not.toBe(b.id);
  });

  it('starts players empty-handed unless a kit is asked for', () => {
    const sim = createTestSimulation();
    const bare = sim.addPlayer();
    expect(bare.inventory.slots.every((slot) => slot === null)).toBe(true);
    expect(bare.equipment.mainHand).toBeNull();

    const kitted = sim.addPlayer({ id: 'kitted', withKit: true });
    const hasSomething =
      kitted.inventory.slots.some((slot) => slot !== null) || kitted.equipment.mainHand !== null;
    expect(hasSomething).toBe(true);
  });

  it('gives items and equipment', () => {
    const sim = createTestSimulation();
    const player = sim.addPlayer();
    sim.giveItem(player, 'wood_log', 5);
    expect(player.inventory.slots.some((slot) => slot?.defId === 'wood_log')).toBe(true);
    expect(player.carryWeight).toBeGreaterThan(0);

    sim.equip(player, 'stone_hatchet');
    expect(player.equipment.mainHand?.defId).toBe('stone_hatchet');
  });

  it('refuses to silently drop items that do not fit', () => {
    const sim = createTestSimulation();
    const player = sim.addPlayer();
    expect(() => sim.giveItem(player, 'wood_log', 100_000)).toThrow(/fitted/);
  });

  it('spawns zombies and animals from the real tables', () => {
    const sim = createTestSimulation();
    const zombie = sim.spawnZombie('walker', 1000, 1000);
    expect(zombie.defId).toBe('walker');
    expect(zombie.maxHealth).toBe(sim.data.zombies.require('walker').maxHealth);
    expect(sim.sim.state.zombies[zombie.id]).toBe(zombie);

    const animal = sim.spawnAnimal('rabbit', 1100, 1000);
    expect(sim.sim.state.animals[animal.id]).toBe(animal);
  });

  it('places structures and registers their collision', () => {
    const sim = createTestSimulation();
    const tileX = pixelToTile(sim.spawn.x) + 4;
    const tileY = pixelToTile(sim.spawn.y);
    const wall = sim.placeStructure('wall_wood', tileX, tileY);
    expect(wall).not.toBeNull();
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(true);
  });

  it('collects events and can filter them by type', () => {
    const sim = createTestSimulation();
    const player = sim.addPlayer();
    expect(sim.eventsOf('playerJoined').map((event) => event.playerId)).toContain(player.id);
    expect(sim.lastEvent('playerJoined')?.playerId).toBe(player.id);
    sim.clearEvents();
    expect(sim.eventsOf('playerJoined')).toHaveLength(0);
  });

  it('flattens the spawn area so mechanics tests get predictable ground', () => {
    const sim = createTestSimulation();
    const tileX = pixelToTile(sim.spawn.x);
    const tileY = pixelToTile(sim.spawn.y);
    expect(sim.world.getTile(tileX, tileY)).toBe(Tile.Grass);
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(false);
  });

  it('can carve walls for line-of-sight and pathing tests', () => {
    const sim = createTestSimulation();
    const tileX = pixelToTile(sim.spawn.x) + 6;
    const tileY = pixelToTile(sim.spawn.y);
    sim.wall(tileX, tileY - 4, tileX, tileY + 4);
    expect(sim.world.isSolidTile(tileX, tileY)).toBe(true);
    expect(sim.world.hasLineOfSight(sim.spawn.x, sim.spawn.y, sim.spawn.x + 400, sim.spawn.y)).toBe(
      false,
    );
  });

  it('is deterministic: the same seed and the same steps give the same state', () => {
    const run = () => {
      const sim = createTestSimulation({ seed: 4242 });
      const player = sim.addPlayer({ id: 'p1' });
      sim.hold(player, { moveX: 1, moveY: 0 }, 40);
      return { x: player.x, y: player.y, tick: sim.sim.state.tick };
    };
    expect(run()).toEqual(run());
  });
});

describe('createFlatWorld', () => {
  it('is walkable everywhere by default', () => {
    const world = createFlatWorld();
    for (let i = 0; i < 50; i++) {
      expect(world.isSolidTile(i * 3, i * 7)).toBe(false);
    }
  });

  it('slides a circle along a wall instead of sticking to it', () => {
    const world = createFlatWorld();
    world.wall(20, 10, 20, 30);
    // Approach the wall diagonally from the west.
    const result = world.moveCircle(20 * 32 - 13, 20 * 32 + 16, 10, 10, 11);
    expect(result.blockedX).toBe(true);
    expect(result.blockedY).toBe(false);
    expect(result.y).toBeGreaterThan(20 * 32 + 16);
  });

  it('does not let a fast mover tunnel through a one-tile wall', () => {
    const world = createFlatWorld();
    world.wall(20, 10, 20, 30);
    const result = world.moveCircle(18 * 32, 20 * 32 + 16, 200, 0, 11);
    expect(result.blockedX).toBe(true);
    expect(result.x).toBeLessThan(20 * 32);
  });

  it('blocks sight with a wall but not with a window', () => {
    const world = createFlatWorld();
    world.wall(20, 20, 20, 20, Tile.WallConcrete);
    expect(world.hasLineOfSight(18 * 32, 20 * 32 + 16, 22 * 32, 20 * 32 + 16)).toBe(false);

    const glazed = createFlatWorld();
    glazed.wall(20, 20, 20, 20, Tile.WindowStatic);
    expect(glazed.hasLineOfSight(18 * 32, 20 * 32 + 16, 22 * 32, 20 * 32 + 16)).toBe(true);
    // ...but it still blocks movement.
    expect(glazed.isSolidTile(20, 20)).toBe(true);
  });

  it('raycasts correctly along an axis-aligned ray', () => {
    const world = createFlatWorld();
    world.wall(20, 20, 20, 20);
    const hit = world.raycast(10 * 32, 20 * 32 + 16, 30 * 32, 20 * 32 + 16);
    expect(hit).not.toBeNull();
    expect(hit!.tileX).toBe(20);
    expect(hit!.tileY).toBe(20);
  });

  it('returns null when a ray reaches its end unobstructed', () => {
    const world = createFlatWorld();
    expect(world.raycast(0, 0, 500, 500)).toBeNull();
  });

  it('paths around a wall', () => {
    const world = createFlatWorld();
    world.wall(20, 10, 20, 25);
    const path = world.findPath(18 * 32 + 16, 20 * 32 + 16, 22 * 32 + 16, 20 * 32 + 16, {
      maxNodes: 20_000,
    });
    expect(path.length).toBeGreaterThan(0);
    // Every waypoint must be walkable.
    for (let i = 0; i < path.length; i += 2) {
      expect(world.isSolidTile(path[i] as number, path[i + 1] as number)).toBe(false);
    }
    // It has to go round the end of the wall, so it is longer than the direct line.
    expect(path.length / 2).toBeGreaterThan(5);
  });

  it('returns an empty path when the goal is walled in', () => {
    const world = createFlatWorld();
    // A closed box around the goal.
    world.wall(30, 28, 34, 28);
    world.wall(30, 32, 34, 32);
    world.wall(30, 28, 30, 32);
    world.wall(34, 28, 34, 32);
    const path = world.findPath(20 * 32, 20 * 32, 32 * 32, 30 * 32, { maxNodes: 8000 });
    expect(path).toEqual([]);
  });

  it('never cuts a diagonal corner', () => {
    const world = createFlatWorld();
    world.wall(10, 10, 10, 10);
    world.wall(11, 11, 11, 11);
    const path = world.findPath(10 * 32 + 16, 11 * 32 + 16, 11 * 32 + 16, 10 * 32 + 16, {
      maxNodes: 4000,
    });
    // A corner-cutting path would be exactly two waypoints (start, goal).
    expect(path.length / 2).toBeGreaterThan(2);
  });

  it('builds a flow field whose costs descend towards the goal', () => {
    const world = createFlatWorld();
    const field = world.getFlowField(30 * 32 + 16, 30 * 32 + 16, 0);
    expect(field).not.toBeNull();
    const at = (tileX: number, tileY: number) =>
      field!.cost[(tileY - field!.minTileY) * field!.width + (tileX - field!.minTileX)] as number;
    expect(at(30, 30)).toBe(0);
    expect(at(33, 30)).toBeGreaterThan(at(31, 30));
    const direction = world.sampleFlow(field!, 35 * 32, 30 * 32);
    expect(direction).not.toBeNull();
    // From the east of the goal, the descent direction points west.
    expect(direction!.x).toBeLessThan(0);
  });

  it('prunes stale flow fields', () => {
    const world = createFlatWorld();
    const first = world.getFlowField(100, 100, 0);
    expect(world.getFlowField(100, 100, 0)).toBe(first);
    world.pruneFlowFields(1000, 100);
    expect(world.getFlowField(100, 100, 1000)).not.toBe(first);
  });

  it('round-trips tile overrides through persistence', () => {
    const world = createFlatWorld();
    world.setTile(5, 7, Tile.FarmlandWet);
    const overrides = world.getOverrides(0, 0);
    expect(overrides).toHaveLength(1);

    const fresh = createFlatWorld();
    expect(fresh.getTile(5, 7)).toBe(Tile.Grass);
    fresh.applyOverrides(0, 0, overrides);
    expect(fresh.getTile(5, 7)).toBe(Tile.FarmlandWet);
  });

  it('finds a spawn position that is never blocked, deterministically', () => {
    const world = createFlatWorld();
    world.fill(0, 0, 40, 40, Tile.WallConcrete);
    world.fill(20, 20, 21, 21, Tile.Grass);
    let counter = 1;
    const roll = () => {
      counter = (Math.imul(counter, 1664525) + 1013904223) >>> 0;
      return counter / 0x100000000;
    };
    const found = world.findSpawnPosition(20 * 32 + 16, 20 * 32 + 16, 64, 8, roll, 400);
    if (found) expect(world.circleBlocked(found.x, found.y, 8)).toBe(false);

    // Deterministic: the same roll sequence gives the same answer.
    counter = 1;
    const again = world.findSpawnPosition(20 * 32 + 16, 20 * 32 + 16, 64, 8, roll, 400);
    expect(again).toEqual(found);
  });
});

/**
 * The double must not survive less than the real thing.
 *
 * `createFlatWorld` stands in for `createWorld` in every simulation test, and it is a real
 * implementation - it slides, raycasts, paths and integrates flow fields - so it is trusted
 * exactly like the shipping grid. When it is *weaker* than the grid, a test written to
 * defend a guard that works instead exercises a hole in the harness. That has already cost
 * this project a whole day: a missing non-finite check in `moveCircle` turned a passing
 * movement guard into an uninterruptible infinite loop, which silently prevented the unit
 * project from ever completing.
 *
 * These are the same three guards, on the rest of the surface.
 */
describe('createFlatWorld matches the real collision contract', () => {
  it('returns from a raycast with a non-finite endpoint instead of spinning', () => {
    const world = createFlatWorld({ seed: 5 });
    // NaN propagates into `travelled`, and a NaN comparison is never true, so the loop's
    // exit condition can never fire. `raycast.ts` guards this; so must the double.
    expect(world.raycast(100, 100, Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(world.raycast(100, 100, Number.NaN, 100)).toBeNull();
    expect(world.hasLineOfSight(100, 100, Number.POSITIVE_INFINITY, 100)).toBe(true);
    expect(world.raycast(Number.NaN, 100, 200, 100)).toBeNull();
  });

  it('lets a body already inside geometry move back out', () => {
    const world = createFlatWorld({ seed: 5 });
    const tileX = 40;
    const tileY = 40;
    world.setTile(tileX, tileY, Tile.WallBrick);

    const centreX = tileX * 32 + 16;
    const centreY = tileY * 32 + 16;
    expect(world.circleBlocked(centreX, centreY, 11)).toBe(true);

    // Every candidate position is inside the wall, so a double without the escape rejects
    // them all and pins the body there for the rest of the run.
    const moved = world.moveCircle(centreX, centreY, 24, 0, 11);
    expect(moved.x).toBeGreaterThan(centreX);
  });

  it('expires a cached flow field rather than serving a pre-wall route forever', () => {
    const world = createFlatWorld({ seed: 5 });
    const goalX = 60 * 32 + 16;
    const goalY = 60 * 32 + 16;

    const first = world.getFlowField(goalX, goalY, 0);
    expect(first).not.toBeNull();
    // Same tick: the cache should answer.
    const cached = world.getFlowField(goalX, goalY, 0);
    expect(cached?.builtTick).toBe(first?.builtTick);

    // Far enough in the future that the real cache would have rebuilt.
    const later = world.getFlowField(goalX, goalY, 10_000);
    expect(later?.builtTick).toBe(10_000);
  });
});
