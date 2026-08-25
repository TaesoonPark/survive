import { describe, expect, it } from 'vitest';
import { Button, pixelToTile, type ProjectileState, type PlayerState } from '@survive/protocol';
import {
  createTestSimulation,
  type TestSimulation,
  type TestSimulationOptions,
} from '@survive/test-utils';
import { bindInputSource, createInputSystem } from '../movement/input';
import { createCombatSystem } from './combat';
import {
  PROJECTILE_MAX_LIFETIME_TICKS,
  createProjectileSystem,
  damageAtRange,
  spawnProjectile,
} from './projectiles';

/**
 * Projectile tests.
 *
 * The single most important property here is that nothing tunnels. A .308 round covers
 * 340 px - more than ten tiles - in one 50 ms tick, so a hit test that looked only at
 * where the round ended up would miss every target and every wall it crossed. Several of
 * these tests exist purely to pin that down, and one of them (`hits a target only once`)
 * pins the mirror-image bug: a slow piercing round finding the same body again next tick
 * because it is still inside the hit radius of the new segment's start.
 */

function makeSim(options: Omit<TestSimulationOptions, 'systems'> = {}): TestSimulation {
  const sim = createTestSimulation({
    ...options,
    systems: [createInputSystem(), createCombatSystem(), createProjectileSystem()],
  });
  bindInputSource(sim.sim);
  return sim;
}

/** Put a round in the air by hand, so speed, damage and pierce are all controlled. */
function fire(
  sim: TestSimulation,
  player: PlayerState,
  defId: string,
  options: { damage?: number; angle?: number; maxRange?: number; armorPen?: number } = {},
): ProjectileState {
  const projectile = spawnProjectile(sim.ctx, {
    ownerId: player.id,
    defId,
    x: player.x,
    y: player.y,
    angle: options.angle ?? 0,
    damage: options.damage ?? 20,
    armorPen: options.armorPen ?? 0,
    maxRange: options.maxRange ?? 4000,
  });
  if (!projectile) throw new Error(`fire: could not spawn ${defId}`);
  return projectile;
}

function damageEventsFor(sim: TestSimulation, targetId: string): number {
  return sim.eventsOf('damage').filter((event) => event.targetId === targetId).length;
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

describe('projectile flight', () => {
  it('travels and keeps the previous position so the hit test can sweep', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const arrow = fire(sim, player, 'arrow_wooden');
    const startX = arrow.x;

    sim.step(1);

    const live = sim.sim.state.projectiles[arrow.id];
    expect(live).toBeDefined();
    expect(live!.prevX).toBeCloseTo(startX, 6);
    // 900 px/s at 20 Hz is 45 px a tick.
    expect(live!.x - startX).toBeCloseTo(45, 4);
    expect(live!.travelled).toBeCloseTo(45, 4);
  });

  it('despawns once it has flown its maximum range', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const arrow = fire(sim, player, 'arrow_wooden', { maxRange: 200 });

    sim.step(4);
    expect(sim.sim.state.projectiles[arrow.id]).toBeDefined();
    sim.step(2);
    expect(sim.sim.state.projectiles[arrow.id]).toBeUndefined();
  });

  it('despawns on the lifetime cap even if it never runs out of range', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // A stationary round would otherwise sit in the air forever.
    const stuck = fire(sim, player, 'arrow_wooden', { maxRange: 4000 });
    stuck.vx = 0;
    stuck.vy = 0;

    sim.step(PROJECTILE_MAX_LIFETIME_TICKS + 2);

    expect(sim.sim.state.projectiles[stuck.id]).toBeUndefined();
  });

  it('never hits the shooter', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    fire(sim, player, 'arrow_wooden');

    sim.step(5);

    expect(damageEventsFor(sim, player.id)).toBe(0);
    expect(player.health).toBe(player.maxHealth);
  });

  it('spares other players when PvP is off and hits them when it is on', () => {
    const peaceful = makeSim();
    const shooter = peaceful.addPlayer({ id: 'p1' });
    const bystander = peaceful.addPlayer({
      id: 'p2',
      x: peaceful.spawn.x + 100,
      y: peaceful.spawn.y,
    });
    fire(peaceful, shooter, 'bullet_9mm');
    peaceful.step(3);
    expect(bystander.health).toBe(bystander.maxHealth);

    const hostile = makeSim({ config: (config) => void (config.mode.pvp = true) });
    const shooter2 = hostile.addPlayer({ id: 'p1' });
    const target = hostile.addPlayer({ id: 'p2', x: hostile.spawn.x + 100, y: hostile.spawn.y });
    fire(hostile, shooter2, 'bullet_9mm');
    hostile.step(3);
    expect(target.health).toBeLessThan(target.maxHealth);
  });

  it('keeps sparing them when the shooter disconnects mid-flight', () => {
    // Whether friendly fire applies is a server setting. It used to be decided by whether
    // the owner was still in `state.players` when the round landed - and a socket closing
    // removes them immediately, so a shooter who quit while their bullet was in the air
    // turned it into a zombie's bullet. The client chose the moment, which made the
    // setting the client's to override.
    const peaceful = makeSim();
    const shooter = peaceful.addPlayer({ id: 'p1' });
    const bystander = peaceful.addPlayer({
      id: 'p2',
      x: peaceful.spawn.x + 100,
      y: peaceful.spawn.y,
    });

    fire(peaceful, shooter, 'bullet_9mm');
    // Gone before the round arrives, exactly as a quit would leave it.
    peaceful.sim.removePlayer('p1');
    peaceful.step(3);

    expect(bystander.health).toBe(bystander.maxHealth);
  });
});

