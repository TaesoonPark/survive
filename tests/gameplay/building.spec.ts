import { expect, test, type Page } from '@playwright/test';
import {
  holdKey,
  joinServer,
  net,
  nearest,
  openClient,
  openPanels,
  self,
  waitForTicks,
} from './helpers';

/**
 * Placing a piece, from the panel to the ground.
 *
 * The server's `build` command was complete, validated and unit-tested, and the client
 * never sent it once - so selecting a piece drew a ghost that followed the cursor and
 * clicking swung a hatchet at it. The same shape of gap as `assignHotbar`: the half that
 * shows on screen was there, and the half that does anything was not. A test that stops at
 * "the panel opens" cannot tell the difference, which is why this one goes all the way to a
 * structure existing in the world.
 *
 * `wall_wood_frame` costs six sticks and four fibre, which is exactly what a new character
 * carries - so this needs no gathering, and if the starting kit ever stops covering it the
 * failure names the piece rather than looking like a broken click.
 */
const PIECE = 'wall_wood_frame';
const GROUP = 'wall';

/** Open the build panel and select the piece. Its category starts collapsed. */
async function selectPiece(page: Page): Promise<void> {
  await page.keyboard.press('KeyB');
  await expect.poll(() => openPanels(page)).toContain('build');
  const group = page.locator(`[data-testid="build-group-${GROUP}"]`);
  // The premise, stated where a failure will show it: the starting kit affords this piece.
  // If the kit or the cost changes, this reads as "0 of 4 ready" rather than as a dead click.
  await expect(group).toContainText('1/4');
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await page.click(`[data-testid="build-entry-${PIECE}"]`);
  // The selection is server state, so the ghost only exists once it has come back.
  await expect.poll(async () => (await self(page)).buildDefId).toBe(PIECE);
  // Left open on purpose. This panel is the one that sets `captures: false` and docks hard
  // right precisely so a piece can be placed without closing it, which is what the key
  // table promises - so placing with it open is the flow worth testing.
  expect(await openPanels(page)).toContain('build');
}

/** How many structures the client can see right now. */
async function structureCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__survive?.entities().structure?.length ?? 0);
}

/**
 * Click a point in the world, offset from the screen centre in pixels.
 *
 * Moves the pointer and lets a frame draw before clicking, because placement uses the tile
 * the *last drawn ghost* was on. A real mouse has been sitting where it is for many frames;
 * a synthetic click that moves and presses in the same frame would place the piece wherever
 * the pointer used to be. Left of centre by default: the build panel docks hard right and
 * the click has to reach the world.
 */
async function clickWorld(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator('canvas').boundingBox())!;
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  await page.mouse.move(x, y);
  await waitForTicks(page, 3);
  await page.mouse.click(x, y);
}

/**
 * Take back down whatever this test built, and *check* that it came down.
 *
 * Every gameplay test shares one world and one spawn point, so a wall left standing here is
 * a wall in the way of whatever runs next - the movement tests probe for an open direction
 * and then walk in it, and they failed on exactly this litter twice while this file was
 * being written. Firing the command and hoping is how it happened the second time: a
 * demolish arriving inside the build cooldown is refused, and nothing said so.
 */
async function demolishNearest(page: Page): Promise<void> {
  const placed = await nearest(page, 'structure');
  if (!placed) return;
  const gone = async (): Promise<boolean> =>
    page.evaluate((id) => window.__survive?.entity(id) == null, placed.id);
  // Retried rather than sent once: the cooldown from placing it is measured in ticks, and
  // the piece has to be gone before this test hands the world to the next one.
  for (let attempt = 0; attempt < 10 && !(await gone()); attempt++) {
    await page.evaluate(
      (id) => window.__survive?.send({ type: 'demolish', structureId: id }),
      placed.id,
    );
    await waitForTicks(page, 6);
  }
  expect(await gone(), `the ${PIECE} this test placed was left standing`).toBe(true);
}

