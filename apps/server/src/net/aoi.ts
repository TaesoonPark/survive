import {
  AOI_RADIUS,
  CHUNK_LOAD_RADIUS,
  CHUNK_SIZE,
  chunkKey,
  chunkKeysAround,
  distanceSq,
  eventPosition,
  eventTargetPlayer,
  parseChunkKey,
  type ChunkKey,
  type EntitySnapshot,
  type OpenContainerView,
  type PlayerId,
  type PlayerState,
  type StructureState,
  type SimEvent,
  type WorldSnapshot,
} from '@survive/protocol';
import type { Simulation } from '@survive/simulation';

/**
 * Area-of-interest replication.
 *
 * Nobody gets the whole world. Each client is told about the entities inside a radius
 * around its own player, and only the ones that actually changed since the last
 * snapshot it received (spec section 21). This is the difference between a server that
 * holds sixteen players and one that falls over at four.
 *
 * The tracker holds one small record per connected client: which entity revisions that
 * client has seen, and which chunks it has terrain for. Everything else is derived
 * from the live simulation each time a snapshot is built.
 */

interface ClientView {
  /** Entity id -> the revision this client last received. */
  knownRevs: Map<string, number>;
  /** Chunk keys whose terrain this client already has. */
  knownChunks: Set<ChunkKey>;
  /** Tick of the last snapshot sent, for diagnostics. */
  lastSnapshotTick: number;
}

export interface AoiOptions {
  /** Replication radius in world pixels. */
  radius?: number;
  /** Chunk terrain radius, in chunks. Should cover the entity radius. */
  chunkRadius?: number;
}

export interface ChunkDelta {
  /** Chunks whose terrain the client needs. */
  send: ChunkKey[];
  /** Chunks the client can forget. */
  drop: ChunkKey[];
}

/**
 * Strip the parts of a structure a nearby client is not entitled to.
 *
 * Structures otherwise ship whole - they change rarely, and the client needs the door
 * state and the crop to draw them. But "whole" included two secrets:
 *
 * - `door.code`. Any player who supplies a code equal to it gets in (`canUnlock`), so
 *   shipping it to everyone in range made every lock decorative: walk up, read the code
 *   out of your own snapshot, send `toggleDoor` with it.
 * - `container.slots`. Contents have their own deliberately gated channel - the
 *   container view, which only fires while the player has that container open - and
 *   shipping the slots in the entity stream went straight around it. Every chest inside
 *   the area of interest was readable without ever opening it.
 *
 * `locked` stays: that a door is locked is visible from the outside anyway, and the HUD
 * needs it to label the prompt. `viewers` goes too - it is bookkeeping for the server's
 * own push list and names other players.
 */
function projectStructure(structure: StructureState): StructureState {
  if (structure.door?.code === undefined && !structure.container) return structure;
  const projected: StructureState = { ...structure };
  if (projected.door) {
    const { code: _code, ...door } = projected.door;
    projected.door = door;
  }
  if (projected.container) {
    // Capacity survives so a client can size the window before the contents arrive.
    projected.container = { ...projected.container, slots: [], viewers: [] };
  }
  return projected;
}

export class AoiTracker {
  private readonly views = new Map<PlayerId, ClientView>();
  private readonly radius: number;
  private readonly chunkRadius: number;

  constructor(options: AoiOptions = {}) {
    this.radius = options.radius ?? AOI_RADIUS;
    this.chunkRadius = options.chunkRadius ?? CHUNK_LOAD_RADIUS;
  }

  /** Number of clients being tracked. */
  get size(): number {
    return this.views.size;
  }

  /** Forget everything about a client. Called on disconnect. */
  forget(playerId: PlayerId): void {
    this.views.delete(playerId);
  }

  /**
   * Forget what a client has seen without dropping it.
   *
   * Used after a respawn or a teleport, where sending deltas relative to the old
   * position would leave stale entities on screen.
   */
  reset(playerId: PlayerId): void {
    const view = this.views.get(playerId);
    if (!view) return;
    view.knownRevs.clear();
    view.knownChunks.clear();
  }

  private view(playerId: PlayerId): ClientView {
    let view = this.views.get(playerId);
    if (!view) {
      view = { knownRevs: new Map(), knownChunks: new Set(), lastSnapshotTick: -1 };
      this.views.set(playerId, view);
    }
    return view;
  }

