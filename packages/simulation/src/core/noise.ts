import { distance, type EntityId } from '@survive/protocol';
import type { SimContext } from './context';

/**
 * Noise propagation.
 *
 * Noise is the game's main aggro currency: footsteps on gravel, a chopped tree, a
 * gunshot. Emitting a noise records an event that the AI system consumes in the same
 * tick, which keeps the AI free of any knowledge of *what* made the sound.
 */

/** Rough loudness reference points, in pixels of audible radius. */
export const NoiseRadius = {
  Footstep: 90,
  Sprint: 170,
  Crouch: 40,
  MeleeSwing: 130,
  MeleeHit: 190,
  TreeChop: 260,
  Mining: 300,
  Building: 240,
  DoorOpen: 150,
  StructureBreak: 420,
  BowShot: 160,
  Gunshot: 1600,
  Explosion: 2400,
  Scream: 1400,
  Hurt: 320,
} as const;

/**
 * Emit a noise event.
 *
 * `loudness` is a 0..n scalar the AI uses to break ties between competing sounds;
 * `radius` is the hard audible cutoff in pixels.
 */
export function emitNoise(
  ctx: SimContext,
  x: number,
  y: number,
  radius: number,
  loudness = 1,
  sourceId?: EntityId,
): void {
  if (radius <= 0) return;
  ctx.events.emit({
    type: 'noise',
    x,
    y,
    radius,
    loudness,
    ...(sourceId ? { sourceId } : {}),
  });
}

/**
 * Attenuate a noise by distance and by whether walls stand in the way.
 *
 * Returns 0..1. Walls muffle rather than block: a gunshot inside a house still pulls
 * zombies, just less reliably than one in the street.
 */
export function heardLoudness(
  ctx: SimContext,
  listenerX: number,
  listenerY: number,
  noiseX: number,
  noiseY: number,
  radius: number,
): number {
  const d = distance(listenerX, listenerY, noiseX, noiseY);
  if (d > radius) return 0;
  const falloff = 1 - d / radius;
  const blocked = !ctx.world.hasLineOfSight(noiseX, noiseY, listenerX, listenerY);
  return blocked ? falloff * 0.45 : falloff;
}
