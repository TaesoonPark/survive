import { describe, expect, it } from 'vitest';
import {
  Tile,
  distance,
  pixelToTile,
  type PlayerState,
  type StructureState,
} from '@survive/protocol';
import { createTestSimulation, type TestSimulation } from '@survive/test-utils';
import { RESPAWN_DELAY_TICKS, killPlayer } from '../../core/death';
import { removeStructure } from '../../core/structures';
import { createCraftingSystem } from '../crafting/crafting';
import { createSurvivalSystem } from './survivalSystem';
import { bedCenter, sleepingBed } from './sleep';
import {
  SLEEP_REACH,
  SLEEP_THREAT_RADIUS,
  WELL_RESTED_FATIGUE,
  WELL_RESTED_MAGNITUDE,
} from './tuning';

/**
 * Sleeping, waking and coming back from the dead.
 *
 * Beds are placed straight into the world rather than built: what is under test is what
 * a bed *does*, and routing through the building system's costs and skill gates would
 * make these tests fail for reasons that live in another file.
 */

interface Bunk {
  harness: TestSimulation;
  player: PlayerState;
  bed: StructureState;
}

/** A player standing on a finished bed, ready to lie down. */
function bunk(defId = 'bed_wood', singlePlayer = true): Bunk {
  const harness = createTestSimulation({
    systems: [createSurvivalSystem()],
    config: (config) => {
      config.mode.singlePlayer = singlePlayer;
      if (!singlePlayer) config.mode.maxPlayers = 8;
    },
  });
  const player = harness.addPlayer();
  const bed = harness.placeStructure(defId, pixelToTile(player.x) + 2, pixelToTile(player.y));
  if (!bed) throw new Error(`bunk: could not place ${defId}`);
  const centre = bedCenter(harness.ctx, bed);
  player.x = centre.x;
  player.y = centre.y;
  player.fatigue = 80;
  return { harness, player, bed };
}

function lieDown({ harness, player, bed }: Bunk): void {
  harness.run(player, { type: 'sleep', structureId: bed.id });
}

