import { TILE_SIZE } from '@survive/protocol';
import type { EntityId } from '@survive/protocol';

/** What kind of thing a spatial index entry refers to. */
export type SpatialKind =
  'player' | 'zombie' | 'animal' | 'item' | 'node' | 'projectile' | 'structure';

export interface SpatialEntry {
  id: EntityId;
  kind: SpatialKind;
  x: number;
  y: number;
  radius: number;
}

/**
 * Uniform-grid spatial hash over the dynamic entities.
 *
 * Rebuilt once per tick from the entity tables, which for a few thousand entities is
 * far cheaper than the alternative of every system scanning every table. Queries are
 * "candidates within a radius"; callers still do the exact distance test.
 */
export class SpatialIndex {
  private readonly cellSize: number;
  private cells = new Map<number, SpatialEntry[]>();
  private count = 0;
  /**
   * Entry objects, reused across rebuilds.
   *
   * The index is rebuilt from scratch every tick, and a populated world holds a few
   * thousand entities - mostly resource nodes, which never move. Allocating one entry
   * object per entity per tick is ~60k short-lived objects a second at 20Hz, and the GC
   * pressure showed up as multi-millisecond ticks on dense seeds. Pooling keeps the
   * rebuild allocation-free after the first tick; `clear` empties the buckets but hands
   * the objects back rather than dropping them.
   */
  private pool: SpatialEntry[] = [];
  private pooled = 0;

  constructor(cellSize = TILE_SIZE * 4) {
    this.cellSize = cellSize;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    // Empty the buckets in place: `Map.clear()` would drop the arrays too, and they get
    // reallocated immediately on the next rebuild.
    for (const bucket of this.cells.values()) bucket.length = 0;
    this.count = 0;
    this.pooled = 0;
  }

  /**
   * Add an entity to the index, taking an entry object from the pool.
   *
   * Prefer this over {@link insert} in the per-tick rebuild: it copies the fields into a
   * reused object instead of retaining the caller's.
   */
  add(id: EntityId, kind: SpatialKind, x: number, y: number, radius: number): void {
    let entry = this.pool[this.pooled];
    if (!entry) {
      entry = { id, kind, x, y, radius };
      this.pool[this.pooled] = entry;
    } else {
      entry.id = id;
      entry.kind = kind;
      entry.x = x;
      entry.y = y;
      entry.radius = radius;
    }
    this.pooled++;
    this.bucketFor(x, y).push(entry);
    this.count++;
  }

  insert(entry: SpatialEntry): void {
    this.bucketFor(entry.x, entry.y).push(entry);
    this.count++;
  }

  private bucketFor(x: number, y: number): SpatialEntry[] {
    const key = this.cellKey(x, y);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Every entry whose cell overlaps the query circle. Includes false positives near
   * cell borders by design; callers filter with an exact test.
   */
  query(x: number, y: number, radius: number, out: SpatialEntry[] = []): SpatialEntry[] {
    out.length = 0;
    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellY = Math.floor((y - radius) / this.cellSize);
    const maxCellY = Math.floor((y + radius) / this.cellSize);
    for (let cy = minCellY; cy <= maxCellY; cy++) {
      for (let cx = minCellX; cx <= maxCellX; cx++) {
        const bucket = this.cells.get(this.packKey(cx, cy));
        if (!bucket) continue;
        for (const entry of bucket) out.push(entry);
      }
    }
    return out;
  }

  /** Entries of the given kinds within an exact distance of the point. */
  queryKinds(
    x: number,
    y: number,
    radius: number,
    kinds: readonly SpatialKind[],
    out: SpatialEntry[] = [],
  ): SpatialEntry[] {
    const candidates = this.query(x, y, radius);
    out.length = 0;
    for (const entry of candidates) {
      if (!kinds.includes(entry.kind)) continue;
      const reach = radius + entry.radius;
      const dx = entry.x - x;
      const dy = entry.y - y;
      if (dx * dx + dy * dy <= reach * reach) out.push(entry);
    }
    return out;
  }

  /** Closest entry of the given kinds, or null. */
  nearest(
    x: number,
    y: number,
    radius: number,
    kinds: readonly SpatialKind[],
    filter?: (entry: SpatialEntry) => boolean,
  ): SpatialEntry | null {
    const candidates = this.query(x, y, radius);
    let best: SpatialEntry | null = null;
    let bestDistSq = radius * radius;
    for (const entry of candidates) {
      if (!kinds.includes(entry.kind)) continue;
      if (filter && !filter(entry)) continue;
      const dx = entry.x - x;
      const dy = entry.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestDistSq) {
        bestDistSq = distSq;
        best = entry;
      }
    }
    return best;
  }

  private cellKey(x: number, y: number): number {
    return this.packKey(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
  }

  /** Pack signed cell coordinates into one number usable as a Map key. */
  private packKey(cx: number, cy: number): number {
    // 16-bit signed range per axis is far more than the world needs at this cell size.
    return ((cx & 0xffff) << 16) | (cy & 0xffff);
  }
}
