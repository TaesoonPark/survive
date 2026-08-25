/**
 * Deterministic, serializable pseudo-random number generator.
 *
 * The simulation must never call `Math.random()`: replaying the same seed with the
 * same input sequence has to produce byte-identical state, both for tests and for
 * bug reproduction. Every gameplay roll goes through an {@link Rng}.
 *
 * Implementation is `sfc32` (small fast counter, 128-bit state) seeded through
 * `splitmix32`. It is fast, passes PractRand well beyond what a game needs, and its
 * whole state is four uint32s, so it round-trips through JSON.
 */

/** Serializable RNG state: four unsigned 32-bit words. */
export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

const UINT32 = 0x100000000;

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/** Hash an arbitrary string into a uint32. Stable across runs and platforms. */
export function hashString(text: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Combine two uint32s into a new uint32 with good avalanche behaviour. */
export function mixSeeds(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createRngState(seed: number | string): RngState {
  const numeric = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  const next = splitmix32(numeric);
  const state: RngState = { a: next(), b: next(), c: next(), d: next() };
  // A zero state is a fixed point for sfc32; nudge it.
  if ((state.a | state.b | state.c | state.d) === 0) state.d = 1;
  return state;
}

/**
 * A seeded random source. Mutates its own state; clone or fork it when you need an
 * independent stream (see {@link Rng.fork}).
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string | RngState) {
    const state =
      typeof seed === 'object' && seed !== null && 'a' in seed ? seed : createRngState(seed);
    this.a = state.a >>> 0;
    this.b = state.b >>> 0;
    this.c = state.c >>> 0;
    this.d = state.d >>> 0;
  }

  /** Snapshot the internal state so it can be saved and restored exactly. */
  getState(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  setState(state: RngState): void {
    this.a = state.a >>> 0;
    this.b = state.b >>> 0;
    this.c = state.c >>> 0;
    this.d = state.d >>> 0;
  }

  /** Next raw uint32. */
  nextUint32(): number {
    const t = (this.a + this.b + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / UINT32;
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    if (max <= min) return min;
    const span = max - min + 1;
    return min + Math.floor(this.next() * span);
  }

  /** True with probability `chance` (0..1). */
  chance(probability: number): boolean {
    if (probability <= 0) return false;
    if (probability >= 1) return true;
    return this.next() < probability;
  }

  /** Uniform angle in [-PI, PI). */
  angle(): number {
    return this.float(-Math.PI, Math.PI);
  }

  /** Random sign, -1 or 1. */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  /** Approximately normal deviate with the given mean and standard deviation. */
  normal(mean = 0, stdDev = 1): number {
    // Box-Muller; the log guard keeps it finite.
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Pick one element uniformly. Returns undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.int(0, items.length - 1)];
  }

  /**
   * Pick one element with weights. `weightOf` must return a non-negative number.
   * Returns undefined when the list is empty or every weight is zero.
   */
  pickWeighted<T>(items: readonly T[], weightOf: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) {
      const w = weightOf(item);
      if (w > 0) total += w;
    }
    if (total <= 0) return undefined;
    let roll = this.next() * total;
    for (const item of items) {
      const w = weightOf(item);
      if (w <= 0) continue;
      roll -= w;
      if (roll < 0) return item;
    }
    return items[items.length - 1];
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /**
   * Derive an independent stream from this one.
   *
   * Use this when a subsystem needs its own randomness so that adding or removing an
   * unrelated roll elsewhere does not shift its results. The derived stream is a pure
   * function of the current state and `label`, and advances this generator once.
   */
  fork(label: string): Rng {
    const seed = mixSeeds(this.nextUint32(), hashString(label));
    return new Rng(seed);
  }

  /** An exact copy, sharing no state. */
  clone(): Rng {
    return new Rng(this.getState());
  }
}

/**
 * A stable, stateless roll derived purely from coordinates and a seed.
 *
 * Terrain generation uses this so that a chunk generates identically no matter what
 * order chunks are visited in.
 */
export function hashNoise(seed: number, x: number, y: number, salt = 0): number {
  let h = seed >>> 0;
  h = mixSeeds(h, (x | 0) >>> 0);
  h = mixSeeds(h, (y | 0) >>> 0);
  h = mixSeeds(h, salt >>> 0);
  return h / UINT32;
}

/** Deterministic per-coordinate RNG, for chunk-local generation. */
export function rngForCoord(seed: number, x: number, y: number, salt = 0): Rng {
  let h = seed >>> 0;
  h = mixSeeds(h, (x | 0) >>> 0);
  h = mixSeeds(h, (y | 0) >>> 0);
  h = mixSeeds(h, salt >>> 0);
  return new Rng(h);
}
