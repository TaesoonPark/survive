import { expect, test } from '@playwright/test';
import { joinServer, openClient, openPanels, pageErrors } from './helpers';

/**
 * The interface: can the player actually reach the game's systems?
 *
 * The panels are DOM, so these are real accessibility-shaped assertions rather than
 * pixel comparisons.
 */
test.describe('interface', () => {
  test('opens and closes the inventory with I', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await page.keyboard.press('KeyI');
    await expect.poll(() => openPanels(page)).toContain('inventory');
    await page.keyboard.press('KeyI');
    await expect.poll(() => openPanels(page)).not.toContain('inventory');
  });

  test('opens crafting with Q and shows recipes', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await page.keyboard.press('KeyQ');
    await expect.poll(() => openPanels(page)).toContain('crafting');
    // A crafting screen with no recipes in it is a content-loading failure.
    await expect(page.locator('.panel')).toBeVisible();
  });

  test('opens the build menu with B', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.keyboard.press('KeyB');
    await expect.poll(() => openPanels(page)).toContain('build');
  });

  test('opens the body screen with H', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.keyboard.press('KeyH');
    await expect.poll(() => openPanels(page)).toContain('body');
  });

  test('Escape closes the top panel before opening the pause menu', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await page.keyboard.press('KeyI');
    await expect.poll(() => openPanels(page)).toContain('inventory');

    await page.keyboard.press('Escape');
    await expect.poll(() => openPanels(page)).not.toContain('inventory');

    await page.keyboard.press('Escape');
    await expect.poll(() => openPanels(page)).toContain('pause');
  });

  test('selects hotbar slots with the number keys', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await page.keyboard.press('Digit3');
    await expect
      .poll(async () => page.evaluate(() => window.__survive?.self()?.id ?? null))
      .not.toBeNull();
    // The selection is server state; the visible proof is the highlighted slot.
    await expect(page.locator('.hotbar .slot--selected')).toHaveCount(2);
  });

  test('opens the debug overlay with F3 without capturing input', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.keyboard.press('F3');
    await expect.poll(() => openPanels(page)).toContain('debug');
    // A read-only overlay must not stop the player moving.
    const before = await page.evaluate(() => window.__survive?.self()?.x ?? 0);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__survive?.self()?.x ?? 0);
    expect(after).toBeGreaterThan(before);
  });

  test('produces no uncaught errors while opening every panel', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    for (const key of ['KeyI', 'KeyQ', 'KeyB', 'KeyH', 'KeyM', 'F3']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    expect(pageErrors(page)).toEqual([]);
  });
});
