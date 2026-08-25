import { expect, test } from '@playwright/test';
import { holdKey, joinServer, net, openClient, predicted, self } from './helpers';

/**
 * WASD, prediction and reconciliation (spec sections 1 and 17).
 *
 * The interesting property is not "the sprite moved" but "the client's prediction and the
 * server's authority agree" — so these tests check both, and check that the error between
 * them stays small.
 */
test.describe('movement', () => {
  test('WASD moves the player, and the server agrees', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    const before = await self(page);
    await holdKey(page, 'KeyD', 700);
    const after = await self(page);

    // The authoritative position moved east.
    expect(after.x).toBeGreaterThan(before.x + 8);
    expect(Math.abs(after.y - before.y)).toBeLessThan(20);
  });

  test('each direction key moves the right way', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    const start = await self(page);
    await holdKey(page, 'KeyS', 500);
    const down = await self(page);
    expect(down.y).toBeGreaterThan(start.y);

    await holdKey(page, 'KeyW', 700);
    const up = await self(page);
    expect(up.y).toBeLessThan(down.y);

    await holdKey(page, 'KeyA', 500);
    const left = await self(page);
    expect(left.x).toBeLessThan(up.x + 2);
  });

  test('prediction stays close to the authoritative position', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    await holdKey(page, 'KeyD', 900);
    const authoritative = await self(page);
    const local = await predicted(page);
    const drift = Math.hypot(local.x - authoritative.x, local.y - authoritative.y);
    // A few tiles of slack covers latency and the unacknowledged input queue; more than
    // that means prediction and the server are running different rules.
    expect(drift).toBeLessThan(96);
    expect((await net(page)).predictionError).toBeLessThan(96);
  });

  test('sprinting is faster than walking and costs stamina', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    const walkStart = await self(page);
    await holdKey(page, 'KeyD', 600);
    const walkEnd = await self(page);
    const walked = Math.abs(walkEnd.x - walkStart.x);

    await page.keyboard.down('ShiftLeft');
    const sprintStart = await self(page);
    await holdKey(page, 'KeyD', 600);
    const sprintEnd = await self(page);
    await page.keyboard.up('ShiftLeft');
    const sprinted = Math.abs(sprintEnd.x - sprintStart.x);

    expect(sprinted).toBeGreaterThan(walked);
    expect(sprintEnd.stamina).toBeLessThan(sprintStart.stamina);
  });

  test('releasing the keys stops the player', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await holdKey(page, 'KeyD', 400);
    const stopped = await self(page);
    await page.waitForTimeout(700);
    const later = await self(page);
    // Knockback aside, a player with no input does not drift.
    expect(Math.abs(later.x - stopped.x)).toBeLessThan(6);
  });
});

/**
 * Smoothness is a separate property from correctness, and the tests above cannot see it:
 * they compare a start position with an end position, which a sprite that teleports once
 * per tick satisfies perfectly.
 *
 * The simulation is a fixed 20 Hz ladder and the display is not, so the local player has to
 * be drawn *between* rungs. Drawing the raw prediction instead froze the sprite for 83% of
 * frames and then jumped it a whole tick's distance - and because the camera eases smoothly,
 * the character appeared to shudder backwards inside its own direction of travel. Nothing
 * actually moved backwards; it only looked that way against a camera that was catching up.
 */
