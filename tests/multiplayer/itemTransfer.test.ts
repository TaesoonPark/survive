import { afterEach, describe, expect, it } from 'vitest';
import { SIM_HZ } from '@survive/protocol';
import { DROP_PROTECTION_TICKS, addToInventory, createStack } from '@survive/simulation';
import {
  createBots,
  createLiveServer,
  sleep,
  waitForAll,
  type Bot,
  type LiveServer,
} from '@survive/test-utils';

/**
 * The canonical multiplayer test from spec section 35:
 *
 *   A drops an item -> B picks it up -> server state is checked ->
 *   A, B and C all see the same result.
 *
 * The point is convergence. Three real clients, one authoritative server, and no client
 * is allowed to believe something the others do not.
 */

let server: LiveServer | null = null;
let bots: Bot[] = [];

afterEach(async () => {
  for (const bot of bots) {
    try {
      await bot.leave();
    } catch {
      // Already gone.
    }
  }
  bots = [];
  await server?.stop();
  server = null;
});

/** Put a stack straight into a connected player's inventory, server-side. */
function grant(live: LiveServer, playerId: string, defId: string, count: number): void {
  const player = live.server.simulation.getPlayer(playerId);
  expect(player, `expected ${playerId} to be in the world`).toBeDefined();
  const stack = createStack(live.data, defId, count);
  const leftover = addToInventory(player!.inventory, stack, live.data);
  expect(leftover).toBe(0);
  player!.rev++;
}

function countIn(live: LiveServer, playerId: string, defId: string): number {
  const player = live.server.simulation.getPlayer(playerId);
  if (!player) return 0;
  let total = 0;
  for (const slot of player.inventory.slots) if (slot?.defId === defId) total += slot.count;
  return total;
}

