import { describe, expect, it } from 'vitest';
import { TILE_SIZE, pixelToTile, tileCenter } from '@survive/protocol';
import type { WorldService } from '@survive/world';
import { createFlatWorld, createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { createZombieAiSystem, MAX_ZOMBIE_PATHS_PER_TICK } from './zombieAi';
import {
  DIRECT_STEER_RANGE,
  FLOW_GOAL_QUANTUM,
  PATH_REFRESH_TICKS,
  blendSteering,
  createNavBudget,
  quantiseGoal,
  separation,
  steerTowards,
  type PathAgent,
} from './steering';

/**
 * The navigation ladder (spec section 23).
 *
 * The contract these tests defend is a *cost* contract as much as a behaviour one: a
 * horde has to get where it is going without every member running its own A* every
 * tick. So each rung is pinned down separately - direct steering close in, a shared flow
 * field in the middle, a rate-limited private search as the last resort - and then the
 * whole thing is checked end to end by counting how many times a running simulation
 * actually reaches for the pathfinder.
 */

const ANCHOR_TILE = 4104;
const CENTRE = tileCenter(ANCHOR_TILE);

function makeAgent(x: number, y: number, id = 'z1'): PathAgent {
  return { id, x, y, path: [], pathIndex: 0, pathTick: -10_000 };
}

/** Fresh steer options with their own budget, so each test counts its own searches. */
function options(maxPaths = 4) {
  return { budget: createNavBudget(), maxPathsPerTick: maxPaths, doorCost: 0 };
}

function makeSim(): TestSimulation {
  return createTestSimulation({
    systems: [],
    spawn: { x: CENTRE, y: CENTRE },
    flattenRadius: 64,
  });
}

describe('quantiseGoal', () => {
  it('snaps to the centre of a goal cell so a jogging target keeps one field', () => {
    // Mid-cell, so a quarter-cell of drift cannot cross a boundary.
    const middle = FLOW_GOAL_QUANTUM * 8 + FLOW_GOAL_QUANTUM / 2;
    const a = quantiseGoal(middle);
    expect(a).toBe(middle);
    expect(quantiseGoal(middle + FLOW_GOAL_QUANTUM / 4)).toBe(a);
    expect(quantiseGoal(middle - FLOW_GOAL_QUANTUM / 4)).toBe(a);
    expect(quantiseGoal(middle + FLOW_GOAL_QUANTUM)).not.toBe(a);
    // The snapping error is always inside the direct-steering bubble, so it can never
    // leave a creature aiming at the wrong side of a wall.
    expect(FLOW_GOAL_QUANTUM).toBeGreaterThanOrEqual(DIRECT_STEER_RANGE);
  });
});

describe('close-range steering', () => {
  it('walks straight at a nearby goal and does not path', () => {
    const sim = makeSim();
    const agent = makeAgent(CENTRE, CENTRE);
    const opts = options();
    const heading = steerTowards(sim.ctx, agent, CENTRE + 64, CENTRE, opts);

    expect(heading.x).toBeCloseTo(1, 6);
    expect(heading.y).toBeCloseTo(0, 6);
    expect(agent.path).toHaveLength(0);
    expect(opts.budget.paths).toBe(0);
  });

  it('reports a zero heading once it has arrived', () => {
    const sim = makeSim();
    const agent = makeAgent(CENTRE, CENTRE);
    const heading = steerTowards(sim.ctx, agent, CENTRE, CENTRE, options());
    expect(heading.x).toBe(0);
    expect(heading.y).toBe(0);
  });
});

describe('flow-field steering', () => {
  it('routes around a wall instead of pressing into it', () => {
    const sim = makeSim();
    // A wall on the column between agent and goal, blocking the direct line and every
    // row below it. The only way through is over the top.
    sim.wall(ANCHOR_TILE, ANCHOR_TILE, ANCHOR_TILE, ANCHOR_TILE + 12);

    const goalX = tileCenter(ANCHOR_TILE + 7);
    const opts = options();

    // Right up against the wall, seven tiles from the goal: still well past the
    // direct-steering bubble, so this is the flow field talking.
    const beside = makeAgent(tileCenter(ANCHOR_TILE - 1), CENTRE);
    expect(goalX - beside.x).toBeGreaterThan(DIRECT_STEER_RANGE);
    const around = steerTowards(sim.ctx, beside, goalX, CENTRE, opts);
    expect(around.y).toBeLessThan(0);

    // Further back, where the wall is not yet in the way, it just walks towards it.
    const behind = makeAgent(tileCenter(ANCHOR_TILE - 6), CENTRE, 'z2');
    const straight = steerTowards(sim.ctx, behind, goalX, CENTRE, opts);
    expect(straight.x).toBeGreaterThan(0);

    // A shared field costs one integration for the whole horde: no private searches.
    expect(opts.budget.paths).toBe(0);
    expect(beside.path).toHaveLength(0);
    expect(behind.path).toHaveLength(0);
  });

  it('lets a horde share one field by aiming every member at the same goal', () => {
    const sim = makeSim();
    const goalX = tileCenter(ANCHOR_TILE + 8);
    const opts = options();
    // Two members a tile apart, each with its own idea of the target, both handed the
    // horde's shared goal.
    const first = makeAgent(tileCenter(ANCHOR_TILE - 8), CENTRE, 'z1');
    const second = makeAgent(tileCenter(ANCHOR_TILE - 8), CENTRE + TILE_SIZE, 'z2');
    const a = steerTowards(sim.ctx, first, goalX, CENTRE + 7, {
      ...opts,
      flowGoalX: goalX,
      flowGoalY: CENTRE,
    });
    const b = steerTowards(sim.ctx, second, goalX, CENTRE - 7, {
      ...opts,
      flowGoalX: goalX,
      flowGoalY: CENTRE,
    });
    expect(a.x).toBeGreaterThan(0);
    expect(b.x).toBeGreaterThan(0);
    expect(opts.budget.paths).toBe(0);
    // One integration for the pair: the second member hit the cache.
    expect(opts.budget.fields).toBe(1);
  });

  it('spends one unit of field budget per build and none on a cache hit', () => {
    const sim = makeSim();
    const goalX = tileCenter(ANCHOR_TILE + 9);
    const opts = options();

    const first = makeAgent(tileCenter(ANCHOR_TILE - 9), CENTRE, 'z1');
    steerTowards(sim.ctx, first, goalX, CENTRE, opts);
    expect(opts.budget.fields).toBe(1);

    // Same goal cell on the same tick: the cache answers, so nothing is spent.
    const second = makeAgent(tileCenter(ANCHOR_TILE - 9), CENTRE + TILE_SIZE, 'z2');
    steerTowards(sim.ctx, second, goalX, CENTRE, opts);
    expect(opts.budget.fields).toBe(1);
  });

  it('stops building fields once the budget is spent, and falls back rather than stalling', () => {
    const sim = makeSim();
    const opts = { ...options(), maxFieldsPerTick: 1 };

    // First agent builds the one field the budget allows.
    const first = makeAgent(tileCenter(ANCHOR_TILE - 9), CENTRE, 'z1');
    const a = steerTowards(sim.ctx, first, tileCenter(ANCHOR_TILE + 9), CENTRE, opts);
    expect(a.x).toBeGreaterThan(0);
    expect(opts.budget.fields).toBe(1);

    // A second agent with a *different* goal cell would need its own integration. It must
    // not get one - and must still be given a direction, because a zombie that stops dead
    // because the server was busy is worse than one that takes a slightly worse route.
    const second = makeAgent(CENTRE, tileCenter(ANCHOR_TILE - 9), 'z2');
    const b = steerTowards(sim.ctx, second, CENTRE, tileCenter(ANCHOR_TILE + 9), opts);
    expect(opts.budget.fields).toBe(1);
    expect(Math.hypot(b.x, b.y)).toBeGreaterThan(0.5);
  });

  it('caps field builds no matter how many creatures ask', () => {
    const sim = makeSim();
    const opts = { ...options(64), maxFieldsPerTick: 3 };
    // Twenty creatures, each chasing a goal far enough apart to need its own field.
    for (let i = 0; i < 20; i++) {
      const agent = makeAgent(CENTRE, CENTRE, `z${i}`);
      steerTowards(sim.ctx, agent, tileCenter(ANCHOR_TILE + 12 + i * 12), CENTRE + i * 400, opts);
    }
    expect(opts.budget.fields).toBeLessThanOrEqual(3);
  });
});

describe('the A* fallback', () => {
  /** A goal far enough away that no cached flow field covers the agent. */
  const FAR_TILES = 40;

  it('is used only when the flow field cannot answer', () => {
    const sim = makeSim();
    const agent = makeAgent(CENTRE, CENTRE);
    const opts = options();
    const goalX = tileCenter(ANCHOR_TILE + FAR_TILES);

    const heading = steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    expect(opts.budget.paths).toBe(1);
    expect(agent.path.length).toBeGreaterThan(0);
    expect(agent.pathTick).toBe(sim.ctx.state.tick);
    expect(heading.x).toBeGreaterThan(0);
  });

  it('follows the stored path on later ticks without searching again', () => {
    const sim = makeSim();
    const agent = makeAgent(CENTRE, CENTRE);
    const opts = options();
    const goalX = tileCenter(ANCHOR_TILE + FAR_TILES);

    steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    expect(opts.budget.paths).toBe(1);
    steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    expect(opts.budget.paths).toBe(1);
  });

  it('will not re-search for the same creature inside the refresh window', () => {
    const sim = makeSim();
    const agent = makeAgent(CENTRE, CENTRE);
    const opts = options();
    const goalX = tileCenter(ANCHOR_TILE + FAR_TILES);

    steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    expect(opts.budget.paths).toBe(1);

    // Throw the path away, as a blocked step would: still no second search this tick.
    agent.path = [];
    agent.pathIndex = 0;
    steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    expect(opts.budget.paths).toBe(1);
    expect(agent.path).toHaveLength(0);

    // Once the window has passed, it may try again.
    sim.step(PATH_REFRESH_TICKS);
    steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    expect(opts.budget.paths).toBe(2);
  });

  it("respects the whole tick's shared cap", () => {
    const sim = makeSim();
    const opts = options(2);
    const goalX = tileCenter(ANCHOR_TILE + FAR_TILES);

    for (let i = 0; i < 6; i++) {
      const agent = makeAgent(CENTRE, CENTRE + i, `z${i}`);
      steerTowards(sim.ctx, agent, goalX, CENTRE, opts);
    }
    expect(opts.budget.paths).toBe(2);
  });
});

describe('separation', () => {
  it('pushes apart creatures that are overlapping', () => {
    const sim = makeSim();
    const left = sim.spawnZombie('walker', CENTRE - 4, CENTRE);
    sim.spawnZombie('walker', CENTRE + 4, CENTRE);
    // The spatial index is rebuilt at the top of a tick, so step once to publish them.
    sim.step(1);

    const push = separation(sim.ctx, left.id, left.x, left.y, 12, ['zombie'], []);
    expect(push.x).toBeLessThan(0);
    expect(Math.hypot(push.x, push.y)).toBeGreaterThan(0);
  });

  it('does nothing when nobody is crowding', () => {
    const sim = makeSim();
    const lone = sim.spawnZombie('walker', CENTRE, CENTRE);
    sim.spawnZombie('walker', CENTRE + 400, CENTRE);
    sim.step(1);

    const push = separation(sim.ctx, lone.id, lone.x, lone.y, 12, ['zombie'], []);
    expect(push.x).toBe(0);
    expect(push.y).toBe(0);
  });

  it('breaks an exact overlap rather than leaving a stable tie', () => {
    const sim = makeSim();
    const first = sim.spawnZombie('walker', CENTRE, CENTRE);
    sim.spawnZombie('walker', CENTRE, CENTRE);
    sim.step(1);

    const push = separation(sim.ctx, first.id, first.x, first.y, 12, ['zombie'], []);
    expect(Math.hypot(push.x, push.y)).toBeGreaterThan(0.5);
  });

  it('ignores kinds it was not asked about', () => {
    const sim = makeSim();
    const zombie = sim.spawnZombie('walker', CENTRE, CENTRE);
    sim.spawnAnimal('cow', CENTRE + 6, CENTRE);
    sim.step(1);

    // A cow standing on a zombie's toes is the cow's problem, not the zombie's.
    const fromZombies = separation(sim.ctx, zombie.id, zombie.x, zombie.y, 12, ['zombie'], []);
    expect(Math.hypot(fromZombies.x, fromZombies.y)).toBe(0);
    const fromAnimals = separation(sim.ctx, zombie.id, zombie.x, zombie.y, 12, ['animal'], []);
    expect(Math.hypot(fromAnimals.x, fromAnimals.y)).toBeGreaterThan(0);
  });
});

describe('blendSteering', () => {
  it('returns a unit heading', () => {
    const blended = blendSteering({ x: 1, y: 0 }, { x: 0, y: 3 });
    expect(Math.hypot(blended.x, blended.y)).toBeCloseTo(1, 6);
    expect(blended.x).toBeGreaterThan(0);
    expect(blended.y).toBeGreaterThan(0);
  });

  it('leaves the desired direction alone when there is no push', () => {
    const blended = blendSteering({ x: 0, y: -1 }, { x: 0, y: 0 });
    expect(blended.x).toBeCloseTo(0, 6);
    expect(blended.y).toBeCloseTo(-1, 6);
  });

  it('collapses to zero when there is nothing to steer by', () => {
    const blended = blendSteering({ x: 0, y: 0 }, { x: 0, y: 0 });
    expect(blended).toEqual({ x: 0, y: 0 });
  });
});

describe('pathfinder budget, end to end', () => {
  it('never runs more searches per tick than the cap, however big the horde', () => {
    const base = createFlatWorld({ seed: 4242 });
    let calls = 0;
    const world: WorldService = {
      ...base,
      findPath: (fromX, fromY, toX, toY, pathOptions) => {
        calls++;
        return base.findPath(fromX, fromY, toX, toY, pathOptions);
      },
    };

    const sim = createTestSimulation({
      world,
      systems: [createZombieAiSystem()],
      spawn: { x: CENTRE, y: CENTRE },
      flattenRadius: 64,
      config: (config) => {
        config.tuning.playerDamageTaken = 0;
      },
    });
    const player = sim.addPlayer({ x: CENTRE, y: CENTRE });
    // A maze wall the horde has to work around, so the fallback is genuinely tempted.
    sim.wall(ANCHOR_TILE - 10, ANCHOR_TILE - 30, ANCHOR_TILE - 10, ANCHOR_TILE + 30);

    for (let i = 0; i < 120; i++) {
      const zombie = sim.spawnZombie('walker', CENTRE - 700 - (i % 10) * 20, CENTRE - 300 + i * 5);
      // Already hunting, so every one of them wants a route past the wall.
      zombie.ai = 'pursue';
      zombie.targetId = player.id;
      zombie.lastSeenX = player.x;
      zombie.lastSeenY = player.y;
      zombie.loseInterestTick = 1_000_000;
    }

    const ticks = 100;
    sim.step(ticks);
    expect(calls).toBeLessThanOrEqual(MAX_ZOMBIE_PATHS_PER_TICK * ticks);
    // And nothing else in the tick decided to path on its own behalf.
    expect(pixelToTile(player.x)).toBe(ANCHOR_TILE);
  });
});