  /**
   * Build the authoritative snapshot for one client.
   *
   * Returns null only when the player is not in the world. A connected player always
   * gets a snapshot, even an otherwise-empty one, because the client uses `ackSeq` in
   * every snapshot to reconcile its prediction.
   */
  build(sim: Simulation, playerId: PlayerId, serverTimeMs: number): WorldSnapshot | null {
    const self = sim.state.players[playerId];
    if (!self) return null;
    const view = this.view(playerId);
    const state = sim.state;

    const entities: EntitySnapshot[] = [];
    const present = new Set<string>();

    const candidates = sim.spatial.query(self.x, self.y, this.radius);
    const radiusSq = this.radius * this.radius;

    for (const candidate of candidates) {
      if (candidate.id === playerId) continue;
      // The spatial query is cell-granular; do the exact test here.
      if (distanceSq(self.x, self.y, candidate.x, candidate.y) > radiusSq) continue;

      const snapshot = this.snapshotFor(sim, candidate.id, candidate.kind);
      if (!snapshot) continue;
      present.add(candidate.id);
      if (view.knownRevs.get(candidate.id) === snapshot.rev) continue;
      view.knownRevs.set(candidate.id, snapshot.rev);
      entities.push(snapshot);
    }

    // Anything the client knows about that is no longer in range - or no longer exists
    // at all - has to be explicitly removed, or it lingers on their screen forever.
    const removed: string[] = [];
    for (const id of view.knownRevs.keys()) {
      if (present.has(id)) continue;
      removed.push(id);
    }
    for (const id of removed) view.knownRevs.delete(id);

    view.lastSnapshotTick = state.tick;

    return {
      tick: state.tick,
      serverTimeMs,
      ackSeq: self.lastInputSeq,
      self,
      entities,
      removed,
      time: state.time,
      weather: state.weather,
      ...(this.containerView(sim, self) ? { container: this.containerView(sim, self)! } : {}),
      paused: state.paused,
    };
  }

  /** The container the player has open, if any, so the UI can render its contents. */
  private containerView(sim: Simulation, player: PlayerState): OpenContainerView | null {
    if (!player.openContainerId) return null;
    const structure = sim.state.structures[player.openContainerId];
    if (!structure?.container) return null;
    return {
      structureId: structure.id,
      defId: structure.defId,
      slots: structure.container.slots,
      capacity: structure.container.capacity,
    };
  }

  /**
   * Project one entity into its wire form.
   *
   * Remote players are deliberately reduced: another player's inventory, skills and
   * exact injuries are not the client's business, and shipping them would be both a
   * bandwidth cost and an information leak.
   */
  private snapshotFor(
    sim: Simulation,
    id: string,
    kind: string,
  ): (EntitySnapshot & { rev: number }) | null {
    const state = sim.state;
    switch (kind) {
      case 'player': {
        const other = state.players[id];
        if (!other) return null;
        const held = other.equipment.mainHand?.defId;
        const head = other.equipment.head?.defId;
        const chest = other.equipment.chest?.defId;
        const legs = other.equipment.legs?.defId;
        return {
          k: 'player',
          id: other.id,
          name: other.name,
          x: other.x,
          y: other.y,
          facing: other.facing,
          aimAngle: other.aimAngle,
          health: other.health,
          maxHealth: other.maxHealth,
          moveMode: other.moveMode,
          alive: other.alive,
          ...(held ? { heldDefId: held } : {}),
          ...(head ? { headDefId: head } : {}),
          ...(chest ? { chestDefId: chest } : {}),
          ...(legs ? { legsDefId: legs } : {}),
          attacking: other.attackReadyTick > state.tick,
          rev: other.rev,
        };
      }
      case 'zombie': {
        const zombie = state.zombies[id];
        if (!zombie) return null;
        return {
          k: 'zombie',
          id: zombie.id,
          defId: zombie.defId,
          x: zombie.x,
          y: zombie.y,
          facing: zombie.facing,
          health: zombie.health,
          maxHealth: zombie.maxHealth,
          ai: zombie.ai,
          crawling: zombie.crawling,
          attacking: zombie.attackReadyTick > state.tick,
          rev: zombie.rev,
        };
      }
      case 'animal': {
        const animal = state.animals[id];
        if (!animal) return null;
        return {
          k: 'animal',
          id: animal.id,
          defId: animal.defId,
          x: animal.x,
          y: animal.y,
          facing: animal.facing,
          health: animal.health,
          maxHealth: animal.maxHealth,
          ai: animal.ai,
          rev: animal.rev,
        };
      }
      case 'item': {
        const item = state.items[id];
        if (!item) return null;
        return { k: 'item', id: item.id, x: item.x, y: item.y, stack: item.stack, rev: item.rev };
      }
      case 'projectile': {
        const projectile = state.projectiles[id];
        if (!projectile) return null;
        return {
          k: 'projectile',
          id: projectile.id,
          defId: projectile.defId,
          x: projectile.x,
          y: projectile.y,
          vx: projectile.vx,
          vy: projectile.vy,
          rev: projectile.rev,
        };
      }
      case 'structure': {
        const structure = state.structures[id];
        if (!structure) return null;
        return { k: 'structure', ...projectStructure(structure) };
      }
      case 'node': {
        const node = state.nodes[id];
        if (!node) return null;
        return { k: 'node', ...node };
      }
      default:
        return null;
    }
  }

