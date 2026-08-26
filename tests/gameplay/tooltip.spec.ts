import { expect, test, type Page } from '@playwright/test';
import { holdKey, joinServer, openClient, waitForTicks, walkTowards } from './helpers';

/**
 * Screen coordinates of a world point, taken from the camera rather than recomputed.
 *
 * Two probes give the scale and offset of whatever transform Phaser is applying. Worth the
 * indirection: `scrollX + screenX / zoom` looks obviously right, is what the camera code
 * itself used to assume, and was 213 px wrong - Phaser zooms about the camera midpoint.
 */
async function toScreen(
  page: Page,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const t = await page.evaluate(() => {
    const cam = window.game!.scene.getScene('Game')!.cameras.main;
    const a = cam.getWorldPoint(0, 0);
    const b = cam.getWorldPoint(100, 100);
    return { ox: a.x, oy: a.y, sx: (b.x - a.x) / 100, sy: (b.y - a.y) / 100 };
  });
  return { x: (world.x - t.ox) / t.sx, y: (world.y - t.oy) / t.sy };
}

/** The nearest live resource node, in world coordinates. */
async function nearestNode(page: Page) {
  return page.evaluate(() => {
    const hook = window.__survive!;
    const from = hook.render();
    let best: { id: string; x: number; y: number; d: number; defId: string } | null = null;
    for (const id of hook.entities().node ?? []) {
      const e = hook.entity(id);
      if (!e || e.k !== 'node' || e.depleted) continue;
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (!best || d < best.d) best = { id, x: e.x, y: e.y, d, defId: e.defId };
    }
    return best;
  });
}

/**
 * Tooltips (spec sections 5 and 7).
 *
 * Item slots had the browser's own `title` attribute, which waits about a second, renders
 * in the OS style and collapses the line breaks that make an item's stats readable - and
 * could not be attached to anything drawn on the canvas, so resource nodes had no tooltip
 * at all. These check the replacement on both sides: a DOM slot and a thing in the world.
 */
test.describe('tooltips', () => {
  test('pointing at a resource node describes it', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    const node = await nearestNode(page);
    expect(node, 'expected a resource node within streaming range').not.toBeNull();

    const at = await toScreen(page, node!);
    await page.mouse.move(at.x, at.y);

    const tip = page.locator('.tip');
    await expect(tip).toBeVisible();
    // The name comes from the node table, so this also proves the client resolved the def
    // rather than falling back to a humanised id.
    await expect(tip.locator('.tip-title')).not.toBeEmpty();
    // What a player actually needs before swinging: how much is left, and what they get.
    await expect(tip).toContainText(/Condition \d+%/);
    await expect(tip).toContainText(/Yields|Depleted/);

    // Pointing at empty ground says nothing. A tooltip that lingers over nothing is worse
    // than none: it describes whatever the cursor last brushed past.
    await page.mouse.move(4, 4);
    await expect(tip).toBeHidden();
  });

  test('pointing at an inventory item describes it, without waiting for the OS', async ({
    page,
  }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    await page.keyboard.press('KeyI');
    const slot = page.locator('.panel .slot:not(.slot--empty)').first();
    await expect(slot).toBeVisible();

    await slot.hover();
    const tip = page.locator('.tip');
    // 400 ms is far longer than the 90 ms rest this uses and far shorter than the second or
    // so the native `title` takes, so passing here means the replacement is what is showing.
    await expect(tip).toBeVisible({ timeout: 400 });
    await expect(tip.locator('.tip-title')).not.toBeEmpty();
    // Multi-line, which is the other half of why `title` was not good enough.
    expect(await tip.locator('.tip-line').count()).toBeGreaterThan(0);
  });

  test('an empty slot has nothing to say', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    await page.keyboard.press('KeyI');
    const empty = page.locator('.panel .slot.slot--empty').first();
    await expect(empty).toBeVisible();
    await empty.hover();
    await page.waitForTimeout(300);
    await expect(page.locator('.tip')).toBeHidden();
  });
  test('closing a panel under the cursor takes its tooltip with it', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    await page.keyboard.press('KeyI');
    const slot = page.locator('.panel .slot:not(.slot--empty)').first();
    await expect(slot).toBeVisible();
    await slot.hover();
    const tip = page.locator('.tip');
    await expect(tip).toBeVisible();

    // `pointerleave` never fires for an element that is *removed* while the cursor is over
    // it, so the tooltip used to stay on screen describing an item in a panel that had
    // closed - and it stayed until the cursor happened to enter and leave something else.
    await page.keyboard.press('KeyI');
    await expect(page.locator('.panel')).toHaveCount(0);
    await expect(tip).toBeHidden();
  });

  test('names the thing the interact key is aimed at, over the ring', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    const node = await nearestNode(page);
    expect(node, 'expected a resource node within streaming range').not.toBeNull();

    const label = page.locator('.focus-label');
    const arrived = await walkTowards(
      page,
      node!,
      async () => (await page.evaluate(() => window.__survive!.focusId())) !== null,
    );
    expect(arrived, 'expected something to become the interaction target').toBe(true);

    // The ring already says *that* something is targeted; standing in a thicket it does not
    // say which bush, and the player finds out by pressing the key.
    await expect(label).toBeVisible();
    await expect(label).not.toBeEmpty();

    const named = await page.evaluate(() => {
      const hook = window.__survive!;
      const id = hook.focusId();
      const entity = id ? hook.entity(id) : null;
      return entity?.k ?? null;
    });
    expect(named, 'the label should be describing a real entity').not.toBeNull();

    // Placed over the target, not over the player: the two are different points, and a
    // label pinned to the player would be a second HUD prompt rather than a name tag.
    const box = await label.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y, 'the label should sit above the middle of the screen').toBeLessThan(
      viewport.height / 2,
    );

    // And it goes away when nothing is in reach.
    await page.evaluate(() => window.__survive!.send({ type: 'interact', tileX: 0, tileY: 0 }));
    await holdKey(page, 'KeyW', 900);
    await holdKey(page, 'KeyW', 900);
    if ((await page.evaluate(() => window.__survive!.focusId())) === null) {
      await expect(label).toBeHidden();
    }
  });
});
