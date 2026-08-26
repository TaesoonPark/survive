import { expect, test, type Page } from '@playwright/test';
import { joinServer, openClient, waitForTicks } from './helpers';

/** Bindings on the bar: an inventory slot index per key, or null for unbound. */
async function hotbar(page: Page): Promise<(number | null)[]> {
  return page.evaluate(() => window.__survive!.self()?.hotbar ?? []);
}

/** A bag slot with something in it. Equipment slots look the same but cannot be bound. */
function filledBagSlot(page: Page) {
  return page.locator('[data-testid^="inventory-slot-"]:has(.slot:not(.slot--empty))').first();
}

function emptyBagSlot(page: Page) {
  return page.locator('[data-testid^="inventory-slot-"]:has(.slot--empty)').first();
}

/**
 * Filling the hotbar (spec section 5).
 *
 * `assignHotbar` was implemented and tested on the server and never sent by the client, so
 * all eight slots stayed empty for good: pressing a number could only ever stow whatever was
 * in hand. Two gestures fill it now - dragging an item onto the bar, or pressing the number
 * while the cursor rests on the item - and an empty slot under the cursor clears the key.
 */
test.describe('hotbar assignment', () => {
  test('starts empty, which is what made this necessary', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    expect(await hotbar(page)).toEqual([null, null, null, null, null, null, null, null]);
  });

  test('a number key over an item binds that slot, and an empty slot clears it', async ({
    page,
  }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    await page.keyboard.press('KeyI');

    const source = filledBagSlot(page);
    await expect(source).toBeVisible();
    const slotIndex = Number((await source.getAttribute('data-testid'))!.replace(/\D+/g, ''));

    await source.hover();
    await page.keyboard.press('Digit3');
    await waitForTicks(page, 8);
    expect((await hotbar(page))[2], 'the third key should point at the hovered slot').toBe(
      slotIndex,
    );

    // Hovering an empty slot and pressing the same key unbinds it. Without this there is no
    // way to clear a key short of binding something else to it.
    await emptyBagSlot(page).hover();
    await page.keyboard.press('Digit3');
    await waitForTicks(page, 8);
    expect((await hotbar(page))[2], 'the third key should be cleared').toBeNull();
  });

  test('a number key over nothing still selects, as it always did', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    // The panel is open but the cursor is off the grid, so the digit keeps its old meaning.
    await page.keyboard.press('KeyI');
    await page.mouse.move(4, 4);
    await page.keyboard.press('Digit5');
    await waitForTicks(page, 8);
    const self = await page.evaluate(() => window.__survive!.self());
    expect(self!.activeHotbar, 'selecting is what a digit means over empty space').toBe(4);
    expect(await hotbar(page)).toEqual([null, null, null, null, null, null, null, null]);
  });

  test('dragging an item onto the bar binds it without moving it', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    await page.keyboard.press('KeyI');

    const source = filledBagSlot(page);
    await expect(source).toBeVisible();
    const slotIndex = Number((await source.getAttribute('data-testid'))!.replace(/\D+/g, ''));
    const before = await page.evaluate(() => window.__survive!.self()?.inventoryCount ?? 0);

    await source.dragTo(page.locator('.hotbar .slot').nth(4));
    await waitForTicks(page, 8);

    expect((await hotbar(page))[4]).toBe(slotIndex);
    // A hotbar entry is a pointer, so nothing moved: the same number of stacks is carried.
    expect(await page.evaluate(() => window.__survive!.self()?.inventoryCount ?? 0)).toBe(before);
  });

  test('the bound key then puts that item in hand, and the key again stows it', async ({
    page,
  }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);
    await page.keyboard.press('KeyI');

    const source = filledBagSlot(page);
    const defId = await source.evaluate(
      (node) => node.querySelector('.slot')?.getAttribute('data-def-id') ?? null,
    );
    expect(defId, 'the slot should name what it holds').not.toBeNull();

    await source.hover();
    await page.keyboard.press('Digit2');
    await waitForTicks(page, 8);
    await page.keyboard.press('KeyI');
    await page.mouse.move(4, 4);

    // Selecting swaps: the bound item comes into the hand.
    await page.keyboard.press('Digit2');
    await waitForTicks(page, 10);
    expect(await page.evaluate(() => window.__survive!.self()?.heldDefId)).toBe(defId);

    // And an unbound key stows it again - the behaviour that used to be all a digit could do.
    await page.keyboard.press('Digit8');
    await waitForTicks(page, 10);
    expect(await page.evaluate(() => window.__survive!.self()?.heldDefId)).toBeNull();
  });
});
