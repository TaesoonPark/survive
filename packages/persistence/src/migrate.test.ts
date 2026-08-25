import { describe, expect, it } from 'vitest';
import { SAVE_FORMAT_VERSION } from '@survive/protocol';
import type { ChunkDynamicPayload, WorldMetaPayload } from '@survive/protocol';
import { makeChunk, makePlayerSave } from './fixtures';
import { SaveFormatError, migrateChunk, migrateMeta, migratePlayer } from './migrate';
import { createInitialWorldMeta } from './types';

/** Cast helper for the deliberately malformed records these tests feed in. */
function withVersion<T>(record: T, version: unknown): T {
  return { ...record, version } as T;
}

describe('save format migration', () => {
  const chunk = makeChunk(2, -3);
  const player = makePlayerSave('alice');
  const meta = createInitialWorldMeta('Test World', 4242, 1_700_000_000_000);

  it('passes a current-version record through unchanged', () => {
    expect(migrateChunk(chunk)).toEqual(chunk);
    expect(migratePlayer(player)).toEqual(player);
    expect(migrateMeta(meta)).toEqual(meta);
  });

  it('does not copy a record it has nothing to do to', () => {
    // Loading is on the hot path (a chunk per player per few seconds); an identity
    // migration must not clone.
    expect(migrateChunk(chunk)).toBe(chunk);
  });

  it('refuses a record from a newer build', () => {
    const future = withVersion(chunk, SAVE_FORMAT_VERSION + 1);
    expect(() => migrateChunk(future)).toThrow(SaveFormatError);
    try {
      migrateChunk(future);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SaveFormatError);
      const failure = error as SaveFormatError;
      expect(failure.name).toBe('SaveFormatError');
      expect(failure.kind).toBe('chunk');
      expect(failure.problem).toBe('too-new');
      expect(failure.found).toBe(SAVE_FORMAT_VERSION + 1);
      expect(failure.supported).toBe(SAVE_FORMAT_VERSION);
      // The message has to be actionable: players see it in a dialog.
      expect(failure.message).toContain('newer build');
    }
  });

  it('names the record kind that failed', () => {
    expect(() => migratePlayer(withVersion(player, 99))).toThrow(/player save/);
    expect(() => migrateMeta(withVersion(meta, 99))).toThrow(/meta save/);
    expect(() => migrateChunk(withVersion(chunk, 99))).toThrow(/chunk save/);
  });

  it('refuses a record with no usable version', () => {
    const cases: unknown[] = [undefined, null, 0, -1, 1.5, Number.NaN, '1', {}];
    for (const version of cases) {
      const broken = withVersion(chunk, version);
      expect(() => migrateChunk(broken)).toThrow(SaveFormatError);
      expect(() => migrateChunk(broken)).toThrow(/malformed/);
    }
  });

  it('reports malformed rather than too-new for a bad version', () => {
    try {
      migrateChunk(withVersion(chunk, '2'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as SaveFormatError).problem).toBe('malformed');
    }
  });

  it('accepts every kind at exactly the supported version', () => {
    const chunkAtVersion: ChunkDynamicPayload = { ...chunk, version: SAVE_FORMAT_VERSION };
    const metaAtVersion: WorldMetaPayload = { ...meta, version: SAVE_FORMAT_VERSION };
    expect(migrateChunk(chunkAtVersion).version).toBe(SAVE_FORMAT_VERSION);
    expect(migrateMeta(metaAtVersion).version).toBe(SAVE_FORMAT_VERSION);
    expect(migratePlayer(player).version).toBe(SAVE_FORMAT_VERSION);
  });
});
