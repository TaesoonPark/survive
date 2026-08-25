/**
 * Deterministic coherent noise.
 *
 * Everything here is a pure function of `(seed, x, y)`. There is no internal cache and
 * no state: sampling a point twice returns the identical double, and sampling points in
 * a different order cannot change any result. That property is what lets terrain
 * generation be order-independent (Architecture Guard rule 7 and spec section 29) -
 * chunk (5, 7) must look the same whether it is the first chunk a player walks into or
 * the ten-thousandth.
 *
 * The lattice values come from {@link hashNoise}, so the noise is *value* noise rather
 * than gradient noise. Value noise has slightly more axis-aligned structure than
 * simplex, which is why the higher-level helpers here (domain warp, ridged multifractal)
 * exist: warping the input domain hides the lattice far more cheaply than switching to a
 * gradient basis, and it costs two extra noise taps instead of eight dot products.
 */

import { hashNoise, mixSeeds } from '@survive/protocol';

/** Parameters for a fractal sum. Frequencies are in *lattice cells per unit input*. */
export interface FbmParams {
  /** Number of summed octaves. Each one doubles (see `lacunarity`) the frequency. */
  octaves: number;
  /** Frequency of the first octave. */
  frequency: number;
  /** Frequency multiplier per octave. Deliberately not exactly 2 in callers, so the
   *  octave lattices do not line up and produce visible grid artefacts. */
  lacunarity: number;
  /** Amplitude multiplier per octave. */
  gain: number;
}

export const DEFAULT_FBM: FbmParams = {
  octaves: 4,
  frequency: 1,
  lacunarity: 2.02,
  gain: 0.5,
};

/**
 * Quintic fade curve, `6t^5 - 15t^4 + 10t^3`.
 *
 * Has zero first *and* second derivative at both ends, so interpolated fields have no
 * visible creases along lattice lines. A cheaper cubic smoothstep leaves a faint grid
 * that shows up badly once the field is thresholded into biomes.
 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Bilinear blend of four lattice corners. Shared so batch and point sampling match. */
export function bilerp(a: number, b: number, c: number, d: number, tx: number, ty: number): number {
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Smooth value noise in `[0, 1)`.
 *
 * Coordinates are continuous; the integer lattice is hashed straight out of the seed so
 * nothing has to be precomputed or allocated.
 */
export function valueNoise2D(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  return bilerp(
    hashNoise(seed, x0, y0),
    hashNoise(seed, x0 + 1, y0),
    hashNoise(seed, x0, y0 + 1),
    hashNoise(seed, x0 + 1, y0 + 1),
    fx,
    fy,
  );
}

/**
 * Fractal Brownian motion: a normalised sum of octaves, in `[0, 1]`.
 *
 * Each octave uses its own derived seed. Reusing one seed at doubled frequencies would
 * correlate the octaves (the coarse lattice points are also fine lattice points), which
 * shows up as blocky repetition.
 */
export function fbm2D(seed: number, x: number, y: number, params: FbmParams = DEFAULT_FBM): number {
  let frequency = params.frequency;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  for (let octave = 0; octave < params.octaves; octave++) {
    sum += valueNoise2D(mixSeeds(seed, octave), x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    frequency *= params.lacunarity;
    amplitude *= params.gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal in `[0, 1]`: sharp crests instead of rolling hills.
 *
 * Folding each octave through `1 - |2n - 1|` turns the smooth field's zero crossings
 * into ridge lines, and weighting each octave by the previous one keeps detail on the
 * crests while leaving the valleys smooth. Used for mountain spines and cliff bands.
 */
export function ridged2D(
  seed: number,
  x: number,
  y: number,
  params: FbmParams = DEFAULT_FBM,
): number {
  let frequency = params.frequency;
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let octave = 0; octave < params.octaves; octave++) {
    let n = valueNoise2D(mixSeeds(seed, octave ^ 0x5bd1), x * frequency, y * frequency);
    n = 1 - Math.abs(n * 2 - 1);
    n *= n;
    n *= weight;
    // Detail only survives where the previous octave was already high: that is what
    // keeps ridges crisp rather than turning into noise everywhere.
    weight = clamp01(n * 2);
    sum += n * amplitude;
    norm += amplitude;
    frequency *= params.lacunarity;
    amplitude *= params.gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Offset a sample point by a low-frequency noise vector.
 *
 * Domain warping is what makes value noise stop looking like value noise: coastlines
 * and biome borders pick up the swirls and inlets that a plain fractal sum never
 * produces. `strength` is measured in units of the *input* space, so callers pass
 * already-scaled coordinates and think in lattice cells.
 */
export function domainWarp2D(
  seed: number,
  x: number,
  y: number,
  strength: number,
  frequency: number,
): { x: number; y: number } {
  const wx = valueNoise2D(mixSeeds(seed, 0x517c), x * frequency, y * frequency) * 2 - 1;
  const wy = valueNoise2D(mixSeeds(seed, 0x9e37), x * frequency, y * frequency) * 2 - 1;
  return { x: x + wx * strength, y: y + wy * strength };
}

/**
 * {@link fbm2D} of a domain-warped point, without allocating the intermediate vector.
 *
 * This is the workhorse for terrain fields: it is called a few hundred times per chunk,
 * so it deliberately avoids returning an object.
 */
export function warpedFbm2D(
  seed: number,
  x: number,
  y: number,
  params: FbmParams,
  strength: number,
  frequency: number,
): number {
  const wx = valueNoise2D(mixSeeds(seed, 0x517c), x * frequency, y * frequency) * 2 - 1;
  const wy = valueNoise2D(mixSeeds(seed, 0x9e37), x * frequency, y * frequency) * 2 - 1;
  return fbm2D(seed, x + wx * strength, y + wy * strength, params);
}

/**
 * Signed "distance" to the centreline of the field's 0.5 contour, remapped so that
 * `1` is dead centre and `<= 0` is outside the band of half-width `width`.
 *
 * Rivers are exactly this: the zero-crossing contour of a smooth field is a set of
 * long winding curves, which is far cheaper than simulating drainage.
 */
export function contourBand(value: number, width: number): number {
  return 1 - Math.abs(value - 0.5) / width;
}
