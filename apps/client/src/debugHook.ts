import type { Command, EntitySnapshotKind } from '@survive/protocol';
import type { GameSession } from './net/session';

/**
 * A narrow window hook for automated tests and for the console.
 *
 * The Playwright gameplay suite drives the real client, and asserting on a canvas by
 * pixel-diffing is both brittle and uninformative. This exposes the *authoritative* state
 * the client already holds so a test can say "the player moved east" instead of "these
 * pixels changed".
 *
 * It is safe to ship. Everything readable here is state the server already sent this
 * client, and `send` only queues an intent — the server validates every command exactly
 * as it does for the real UI (Architecture Guard rule 4). There is no cheat here that a
 * modified client could not perform anyway, which is precisely why the server is
 * authoritative in the first place.
 */

export interface SurviveDebugHook {
  readonly connected: boolean;
  /** Authoritative player state, or null before the first snapshot. */
  self(): {
    id: string;
    x: number;
    y: number;
    health: number;
    hunger: number;
    thirst: number;
    fatigue: number;
    stamina: number;
    alive: boolean;
    tileX: number;
    tileY: number;
    inventoryCount: number;
    heldDefId: string | null;
  } | null;
  /** The locally predicted position: the latest fixed-step rung. */
  predicted(): { x: number; y: number };
  /** The interpolated position actually drawn this frame. */
  render(): { x: number; y: number };
  /**
   * Where the player sits on screen, and how long the last frame took.
   *
   * This is the number the eye actually judges. Both the sprite and the camera are eased,
   * so a wobble can exist in the difference between them while each is independently
   * smooth in world space - `render()` alone cannot see it.
   */
  screen(): { x: number; y: number; deltaMs: number };
  world(): {
    tick: number;
    day: number;
    hour: number;
    minute: number;
    weather: string;
    lightLevel: number;
  } | null;
  net(): { latencyMs: number; predictionError: number; entityCount: number; chunkCount: number };
  /**
   * What the last reconciliation did, or null before the first snapshot.
   *
   * `predictionError` alone is a poor diagnostic: it is measured at the acknowledged
   * frame, so a client running away from the server - a growing backlog, a rate mismatch -
   * shows up as zero error while the player visibly judders. These are the numbers that
   * distinguish the cases.
   */
  reconcile(): {
    error: number;
    ackSeq: number;
    newestSeq: number;
    pending: number;
    replayed: number;
    corrected: boolean;
    hardSnapped: boolean;
  } | null;
  /** Entity ids by kind, for "is there a zombie near me" assertions. */
  entities(): Record<string, string[]>;
  /**
   * Nearest replicated entity of a kind to the player, in pixels, or null when none is
   * in range.
   *
   * Exists so a test can walk *towards* something instead of walking in hopeful
   * directions and asserting it got lucky. Reads the same snapshot the renderer draws
   * from, so it reveals nothing the client was not already told.
   */
  nearest(kind: EntitySnapshotKind): { id: string; x: number; y: number; distance: number } | null;
  /** Send an intent. Validated server-side like any other. */
  send(command: Command): void;
  /** Panel ids currently open. */
  openPanels(): string[];
  /** Frame loop health: how many frames the world scene has stepped, and its delta. */
  frames(): { count: number; lastDeltaMs: number };
}

declare global {
  interface Window {
    __survive?: SurviveDebugHook;
  }
}

export function installDebugHook(
  session: GameSession,
  openPanels: () => string[],
  frames: () => { count: number; lastDeltaMs: number },
  cameraScroll: () => { x: number; y: number },
): void {
  const hook: SurviveDebugHook = {
    get connected() {
      return session.isConnected;
    },
    self() {
      const self = session.self;
      if (!self) return null;
      return {
        id: self.id,
        x: self.x,
        y: self.y,
        health: self.health,
        hunger: self.hunger,
        thirst: self.thirst,
        fatigue: self.fatigue,
        stamina: self.stamina,
        alive: self.alive,
        tileX: Math.floor(self.x / 32),
        tileY: Math.floor(self.y / 32),
        inventoryCount: self.inventory.slots.filter((slot) => slot !== null).length,
        heldDefId: self.equipment.mainHand?.defId ?? null,
      };
    },
    predicted() {
      const predicted = session.predicted;
      return { x: predicted.x, y: predicted.y };
    },
    render() {
      return session.renderPosition;
    },
    screen() {
      const p = session.renderPosition;
      const scroll = cameraScroll();
      return { x: p.x - scroll.x, y: p.y - scroll.y, deltaMs: frames().lastDeltaMs };
    },
    world() {
      const time = session.time;
      if (!time) return null;
      return {
        tick: time.tick,
        day: time.day,
        hour: time.hour,
        minute: time.minute,
        weather: session.weather?.type ?? 'unknown',
        lightLevel: time.lightLevel,
      };
    },
    net() {
      return {
        latencyMs: session.latencyMs,
        predictionError: session.predictionError,
        entityCount: session.store.entityCount,
        chunkCount: session.store.chunkCount,
      };
    },
    entities() {
      const grouped: Record<string, string[]> = {};
      for (const entity of session.store.entities()) {
        const bucket = grouped[entity.k] ?? [];
        bucket.push(entity.id);
        grouped[entity.k] = bucket;
      }
      return grouped;
    },
    nearest(kind: EntitySnapshotKind) {
      const from = session.predicted;
      let best: { id: string; x: number; y: number; distance: number } | null = null;
      for (const entity of session.store.entitiesOfKind(kind)) {
        // Nodes and structures are placed by tile; everything else carries pixels.
        const x = 'x' in entity ? entity.x : entity.tileX * 32 + 16;
        const y = 'y' in entity ? entity.y : entity.tileY * 32 + 16;
        const distance = Math.hypot(x - from.x, y - from.y);
        if (!best || distance < best.distance) best = { id: entity.id, x, y, distance };
      }
      return best;
    },
    send(command: Command) {
      session.send(command);
    },
    reconcile() {
      return session.lastReconcileInfo;
    },
    openPanels,
    frames,
  };
  window.__survive = hook;
}

export function removeDebugHook(): void {
  delete window.__survive;
}
