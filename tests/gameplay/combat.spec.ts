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

/** Text objects currently in the world, with where they are. */
async function worldTexts(page: Page) {
  return page.evaluate(() => {
    const scene = window.game!.scene.getScene('Game') as unknown as {
      children: { list: { type: string; text?: string; alpha: number; x: number; y: number }[] };
    };
    return scene.children.list
      .filter((o) => o.type === 'Text' && typeof o.text === 'string' && o.text.length > 0)
      .map((o) => ({ text: o.text!, alpha: o.alpha, x: o.x, y: o.y }));
  });
}

/**
 * Refusals appear over the player's head (spec section 5).
 *
 * They used to go into the toast feed, alongside levelling up and picking things up - so
 * "too far away", which answers something the player just tried, scrolled past among things
 * that had happened *to* them and read as news rather than as an answer.
 */
test.describe('refusal bubble', () => {
  test('answers a refused action over the player, then clears', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    expect(await worldTexts(page), 'nothing should be said unprompted').toHaveLength(0);

    // Ask for something impossible. The id is deliberately one no node will ever have.
    await page.evaluate(() => window.__survive!.send({ type: 'gather', nodeId: 'n999999' }));
    await page.waitForFunction(
      () => {
        const scene = window.game!.scene.getScene('Game') as unknown as {
          children: { list: { type: string; text?: string }[] };
        };
        return scene.children.list.some((o) => o.type === 'Text' && (o.text?.length ?? 0) > 0);
      },
      undefined,
      { timeout: 5000 },
    );

    const said = await worldTexts(page);
    expect(said).toHaveLength(1);
    // Wording from the string table, not the raw reason the server sent. `unknownNode`
    // reaching the screen is the bug this replaced.
    expect(said[0]!.text).not.toMatch(/^[a-z]+[A-Z]/);
    expect(said[0]!.text.length).toBeGreaterThan(4);

    // Over the player, and clear of the focus name label that hangs just above whatever the
    // interact key is aimed at - usually the thing at the player's feet.
    const drawn = await page.evaluate(() => window.__survive!.render());
    expect(Math.abs(said[0]!.x - drawn.x)).toBeLessThan(8);
    expect(drawn.y - said[0]!.y).toBeGreaterThan(30);

    // And it goes away. A refusal that stays is worse than none: it answers a question the
    // player has stopped asking.
    await page.waitForTimeout(2800);
    const after = await worldTexts(page);
    expect(after.filter((entry) => entry.alpha > 0.02)).toHaveLength(0);
  });

  test('a burst of refusals leaves one bubble, not a column', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    // Refusals arrive in bursts in real play - a held key retrying, a wrong tool swung
    // twice - and a stack growing off the top of the sprite reads as a bug.
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__survive!.send({ type: 'gather', nodeId: 'n999999' }));
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(300);
    expect(await worldTexts(page)).toHaveLength(1);
  });
});
