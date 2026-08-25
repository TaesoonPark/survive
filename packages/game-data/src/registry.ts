import type { Registry } from './types';

/**
 * Immutable id -> definition lookup.
 *
 * Content tables are authored as plain arrays because arrays are the readable form
 * for humans (and diff cleanly in review), but every consumer wants a map. This
 * builds the map once at startup and hands back a frozen view.
 *
 * Two deliberate choices:
 *
 * - **Duplicate ids throw at construction.** A silently shadowed definition is the
 *   worst kind of content bug: the game keeps running, but half the references point
 *   at the wrong thing and the `version` hash still looks plausible.
 * - **`require()` reports the label and a few near-miss candidates.** Most unknown-id
 *   failures are typos, and the stack trace alone never says which table was missed.
 */
export function createRegistry<T extends { id: string }>(
  items: readonly T[],
  label: string,
): Registry<T> {
  const byId = new Map<string, T>();
  const duplicates: string[] = [];

  for (const entry of items) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error(`${label}: definition with a missing or empty id`);
    }
    if (byId.has(entry.id)) duplicates.push(entry.id);
    byId.set(entry.id, entry);
  }

  if (duplicates.length > 0) {
    throw new Error(
      `${label}: duplicate definition id(s): ${[...new Set(duplicates)].sort().join(', ')}`,
    );
  }

  const ordered = Object.freeze([...items]) as readonly T[];
  const ids = Object.freeze([...byId.keys()]) as readonly string[];

  return {
    get(id: string): T | undefined {
      return byId.get(id);
    },
    require(id: string): T {
      const found = byId.get(id);
      if (found) return found;
      throw new Error(`${label}: unknown id "${id}".${suggestion(id, ids)}`);
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    all(): readonly T[] {
      return ordered;
    },
    ids(): readonly string[] {
      return ids;
    },
    get size(): number {
      return byId.size;
    },
  };
}

/**
 * Cheap "did you mean" hint. Substring and shared-prefix matching only: a real edit
 * distance is not worth the code for an error path, and typos in content tables are
 * nearly always a prefix or a plural away from the truth.
 */
function suggestion(id: string, ids: readonly string[]): string {
  const needle = id.toLowerCase();
  const scored: { id: string; score: number }[] = [];

  for (const candidate of ids) {
    const other = candidate.toLowerCase();
    let score = 0;
    if (other.includes(needle) || needle.includes(other)) score += 100;
    score += sharedPrefix(needle, other) * 4;
    score += sharedTokens(needle, other) * 12;
    if (score > 0) scored.push({ id: candidate, score });
  }

  if (scored.length === 0) return ` No similar ids in this table (${ids.length} entries).`;
  // Code-unit comparison, not `localeCompare`: this package must produce byte-identical
  // output on every host, and `localeCompare` depends on the ICU build Node was
  // compiled against. Ids are ASCII snake_case, so the two agree anyway.
  scored.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));
  const best = scored.slice(0, 4).map((entry) => entry.id);
  return ` Did you mean: ${best.join(', ')}?`;
}

/** Total order on definition ids that does not depend on the host's locale data. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sharedPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function sharedTokens(a: string, b: string): number {
  const left = new Set(a.split('_'));
  let shared = 0;
  for (const token of b.split('_')) {
    if (token.length > 1 && left.has(token)) shared++;
  }
  return shared;
}
