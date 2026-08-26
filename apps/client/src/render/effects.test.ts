import { describe, expect, it } from 'vitest';
import { createGameData } from '@survive/game-data';
import { UNARMED, arcHalfAngle } from '@survive/simulation/systems/combat/weapons';
import { meleeArcShape } from './effects';

/**
 * The swing marker has to show the reach the server actually tests, not a shape that looks
 * about right.
 *
 * A marker that overstates the reach teaches the player to swing at things they cannot hit;
 * one that understates it teaches them to walk closer than they need to and take a hit for
 * it. Either is worse than drawing nothing, so this checks the drawn sector against the
 * same weapon properties `livingTargetsInArc` reads - including `arcHalfAngle`, the
 * server's own function, rather than a second opinion about what the degrees mean.
 */
describe('melee swing marker', () => {
  const data = createGameData();

  const meleeItems = data.items.all().filter((item) => item.weapon?.kind === 'melee');

  it('covers a real spread of weapons, so this is not a spot check', () => {
    expect(meleeItems.length).toBeGreaterThan(5);
  });

  it.each(meleeItems.map((item) => [item.id] as const))(
    'matches the server hit test for %s',
    (id) => {
      const weapon = data.items.require(id).weapon!;
      const shape = meleeArcShape(id, data);
      expect(shape, id).not.toBeNull();
      expect(shape!.radius, `${id} reach`).toBe(weapon.range);
      expect(shape!.halfAngle, `${id} spread`).toBeCloseTo(arcHalfAngle(weapon), 10);
    },
  );

  it("falls back to the simulation's own unarmed numbers", () => {
    // Bare-handed swings carry no `weaponDefId`. Restating 26 and 60 here instead of
    // importing UNARMED would be a copy that drifts the first time punching is rebalanced.
    const shape = meleeArcShape(undefined, data);
    expect(shape).not.toBeNull();
    expect(shape!.radius).toBe(UNARMED.range);
    expect(shape!.halfAngle).toBeCloseTo(arcHalfAngle(UNARMED), 10);
  });

  it('falls back to fists for an item that is not a weapon at all', () => {
    // Swinging a rag or a log: the server resolves those to fists too.
    const shape = meleeArcShape('cloth_rag', data);
    expect(shape!.radius).toBe(UNARMED.range);
  });

  it('draws nothing for a weapon that is not swung', () => {
    const ranged = data.items.all().find((item) => item.weapon?.kind === 'ranged');
    expect(ranged, 'expected at least one ranged weapon in the table').toBeDefined();
    expect(meleeArcShape(ranged!.id, data)).toBeNull();
  });

  it('gives a thrust a visible wedge rather than a zero-width line', () => {
    // The server widens a zero-degree arc to 20 so the weapon is usable; the marker has to
    // agree, or a thrust would be drawn as a shape with no area.
    for (const item of meleeItems) {
      expect(meleeArcShape(item.id, data)!.halfAngle, item.id).toBeGreaterThan(0);
    }
  });

  it('lasts about as long as the swing, and never vanishes instantly', () => {
    for (const item of meleeItems) {
      const shape = meleeArcShape(item.id, data)!;
      expect(shape.swingMs, item.id).toBeGreaterThanOrEqual(160);
      expect(shape.swingMs, item.id).toBeLessThan(3000);
    }
  });
});
