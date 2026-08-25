import { expect, test } from '@playwright/test';
import { openClient, pageErrors } from './helpers';

/**
 * Does the client start at all?
 *
 * Everything else in the suite depends on this, so it is checked on its own and first.
 */
test.describe('boot', () => {
  test('loads, generates its textures and shows the menu', async ({ page }) => {
    await openClient(page);

    await expect(page.locator('.menu-panel h1')).toHaveText('Survive');
    // The footer proves the content tables validated and were hashed.
    await expect(page.locator('.menu-foot')).toContainText('protocol v');
    await expect(page.locator('.menu-foot')).toContainText('content ');

    // Textures are drawn procedurally at boot; a zero count means nothing would render.
    const textureCount = await page.evaluate(() => {
      const game = (window as unknown as { game?: { registry?: { get(key: string): unknown } } })
        .game;
      return game?.registry?.get('textureCount') ?? 0;
    });
    expect(Number(textureCount)).toBeGreaterThan(200);

    expect(pageErrors(page)).toEqual([]);
  });

  test('offers both single player and a server address', async ({ page }) => {
    await openClient(page);
    // The browser build cannot spawn a local server, so it must say so rather than
    // offering a button that silently does nothing.
    await expect(page.locator('#mp-url')).toBeVisible();
    await expect(page.locator('#mp-join')).toBeVisible();
    await expect(page.locator('#mp-name')).toBeVisible();
  });

  test('renders a canvas sized to the window', async ({ page }) => {
    await openClient(page);
    const canvas = page.locator('#game canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(400);
    expect(box?.height ?? 0).toBeGreaterThan(300);
  });
});