test.describe('render smoothness', () => {
  test('the local player moves a little every frame, never in jumps', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.waitForTimeout(800);

    const stats = await page.evaluate(async () => {
      const hook = window.__survive!;
      const hold = (code: string, down: boolean): void => {
        window.dispatchEvent(
          new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }),
        );
      };
      const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

      // Whichever way is open depends entirely on where the earlier tests left the player -
      // every gameplay spec shares one server and one save - so probe for a direction with
      // room before measuring. Without this the test silently graded a sprite pinned
      // against a wall.
      let heading = 'KeyD';
      let best = 0;
      for (const code of ['KeyD', 'KeyA', 'KeyS', 'KeyW']) {
        const from = hook.render();
        hold(code, true);
        await wait(300);
        hold(code, false);
        const moved = Math.hypot(hook.render().x - from.x, hook.render().y - from.y);
        if (moved > best) {
          best = moved;
          heading = code;
        }
        await wait(120);
      }

      const frames: { dx: number; dy: number; dt: number }[] = [];
      let last: { x: number; y: number } | null = null;
      let lastT = 0;
      hold(heading, true);
      await new Promise<void>((done) => {
        let n = 0;
        const step = (now: number): void => {
          const p = hook.render();
          const dt = now - lastT;
          if (last && dt > 0) frames.push({ dx: p.x - last.x, dy: p.y - last.y, dt });
          last = { x: p.x, y: p.y };
          lastT = now;
          if (++n < 220) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      hold(heading, false);

      // Drop the opening frames, and any frame long enough to have spanned a hitch.
      const moving = frames.slice(40).filter((f) => f.dt < 40);
      // Measured along the direction actually travelled, not along the key pressed: a wall
      // can deflect a diagonal, and this test is about smoothness, not heading.
      const netX = moving.reduce((a, f) => a + f.dx, 0);
      const netY = moving.reduce((a, f) => a + f.dy, 0);
      const travelled = Math.hypot(netX, netY);
      const ux = travelled > 0 ? netX / travelled : 0;
      const uy = travelled > 0 ? netY / travelled : 0;
      const along = moving.map((f) => (f.dx * ux + f.dy * uy) / f.dt);
      return {
        heading,
        count: along.length,
        travelled,
        frozen: along.filter((v) => Math.abs(v) < 0.005).length,
        fastest: Math.max(...along),
      };
    });

    expect(stats.count).toBeGreaterThan(60);
    // The premise: it has to have gone somewhere, or the rest measures a stationary sprite.
    expect(
      stats.travelled,
      `the player did not move heading ${stats.heading}; is every way blocked?`,
    ).toBeGreaterThan(20);
    // The judder is the sprite standing still and then jumping a whole tick, so the frozen
    // fraction is what to grade on: drawing the raw 20 Hz rung leaves five frames in six
    // dead, while easing leaves none. Unlike a peak-speed bound it does not depend on the
    // refresh rate, which in headless Chromium is not the 120 Hz it looks like from one run.
    expect(stats.frozen).toBeLessThan(stats.count * 0.15);
    // Walking is 105 px/s = 0.105 px/ms, so this is a loose sanity bound rather than a
    // tight one - the ease legitimately runs fast for a frame or two catching up after a
    // hitch. A whole tick delivered in one frame is 0.6-0.7 px/ms and still fails.
    expect(stats.fastest).toBeLessThan(0.45);
    // Deliberately not asserting that the drawn position never moves backwards. When the
    // server genuinely disagrees it *should* pull the player back, and how often that
    // happens depends on where earlier tests left them - prediction accuracy has its own
    // tests (`apps/client/src/net/prediction.test.ts`, `tests/unit/inputBackpressure.test.ts`).
    // What is asserted here is only that whatever motion happens is delivered smoothly.
  });
  test('holds the screen centre and draws at an even speed', async ({ page }) => {
    await openClient(page);
    await joinServer(page);
    await page.waitForTimeout(900);

    const stats = await page.evaluate(async () => {
      const hook = window.__survive!;
      const hold = (code: string, down: boolean): void => {
        window.dispatchEvent(
          new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }),
        );
      };
      const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

      let heading = 'KeyD';
      let best = 0;
      for (const code of ['KeyD', 'KeyA', 'KeyS', 'KeyW']) {
        const from = hook.render();
        hold(code, true);
        await wait(300);
        hold(code, false);
        const moved = Math.hypot(hook.render().x - from.x, hook.render().y - from.y);
        if (moved > best) {
          best = moved;
          heading = code;
        }
        await wait(140);
      }

      const rows: { t: number; sx: number; sy: number; rx: number; ry: number }[] = [];
      // Walk, stop, walk again: a second-order filter rings on the transitions, not in
      // the middle, so the samples have to cover a start and a stop.
      const script: [number, boolean][] = [
        [250, false],
        [1200, true],
        [400, false],
        [800, true],
      ];
      let phase = 0;
      let phaseStart = 0;
      let held = false;
      await new Promise<void>((done) => {
        const step = (now: number): void => {
          if (phaseStart === 0) phaseStart = now;
          const want = script[phase]![1];
          if (want !== held) {
            hold(heading, want);
            held = want;
          }
          if (now - phaseStart > script[phase]![0]) {
            phase++;
            phaseStart = now;
          }
          const sc = hook.screen();
          const r = hook.render();
          rows.push({ t: now, sx: sc.x, sy: sc.y, rx: r.x, ry: r.y });
          if (phase < script.length) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      if (held) hold(heading, false);

      let worstScreenStep = 0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1]!;
        const b = rows[i]!;
        if (b.t - a.t > 40) continue;
        worstScreenStep = Math.max(worstScreenStep, Math.hypot(b.sx - a.sx, b.sy - a.sy));
      }

      // Only the steady stretch inside the first walk, where the speed should be flat.
      const walk = rows.slice(40, 130);
      const speeds: number[] = [];
      for (let i = 1; i < walk.length; i++) {
        const a = walk[i - 1]!;
        const b = walk[i]!;
        const dt = b.t - a.t;
        if (dt > 0 && dt < 40) speeds.push(Math.hypot(b.rx - a.rx, b.ry - a.ry) / dt);
      }
      // Frame-to-frame change, not the spread of the whole window: the speed legitimately
      // changes with the terrain underfoot, and after the earlier specs have walked the
      // player around, a window that crosses a road or a patch of brush shows a real step
      // change. Judder is a per-frame wobble, so measure that and take the median, which a
      // couple of tile boundaries cannot move.
      const deltas: number[] = [];
      for (let i = 1; i < speeds.length; i++) deltas.push(Math.abs(speeds[i]! - speeds[i - 1]!));
      const sortedSpeeds = [...speeds].sort((x, y) => x - y);
      deltas.sort((x, y) => x - y);
      const p50 = sortedSpeeds[Math.floor(sortedSpeeds.length / 2)] ?? 0;
      return {
        heading,
        samples: speeds.length,
        worstScreenStep,
        p50,
        jitter: p50 > 0 ? (deltas[Math.floor(deltas.length / 2)] ?? 0) / p50 : 0,
      };
    });

    expect(stats.samples).toBeGreaterThan(40);
    expect(stats.p50, `did the player move heading ${stats.heading}?`).toBeGreaterThan(0.02);
    // The camera is locked to the drawn position, so the player does not move on screen at
    // all. Easing the camera towards an already-eased sprite made a second-order filter
    // that rang on every start and stop - 0.77 px of screen-space slide per frame, with
    // reconciliation reporting no error whatsoever.
    expect(stats.worstScreenStep).toBeLessThan(0.05);
    // Speed has to be flat, not merely nonzero. Feeding a plain low-pass filter the 20 Hz
    // staircase closed most of each step early and coasted at the end (ratio 1.56), and
    // handing update() a smoothed delta desynchronised the integration clock from the
    // display clock (2.16 on one run, 1.05 on the next - which is exactly why that one
    // presented as intermittent). Interpolating across the step in progress from the real
    // delta measures 1.006-1.010 run to run, so this bound has an order of magnitude more
    // margin than the fixed code needs. It will not catch a delta-smoothing regression on
    // every run, only on the runs where it is actually visible.
    expect(stats.jitter).toBeLessThan(0.99);
  });
  test('draws without snapping to whole pixels, from the real frame delta', async ({ page }) => {
    await openClient(page);
    await joinServer(page);

    // Asserted on the live game rather than on the config literal, because what matters is
    // what Phaser ended up running with. Both flags read like harmless quality settings and
    // both put visible judder back: `roundPixels: true` is the pixel-art default every
    // tutorial repeats, and `smoothStep` defaults to on. Neither leaves a trace in a test
    // that checks positions - the world coordinates stayed even to within half a percent
    // while the screen stuttered - so they are checked directly.
    const flags = await page.evaluate(() => {
      const game = window.game!;
      return {
        roundPixels: game.config.roundPixels,
        smoothStep: game.loop.smoothStep,
        pixelArt: game.config.pixelArt,
        antialias: game.config.antialias,
      };
    });

    // The camera runs at zoom 1.5, so snapping cannot align the pixel grid anyway - a
    // source pixel spans one and a half screen pixels however the coordinates are rounded.
    // What it does do is quantise the scroll: walking covers 1.31 screen pixels per frame
    // at 120 Hz, so rounding alternates frames that do not move with frames that move
    // twice as far. Frame-to-frame jitter of the drawn position: 0.163 rounded, 0.006 not.
    expect(flags.roundPixels).toBe(false);
    // The prediction accumulator and the render interpolation both integrate the frame
    // delta, while the eye judges the result against real time. Averaging it desynchronises
    // those two clocks by however much the frame times scatter, which is why this one
    // presented as intermittent: one run measured a 2.16x speed spread, the next 1.05x.
    expect(flags.smoothStep).toBe(false);
    // Nearest-neighbour comes from antialias:false, not from the pixelArt shorthand - the
    // shorthand would force roundPixels back on and silently undo the assertion above.
    expect(flags.pixelArt).toBe(false);
    expect(flags.antialias).toBe(false);
  });
});
