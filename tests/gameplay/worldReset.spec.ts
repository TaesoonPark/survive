import { expect, test } from '@playwright/test';
import { SERVER_URL, holdKey, joinServer, openClient, self, waitForTicks, world } from './helpers';

/**
 * The lobby's reset button, driven the way a player drives it.
 *
 * The rules live in `apps/server/src/net/admin.test.ts` and the wire in
 * `tests/multiplayer/worldReset.test.ts`. What only this can show is the browser: the page
 * is served from one port and the server listens on another, so every click here is a real
 * cross-origin request, and a preflight the server does not permit fails as a network
 * error rather than as a refusal. That is a failure mode no server-side test can see, and
 * it is the one this feature actually shipped with the first time it was tried.
 */
test.describe('world reset', () => {
  test('takes two clicks, and says what the first one armed', async ({ page }) => {
    await openClient(page);
    const button = page.locator('#mp-reset');

    await button.click();
    // Armed, not fired: the status has to say what is about to be destroyed.
    await expect(button).toHaveClass(/armed/);
    await expect(page.locator('#menu-status')).not.toHaveText('');

    // Touching anything else disarms it, so an armed button cannot lie in wait for an
    // unrelated click a minute later.
    await page.click('#mp-name');
    await expect(button).not.toHaveClass(/armed/);
  });

  test('deletes the world, through a real cross-origin request', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    // Two marks that only survive if the reset does not happen: a clock that has run, and
    // a character standing somewhere other than where a new one appears.
    const spawn = await self(page);
    await holdKey(page, 'KeyD', 900);
    const moved = await self(page);
    expect(Math.abs(moved.x - spawn.x), 'the character actually left the spawn').toBeGreaterThan(8);
    const clockBefore = (await world(page))!.tick;

    await page.reload();
    await page.fill('#mp-url', SERVER_URL);
    await page.click('#mp-reset');
    await page.click('#mp-reset');

    // The message is the proof the browser could *read* the response. A preflight the
    // server did not permit shows up here as "could not reach", on a server that is
    // running perfectly well - which is exactly how this failed the first time.
    await expect
      .poll(async () => (await page.locator('#menu-status').innerText()).trim(), {
        timeout: 30_000,
      })
      .not.toMatch(/…$/);
    await expect(page.locator('#menu-status')).not.toContainText('reach');

    // Back in, on a world that started over: the clock is behind where it was, and the
    // character is a new one at the spawn point rather than the one left standing east.
    await joinServer(page);
    const after = await self(page);
    expect((await world(page))!.tick).toBeLessThan(clockBefore);
    expect(after.id, 'the same name, so this is the same character being remade').toBe(spawn.id);
    expect(Math.abs(after.x - moved.x)).toBeGreaterThan(8);
  });
});
