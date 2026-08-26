import { beforeEach, describe, expect, it } from 'vitest';
import { JoinError, PROTOCOL_VERSION, dedicatedConfig } from '@survive/protocol';
import { CLAIM_TTL_MS, JoinGate, sanitizeName, sanitizePlayerId } from './joinGate';

/**
 * The gate is the server's front door, so it gets tested like one: every way in, and
 * every way of being turned away.
 */
describe('sanitizeName', () => {
  it('trims and bounds a name', () => {
    expect(sanitizeName('  Alice  ')).toBe('Alice');
    expect(sanitizeName('x'.repeat(100))).toHaveLength(24);
  });

  it('strips control and formatting characters', () => {
    expect(sanitizeName('Al\u0000i\u200bce')).toBe('Alice');
  });

  it('falls back for empty or non-string input', () => {
    expect(sanitizeName('')).toBe('Survivor');
    expect(sanitizeName('   ')).toBe('Survivor');
    expect(sanitizeName(undefined)).toBe('Survivor');
    expect(sanitizeName(42)).toBe('Survivor');
  });
});

describe('sanitizePlayerId', () => {
  /** The persistence layer's own rule for a filename, restated so this can check against it. */
  const FILENAME_SAFE = /^[A-Za-z0-9 ._@-]+$/;

  it('lowercases and keeps only safe characters', () => {
    expect(sanitizePlayerId('Alice_01')).toBe('alice_01');
    expect(sanitizePlayerId('survivor')).toBe('survivor');
  });

  it('refuses to let a name escape the saves folder', () => {
    // Player ids become filenames, so traversal has to be impossible by construction.
    for (const attack of ['../../etc/passwd', '..', '/', 'C:\\Windows', '\u0000nul']) {
      const id = sanitizePlayerId(attack);
      expect(id, attack).toMatch(FILENAME_SAFE);
      expect(id, attack).not.toContain('/');
      expect(id, attack).not.toContain('\\');
      expect(id, attack).not.toContain('..');
    }
  });

  it('collapses to a usable default when there is nothing to work with', () => {
    expect(sanitizePlayerId('')).toBe('survivor');
    expect(sanitizePlayerId('   ')).toBe('survivor');
    expect(sanitizePlayerId(undefined)).toBe('survivor');
  });

  it('is case-insensitive, so two players cannot share a character by casing', () => {
    expect(sanitizePlayerId('Alice')).toBe(sanitizePlayerId('ALICE'));
  });

  it('gives different names different characters, whatever they are written in', () => {
    // The bug this guards: stripping to `[a-z0-9_-]` erased every Korean, Chinese,
    // Japanese, Cyrillic and Greek name to the empty string, which then became the same
    // fallback. `홍길동` and `김철수` were both `survivor` - one character shared by
    // everyone whose name is not spelled in ASCII, and renaming did nothing at all.
    const names = [
      '홍길동',
      '김철수',
      '박태순',
      '玩家一',
      '玩家二',
      'Алексей',
      'Ålex',
      'Alex',
      'Bob Smith',
      'Bob_Smith',
    ];
    const ids = names.map((name) => sanitizePlayerId(name));
    expect(new Set(ids).size, `collisions in ${JSON.stringify(ids)}`).toBe(names.length);
  });

  it('produces ids the save layer will accept', () => {
    // 48 characters is the id budget; the persistence layer allows 64.
    for (const name of ['홍길동', 'Ålex', '玩家一', 'x'.repeat(80), 'Bob Smith']) {
      const id = sanitizePlayerId(name);
      expect(id, name).toMatch(FILENAME_SAFE);
      expect(id.length, name).toBeLessThanOrEqual(48);
      expect(id.length, name).toBeGreaterThan(0);
    }
  });

  it('is stable, so a player comes back to the same character', () => {
    // Derived from the name alone with no clock and no randomness, or a character would be
    // unreachable the next time its owner logged in.
    for (const name of ['홍길동', 'Ålex', 'Alice']) {
      expect(sanitizePlayerId(name)).toBe(sanitizePlayerId(name));
    }
    expect(sanitizePlayerId('홍길동')).toBe(sanitizePlayerId(' 홍길동 '));
  });

  it('leaves a plain ASCII name exactly as it was', () => {
    // Deliberate: these are the ids already on disk, and appending a digest to them would
    // strand every existing character. A name with a space or punctuation does get one -
    // that is the cost of telling `Bob Smith` and `Bob_Smith` apart.
    for (const name of ['Tester', 'alice', 'Bob', 'player_2', 'a-b']) {
      expect(sanitizePlayerId(name)).toBe(name.toLowerCase());
    }
  });
});

