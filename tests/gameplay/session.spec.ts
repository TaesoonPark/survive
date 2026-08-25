import { expect, test } from '@playwright/test';
import { joinServer, net, openClient, pageErrors, self, waitForTicks, world } from './helpers';

/**
 * Connecting and staying connected.
 *
 * The single-player and multiplayer paths are the same code (spec sections 9 and 10), so
 * proving the client can join a real server proves both.
 */
test.describe('session', () => {
  test('joins a real server and holds authoritative state', async ({ page }) => {
    await openClient(page);
    await joinServer(page, 'Tester');

    const player = await self(page);
    expect(player.alive).toBe(true);
    expect(player.health).toBeGreaterThan(0);
    expect(Number.isFinite(player.x)).toBe(true);
    expect(Number.isFinite(player.y)).toBe(true);

    const clock = await world(page);
    expect(clock).not.toBeNull();
    expect(clock!.day).toBeGreaterThanOrEqual(1);
    expect(clock!.hour).toBeGreaterThanOrEqual(0);
    expect(clock!.hour).toBeLessThan(24);

    expect(pageErrors(page)).toEqual([]);
  });

  test('receives terrain for the ground it is standing on', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.waitForFunction(() => (window.__survive?.net().chunkCount ?? 0) > 0, undefined, {
      timeout: 20_000,
    });
    expect((await net(page)).chunkCount).toBeGreaterThan(0);
  });

  test('shows the HUD: vitals, clock and hotbar', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await expect(page.locator('.hud-vitals')).toBeVisible();
    await expect(page.locator('.hud-clock')).toBeVisible();
    await expect(page.locator('.hotbar')).toBeVisible();

    // Every vital the player has to manage is on screen.
    const labels = await page.locator('.hud-vitals .bar-label').allTextContents();
    expect(labels).toContain('HP');
    expect(labels).toContain('FOOD');
    expect(labels).toContain('WATER');
    expect(labels).toContain('REST');
  });

  test('keeps the server simulating while connected', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    const before = (await world(page))!.tick;
    await waitForTicks(page, 40);
    expect((await world(page))!.tick).toBeGreaterThan(before);
  });

  test('reports a plausible latency to the local server', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.waitForTimeout(2500);
    const stats = await net(page);
    expect(stats.latencyMs).toBeGreaterThanOrEqual(0);
    expect(stats.latencyMs).toBeLessThan(1000);
  });

  test('shows an error rather than hanging when the address is wrong', async ({ page }) => {
    await openClient(page);
    await page.fill('#mp-url', 'http://127.0.0.1:1');
    await page.click('#mp-join');
    // The menu is where the player can fix it, so that is where the reason has to appear.
    await expect(page.locator('#menu-status')).toContainText(/./, { timeout: 40_000 });
    await expect(page.locator('.menu-panel')).toBeVisible();
  });
});