// ---------------------------------------------------------------------------
// Tunnelling
// ---------------------------------------------------------------------------

describe('no tunnelling', () => {
  it('hits a target the round crosses entirely within one tick', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // A .308 covers 340 px in a tick; the walker is 200 px out, so a naive test
    // against the end position would find nothing at all.
    const target = sim.spawnZombie('walker', player.x + 200, player.y);
    fire(sim, player, 'bullet_308', { damage: 10 });

    sim.step(1);

    expect(target.health).toBeLessThan(target.maxHealth);
    expect(sim.lastEvent('projectileHit')?.targetId).toBe(target.id);
  });

  it('stops at a wall the round crosses entirely within one tick', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x);
    const tileY = pixelToTile(player.y);
    // Wall three tiles out, target five tiles out: both inside one tick of flight.
    sim.wall(tileX + 3, tileY - 2, tileX + 3, tileY + 2);
    const shielded = sim.spawnZombie('walker', player.x + 160, player.y);
    fire(sim, player, 'bullet_308', { damage: 10 });

    sim.step(2);

    expect(shielded.health).toBe(shielded.maxHealth);
    const hit = sim.lastEvent('projectileHit');
    expect(hit).toBeDefined();
    expect(hit!.targetId).toBeUndefined();
  });

  it('hits the nearer of two targets first', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const near = sim.spawnZombie('walker', player.x + 60, player.y);
    const far = sim.spawnZombie('walker', player.x + 220, player.y);
    // 9 mm does not pierce, so exactly one of them can be hit.
    fire(sim, player, 'bullet_9mm', { damage: 10 });

    sim.step(2);

    expect(near.health).toBeLessThan(near.maxHealth);
    expect(far.health).toBe(far.maxHealth);
  });
});

// ---------------------------------------------------------------------------
// Pierce
// ---------------------------------------------------------------------------