describe('JoinGate', () => {
  let gate: JoinGate;
  let clock = 0;

  const options = (extra: Record<string, unknown> = {}) => ({
    protocolVersion: PROTOCOL_VERSION,
    name: 'Alice',
    ...extra,
  });

  beforeEach(() => {
    clock = 1_000_000;
    gate = new JoinGate();
    const config = dedicatedConfig('test');
    config.mode.maxPlayers = 2;
    gate.configure(config, () => clock);
  });

  it('refuses everything before it is configured', () => {
    const unconfigured = new JoinGate();
    const decision = unconfigured.validate(options());
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe(JoinError.ShuttingDown);
    expect(decision.status).toBe(503);
  });

  it('accepts a well-formed request and claims the id', () => {
    const decision = gate.validate(options({ playerId: 'Alice' }));
    expect(decision).toMatchObject({ ok: true, playerId: 'alice', name: 'Alice' });
    expect(gate.has('alice')).toBe(true);
    expect(gate.claimedCount).toBe(1);
  });

  it('derives the player id from the name when none is given', () => {
    // A space is not a safe filename character here, so the id keeps a digest of the name
    // it could not spell - that is what stops `Bob Smith` and `Bob_Smith` being one person.
    expect(gate.validate(options({ name: 'Bob Smith' })).playerId).toBe(
      sanitizePlayerId('Bob Smith'),
    );
    expect(gate.validate(options({ name: 'Bob Smith' })).playerId).toMatch(/^bob_smith-/);
    expect(gate.validate(options({ name: 'Alice' })).playerId).toBe('alice');
  });

  it('rejects a protocol mismatch with a message naming both versions', () => {
    const decision = gate.validate(options({ protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(400);
    expect(decision.reason).toContain(JoinError.ProtocolMismatch);
    expect(decision.reason).toContain(String(PROTOCOL_VERSION));
    // A rejected request must not claim anything.
    expect(gate.claimedCount).toBe(0);
  });

  it('rejects a missing protocol version', () => {
    expect(gate.validate({ name: 'Alice' }).ok).toBe(false);
  });

  it('checks the password only when one is configured', () => {
    expect(gate.validate(options()).ok).toBe(true);

    const guarded = new JoinGate();
    const config = dedicatedConfig('test');
    config.network.password = 'hunter2';
    guarded.configure(config, () => clock);
    expect(guarded.validate(options({ password: 'wrong' })).reason).toBe(JoinError.BadPassword);
    expect(guarded.validate(options()).reason).toBe(JoinError.BadPassword);
    expect(guarded.validate(options({ password: 'hunter2' })).ok).toBe(true);
  });

  it('checks the single-player token only when one is configured', () => {
    const guarded = new JoinGate();
    const config = dedicatedConfig('test');
    config.network.token = 'one-shot';
    guarded.configure(config, () => clock);
    expect(guarded.validate(options({ token: 'nope' })).reason).toBe(JoinError.BadToken);
    expect(guarded.validate(options({ token: 'one-shot' })).ok).toBe(true);
  });

  it('rejects a second claim on the same character', () => {
    expect(gate.validate(options({ playerId: 'alice' })).ok).toBe(true);
    const second = gate.validate(options({ playerId: 'alice' }));
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(second.reason).toBe(JoinError.NameTaken);
  });

  it('enforces the player cap', () => {
    expect(gate.validate(options({ playerId: 'a' })).ok).toBe(true);
    expect(gate.validate(options({ playerId: 'b' })).ok).toBe(true);
    const third = gate.validate(options({ playerId: 'c' }));
    expect(third.ok).toBe(false);
    expect(third.status).toBe(403);
    expect(third.reason).toBe(JoinError.ServerFull);
  });

  it('frees a slot when a player leaves', () => {
    gate.validate(options({ playerId: 'a' }));
    gate.validate(options({ playerId: 'b' }));
    expect(gate.validate(options({ playerId: 'c' })).ok).toBe(false);
    gate.release('a');
    expect(gate.claimedCount).toBe(1);
    expect(gate.validate(options({ playerId: 'c' })).ok).toBe(true);
  });

  it('reaps a reservation that never connected', () => {
    expect(gate.validate(options({ playerId: 'ghost' })).ok).toBe(true);
    // Still held while the reservation is fresh.
    clock += CLAIM_TTL_MS - 1;
    expect(gate.validate(options({ playerId: 'ghost' })).ok).toBe(false);
    // ...and released once it has expired, so a crashed client is not locked out forever.
    clock += 2;
    expect(gate.validate(options({ playerId: 'ghost' })).ok).toBe(true);
  });

  it('never reaps a confirmed connection, however long it lasts', () => {
    gate.validate(options({ playerId: 'alice' }));
    gate.confirm('alice');
    clock += CLAIM_TTL_MS * 1000;
    gate.reap();
    expect(gate.has('alice')).toBe(true);
  });

  it('reset clears configuration and claims', () => {
    gate.validate(options({ playerId: 'alice' }));
    gate.reset();
    expect(gate.claimedCount).toBe(0);
    expect(gate.validate(options()).reason).toBe(JoinError.ShuttingDown);
  });
});