// ---------------------------------------------------------------------------
// Sleeping
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('claims the bed, announces it, and pins the sleeper', () => {
    const scene = bunk();
    lieDown(scene);

    expect(scene.bed.bed?.occupantId).toBe(scene.player.id);
    expect(scene.bed.bed?.sleepStartTick).toBe(scene.harness.sim.state.tick);
    expect(sleepingBed(scene.harness.ctx, scene.player)).toBe(scene.bed);
    expect(scene.harness.lastEvent('sleepStarted')?.structureId).toBe(scene.bed.id);

    scene.harness.step(1);
    expect(scene.player.actionLockedUntilTick).toBeGreaterThan(scene.harness.sim.state.tick);
  });

  it('sheds fatigue far faster than resting awake', () => {
    const asleep = bunk();
    lieDown(asleep);
    const awake = bunk();

    asleep.harness.advanceSeconds(10);
    awake.harness.advanceSeconds(10);

    expect(asleep.player.fatigue).toBeLessThan(70);
    expect(awake.player.fatigue).toBeGreaterThan(80);
  });

  it('heals wounds much faster than lying awake', () => {
    const asleep = bunk();
    asleep.player.hunger = 0;
    asleep.player.thirst = 0;
    asleep.player.body.parts.torso.health = 50;
    lieDown(asleep);

    const awake = bunk();
    awake.player.hunger = 0;
    awake.player.thirst = 0;
    awake.player.body.parts.torso.health = 50;

    asleep.harness.advanceSeconds(20);
    awake.harness.advanceSeconds(20);

    expect(asleep.player.body.parts.torso.health).toBeGreaterThan(
      awake.player.body.parts.torso.health + 3,
    );
  });

  it('gives a lone single-player sleeper more recovery than a multiplayer one', () => {
    const solo = bunk('bed_wood', true);
    const shared = bunk('bed_wood', false);
    lieDown(solo);
    lieDown(shared);

    solo.harness.advanceSeconds(10);
    shared.harness.advanceSeconds(10);

    // Nobody else is waiting on the world in single player, so the night passes for
    // the sleeper instead of the clock. In multiplayer it is real recovery only.
    expect(solo.player.fatigue).toBeLessThan(shared.player.fatigue - 10);
    expect(shared.player.fatigue).toBeLessThan(80);
  });

  it('rests better in a real bed than in a bedroll', () => {
    const good = bunk('bed_wood');
    const rough = bunk('bed_bedroll');
    lieDown(good);
    lieDown(rough);

    good.harness.advanceSeconds(10);
    rough.harness.advanceSeconds(10);

    expect(good.player.fatigue).toBeLessThan(rough.player.fatigue);
  });

  it('claims the bed as a respawn point', () => {
    const scene = bunk();
    const centre = bedCenter(scene.harness.ctx, scene.bed);
    lieDown(scene);

    expect(scene.player.bedStructureId).toBe(scene.bed.id);
    expect(scene.player.spawnX).toBeCloseTo(centre.x, 5);
    expect(scene.player.spawnY).toBeCloseTo(centre.y, 5);
  });

  it('wakes on the wake command and reports how long it lasted', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.advanceSeconds(5);

    scene.harness.run(scene.player, { type: 'wake' });

    expect(scene.bed.bed?.occupantId).toBeUndefined();
    expect(sleepingBed(scene.harness.ctx, scene.player)).toBeUndefined();
    const ended = scene.harness.lastEvent('sleepEnded');
    expect(ended?.playerId).toBe(scene.player.id);
    expect(ended?.ticksSlept).toBeGreaterThan(90);
  });

  it('wakes by itself once the player is fully rested', () => {
    const scene = bunk();
    scene.player.fatigue = 2;
    lieDown(scene);

    scene.harness.advanceSeconds(3);

    // Woken at zero; the counter starts climbing again the moment they are up.
    expect(scene.player.fatigue).toBeLessThan(0.5);
    expect(sleepingBed(scene.harness.ctx, scene.player)).toBeUndefined();
    expect(
      scene.harness
        .eventsOf('notification')
        .some((event) => event.message.code === 'notify.wake.rested'),
    ).toBe(true);
  });

  it('is dragged awake by a zombie wandering into the room', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.advanceSeconds(2);
    scene.harness.clearEvents();

    scene.harness.spawnZombie('walker', scene.player.x + 64, scene.player.y);
    scene.harness.step(2);

    expect(sleepingBed(scene.harness.ctx, scene.player)).toBeUndefined();
    expect(scene.harness.eventsOf('sleepEnded')).toHaveLength(1);
    expect(
      scene.harness
        .eventsOf('notification')
        .some((event) => event.message.code === 'notify.wake.threat'),
    ).toBe(true);
  });

  it('wakes when the bed is destroyed underneath the sleeper', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.advanceSeconds(2);
    scene.harness.clearEvents();

    removeStructure(scene.harness.ctx, scene.bed);
    scene.harness.step(2);

    expect(scene.harness.eventsOf('sleepEnded')).toHaveLength(1);
    expect(
      scene.harness
        .eventsOf('notification')
        .some((event) => event.message.code === 'notify.wake.bedLost'),
    ).toBe(true);
    // Fatigue is rising again, not falling.
    const fatigue = scene.player.fatigue;
    scene.harness.advanceSeconds(5);
    expect(scene.player.fatigue).toBeGreaterThan(fatigue);
  });

  it('gets up when the player walks off the bed', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.advanceSeconds(2);

    scene.player.x += 400;
    scene.harness.step(2);

    expect(sleepingBed(scene.harness.ctx, scene.player)).toBeUndefined();
  });

  it('frees the bed when the sleeper disconnects', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.advanceSeconds(2);

    scene.harness.sim.removePlayer(scene.player.id);

    expect(scene.bed.bed?.occupantId).toBeUndefined();
    expect(scene.harness.eventsOf('sleepEnded')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sleep rejections
// ---------------------------------------------------------------------------

describe('a bed behind a wall is not reachable', () => {
  it('refuses to sleep in, or claim, a bed on the far side of a wall', () => {
    // Distance alone is not reach. `SLEEP_REACH` is two tiles, so a bed one tile beyond a
    // wall measures 63 px and passed the only check there was - which let a player lie down
    // in, and set their respawn point to, a bed sealed inside someone else's base. Every
    // other structure interaction pairs distance with line of sight; beds did not.
    const harness = createTestSimulation({
      systems: [createSurvivalSystem()],
      flattenRadius: 30,
    });
    const player = harness.addPlayer();
    const px = pixelToTile(player.x);
    const py = pixelToTile(player.y);

    const bed = harness.placeStructure('bed_wood', px + 2, py);
    if (!bed) throw new Error('could not place the bed');
    bed.progress = 1;
    harness.wall(px + 1, py - 3, px + 1, py + 3);
    player.fatigue = 80;

    // The premise: close enough to pass the distance test, with no line to it.
    const centre = bedCenter(harness.ctx, bed);
    expect(distance(player.x, player.y, centre.x, centre.y)).toBeLessThan(SLEEP_REACH);
    expect(harness.world.hasLineOfSight(player.x, player.y, centre.x, centre.y)).toBe(false);

    harness.clearEvents();
    harness.run(player, { type: 'sleep', structureId: bed.id });
    expect(harness.eventsOf('sleepStarted')).toHaveLength(0);
    expect(player.bedStructureId).toBeUndefined();

    harness.clearEvents();
    harness.run(player, { type: 'setSpawnPoint', structureId: bed.id });
    expect(player.bedStructureId).toBeUndefined();

    // ...and it still works with the wall gone, so this is the line and not the distance.
    for (let ty = py - 3; ty <= py + 3; ty++) harness.world.setTile(px + 1, ty, Tile.Grass);
    harness.clearEvents();
    harness.run(player, { type: 'sleep', structureId: bed.id });
    expect(harness.eventsOf('sleepStarted')).toHaveLength(1);
  });
});

describe('sleeping with work queued', () => {
  it("drops the hand queue's reserved materials beside the bed rather than deleting them", () => {
    // Clearing the queue on sleep is deliberate - you do not craft while unconscious - but
    // the materials it reserved had already left the pack, so dropping the array dropped
    // them out of the world. Lying down was a way to destroy your own inputs.
    //
    // Both systems, deliberately: with only survival running the `craft` command is never
    // handled, the queue stays empty, and an assertion about its materials would pass
    // without testing anything.
    const harness = createTestSimulation({
      systems: [createSurvivalSystem(), createCraftingSystem()],
      config: (config) => {
        config.mode.singlePlayer = true;
      },
    });
    const player = harness.addPlayer();
    const bed = harness.placeStructure(
      'bed_wood',
      pixelToTile(player.x) + 2,
      pixelToTile(player.y),
    );
    if (!bed) throw new Error('could not place the bed');
    const centre = bedCenter(harness.ctx, bed);
    player.x = centre.x;
    player.y = centre.y;
    player.fatigue = 80;

    harness.giveItem(player, 'plant_fiber', 5);
    harness.run(player, { type: 'craft', recipeId: 'craft_rope', count: 1 });

    // The premise, asserted rather than assumed.
    expect(player.craftQueue).toHaveLength(1);
    const reserved = player.craftQueue.flatMap((job) => job.reserved ?? []);
    const expected = reserved.reduce((total, stack) => total + stack.count, 0);
    expect(expected).toBe(5);

    harness.run(player, { type: 'sleep', structureId: bed.id });
    expect(harness.lastEvent('sleepStarted')?.structureId).toBe(bed.id);
    expect(player.craftQueue).toHaveLength(0);

    const onGround = Object.values(harness.sim.state.items)
      .filter((item) => item.stack.defId === 'plant_fiber')
      .reduce((total, item) => total + item.stack.count, 0);
    expect(onGround).toBe(expected);
  });
});

describe('sleep rejections', () => {
  const lastReason = (harness: TestSimulation): string | undefined =>
    harness.lastEvent('commandRejected')?.reason;

  it('refuses a structure that does not exist', () => {
    const scene = bunk();
    scene.harness.run(scene.player, { type: 'sleep', structureId: 'sNope' });
    expect(lastReason(scene.harness)).toBe('no such structure');
  });

  it('refuses something that is not a bed', () => {
    const scene = bunk();
    const box = scene.harness.placeStructure(
      'storage_box',
      pixelToTile(scene.player.x) + 1,
      pixelToTile(scene.player.y) + 1,
    );
    scene.harness.run(scene.player, { type: 'sleep', structureId: box?.id ?? 'sNope' });
    expect(lastReason(scene.harness)).toBe('that is not a usable bed');
  });

  it('refuses an unfinished bed frame', () => {
    const scene = bunk();
    scene.bed.progress = 0.4;
    lieDown(scene);
    expect(lastReason(scene.harness)).toBe('that is not a usable bed');
  });

  it('refuses a bed the player cannot reach', () => {
    const scene = bunk();
    scene.player.x += 600;
    lieDown(scene);
    expect(lastReason(scene.harness)).toBe('too far from the bed');
  });

  it('refuses a bed someone else is in', () => {
    const scene = bunk();
    if (scene.bed.bed) scene.bed.bed.occupantId = 'someone-else';
    lieDown(scene);
    expect(lastReason(scene.harness)).toBe('someone is already in it');
  });

  it('refuses to sleep with zombies at the door', () => {
    const scene = bunk();
    scene.harness.spawnZombie('walker', scene.player.x + SLEEP_THREAT_RADIUS / 2, scene.player.y);
    scene.harness.step(1);
    lieDown(scene);
    expect(lastReason(scene.harness)).toBe('not with those things so close');
  });

  it('refuses to sleep twice', () => {
    const scene = bunk();
    lieDown(scene);
    lieDown(scene);
    expect(lastReason(scene.harness)).toBe('already asleep');
  });

  it('refuses to sleep while dead', () => {
    const scene = bunk();
    scene.player.alive = false;
    lieDown(scene);
    expect(lastReason(scene.harness)).toBe('you are dead');
  });

  it('refuses to wake someone who is not asleep', () => {
    const scene = bunk();
    scene.harness.run(scene.player, { type: 'wake' });
    expect(lastReason(scene.harness)).toBe('you are not asleep');
  });
});

// ---------------------------------------------------------------------------
// Respawn
// ---------------------------------------------------------------------------

describe('respawn', () => {
  it('refuses a player who is not dead', () => {
    const scene = bunk();
    scene.harness.run(scene.player, { type: 'respawn', atBed: false });
    expect(scene.harness.lastEvent('commandRejected')?.reason).toBe('you are not dead');
    expect(scene.harness.eventsOf('playerRespawned')).toHaveLength(0);
  });

  it('refuses until the death timer has run out, then allows it', () => {
    const scene = bunk();
    killPlayer(scene.harness.ctx, scene.player, 'test');

    scene.harness.run(scene.player, { type: 'respawn', atBed: false });
    expect(scene.harness.lastEvent('commandRejected')?.reason).toMatch(/^wait \d+ more ticks$/);
    expect(scene.player.alive).toBe(false);

    scene.harness.step(RESPAWN_DELAY_TICKS);
    scene.harness.run(scene.player, { type: 'respawn', atBed: false });

    expect(scene.player.alive).toBe(true);
    expect(scene.harness.lastEvent('playerRespawned')?.playerId).toBe(scene.player.id);
  });

  it('puts the player back at their spawn point and wipes their condition', () => {
    const scene = bunk();
    const { player } = scene;
    player.spawnX = player.x - 320;
    player.spawnY = player.y;
    player.body.parts.leftArm.bleeding = 4;
    player.body.parts.leftArm.fractured = true;
    player.blood = 20;
    player.hunger = 95;
    killPlayer(scene.harness.ctx, player, 'starvation');

    scene.harness.step(RESPAWN_DELAY_TICKS + 1);
    scene.harness.run(player, { type: 'respawn', atBed: false });

    expect(player.x).toBeCloseTo(player.spawnX, 5);
    expect(player.blood).toBe(100);
    expect(player.hunger).toBeLessThan(50);
    expect(player.body.parts.leftArm.bleeding).toBe(0);
    expect(player.body.parts.leftArm.fractured).toBe(false);
    expect(player.effects).toHaveLength(0);
    expect(player.deathCause).toBeUndefined();
    expect(player.respawnAtTick).toBe(-1);
  });

  it('puts the player back at their bed when they ask for it', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.run(scene.player, { type: 'wake' });
    const centre = bedCenter(scene.harness.ctx, scene.bed);
    // Somewhere else entirely, so "at the bed" is distinguishable from "where I died".
    scene.player.spawnX = scene.player.x - 900;
    killPlayer(scene.harness.ctx, scene.player, 'test');

    scene.harness.step(RESPAWN_DELAY_TICKS + 1);
    scene.harness.run(scene.player, { type: 'respawn', atBed: true });

    expect(scene.player.alive).toBe(true);
    expect(scene.player.x).toBeCloseTo(centre.x, 5);
    expect(scene.player.y).toBeCloseTo(centre.y, 5);
  });

  it('falls back to the spawn point, with a warning, when the bed is gone', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.run(scene.player, { type: 'wake' });
    scene.player.spawnX = scene.player.x - 640;
    const spawnX = scene.player.spawnX;
    killPlayer(scene.harness.ctx, scene.player, 'test');
    removeStructure(scene.harness.ctx, scene.bed);
    scene.harness.clearEvents();

    scene.harness.step(RESPAWN_DELAY_TICKS + 1);
    scene.harness.run(scene.player, { type: 'respawn', atBed: true });

    expect(scene.player.alive).toBe(true);
    expect(scene.player.x).toBeCloseTo(spawnX, 5);
    expect(
      scene.harness
        .eventsOf('notification')
        .some((event) => event.message.code === 'notify.bedGone'),
    ).toBe(true);
  });

  it('frees the bed of a player who died in it', () => {
    const scene = bunk();
    lieDown(scene);
    killPlayer(scene.harness.ctx, scene.player, 'test');
    // The survival pass releases the bed for a corpse on the next tick.
    scene.harness.step(RESPAWN_DELAY_TICKS + 1);
    expect(scene.bed.bed?.occupantId).toBeUndefined();

    scene.harness.run(scene.player, { type: 'respawn', atBed: true });
    expect(scene.player.alive).toBe(true);
  });

  it('never drops a player inside geometry', () => {
    const scene = bunk();
    const { player, harness } = scene;
    player.spawnX = player.x + 320;
    player.spawnY = player.y;
    // Wall the spawn point in solidly.
    harness.wall(
      pixelToTile(player.spawnX) - 1,
      pixelToTile(player.spawnY) - 1,
      pixelToTile(player.spawnX) + 1,
      pixelToTile(player.spawnY) + 1,
    );
    killPlayer(harness.ctx, player, 'test');

    harness.step(RESPAWN_DELAY_TICKS + 1);
    harness.run(player, { type: 'respawn', atBed: false });

    expect(player.alive).toBe(true);
    expect(harness.world.circleBlocked(player.x, player.y, 11)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The well_rested payoff
// ---------------------------------------------------------------------------

/** Read an effect off a player without pulling in either `hasEffect` overload. */
function effect(player: PlayerState, id: string) {
  return player.effects.find((entry) => entry.id === id);
}

describe('waking up rested', () => {
  it('pays a full night out as the well_rested bonus', () => {
    const scene = bunk();
    lieDown(scene);

    // 80 fatigue at a wood bed's recovery rate is a little under a minute of ticks.
    scene.harness.advanceSeconds(60);

    expect(sleepingBed(scene.harness.ctx, scene.player)).toBeUndefined();
    expect(effect(scene.player, 'well_rested')?.magnitude).toBeCloseTo(WELL_RESTED_MAGNITUDE, 5);
  });

  it('slows the following day for a rested sleeper', () => {
    const rested = bunk();
    lieDown(rested);
    rested.harness.advanceSeconds(60);
    // The control starts the comparison from the same fatigue, without the bed.
    const control = bunk();
    control.player.fatigue = rested.player.fatigue;
    const from = rested.player.fatigue;

    rested.harness.advanceSeconds(120);
    control.harness.advanceSeconds(120);

    const restedGain = rested.player.fatigue - from;
    const controlGain = control.player.fatigue - from;
    expect(restedGain).toBeGreaterThan(0);
    expect(restedGain).toBeLessThan(controlGain * 0.8);
  });

  it('gives a doze nothing, however rested it leaves you', () => {
    const scene = bunk();
    scene.player.fatigue = 2;
    lieDown(scene);

    scene.harness.advanceSeconds(5);

    // Woken rested, but a two-second nap is not a night.
    expect(scene.player.fatigue).toBeLessThan(0.5);
    expect(effect(scene.player, 'well_rested')).toBeUndefined();
  });

  it('gives nothing to a sleeper who gets up half rested', () => {
    const scene = bunk();
    lieDown(scene);
    scene.harness.advanceSeconds(20);

    scene.harness.run(scene.player, { type: 'wake' });

    expect(scene.player.fatigue).toBeGreaterThan(WELL_RESTED_FATIGUE);
    expect(effect(scene.player, 'well_rested')).toBeUndefined();
  });

  it('gives nothing to a player who died in their sleep', () => {
    const scene = bunk();
    scene.player.fatigue = 10;
    lieDown(scene);
    scene.harness.advanceSeconds(20);

    killPlayer(scene.harness.ctx, scene.player, 'test');
    scene.harness.step(2);

    expect(scene.harness.eventsOf('sleepEnded')).toHaveLength(1);
    expect(effect(scene.player, 'well_rested')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setSpawnPoint
// ---------------------------------------------------------------------------

describe('setSpawnPoint', () => {
  it('claims a bed without sleeping in it', () => {
    const scene = bunk();
    const centre = bedCenter(scene.harness.ctx, scene.bed);
    scene.player.spawnX = scene.player.x - 900;

    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: scene.bed.id });

    expect(scene.player.bedStructureId).toBe(scene.bed.id);
    expect(scene.player.spawnX).toBeCloseTo(centre.x, 5);
    expect(scene.player.spawnY).toBeCloseTo(centre.y, 5);
    // Claiming is not resting: the bed is still free and the player still awake.
    expect(scene.bed.bed?.occupantId).toBeUndefined();
    expect(sleepingBed(scene.harness.ctx, scene.player)).toBeUndefined();
    expect(scene.harness.eventsOf('sleepStarted')).toHaveLength(0);
  });

  it('is where the player comes back', () => {
    const scene = bunk();
    const centre = bedCenter(scene.harness.ctx, scene.bed);
    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: scene.bed.id });
    killPlayer(scene.harness.ctx, scene.player, 'test');

    scene.harness.step(RESPAWN_DELAY_TICKS + 1);
    scene.harness.run(scene.player, { type: 'respawn', atBed: true });

    expect(scene.player.alive).toBe(true);
    expect(scene.player.x).toBeCloseTo(centre.x, 5);
    expect(scene.player.y).toBeCloseTo(centre.y, 5);
  });

  it('refuses a structure that is not a bed', () => {
    const scene = bunk();
    const box = scene.harness.placeStructure(
      'storage_box',
      pixelToTile(scene.player.x) - 1,
      pixelToTile(scene.player.y),
    );
    if (!box) throw new Error('could not place storage box');

    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: box.id });

    expect(scene.harness.lastEvent('commandRejected')?.reason).toBe('that is not a usable bed');
    expect(scene.player.bedStructureId).toBeUndefined();
  });

  it('refuses a structure that does not exist', () => {
    const scene = bunk();
    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: 's999999' });
    expect(scene.harness.lastEvent('commandRejected')?.reason).toBe('no such structure');
  });

  it('refuses a bed the player cannot reach', () => {
    const scene = bunk();
    scene.player.x += SLEEP_REACH * 4;

    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: scene.bed.id });

    expect(scene.harness.lastEvent('commandRejected')?.reason).toBe('too far from the bed');
    expect(scene.player.bedStructureId).toBeUndefined();
  });

  it('refuses a bed someone else is asleep in', () => {
    const scene = bunk();
    const other = scene.harness.addPlayer({ id: 'other' });
    const centre = bedCenter(scene.harness.ctx, scene.bed);
    other.x = centre.x;
    other.y = centre.y;
    scene.harness.run(other, { type: 'sleep', structureId: scene.bed.id });

    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: scene.bed.id });

    expect(scene.harness.lastEvent('commandRejected')?.reason).toBe('someone is already in it');
    expect(scene.player.bedStructureId).toBeUndefined();
  });

  it('refuses a dead player', () => {
    const scene = bunk();
    killPlayer(scene.harness.ctx, scene.player, 'test');

    scene.harness.run(scene.player, { type: 'setSpawnPoint', structureId: scene.bed.id });

    expect(scene.harness.lastEvent('commandRejected')?.reason).toBe('you are dead');
  });
});
