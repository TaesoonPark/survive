import { expect, test, type Page } from '@playwright/test';
import { joinServer, openClient, waitForTicks, walkTowards } from './helpers';

interface NodeProbe {
  id: string;
  x: number;
  y: number;
  health: number;
  maxHealth: number;
  harvests: number;
}

/**
 * The nearest node sturdy enough to survive several swings.
 *
 * `nearest(page, 'node')` is not good enough here: the closest node is often a patch of
 * fibre grass, which depletes on the first harvest and is removed from the client - so the
 * counter being watched vanishes and the test reads as a failure of the repeat. A tree or a
 * boulder has health in the hundreds and takes a dozen swings.
 */
async function sturdyNode(page: Page, minHealth = 60): Promise<NodeProbe | null> {
  return page.evaluate((floor) => {
    const hook = window.__survive!;
    const from = hook.render();
    let best: NodeProbe | null = null;
    for (const id of hook.entities().node ?? []) {
      const entity = hook.entity(id);
      if (!entity || entity.k !== 'node' || entity.depleted) continue;
      if (entity.maxHealth < floor) continue;
      const probe = {
        id,
        x: entity.x,
        y: entity.y,
        health: entity.health,
        maxHealth: entity.maxHealth,
        harvests: entity.harvests,
      };
      if (
        !best ||
        Math.hypot(probe.x - from.x, probe.y - from.y) <
          Math.hypot(best.x - from.x, best.y - from.y)
      ) {
        best = probe;
      }
    }
    return best;
  }, minHealth);
}

async function probe(page: Page, id: string): Promise<NodeProbe | null> {
  return page.evaluate((nodeId) => {
    const entity = window.__survive!.entity(nodeId);
    if (!entity || entity.k !== 'node') return null;
    return {
      id: nodeId,
      x: entity.x,
      y: entity.y,
      health: entity.health,
      maxHealth: entity.maxHealth,
      harvests: entity.harvests,
    };
  }, id);
}

/**
 * Walk to the node until it is the thing the key would actually act on.
 *
 * Checking the prompt is not enough: the interaction search takes the *nearest*
 * interactable, so a patch of grass underfoot outranks the tree that was walked to, and the
 * prompt reads "harvest" either way. The first version of this test pressed the key, cut the
 * grass, and reported the tree as undamaged.
 */
async function reach(page: Page, node: NodeProbe): Promise<boolean> {
  return walkTowards(page, node, async () => {
    return (await page.evaluate(() => window.__survive!.focusId())) === node.id;
  });
}

/**
 * Holding the interact key keeps gathering (spec section 7).
 *
 * Felling a tree takes a dozen swings, and one key press per swing turns gathering into a
 * typing exercise. What is measured is the node's own health, not the player's inventory:
 * a tree yields its logs when it finally falls, and every swing before that is invisible
 * from the inventory side.
 */
test.describe('gathering', () => {
  test('one press swings once, holding keeps swinging, releasing stops it', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await waitForTicks(page, 20);

    // One walk, three assertions. Split across two tests, the second had to find a tree of
    // its own - and the first had just spent a while felling the only one in range.
    const node = await sturdyNode(page);
    expect(node, 'expected a tree or boulder within streaming range').not.toBeNull();
    expect(await reach(page, node!), 'expected it to become the interaction target').toBe(true);

    const start = await probe(page, node!.id);
    expect(start).not.toBeNull();

    // One tap, then long enough for the round trip.
    await page.keyboard.down('KeyE');
    await page.keyboard.up('KeyE');
    await waitForTicks(page, 14);
    const afterTap = await probe(page, node!.id);
    expect(afterTap, 'the node should have taken a hit').not.toBeNull();
    const tapDamage = start!.health - afterTap!.health;
    expect(tapDamage, 'one press should land one swing').toBeGreaterThan(0);

    // Held. The cooldown is 8 ticks, so 1.6 s leaves room for three more swings even after
    // the round trip - a lower bound, because how many land depends on latency.
    await page.keyboard.down('KeyE');
    await page.waitForTimeout(1600);
    await page.keyboard.up('KeyE');
    await waitForTicks(page, 14);

    const afterHold = await probe(page, node!.id);
    expect(afterHold, 'the node should not have been felled outright').not.toBeNull();
    const holdDamage = afterTap!.health - afterHold!.health;
    expect(
      holdDamage,
      `held for 1.6 s: expected several swings, one tap did ${tapDamage}`,
    ).toBeGreaterThanOrEqual(tapDamage * 2);

    // And it has to actually stop. A repeat that outlives the key press is worse than no
    // repeat at all - the player would strip a forest by walking through it.
    await page.waitForTimeout(1300);
    const later = await probe(page, node!.id);
    expect(later, 'the node left the client view while idle').not.toBeNull();
    expect(later!.health, 'the node kept taking damage after the key was released').toBe(
      afterHold!.health,
    );
  });
});
