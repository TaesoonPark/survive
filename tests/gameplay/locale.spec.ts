import { expect, test, type Page } from '@playwright/test';
import { joinServer, waitForTicks } from './helpers';

/** Visible text in the interface layer, with the whitespace collapsed. */
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    for (const root of document.querySelectorAll('.ui-root, .tip, .focus-label')) {
      parts.push((root as HTMLElement).innerText ?? '');
    }
    for (const input of document.querySelectorAll<HTMLInputElement>('.ui-root input')) {
      parts.push(input.placeholder);
    }
    return parts.join(' ').replace(/\s+/g, ' ');
  });
}

/**
 * The Korean build has to actually be in Korean (spec section 5).
 *
 * The string tables are checked for completeness by unit tests, but completeness is not the
 * same as *reaching the screen*: several panels build their label tables as module
 * constants, so `t()` runs at import time. When the locale was chosen in the boot scene
 * those tables had already been filled in English, and every unit test still passed. Only
 * looking at the rendered page catches that.
 */
test.describe('Korean locale', () => {
  /** Latin words that would betray an untranslated label. Units and keycaps are fine. */
  const ALLOWED = new Set([
    'hp',
    'kg',
    'px',
    'esc',
    'shift',
    'ctrl',
    'alt',
    'survive',
    'day',
    'spring',
    'summer',
    'autumn',
    'winter',
    'clear',
    'rain',
    'storm',
    'fog',
    'snow',
    'heatwave',
    'e',
    'b',
    't',
    'npm',
    'run',
    'start',
    'server',
    'v1',
    'gd1',
    'c',
    'slots',
    // Units and calibres that stay Latin in Korean text too.
    'ms',
    'mm',
  ]);

  function latinWords(text: string): string[] {
    return [...text.matchAll(/[A-Za-z][A-Za-z']{1,}/g)]
      .map((match) => match[0].toLowerCase())
      .filter((word) => !ALLOWED.has(word));
  }

  test('renders the menu in Korean when asked', async ({ page }) => {
    await page.goto('/?lang=ko');
    await page.waitForFunction(() => window.game !== undefined, undefined, { timeout: 45_000 });
    await expect(page.locator('#mp-join')).toBeVisible();

    const text = await page.locator('.menu-panel').innerText();
    // The tagline, the section headings and the buttons.
    expect(text).toContain('싱글플레이');
    expect(text).toContain('서버 접속');
    expect(await page.locator('#mp-join').innerText()).toBe('접속');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ko');
  });

  test('renders every panel in Korean, with no English left on screen', async ({ page }) => {
    await page.goto('/?lang=ko');
    await page.waitForFunction(() => window.game !== undefined, undefined, { timeout: 45_000 });
    await joinServer(page, 'KoLocale');
    await waitForTicks(page, 20);

    const leftovers: string[] = [];
    for (const key of ['KeyI', 'KeyQ', 'KeyB', 'KeyH', 'KeyM'] as const) {
      await page.keyboard.press(key);
      await page.waitForTimeout(350);
      const words = latinWords(await screenText(page));
      if (words.length > 0) leftovers.push(`${key}: ${[...new Set(words)].join(', ')}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
    }
    expect(leftovers, `untranslated text on screen — ${leftovers.join(' | ')}`).toEqual([]);
  });

  test('names content in Korean, from the data tables', async ({ page }) => {
    await page.goto('/?lang=ko');
    await page.waitForFunction(() => window.game !== undefined, undefined, { timeout: 45_000 });
    await joinServer(page, 'KoContent');
    await waitForTicks(page, 20);

    // The starting hatchet, straight out of the item table.
    const held = await page.evaluate(() => {
      const hook = window.__survive!;
      const id = hook.self()?.heldDefId ?? null;
      return { id, name: id === null ? null : hook.itemName(id) };
    });
    expect(held.id).toBe('stone_hatchet');
    expect(held.name).toBe('돌 손도끼');
  });

  test('falls back to English for an unknown language', async ({ page }) => {
    await page.goto('/?lang=xx');
    await page.waitForFunction(() => window.game !== undefined, undefined, { timeout: 45_000 });
    expect(await page.locator('#mp-join').innerText()).toBe('JOIN');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });
});
