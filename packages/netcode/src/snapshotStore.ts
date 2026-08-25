import { chunkKeyAtTile, chunkTileIndex } from '@survive/protocol';
import type {
  ChunkKey,
  ChunkPayload,
  EntityId,
  EntitySnapshot,
  EntitySnapshotKind,
  OpenContainerView,
  PlayerState,
  WeatherState,
  WorldSnapshot,
  WorldTimeState,
} from '@survive/protocol';

/**
 * The client's mirror of the authoritative world.
 *
 * The server sends area-of-interest deltas: own player state in full, nearby entities
 * as slim projections, and only the ones whose `rev` changed. This store folds that
 * stream into something a renderer can walk — a map of live entities, the world clock,
 * the weather, the open container, and a cache of chunk terrain — and reports what
 * changed so sprites can be created and destroyed without diffing anything.
 *
 * It holds no game rules and makes no decisions: everything here is the server's
 * word, kept verbatim. Snapshots are stored by reference rather than cloned (they
 * come off the wire freshly decoded and are never reused), so callers must treat
 * everything the store hands back as read-only.
 */
export interface SnapshotStoreListener {
  /** An entity entered the area of interest, or came into existence. */
  onEntityAdded?(entity: EntitySnapshot): void;
  /** An entity the client already knew about changed. */
  onEntityUpdated?(entity: EntitySnapshot, previous: EntitySnapshot): void;
  /** An entity left the area of interest or was destroyed. */
  onEntityRemoved?(id: EntityId, previous: EntitySnapshot): void;
  onSelfChanged?(self: PlayerState): void;
  onWorldChanged?(time: WorldTimeState, weather: WeatherState): void;
  /**
   * Fired for every snapshot that carries an open container view, and once with
   * `null` when it closes.
   *
   * It is not deduplicated: the server sends the view whenever the container is open
   * and its slots change as items move, so "unchanged" cannot be established without
   * a deep compare the renderer would pay for ten times a second. Listeners should
   * treat it as "here is the current view", not "something is different".
   */
  onContainerChanged?(container: OpenContainerView | null): void;
  onChunkLoaded?(chunk: ChunkPayload): void;
  onChunkDropped?(key: ChunkKey): void;
  /** Fired once per accepted snapshot, after every other callback for it. */
  onSnapshotApplied?(snapshot: WorldSnapshot): void;
}

export class SnapshotStore {
  private readonly entityMap = new Map<EntityId, EntitySnapshot>();
  /** Secondary index, so the renderer can walk one kind without scanning them all. */
  private readonly byKind = new Map<EntitySnapshotKind, Set<EntityId>>();
  private readonly chunkCache = new Map<ChunkKey, ChunkPayload>();
  private readonly listeners = new Set<SnapshotStoreListener>();

  private lastTick = -1;
  private lastServerTimeMs = 0;
  private lastAckSeq = 0;
  private selfState: PlayerState | null = null;
  private timeState: WorldTimeState | null = null;
  private weatherState: WeatherState | null = null;
  private containerView: OpenContainerView | null = null;
  private pausedFlag = false;
  private staleSnapshots = 0;
  private appliedSnapshots = 0;

