import { expect, test, type Page } from '@playwright/test';

/**
 * Shared plumbing for the gameplay suite.
 *
 * These tests drive the real Phaser client against a real GameServer (spec section 37).
 * Assertions read the client's authoritative state through `window.__survive` rather than
 * inspecting the canvas: a pixel diff tells you *something changed*, which is not what a
 * gameplay test wants to know.
 */

export interface SelfSnapshot {
  id: string;
  x: number;
  y: number;
  health: number;
  hunger: number;
  thirst: number;
  fatigue: number;
  stamina: number;
  alive: boolean;
  tileX: number;
  tileY: number;
  inventoryCount: number;
  heldDefId: string | null;
  buildDefId: string | null;
  buildRotation: number;
}

/** The address the Playwright web server config starts the game server on. */
export const SERVER_URL = 'http://127.0.0.1:27510';

/** Load the client and wait for the menu. */
export async function openClient(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  (page as Page & { __errors?: string[] }).__errors = errors;

  await page.goto('/');
  // The boot overlay hides itself once content and textures are ready.
  await expect(page.locator('#boot')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('.menu-panel')).toBeVisible();
}

/** Any uncaught page errors seen so far. */
export function pageErrors(page: Page): string[] {
  return (page as Page & { __errors?: string[] }).__errors ?? [];
}

/** Join the test server and wait until the client holds authoritative state. */
/**
 * A player name unique to the running test.
 *
 * Every gameplay spec talks to one server, and the character is keyed by name - so a shared
 * name meant thirty-eight tests taking turns moving one body around. By the end of a run it
 * was wedged in a corner, and tests that needed room to walk failed on where their
 * predecessors had left it. Half a dozen fixes in this file were really just working around
 * that. A name per test gives each one a character of its own, at the spawn point, with full
 * stamina and its own inventory.
 *
 * The world is still shared, which is what the tests want: the terrain and the resource
 * nodes are the same for everyone.
 */
function testCharacterName(): string {
  const path = test.info().titlePath.join(' ');
  // The id derived from this has to stay inside 48 characters and must not collide, so it is
  // a hash of the full title rather than a truncation of it.
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  return `T${hash.toString(36)}`;
}

export async function joinServer(page: Page, name = testCharacterName()): Promise<void> {
  await page.fill('#mp-url', SERVER_URL);
  await page.fill('#mp-name', name);
  await page.click('#mp-join');

  await page.waitForFunction(() => window.__survive?.self() != null, undefined, {
    timeout: 45_000,
  });
  // The HUD is the visible proof the client actually entered the world.
  await expect(page.locator('.hud-vitals')).toBeVisible({ timeout: 15_000 });
}

export async function self(page: Page): Promise<SelfSnapshot> {
  const state = await page.evaluate(() => window.__survive?.self() ?? null);
  expect(state, 'expected authoritative player state').not.toBeNull();
  return state as SelfSnapshot;
}

export async function predicted(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => window.__survive?.predicted() ?? { x: 0, y: 0 });
}

export async function world(page: Page): Promise<{
  tick: number;
  day: number;
  hour: number;
  minute: number;
  weather: string;
  lightLevel: number;
} | null> {
  return page.evaluate(() => window.__survive?.world() ?? null);
}

export async function net(page: Page): Promise<{
  latencyMs: number;
  predictionError: number;
  entityCount: number;
  chunkCount: number;
}> {
  return page.evaluate(
    () =>
      window.__survive?.net() ?? {
        latencyMs: 0,
        predictionError: 0,
        entityCount: 0,
        chunkCount: 0,
      },
  );
}

export async function openPanels(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__survive?.openPanels() ?? []);
}

/** Hold a key for a while, so the client sends several input frames. */
export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  // Let the last frames reach the server and come back.
  await page.waitForTimeout(300);
}

/**
 * Wait until the player has at least this much stamina.
 *
 * Sprinting silently degrades to walking below `SPRINT_STAMINA_FLOOR`, so a test that
 * swung at something first would measure a walk and call it a sprint. Standing still is
 * what regenerates it.
 */
export async function waitForStamina(page: Page, atLeast: number): Promise<void> {
  await page.waitForFunction(
    (target) => (window.__survive?.self()?.stamina ?? 0) >= target,
    atLeast,
    { timeout: 30_000 },
  );
}

/**
 * Hold each direction briefly and return whichever moved the player furthest.
 *
 * Each test gets its own character at the spawn point, but what surrounds that point is
 * whatever the world generated - a tree, a boulder, the corner of a ruin. A test that
 * assumes east is open grades a sprint against a wall as "no faster than walking".
 */
export async function openDirection(page: Page): Promise<string> {
  let best = 'KeyD';
  let furthest = 0;
  for (const code of ['KeyD', 'KeyA', 'KeyS', 'KeyW']) {
    const from = await predicted(page);
    await holdKey(page, code, 260);
    const to = await predicted(page);
    const moved = Math.hypot(to.x - from.x, to.y - from.y);
    if (moved > furthest) {
      furthest = moved;
      best = code;
    }
  }
  return best;
}

/** Wait until the world tick has advanced, proving the server is simulating. */
export async function waitForTicks(page: Page, ticks: number): Promise<void> {
  const start = (await world(page))?.tick ?? 0;
  await page.waitForFunction(
    (target) => (window.__survive?.world()?.tick ?? 0) >= target,
    start + ticks,
    { timeout: 30_000 },
  );
}

/** Nearest replicated entity of a kind, as the client sees it. */
export async function nearest(
  page: Page,
  kind: string,
): Promise<{ id: string; x: number; y: number; distance: number } | null> {
  return page.evaluate((k) => window.__survive?.nearest(k as never) ?? null, kind);
}

/**
 * Walk towards a point until `done` reports success.
 *
 * Steps in whichever axis has the most ground left, which is enough to close on a target
 * in the open and good enough around obstacles because the mover slides along walls. The
 * alternative - holding a fixed direction and hoping something interesting is that way -
 * makes a test that passes or fails on where the previous test happened to leave the
 * player.
 */
export async function walkTowards(
  page: Page,
  target: { x: number; y: number },
  done: () => Promise<boolean>,
  maxSteps = 14,
): Promise<boolean> {
  for (let step = 0; step < maxSteps; step++) {
    if (await done()) return true;
    const from = await predicted(page);
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    if (Math.hypot(dx, dy) < 16) return done();
    const key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'KeyD' : 'KeyA') : dy > 0 ? 'KeyS' : 'KeyW';
    await holdKey(page, key, 220);
  }
  return done();
}