describe('item transfer between players', () => {
  it('A drops, B picks up, and all three clients converge on the same state', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    const [alice, bob, carol] = await createBots(server.url, ['Alice', 'Bob', 'Carol']);
    bots.push(alice!, bob!, carol!);

    // Everyone spawns at the same point, so all three are inside each other's area of
    // interest and every one of them should see the dropped item.
    grant(server, 'alice', 'wood_log', 5);
    expect(countIn(server, 'alice', 'wood_log')).toBe(5);
    expect(countIn(server, 'bob', 'wood_log')).toBe(0);

    // --- A drops ----------------------------------------------------------
    const slot = server.server.simulation
      .getPlayer('alice')!
      .inventory.slots.findIndex((entry) => entry?.defId === 'wood_log');
    expect(slot).toBeGreaterThanOrEqual(0);
    alice!.send({ type: 'dropItem', ref: { kind: 'inventory' }, index: slot, count: 5 });

    // The server is the authority on whether that happened.
    await alice!.waitFor(() => countIn(server!, 'alice', 'wood_log') === 0, 'alice to drop');
    const dropped = Object.values(server.server.simulation.state.items).filter(
      (item) => item.stack.defId === 'wood_log',
    );
    expect(dropped).toHaveLength(1);
    const itemId = dropped[0]!.id;

    // ...and every client is told about it.
    await waitForAll(
      [alice!, bob!, carol!],
      (bot) => bot.entity(itemId) !== undefined,
      'the dropped log to replicate',
    );

    // --- B cannot pick up yet --------------------------------------------
    // A fresh drop belongs to whoever dropped it for `DROP_PROTECTION_TICKS`, so that a
    // fumbled swap in a shared base cannot be sniped. Bob asking early must be refused,
    // and the refusal must leave the item exactly where it was.
    bob!.send({ type: 'pickUpItem', itemEntityId: itemId });
    await sleep(300);
    expect(countIn(server, 'bob', 'wood_log')).toBe(0);
    expect(server.server.simulation.state.items[itemId]).toBeDefined();

    // --- B picks up once the window closes -------------------------------
    // Waited out rather than reached around: the point is that the protection *expires*.
    // A rejected command is not queued, so this is a second send, not a retry of the
    // first one.
    await sleep((DROP_PROTECTION_TICKS / SIM_HZ) * 1000 + 500);
    bob!.send({ type: 'pickUpItem', itemEntityId: itemId });

    await bob!.waitFor(() => countIn(server!, 'bob', 'wood_log') === 5, 'bob to pick up');
    expect(countIn(server, 'alice', 'wood_log')).toBe(0);
    // The item entity is gone from the world, not duplicated.
    expect(server.server.simulation.state.items[itemId]).toBeUndefined();

    // --- everyone agrees --------------------------------------------------
    await waitForAll(
      [alice!, bob!, carol!],
      (bot) => bot.entity(itemId) === undefined,
      'the log to disappear for everyone',
    );

    // Bob sees it in his own inventory; the others do not see Bob's inventory at all,
    // which is exactly the area-of-interest projection working.
    expect(bob!.self!.inventory.slots.some((entry) => entry?.defId === 'wood_log')).toBe(true);
    expect(alice!.self!.inventory.slots.some((entry) => entry?.defId === 'wood_log')).toBe(false);
    const bobAsSeenByAlice = alice!.entity('bob');
    expect(bobAsSeenByAlice).toBeDefined();
    expect(bobAsSeenByAlice).not.toHaveProperty('inventory');
  });

  it('only one of two racing players gets the item', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    const [alice, bob] = await createBots(server.url, ['Alice', 'Bob']);
    bots.push(alice!, bob!);

    grant(server, 'alice', 'stone', 3);
    const slot = server.server.simulation
      .getPlayer('alice')!
      .inventory.slots.findIndex((entry) => entry?.defId === 'stone');
    alice!.send({ type: 'dropItem', ref: { kind: 'inventory' }, index: slot, count: 3 });
    await alice!.waitFor(() => countIn(server!, 'alice', 'stone') === 0, 'alice to drop');

    const itemId = Object.values(server.server.simulation.state.items).find(
      (item) => item.stack.defId === 'stone',
    )!.id;

    // Both grab for it in the same breath. The server has to pick exactly one winner:
    // a duplicated stack here would be the classic pickup race bug.
    alice!.send({ type: 'pickUpItem', itemEntityId: itemId });
    bob!.send({ type: 'pickUpItem', itemEntityId: itemId });
    await sleep(600);

    const total = countIn(server, 'alice', 'stone') + countIn(server, 'bob', 'stone');
    expect(total).toBe(3);
    expect(server.server.simulation.state.items[itemId]).toBeUndefined();
  });

  it('refuses a pickup from across the map', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    const [alice, bob] = await createBots(server.url, ['Alice', 'Bob']);
    bots.push(alice!, bob!);

    grant(server, 'alice', 'stone', 2);
    const slot = server.server.simulation
      .getPlayer('alice')!
      .inventory.slots.findIndex((entry) => entry?.defId === 'stone');
    alice!.send({ type: 'dropItem', ref: { kind: 'inventory' }, index: slot, count: 2 });
    await alice!.waitFor(() => countIn(server!, 'alice', 'stone') === 0, 'alice to drop');
    const itemId = Object.values(server.server.simulation.state.items).find(
      (item) => item.stack.defId === 'stone',
    )!.id;

    // Teleport Bob far away, then have him ask for it anyway.
    const bobPlayer = server.server.simulation.getPlayer('bob')!;
    bobPlayer.x += 5000;
    bobPlayer.rev++;
    bob!.send({ type: 'pickUpItem', itemEntityId: itemId });
    await sleep(600);

    expect(countIn(server, 'bob', 'stone')).toBe(0);
    expect(server.server.simulation.state.items[itemId]).toBeDefined();
  });

  it('shows a container to whoever opens it, and to nobody else', async () => {
    server = await createLiveServer({ maxPlayers: 4 });
    const [alice, bob] = await createBots(server.url, ['Alice', 'Bob']);
    bots.push(alice!, bob!);

    const alicePlayer = server.server.simulation.getPlayer('alice')!;
    const tileX = Math.floor(alicePlayer.x / 32) + 1;
    const tileY = Math.floor(alicePlayer.y / 32);
    // Place a box next to them, server-side, and put something in it.
    const { spawnStructure } = await import('@survive/simulation');
    const box = spawnStructure(
      server.server.simulation.context,
      'storage_box',
      tileX,
      tileY,
      0,
      'alice',
    );
    expect(box?.container).toBeDefined();
    box!.container!.slots[0] = createStack(server.data, 'wood_plank', 4);
    box!.container!.rolled = true;
    box!.rev++;

    // Both clients should be told the box exists.
    await waitForAll([alice!, bob!], (bot) => bot.entity(box!.id) !== undefined, 'the box');

    alice!.send({ type: 'openContainer', structureId: box!.id });
    await alice!.waitFor(
      (bot) => bot.store.container?.structureId === box!.id,
      'the container view',
    );
    const view = alice!.store.container!;
    expect(view.slots.some((slot) => slot?.defId === 'wood_plank')).toBe(true);

    // Bob has not opened it, so he gets no container view of his own.
    expect(bob!.store.container).toBeNull();
  });
});