  /** Register change callbacks. Returns the unsubscribe function. */
  subscribe(listener: SnapshotStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Tick of the newest applied snapshot, or -1 before the first one. */
  get tick(): number {
    return this.lastTick;
  }

  get serverTimeMs(): number {
    return this.lastServerTimeMs;
  }

  /** Highest input sequence the server has confirmed consuming. */
  get ackSeq(): number {
    return this.lastAckSeq;
  }

  get self(): PlayerState | null {
    return this.selfState;
  }

  get time(): WorldTimeState | null {
    return this.timeState;
  }

  get weather(): WeatherState | null {
    return this.weatherState;
  }

  get container(): OpenContainerView | null {
    return this.containerView;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get entityCount(): number {
    return this.entityMap.size;
  }

  /** Snapshots rejected as stale or duplicate. Diagnostic. */
  get staleSnapshotCount(): number {
    return this.staleSnapshots;
  }

  get appliedSnapshotCount(): number {
    return this.appliedSnapshots;
  }

  get chunkCount(): number {
    return this.chunkCache.size;
  }

  entity(id: EntityId): EntitySnapshot | undefined {
    return this.entityMap.get(id);
  }

  entities(): IterableIterator<EntitySnapshot> {
    return this.entityMap.values();
  }

  entityIds(): IterableIterator<EntityId> {
    return this.entityMap.keys();
  }

  /** Every tracked entity of one kind. Empty array when there are none. */
  entitiesOfKind(kind: EntitySnapshotKind): EntitySnapshot[] {
    const ids = this.byKind.get(kind);
    if (!ids) return [];
    const out: EntitySnapshot[] = [];
    for (const id of ids) {
      const entity = this.entityMap.get(id);
      if (entity) out.push(entity);
    }
    return out;
  }

  /**
   * Apply one authoritative update.
   *
   * @returns false when the snapshot was ignored as stale or duplicate.
   */
  applySnapshot(snapshot: WorldSnapshot): boolean {
    // UDP-style reordering does not happen over a WebSocket, but re-sends after a
    // reconnect and a second server process talking to the same client both do. An
    // older snapshot would resurrect removed entities and rewind the world clock, so
    // anything not strictly newer is dropped.
    if (snapshot.tick <= this.lastTick) {
      this.staleSnapshots++;
      return false;
    }

    this.lastTick = snapshot.tick;
    this.lastServerTimeMs = snapshot.serverTimeMs;
    if (snapshot.ackSeq > this.lastAckSeq) this.lastAckSeq = snapshot.ackSeq;
    this.pausedFlag = snapshot.paused;

    this.selfState = snapshot.self;
    this.emit((listener) => listener.onSelfChanged?.(snapshot.self));

    for (const entity of snapshot.entities) this.upsert(entity);
    // Removals are applied after upserts: within one snapshot the server never does
    // both for the same id, and this order keeps a re-add-after-remove sane.
    for (const id of snapshot.removed) this.remove(id);

    this.timeState = snapshot.time;
    this.weatherState = snapshot.weather;
    this.emit((listener) => listener.onWorldChanged?.(snapshot.time, snapshot.weather));

    const container = snapshot.container ?? null;
    const containerChanged = container !== null || this.containerView !== null;
    this.containerView = container;
    if (containerChanged) this.emit((listener) => listener.onContainerChanged?.(container));

    this.appliedSnapshots++;
    this.emit((listener) => listener.onSnapshotApplied?.(snapshot));
    return true;
  }

  /** Cache terrain for one chunk. Fed by the `chunk` server message. */
  applyChunk(chunk: ChunkPayload): void {
    this.chunkCache.set(chunk.key, chunk);
    this.emit((listener) => listener.onChunkLoaded?.(chunk));
  }

  /** Forget chunks the server says are out of range. Fed by `chunkdrop`. */
  dropChunks(keys: readonly ChunkKey[]): void {
    for (const key of keys) {
      if (!this.chunkCache.delete(key)) continue;
      this.emit((listener) => listener.onChunkDropped?.(key));
    }
  }

  hasChunk(key: ChunkKey): boolean {
    return this.chunkCache.has(key);
  }

  chunk(key: ChunkKey): ChunkPayload | undefined {
    return this.chunkCache.get(key);
  }

  chunkKeys(): IterableIterator<ChunkKey> {
    return this.chunkCache.keys();
  }

  /** Cached tile id at a world tile, or undefined when the chunk is not loaded. */
  tileAt(tileX: number, tileY: number): number | undefined {
    const chunk = this.chunkCache.get(chunkKeyAtTile(tileX, tileY));
    if (!chunk) return undefined;
    return chunk.tiles[chunkTileIndex(tileX, tileY)];
  }

  /** Cached biome id at a world tile, or undefined when the chunk is not loaded. */
  biomeAt(tileX: number, tileY: number): number | undefined {
    const chunk = this.chunkCache.get(chunkKeyAtTile(tileX, tileY));
    if (!chunk) return undefined;
    return chunk.biomes[chunkTileIndex(tileX, tileY)];
  }

  /**
   * Drop everything and report every entity as removed, so the renderer tears its
   * sprites down. Used when a reconnect may have landed on a different world.
   */
  reset(): void {
    for (const [id, entity] of this.entityMap) {
      this.emit((listener) => listener.onEntityRemoved?.(id, entity));
    }
    this.entityMap.clear();
    this.byKind.clear();
    for (const key of [...this.chunkCache.keys()]) {
      this.chunkCache.delete(key);
      this.emit((listener) => listener.onChunkDropped?.(key));
    }
    this.lastTick = -1;
    this.lastServerTimeMs = 0;
    this.lastAckSeq = 0;
    this.selfState = null;
    this.timeState = null;
    this.weatherState = null;
    this.pausedFlag = false;
    if (this.containerView !== null) {
      this.containerView = null;
      this.emit((listener) => listener.onContainerChanged?.(null));
    }
    this.staleSnapshots = 0;
    this.appliedSnapshots = 0;
  }

  private upsert(entity: EntitySnapshot): void {
    const previous = this.entityMap.get(entity.id);
    this.entityMap.set(entity.id, entity);
    if (!previous) {
      this.indexOf(entity.k).add(entity.id);
      this.emit((listener) => listener.onEntityAdded?.(entity));
      return;
    }
    if (previous.k !== entity.k) {
      // Id reuse across kinds should never happen, but if it does the stale index
      // entry would leak the sprite forever.
      this.byKind.get(previous.k)?.delete(entity.id);
      this.indexOf(entity.k).add(entity.id);
    }
    this.emit((listener) => listener.onEntityUpdated?.(entity, previous));
  }

  private remove(id: EntityId): void {
    const previous = this.entityMap.get(id);
    if (!previous) return;
    this.entityMap.delete(id);
    this.byKind.get(previous.k)?.delete(id);
    this.emit((listener) => listener.onEntityRemoved?.(id, previous));
  }

  private indexOf(kind: EntitySnapshotKind): Set<EntityId> {
    let ids = this.byKind.get(kind);
    if (!ids) {
      ids = new Set<EntityId>();
      this.byKind.set(kind, ids);
    }
    return ids;
  }

  private emit(notify: (listener: SnapshotStoreListener) => void): void {
    for (const listener of this.listeners) notify(listener);
  }
}
