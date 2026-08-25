import { afterEach, describe, expect, it } from 'vitest';
import { SAVE_FORMAT_VERSION, TICKS_PER_GAME_HOUR, pixelToTile } from '@survive/protocol';
import { createMemoryStore, type SaveStore } from '@survive/persistence';
import { addToInventory, createStack, damagePlayer, spawnStructure } from '@survive/simulation';
import { createDefaultSystems } from '@survive/simulation';
import { createFlatWorld, createHeadlessServer, type HeadlessServer } from '@survive/test-utils';

/**
 * The save/restart test from spec section 36.
 *
 *   start -> connect -> acquire an item -> build -> get hurt -> save -> shut down
 *         -> restart -> restore -> verify
 *
 * This is the test that proves the world is genuinely persistent rather than merely
 * appearing to be. It runs against a real {@link GameServer} over an in-memory
 * repository, with no sockets and no wall clock.
 */

const WORLD = 'save-restart';

/** A fixed clock so save timestamps are deterministic. */
let fakeNow = 1_700_000_000_000;
const now = () => fakeNow;

async function boot(store: SaveStore): Promise<HeadlessServer> {
  return createHeadlessServer({
    store,
    worldName: WORLD,
    seed: 4242,
    now,
    // The same flat world both times: terrain is regenerated from the seed, never saved,
    // so the two runs must agree about it.
    world: createFlatWorld({ seed: 4242 }),
    // No zombies and no wildlife. This test is about whether state survives a restart,
    // and a wandering walker that kills the player mid-test would empty the very
    // inventory being asserted on - a confusing failure with nothing to do with saving.
    systems: createDefaultSystems().filter(
      (system) => system.id !== 'spawn' && system.id !== 'zombieAi' && system.id !== 'animalAi',
    ),
  });
}

let servers: HeadlessServer[] = [];

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.stop();
    } catch {
      // Already stopped by the test.
    }
  }
  servers = [];
});