  /**
   * Which chunk terrain payloads this client needs, and which it can drop.
   *
   * Terrain is static and cacheable, so it is sent once per chunk per session rather
   * than in every snapshot.
   */
  chunkDelta(sim: Simulation, playerId: PlayerId): ChunkDelta {
    const player = sim.state.players[playerId];
    if (!player) return { send: [], drop: [] };
    const view = this.view(playerId);

    const wanted = new Set(chunkKeysAround(player.x, player.y, this.chunkRadius));
    const playerChunkX = Math.floor(player.x / CHUNK_SIZE);
    const playerChunkY = Math.floor(player.y / CHUNK_SIZE);
    const candidates: Array<{ key: ChunkKey; distance: number }> = [];
    for (const key of wanted) {
      if (view.knownChunks.has(key)) continue;
      const { cx, cy } = parseChunkKey(key);
      // Only offer chunks the simulation has actually loaded; the rest arrive later.
      if (!sim.state.chunks[chunkKey(cx, cy)]) continue;
      candidates.push({
        key,
        distance: Math.max(Math.abs(cx - playerChunkX), Math.abs(cy - playerChunkY)),
      });
    }
    // Nearest first. The send is rate-limited, so an unordered list would hand the client
    // a corner of the ring before the ground under its own feet.
    candidates.sort((a, b) => a.distance - b.distance || (a.key < b.key ? -1 : 1));
    const send: ChunkKey[] = candidates.map((entry) => entry.key);

    const drop: ChunkKey[] = [];
    for (const key of view.knownChunks) {
      if (!wanted.has(key)) drop.push(key);
    }
    return { send, drop };
  }

  /** Record that a chunk payload was successfully sent. */
  markChunkSent(playerId: PlayerId, key: ChunkKey): void {
    this.view(playerId).knownChunks.add(key);
  }

  /** Record that a chunk was dropped from the client's cache. */
  markChunkDropped(playerId: PlayerId, key: ChunkKey): void {
    this.view(playerId).knownChunks.delete(key);
  }

  /** Whether the client already holds terrain for a chunk. */
  hasChunk(playerId: PlayerId, key: ChunkKey): boolean {
    return this.view(playerId).knownChunks.has(key);
  }

  /**
   * Filter a tick's events down to what one client should hear about.
   *
   * Positioned events are gated on distance; private feedback (craft results, rejected
   * commands, XP) goes only to the player it concerns; everything else is global.
   */
  filterEvents(events: readonly SimEvent[], player: PlayerState, audioSlack = 1.6): SimEvent[] {
    if (events.length === 0) return [];
    const out: SimEvent[] = [];
    // Sounds carry further than sight, so the audible radius is deliberately larger
    // than the replication radius.
    const limit = this.radius * audioSlack;
    const limitSq = limit * limit;

    for (const event of events) {
      const target = eventTargetPlayer(event);
      if (target) {
        if (target === player.id) out.push(event);
        continue;
      }
      const position = eventPosition(event);
      if (!position) {
        out.push(event);
        continue;
      }
      if (distanceSq(player.x, player.y, position.x, position.y) <= limitSq) out.push(event);
    }
    return out;
  }

  /** Diagnostics for the launcher's stats panel. */
  stats(playerId: PlayerId): { knownEntities: number; knownChunks: number; lastTick: number } {
    const view = this.views.get(playerId);
    return {
      knownEntities: view?.knownRevs.size ?? 0,
      knownChunks: view?.knownChunks.size ?? 0,
      lastTick: view?.lastSnapshotTick ?? -1,
    };
  }
}
