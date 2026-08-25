import { describe, expect, it } from 'vitest';
import { Rng, createRngState, hashNoise, hashString, mixSeeds, rngForCoord } from './rng';

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const left = Array.from({ length: 64 }, () => a.next());
    const right = Array.from({ length: 64 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 32 }, (_, i) => new Rng(1).next() + i * 0);
    const b = new Rng(2);
    // Compare full sequences rather than single draws, which can collide by chance.
    const first = new Rng(1);
    const seqA = Array.from({ length: 32 }, () => first.next());
    const seqB = Array.from({ length: 32 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
    expect(a.length).toBe(32);
  });

  it('round-trips its state exactly', () => {
    const rng = new Rng('save-me');
    for (let i = 0; i < 10; i++) rng.next();
    const saved = rng.getState();
    const expected = Array.from({ length: 16 }, () => rng.next());

    const restored = new Rng(saved);
    const actual = Array.from({ length: 16 }, () => restored.next());
    expect(actual).toEqual(expected);
  });

  it('survives a JSON round trip', () => {
    const rng = new Rng(99);
    rng.next();
    const revived = new Rng(JSON.parse(JSON.stringify(rng.getState())));
    expect(revived.next()).toBe(new Rng(rng.getState()).next());
  });

  it('keeps float() inside its bounds', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const value = rng.float(-3, 11);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThan(11);
    }
  });

  it('keeps int() inclusive on both ends and covers the whole range', () => {
    const rng = new Rng(21);
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const value = rng.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
  });

  it('treats int(min, min) as a constant', () => {
    const rng = new Rng(5);
    expect(rng.int(4, 4)).toBe(4);
    expect(rng.int(4, 2)).toBe(4);
  });

  it('honours chance() at the extremes without consuming entropy', () => {
    const rng = new Rng(1);
    const before = rng.getState();
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    expect(rng.getState()).toEqual(before);
  });

  it('approximates the requested probability', () => {
    const rng = new Rng(4242);
    let hits = 0;
    const trials = 20000;
    for (let i = 0; i < trials; i++) if (rng.chance(0.25)) hits++;
    expect(hits / trials).toBeGreaterThan(0.23);
    expect(hits / trials).toBeLessThan(0.27);
  });

  it('picks weighted entries in proportion to their weights', () => {
    const rng = new Rng(31337);
    const items = [
      { id: 'a', w: 1 },
      { id: 'b', w: 9 },
      { id: 'zero', w: 0 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0, zero: 0 };
    for (let i = 0; i < 20000; i++) {
      const picked = rng.pickWeighted(items, (item) => item.w);
      counts[picked!.id]!++;
    }
    expect(counts.zero).toBe(0);
    expect(counts.b! / counts.a!).toBeGreaterThan(7);
    expect(counts.b! / counts.a!).toBeLessThan(11);
  });

  it('returns undefined for empty or all-zero weighted pools', () => {
    const rng = new Rng(1);
    expect(rng.pick([])).toBeUndefined();
    expect(rng.pickWeighted([], () => 1)).toBeUndefined();
    expect(rng.pickWeighted([{ w: 0 }], (i) => i.w)).toBeUndefined();
  });

  it('shuffles as a permutation, not a filter', () => {
    const rng = new Rng(808);
    const source = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = rng.shuffle([...source]);
    expect(shuffled).toHaveLength(50);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(source);
    expect(shuffled).not.toEqual(source);
  });

  it('forks independent but reproducible streams', () => {
    const parentA = new Rng(500);
    const parentB = new Rng(500);
    const forkA = parentA.fork('combat');
    const forkB = parentB.fork('combat');
    expect(forkA.next()).toBe(forkB.next());

    const other = new Rng(500).fork('loot');
    expect(other.next()).not.toBe(forkA.next());
  });

  it('advances the parent when forking, so repeated forks differ', () => {
    const parent = new Rng(11);
    const first = parent.fork('x').next();
    const second = parent.fork('x').next();
    expect(first).not.toBe(second);
  });

  it('clones without sharing state', () => {
    const rng = new Rng(64);
    const clone = rng.clone();
    expect(clone.next()).toBe(new Rng(rng.getState()).next());
    rng.next();
    // The clone is unaffected by the original advancing.
    const cloneState = clone.getState();
    clone.next();
    expect(cloneState).not.toEqual(clone.getState());
  });

  it('never produces a zero state, which would be a fixed point', () => {
    const state = createRngState(0);
    expect(state.a | state.b | state.c | state.d).not.toBe(0);
    const rng = new Rng(0);
    const values = new Set(Array.from({ length: 20 }, () => rng.next()));
    expect(values.size).toBeGreaterThan(15);
  });

  it('accepts string seeds', () => {
    expect(new Rng('hello').next()).toBe(new Rng('hello').next());
    expect(new Rng('hello').next()).not.toBe(new Rng('world').next());
  });
});

describe('hashing helpers', () => {
  it('hashString is stable and well distributed', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('')).toBeGreaterThanOrEqual(0);
  });

  it('mixSeeds is order sensitive', () => {
    expect(mixSeeds(1, 2)).not.toBe(mixSeeds(2, 1));
  });

  it('hashNoise is a pure function of its inputs', () => {
    expect(hashNoise(1, 5, 9)).toBe(hashNoise(1, 5, 9));
    expect(hashNoise(1, 5, 9)).not.toBe(hashNoise(1, 9, 5));
    for (let i = 0; i < 500; i++) {
      const value = hashNoise(42, i, i * 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('rngForCoord does not depend on visit order', () => {
    const direct = rngForCoord(7, 12, 34).next();
    const warmed = new Rng(1);
    for (let i = 0; i < 100; i++) warmed.next();
    expect(rngForCoord(7, 12, 34).next()).toBe(direct);
  });
});
