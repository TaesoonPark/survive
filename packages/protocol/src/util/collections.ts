/** Small helpers used across packages. Kept dependency-free on purpose. */

/** Remove the first occurrence of `value`. Returns true when something was removed. */
export function removeFrom<T>(items: T[], value: T): boolean {
  const index = items.indexOf(value);
  if (index < 0) return false;
  items.splice(index, 1);
  return true;
}

/** Remove by predicate, in place. Returns the number removed. */
export function removeWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  let removed = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i] as T)) {
      items.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/** Structured deep clone that keeps plain JSON data intact. */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** Stable JSON stringify: object keys sorted, so hashes are reproducible. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

/** Ensure a keyed bucket exists and return it. */
export function bucket<K, V>(map: Map<K, V[]>, key: K): V[] {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  return list;
}

/** Insert into a sorted array, keeping it sorted by `score` ascending. */
export function insertSorted<T>(items: T[], item: T, score: (value: T) => number): void {
  const target = score(item);
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (score(items[mid] as T) < target) low = mid + 1;
    else high = mid;
  }
  items.splice(low, 0, item);
}
