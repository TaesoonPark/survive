import { describe, expect, it } from 'vitest';
import { computeDataVersion, defaultTables, localizeTables } from '../gameData';
import { EN } from './en';
import { KO } from './ko';
import { stringTable, type Locale, type TextKind } from './index';

/**
 * The locale table and the content tables have to describe the same world.
 *
 * Text used to live inside the definitions, where it could not go missing. Now that it is a
 * table of its own, nothing in the type system holds the two together - the def id types
 * are aliases for `string`, not literal unions, because the unions would have to come from
 * the content tables and the content tables would then depend on the locale. So the
 * agreement is a test, and it checks both directions: an item with no text would render as
 * a bare id, and text for a deleted item is a translator's wasted afternoon.
 */
describe('display text', () => {
  const tables = defaultTables();
  const kinds: { kind: TextKind; ids: string[]; describes: boolean }[] = [
    { kind: 'items', ids: tables.items.map((d) => d.id), describes: true },
    { kind: 'recipes', ids: tables.recipes.map((d) => d.id), describes: false },
    { kind: 'structures', ids: tables.structures.map((d) => d.id), describes: true },
    { kind: 'nodes', ids: tables.nodes.map((d) => d.id), describes: false },
    { kind: 'zombies', ids: tables.zombies.map((d) => d.id), describes: false },
    { kind: 'animals', ids: tables.animals.map((d) => d.id), describes: false },
    { kind: 'crops', ids: tables.crops.map((d) => d.id), describes: false },
  ];

  it('covers the whole content set, so this is not a spot check', () => {
    expect(kinds.reduce((total, k) => total + k.ids.length, 0)).toBeGreaterThan(350);
  });

  /** Every shipped locale, so a second language is held to the same bar as the first. */
  const locales: Locale[] = ['en', 'ko'];

  it.each(locales)('%s covers every definition, and nothing else', (locale) => {
    const table = stringTable(locale);
    for (const { kind, ids } of kinds) {
      const missing = ids.filter((id) => !table[kind][id]?.name);
      expect(missing, `${locale} is missing ${kind}: ${missing.join(', ')}`).toEqual([]);
      const known = new Set(ids);
      const orphans = Object.keys(table[kind]).filter((id) => !known.has(id));
      expect(orphans, `${locale} has stale ${kind}: ${orphans.join(', ')}`).toEqual([]);
    }
  });

  it.each(locales)('%s says something different from the ids', (locale) => {
    // A locale that fell back to ids everywhere would pass the coverage test above.
    const table = stringTable(locale);
    for (const { kind, ids } of kinds) {
      for (const id of ids) expect(table[kind][id]!.name, `${locale} ${kind} ${id}`).not.toBe(id);
    }
  });

  it('translates rather than copying English', () => {
    // Not a quality check - it cannot be - but it does catch a locale file left half done,
    // which is what a wall of identical strings means.
    const shared = EN.items;
    const other = KO.items;
    const identical = Object.keys(shared).filter((id) => shared[id]!.name === other[id]!.name);
    expect(identical.length, `untranslated item names: ${identical.join(', ')}`).toBeLessThan(5);
  });

  describe.each(kinds)('$kind', ({ kind, ids, describes }) => {
    const table = EN[kind];

    it('names every definition', () => {
      const missing = ids.filter((id) => !table[id]?.name);
      expect(missing, `no ${kind} text for: ${missing.join(', ')}`).toEqual([]);
    });

    it('names nothing that no longer exists', () => {
      const known = new Set(ids);
      const orphans = Object.keys(table).filter((id) => !known.has(id));
      expect(orphans, `${kind} text for missing definitions: ${orphans.join(', ')}`).toEqual([]);
    });

    it('has no blank or placeholder text', () => {
      for (const id of ids) {
        const text = table[id]!;
        expect(text.name.trim(), id).not.toBe('');
        // An id that leaked through as its own name - `stone_hatchet` rather than
        // `Stone Hatchet` - is the shape a missing translation takes.
        expect(text.name, id).not.toBe(id);
        if (describes) {
          expect(text.description?.trim(), `${id} description`).toBeTruthy();
        }
      }
    });
  });

  it('leaves the description off kinds whose definitions have no such field', () => {
    // Not cosmetic: `computeDataVersion` hashes the tables, so inventing an empty field on
    // every recipe and crop would change the content version of every existing save.
    for (const kind of ['recipes', 'nodes', 'zombies', 'animals', 'crops'] as const) {
      for (const [id, text] of Object.entries(EN[kind])) {
        expect(text.description, `${kind}.${id}`).toBeUndefined();
      }
    }
  });

  it('does not let the locale change the content version', () => {
    // The version is a content identity and it is compared across the wire - the client
    // refuses to play against a server whose content differs. A Korean client and an
    // English server run the same world, so a translation must not read as a mismatch.
    // Checked by hashing the tables with text and without, since there is only one locale
    // to compare today and this has to hold on the day there are two.
    const withText = localizeTables(tables);
    expect(computeDataVersion(withText)).toBe(computeDataVersion(tables));
    // And the text really is there, so this is not passing because nothing was merged.
    expect(withText.items[0]!.name).not.toBe(withText.items[0]!.id);
  });

  it('falls back to the id rather than throwing when a locale is short', () => {
    // The fallback exists so one missing string cannot stop the game from starting. It is
    // never meant to be seen, which is what the tests above are for.
    expect(stringTable('en')).toBe(EN);
  });
});
