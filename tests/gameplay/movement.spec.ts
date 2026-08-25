import { expect, test } from '@playwright/test';
import { holdKey, joinServer, net, openClient, predicted, self } from './helpers';

/**
 * WASD, prediction and reconciliation (spec sections 1 and 17).
 *
 * The interesting property is not "the sprite moved" but "the client's prediction and the
 * server's authority agree" — so these tests check both, and check that the error between
 * them stays small.
 */
test.describe('movement', () => {
  test('WASD moves the player, and the server agrees', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    const before = await self(page);
    await holdKey(page, 'KeyD', 700);
    const after = await self(page);

    // The authoritative position moved east.
    expect(after.x).toBeGreaterThan(before.x + 8);
    expect(Math.abs(after.y - before.y)).toBeLessThan(20);
  });

  test('each direction key moves the right way', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    const start = await self(page);
    await holdKey(page, 'KeyS', 500);
    const down = await self(page);
    expect(down.y).toBeGreaterThan(start.y);

    await holdKey(page, 'KeyW', 700);
    const up = await self(page);
    expect(up.y).toBeLessThan(down.y);

    await holdKey(page, 'KeyA', 500);
    const left = await self(page);
    expect(left.x).toBeLessThan(up.x + 2);
  });

  test('prediction stays close to the authoritative position', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await holdKey(page, 'KeyD', 900);
    const authoritative = await self(page);
    const local = await predicted(page);
    const drift = Math.hypot(local.x - authoritative.x, local.y - authoritative.y);
    // A few tiles of slack covers latency and the unacknowledged input queue; more than
    // that means prediction and the server are running different rules.
    expect(drift).toBeLessThan(96);
    expect((await net(page)).predictionError).toBeLessThan(96);
  });

  test('sprinting is faster than walking and costs stamina', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    const walkStart = await self(page);
    await holdKey(page, 'KeyD', 600);
    const walkEnd = await self(page);
    const walked = Math.abs(walkEnd.x - walkStart.x);

    await page.keyboard.down('ShiftLeft');
    const sprintStart = await self(page);
    await holdKey(page, 'KeyD', 600);
    const sprintEnd = await self(page);
    await page.keyboard.up('ShiftLeft');
    const sprinted = Math.abs(sprintEnd.x - sprintStart.x);

    expect(sprinted).toBeGreaterThan(walked);
    expect(sprintEnd.stamina).toBeLessThan(sprintStart.stamina);
  });

  test('releasing the keys stops the player', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await holdKey(page, 'KeyD', 400);
    const stopped = await self(page);
    await page.waitForTimeout(700);
    const later = await self(page);
    // Knockback aside, a player with no input does not drift.
    expect(Math.abs(later.x - stopped.x)).toBeLessThan(6);
  });
});
