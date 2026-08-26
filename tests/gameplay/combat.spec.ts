import { expect, test, type Page } from '@playwright/test';
import { joinServer, openClient, waitForTicks } from './helpers';

/** Swing-arc graphics currently in the scene, and where they are. */
async function arcs(page: Page): Promise<{ x: number; y: number; alpha: number }[]> {
  return page.evaluate(() => {
    const scene = window.game!.scene.getScene('Game') as unknown as {
      children: { list: { name: string; x: number; y: number; alpha: number }[] };
    };
    return scene.children.list
      .filter((object) => object.name === 'melee-arc')
      .map((object) => ({ x: object.x, y: object.y, alpha: object.alpha }));
  });
}

/**
 * The melee swing marker (spec section 4).
 *
 * A player could not see how far their weapon reached, which made every miss ambiguous -
 * out of range, or facing slightly wrong? The marker answers that, and `effects.test.ts`
 * holds its shape to the same numbers the server tests against. This checks the other half:
 * that it appears when you swing, sits where you swung from, and goes away again.
 */
test.describe('melee swing marker', () => {
  test('appears on a swing, at the player, and clears itself', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    expect(await arcs(page), 'nothing should be drawn before swinging').toHaveLength(0);

    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width / 2 + 200, viewport.height / 2 + 40);
    const before = await page.evaluate(() => window.__survive!.render());

    await page.mouse.down();
    // Swings have a windup, so the marker is not up on the first frame - a check that fires
    // immediately sees nothing and reads as a broken feature.
    await page.waitForFunction(
      () => {
        const scene = window.game!.scene.getScene('Game') as unknown as {
          children: { list: { name: string }[] };
        };
        return scene.children.list.some((object) => object.name === 'melee-arc');
      },
      undefined,
      { timeout: 5000 },
    );
    const drawn = await arcs(page);
    await page.mouse.up();

    expect(drawn.length).toBeGreaterThan(0);
    // Anchored where the swing was made from, not on the cursor and not at the origin.
    expect(Math.hypot(drawn[0]!.x - before.x, drawn[0]!.y - before.y)).toBeLessThan(40);

    // And it clears. Left behind, the marks would pile up into a solid white disc around
    // anyone who fights for a while.
    await page.waitForTimeout(1500);
    expect(await arcs(page), 'the marker should not outlive the swing').toHaveLength(0);
  });

  test('does not paint the screen when swinging repeatedly', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    const viewport = page.viewportSize()!;
    await page.mouse.move(viewport.width / 2 + 160, viewport.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(2500);
    const during = await arcs(page);
    await page.mouse.up();

    // One swing at a time: the marker fades within the attack cooldown, so however long the
    // button is held there is never a stack of them.
    expect(during.length).toBeLessThanOrEqual(2);

    await page.waitForTimeout(1500);
    expect(await arcs(page)).toHaveLength(0);
  });
});
