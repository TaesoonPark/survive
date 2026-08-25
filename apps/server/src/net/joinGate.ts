import {
  JoinError,
  PROTOCOL_VERSION,
  type JoinOptions,
  type SimulationConfig,
} from '@survive/protocol';

/**
 * The join handshake.
 *
 * Colyseus 0.17 only calls the *static* `onAuth`, and it calls it during the matchmaking
 * HTTP request - before a seat is reserved and before a socket is opened. That is exactly
 * where these checks belong: a client with the wrong password or a stale protocol version
 * gets a readable HTTP error instead of a socket that silently closes.
 *
 * Being static means it has no room instance to read, so the room registers its state
 * here on create. A server process hosts exactly one world, so a module-level gate is the
 * honest shape for this rather than a pretence of multi-tenancy.
 */

export interface JoinDecision {
  ok: boolean;
  /** HTTP status to reject with. */
  status: number;
  /** A {@link JoinError} code, plus detail where it helps. */
  reason: string;
  /** The sanitized, claimed player id. Only set when `ok`. */
  playerId: string;
  name: string;
}

/** Trim and bound a display name; fall back to something usable. */
export function sanitizeName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const cleaned = text.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 24);
  return cleaned.length > 0 ? cleaned : 'Survivor';
}

/**
 * Reduce an arbitrary string to a safe persistence key.
 *
 * Player ids become filenames, so anything that could escape a directory or collide
 * across cases has to go.
 */
export function sanitizePlayerId(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    // Collapse runs, so `C:\Windows` becomes `c_windows` rather than `c__windows`.
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'survivor';
}

/** How long a reserved-but-unconnected claim is held before it is reaped. */
export const CLAIM_TTL_MS = 30_000;

export class JoinGate {
  private config: SimulationConfig | null = null;
  /** Player ids held by a live connection or a fresh reservation. */
  private readonly claimed = new Set<string>();
  /** Claim time for ids that have a reservation but no socket yet. */
  private readonly pending = new Map<string, number>();
  private now: () => number = () => Date.now();

  /** Called by the room on create. */
  configure(config: SimulationConfig, now?: () => number): void {
    this.config = config;
    if (now) this.now = now;
  }

  /** Drop all state. Used between tests and on room dispose. */
  reset(): void {
    this.config = null;
    this.claimed.clear();
    this.pending.clear();
  }

  get claimedCount(): number {
    return this.claimed.size;
  }

  has(playerId: string): boolean {
    return this.claimed.has(playerId);
  }

  /**
   * Validate a join request and, on success, claim the player id.
   *
   * Claiming here rather than at connect time is what stops two tabs racing to be the
   * same character: whichever reservation lands first owns it.
   */
  validate(rawOptions: unknown): JoinDecision {
    const options = (rawOptions ?? {}) as Partial<JoinOptions>;
    const name = sanitizeName(options.name);
    const playerId = sanitizePlayerId(options.playerId ?? name);
    const reject = (status: number, reason: string): JoinDecision => ({
      ok: false,
      status,
      reason,
      playerId,
      name,
    });

    const config = this.config;
    if (!config) return reject(503, JoinError.ShuttingDown);

    if (options.protocolVersion !== PROTOCOL_VERSION) {
      return reject(
        400,
        `${JoinError.ProtocolMismatch}: server speaks v${PROTOCOL_VERSION}, client sent v${String(
          options.protocolVersion,
        )}`,
      );
    }
    if (config.network.password && options.password !== config.network.password) {
      return reject(401, JoinError.BadPassword);
    }
    if (config.network.token && options.token !== config.network.token) {
      return reject(401, JoinError.BadToken);
    }

    this.reap();

    if (this.claimed.has(playerId)) return reject(409, JoinError.NameTaken);
    if (this.claimed.size >= config.mode.maxPlayers) return reject(403, JoinError.ServerFull);

    this.claimed.add(playerId);
    this.pending.set(playerId, this.now());
    return { ok: true, status: 200, reason: '', playerId, name };
  }

  /** Promote a claim to a live connection, so it is no longer reapable. */
  confirm(playerId: string): void {
    this.pending.delete(playerId);
    this.claimed.add(playerId);
  }

  /** Release a claim: the client left, or its join failed. */
  release(playerId: string): void {
    this.pending.delete(playerId);
    this.claimed.delete(playerId);
  }

  /**
   * Drop claims from reservations that were never consumed.
   *
   * Without this, a client that crashes between matchmaking and connecting locks its own
   * character out until the server restarts.
   */
  reap(): void {
    if (this.pending.size === 0) return;
    const now = this.now();
    for (const [playerId, claimedAt] of this.pending) {
      if (now - claimedAt < CLAIM_TTL_MS) continue;
      this.pending.delete(playerId);
      this.claimed.delete(playerId);
    }
  }
}

/**
 * The process-wide gate.
 *
 * `static onAuth` has nowhere else to look. The room populates it on create and clears it
 * on dispose.
 */
export const joinGate = new JoinGate();