test.describe('building', () => {
  test('a click places the piece the ghost was showing', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    await selectPiece(page);

    const before = await structureCount(page);
    await clickWorld(page, -64, 0);

    await expect.poll(() => structureCount(page), { timeout: 15_000 }).toBeGreaterThan(before);

    // Take it back down. Every gameplay test shares one world and one spawn point, so a
    // wall left standing here is a wall in the way of whatever runs next - and the movement
    // tests, which probe for an open direction and then walk in it, failed on exactly this
    // wall the first time this test ran in the full suite. A frame is refunded in full, so
    // the character is left as it was found too.
    await demolishNearest(page);
    await expect.poll(() => structureCount(page), { timeout: 15_000 }).toBe(before);
  });

  test('the selection survives placing, and ESC is the way out', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    await selectPiece(page);

    await clickWorld(page, -64, 0);
    await expect.poll(() => structureCount(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // Still armed: placing one piece is not a reason to put the rest down.
    expect((await self(page)).buildDefId, 'the selection survives a placement').toBe(PIECE);

    // ESC is the only way out that is always on screen. A campfire used from the inventory
    // arms the ghost without opening this panel at all, so `Clear` is not reachable - and
    // with the materials spent, every further click is a refusal with nothing to press.
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await self(page)).buildDefId).toBeNull();
    // And ESC did not also open the pause menu on its way past.
    expect(await openPanels(page)).not.toContain('pause');

    await demolishNearest(page);
  });

  test('the builder is held in place while the frame goes up', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    await selectPiece(page);

    await clickWorld(page, -64, 0);
    await expect.poll(() => structureCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    const frame = (await nearest(page, 'structure'))!;
    const progress = async (): Promise<number> =>
      page.evaluate((id) => {
        const entity = window.__survive?.entity(id);
        return entity && 'progress' in entity ? (entity.progress as number) : 1;
      }, frame.id);
    // The premise: this frame is still going up. Everything below is about that window.
    expect(await progress()).toBeLessThan(1);

    // Walk *east*, away from the frame that was placed to the west - so nothing but the
    // lock could keep the player where they are. Walking out of range would stop the work
    // and free them, which is the outcome this is distinguishing itself from.
    const before = await self(page);
    await holdKey(page, 'KeyD', 700);
    const during = await self(page);
    expect(
      Math.hypot(during.x - before.x, during.y - before.y),
      'held in place while building',
    ).toBeLessThan(4);
    // And the client agreed rather than being corrected. A client that predicted movement
    // through the lock would run the sprite away from the authoritative position and be
    // handed back on every snapshot: the drawn position alone cannot show this, because the
    // correction has already put it back by the time a test reads it. The prediction error,
    // sampled while the key is still down, is what shows it.
    const errors: number[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down('KeyD');
      await waitForTicks(page, 3);
      errors.push((await net(page)).predictionError);
    }
    await page.keyboard.up('KeyD');
    expect(Math.max(...errors), `prediction error while held: ${errors.join(', ')}`).toBeLessThan(
      8,
    );

    const drawn = await page.evaluate(() => window.__survive!.render());
    expect(Math.hypot(drawn.x - during.x, drawn.y - during.y)).toBeLessThan(8);
    expect(await progress(), 'the frame kept rising while they stood there').toBeGreaterThan(0);

    await expect.poll(progress, { timeout: 30_000 }).toBe(1);
    await waitForTicks(page, 4);

    // Cleared before the walk, not after: demolishing needs the player within reach of the
    // piece, and the whole point of what follows is that they can now leave.
    await demolishNearest(page);

    // Free again once it is finished.
    const done = await self(page);
    await holdKey(page, 'KeyD', 700);
    const after = await self(page);
    expect(
      Math.hypot(after.x - done.x, after.y - done.y),
      'walking again once the frame is up',
    ).toBeGreaterThan(8);
  });
});