describe('save and restart', () => {
  it('restores the player, their gear, their building and their injuries', async () => {
    const store = createMemoryStore();

    // --- first session -----------------------------------------------------
    const first = await boot(store);
    servers.push(first);
    const sim = first.server.simulation;

    const { player, created } = await first.server.joinPlayer('alice', 'Alice');
    expect(created).toBe(true);

    // Acquire an item.
    const axe = createStack(first.data, 'stone_hatchet');
    axe.durability = 42;
    addToInventory(player.inventory, axe, first.data);
    addToInventory(player.inventory, createStack(first.data, 'wood_log', 7), first.data);

    // Build something.
    const tileX = pixelToTile(player.x) + 3;
    const tileY = pixelToTile(player.y);
    const wall = spawnStructure(sim.context, 'wall_wood', tileX, tileY, 0, player.id);
    expect(wall).not.toBeNull();
    const wallId = wall!.id;

    // Take an injury with lasting consequences. Deliberately blunt trauma rather than a
    // bleeding cut: an untreated bleed is lethal inside the hour this test waits, which
    // is correct behaviour but would make this a survival test rather than a save test.
    damagePlayer(sim.context, player, {
      amount: 24,
      type: 'blunt',
      bodyPart: 'leftLeg',
      bleedFactor: 0,
      fractureChance: 0,
    });
    player.body.parts.leftLeg.fractured = true;
    player.body.parts.leftLeg.splinted = true;
    player.hunger = 61;
    player.thirst = 47;
    const woundedLegHealth = player.body.parts.leftLeg.health;
    const healthAfterWound = player.health;

    // Let the world turn for an in-game hour, then save and shut down.
    const tickBefore = sim.state.tick;
    await first.advance(TICKS_PER_GAME_HOUR);
    const tickAtSave = sim.state.tick;
    expect(tickAtSave).toBe(tickBefore + TICKS_PER_GAME_HOUR);
    // If the player died in that hour, everything below would be asserting on a corpse.
    expect(player.alive, 'the player should survive an uneventful hour').toBe(true);

    fakeNow += 60_000;
    await first.server.saveAll();
    await first.server.settle();
    await first.server.stop();

    // The save must actually contain something.
    const savedMeta = await (await store.openWorld(WORLD)).loadMeta();
    expect(savedMeta).not.toBeNull();
    expect(savedMeta!.version).toBe(SAVE_FORMAT_VERSION);
    expect(savedMeta!.tick).toBe(tickAtSave);
    expect(savedMeta!.seed).toBe(4242);

    // --- second session ----------------------------------------------------
    const second = await boot(store);
    servers.push(second);

    // The clock resumed where it stopped.
    expect(second.server.simulation.state.tick).toBe(tickAtSave);
    expect(second.server.simulation.state.seed).toBe(4242);

    const rejoin = await second.server.joinPlayer('alice', 'Alice');
    expect(rejoin.created).toBe(false);
    const restored = rejoin.player;

    // Gear survived, including per-item state.
    const restoredAxe = restored.inventory.slots.find((slot) => slot?.defId === 'stone_hatchet');
    expect(restoredAxe).toBeDefined();
    expect(restoredAxe!.durability).toBe(42);
    const restoredLogs = restored.inventory.slots.find((slot) => slot?.defId === 'wood_log');
    expect(restoredLogs?.count).toBe(7);

    // Needs survived.
    expect(restored.hunger).toBeCloseTo(player.hunger, 5);
    expect(restored.thirst).toBeCloseTo(player.thirst, 5);

    // Injuries survived, in detail.
    expect(restored.health).toBeCloseTo(healthAfterWound, 5);
    expect(restored.body.parts.leftLeg.health).toBeCloseTo(woundedLegHealth, 5);
    expect(restored.body.parts.leftLeg.fractured).toBe(true);
    expect(restored.body.parts.leftLeg.splinted).toBe(true);
    expect(restored.body.parts.head.health).toBe(restored.body.parts.head.maxHealth);

    // The building survived, in the right place, owned by the right player.
    const restoredWall = second.server.simulation.state.structures[wallId];
    expect(restoredWall).toBeDefined();
    expect(restoredWall!.defId).toBe('wall_wood');
    expect(restoredWall!.tileX).toBe(tileX);
    expect(restoredWall!.tileY).toBe(tileY);
    expect(restoredWall!.ownerId).toBe('alice');

    // ...and so did its collision, which is a separate index that has to be rebuilt.
    expect(second.world.isSolidTile(tileX, tileY)).toBe(true);
  });

  it('keeps entity ids unique across a restart', async () => {
    const store = createMemoryStore();
    const first = await boot(store);
    servers.push(first);
    const { player } = await first.server.joinPlayer('bob', 'Bob');
    const tileX = pixelToTile(player.x) + 2;
    const tileY = pixelToTile(player.y) + 2;
    const before = spawnStructure(
      first.server.simulation.context,
      'wall_wood',
      tileX,
      tileY,
      0,
      'bob',
    );
    expect(before).not.toBeNull();
    await first.server.saveAll();
    await first.server.settle();
    await first.server.stop();

    const second = await boot(store);
    servers.push(second);
    await second.server.joinPlayer('bob', 'Bob');
    const after = spawnStructure(
      second.server.simulation.context,
      'wall_wood',
      tileX + 1,
      tileY,
      0,
      'bob',
    );
    expect(after).not.toBeNull();
    // A restart that reset the counter would hand out an id that already exists on disk.
    expect(after!.id).not.toBe(before!.id);
  });

  it('regenerates terrain from the seed rather than saving it', async () => {
    const store = createMemoryStore();
    const first = await boot(store);
    servers.push(first);
    await first.server.joinPlayer('carol', 'Carol');
    await first.advance(20);
    await first.server.saveAll();
    await first.server.settle();

    const repository = await store.openWorld(WORLD);
    const chunk = await repository.loadChunk(4096 / 32, 4096 / 32);
    // A saved chunk carries only the dynamic layer (spec section 29). If tiles were in
    // here, every world would be gigabytes.
    if (chunk) {
      expect(Object.keys(chunk)).not.toContain('tiles');
      expect(Object.keys(chunk)).not.toContain('biomes');
    }
    await first.server.stop();
  });

  it('survives being saved twice with no changes in between', async () => {
    const store = createMemoryStore();
    const server = await boot(store);
    servers.push(server);
    await server.server.joinPlayer('dave', 'Dave');
    await server.server.saveAll();
    await server.server.settle();
    await expect(server.server.saveAll()).resolves.toBeUndefined();
    await server.server.settle();
  });

  it('reports the world in the store listing', async () => {
    const store = createMemoryStore();
    const server = await boot(store);
    servers.push(server);
    await server.server.joinPlayer('erin', 'Erin');
    await server.server.saveAll();
    await server.server.settle();

    const worlds = await store.listWorlds();
    const entry = worlds.find((world) => world.name === WORLD);
    expect(entry).toBeDefined();
    expect(entry!.seed).toBe(4242);
    expect(entry!.playerCount).toBeGreaterThanOrEqual(1);
  });
});