describe('pierce', () => {
  it('passes through one body and stops in the second', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // A bolt pierces one target.
    const first = sim.spawnZombie('walker', player.x + 30, player.y);
    const second = sim.spawnZombie('walker', player.x + 120, player.y);
    const third = sim.spawnZombie('walker', player.x + 200, player.y);
    fire(sim, player, 'bolt', { damage: 5 });

    sim.step(8);

    expect(first.health).toBeLessThan(first.maxHealth);
    expect(second.health).toBeLessThan(second.maxHealth);
    expect(third.health).toBe(third.maxHealth);
  });

  it('stops in the first body when it cannot pierce at all', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const first = sim.spawnZombie('walker', player.x + 30, player.y);
    const second = sim.spawnZombie('walker', player.x + 120, player.y);
    fire(sim, player, 'arrow_wooden', { damage: 5 });

    sim.step(8);

    expect(first.health).toBeLessThan(first.maxHealth);
    expect(second.health).toBe(second.maxHealth);
  });

  it('hits a target only once, even when the tick ends just past it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    // A bolt moves 57.5 px a tick. At 45 px out, the target ends up 12.5 px *behind*
    // the next tick's segment start - still inside the 17 px hit radius - so without
    // a wound list a piercing round would collect it a second time for free.
    const target = sim.spawnZombie('walker', player.x + 45, player.y);
    fire(sim, player, 'bolt', { damage: 4 });

    sim.step(20);

    expect(damageEventsFor(sim, target.id)).toBe(1);
  });

  it('forgets its wound list once the round is gone', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const target = sim.spawnZombie('walker', player.x + 45, player.y);

    fire(sim, player, 'bolt', { damage: 4 });
    sim.step(20);
    expect(damageEventsFor(sim, target.id)).toBe(1);

    // A second, entirely separate round must be able to hit the same walker.
    fire(sim, player, 'bolt', { damage: 4 });
    sim.step(20);
    expect(damageEventsFor(sim, target.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Range falloff
// ---------------------------------------------------------------------------

describe('range falloff', () => {
  it('interpolates linearly from the muzzle to the maximum range', () => {
    const projectile = { damage: 100, maxRange: 1000 } as ProjectileState;
    expect(damageAtRange(projectile, 0.5, 0)).toBeCloseTo(100, 6);
    expect(damageAtRange(projectile, 0.5, 500)).toBeCloseTo(75, 6);
    expect(damageAtRange(projectile, 0.5, 1000)).toBeCloseTo(50, 6);
    // Past the cap the falloff floors rather than inverting.
    expect(damageAtRange(projectile, 0.5, 4000)).toBeCloseTo(50, 6);
  });

  it('does much less damage at the far edge of a shotgun reach', () => {
    // Animals take flat damage with no body-part roll, so the two numbers compare
    // directly. Buckshot keeps 30% of its bite at maximum range.
    const hitAt = (distance: number): number => {
      const sim = makeSim({ seed: 777 });
      const player = sim.addPlayer();
      const deer = sim.spawnAnimal('deer', player.x + distance, player.y);
      fire(sim, player, 'pellet', { damage: 40, maxRange: 420 });
      sim.step(6);
      return sim
        .eventsOf('damage')
        .filter((event) => event.targetId === deer.id)
        .reduce((sum, event) => sum + event.amount, 0);
    };
    const point = hitAt(40);
    const distant = hitAt(380);
    expect(point).toBeGreaterThan(0);
    expect(distant).toBeGreaterThan(0);
    expect(distant).toBeLessThan(point * 0.6);
  });
});

// ---------------------------------------------------------------------------
// Terrain and structures
// ---------------------------------------------------------------------------

describe('projectiles and the world', () => {
  it('damages the structure it stops on', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x) + 3;
    const tileY = pixelToTile(player.y);
    const wall = sim.placeStructure('wall_wood', tileX, tileY);
    expect(wall).not.toBeNull();

    fire(sim, player, 'bullet_9mm', { damage: 40 });
    sim.step(2);

    expect(wall!.health).toBeLessThan(wall!.maxHealth);
    expect(sim.lastEvent('structureDamaged')?.structureId).toBe(wall!.id);
  });

  it('does not damage plain terrain, but does stop on it', () => {
    const sim = makeSim();
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x);
    const tileY = pixelToTile(player.y);
    sim.wall(tileX + 3, tileY - 1, tileX + 3, tileY + 1);

    const bullet = fire(sim, player, 'bullet_9mm', { damage: 40 });
    sim.step(2);

    expect(sim.sim.state.projectiles[bullet.id]).toBeUndefined();
    expect(sim.eventsOf('structureDamaged')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ammunition recovery
// ---------------------------------------------------------------------------

describe('ammunition recovery', () => {
  it('leaves some arrows on the ground where they struck', () => {
    const sim = makeSim({ seed: 3131 });
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x);
    const tileY = pixelToTile(player.y);
    sim.wall(tileX + 4, tileY - 2, tileX + 4, tileY + 2);

    for (let i = 0; i < 10; i++) {
      fire(sim, player, 'arrow_wooden', { damage: 5 });
      sim.step(4);
    }

    const recovered = Object.values(sim.sim.state.items).filter(
      (item) => item.stack.defId === 'arrow_wooden',
    );
    // Roughly half of wooden arrows survive; ten shots must leave at least one and
    // cannot leave more than ten.
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered.length).toBeLessThanOrEqual(10);
  });

  it('never leaves a spent bullet behind', () => {
    const sim = makeSim({ seed: 3131 });
    const player = sim.addPlayer();
    const tileX = pixelToTile(player.x);
    const tileY = pixelToTile(player.y);
    sim.wall(tileX + 4, tileY - 2, tileX + 4, tileY + 2);

    for (let i = 0; i < 10; i++) {
      fire(sim, player, 'bullet_9mm', { damage: 5 });
      sim.step(4);
    }

    expect(Object.keys(sim.sim.state.items)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End to end, through the weapon
// ---------------------------------------------------------------------------

describe('shooting for real', () => {
  it('kills a walker with a rifle round fired from the hip', () => {
    const sim = makeSim({ seed: 2024 });
    const player = sim.addPlayer();
    sim.equip(player, 'rifle_308');
    sim.giveItem(player, 'ammo_308', 10);
    sim.command(player, { type: 'reload' });
    for (let i = 0; i < 200 && !sim.lastEvent('reloaded'); i++) {
      sim.input(player, { buttons: 0 });
      sim.step(1);
    }
    const target = sim.spawnZombie('walker', player.x + 300, player.y);

    sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
    sim.step(1);
    sim.input(player, { buttons: 0, aimAngle: 0 });
    sim.step(2);

    expect(target.health).toBeLessThan(target.maxHealth);
    expect(sim.eventsOf('projectileHit').some((event) => event.targetId === target.id)).toBe(true);
    // A rifle hit trains the ranged skill, not melee.
    expect(sim.eventsOf('skillXp').some((event) => event.skill === 'ranged')).toBe(true);
  });

  it('is deterministic: the same seed puts the same buckshot in the same walkers', () => {
    const run = () => {
      const sim = makeSim({ seed: 6161 });
      const player = sim.addPlayer({ id: 'p1' });
      sim.equip(player, 'shotgun');
      sim.giveItem(player, 'ammo_shell', 10);
      sim.command(player, { type: 'reload' });
      for (let i = 0; i < 200 && !sim.lastEvent('reloaded'); i++) {
        sim.input(player, { buttons: 0 });
        sim.step(1);
      }
      sim.spawnZombie('walker', player.x + 90, player.y - 24);
      sim.spawnZombie('walker', player.x + 90, player.y);
      sim.spawnZombie('walker', player.x + 90, player.y + 24);

      sim.input(player, { buttons: Button.Primary, aimAngle: 0 });
      sim.step(1);
      sim.input(player, { buttons: 0, aimAngle: 0 });
      sim.step(6);

      return Object.keys(sim.sim.state.zombies)
        .sort()
        .map((id) => {
          const zombie = sim.sim.state.zombies[id]!;
          return { id, health: zombie.health, ai: zombie.ai };
        });
    };
    expect(run()).toEqual(run());
  });
});
