import { EN } from './en';
import type { DisplayText, Locale, StringTable, TextKind } from './types';

export type { DisplayText, Locale, StringTable, TextKind };

/**
 * The shipped locales.
 *
 * Adding a language is adding a file here and a case to {@link Locale}. Nothing in the
 * content tables, the simulation or the renderer has to change - that separation is the
 * whole reason the text was pulled out of the definitions.
 */
const TABLES: Record<Locale, StringTable> = {
  en: EN,
};

export const DEFAULT_LOCALE: Locale = 'en';

export function stringTable(locale: Locale = DEFAULT_LOCALE): StringTable {
  return TABLES[locale] ?? EN;
}

/**
 * Overlay display text onto a content definition.
 *
 * A definition carries the numbers; the locale carries the words. Merged here, at table
 * build time, so everything downstream keeps reading `def.name` and never learns that the
 * two were ever apart.
 *
 * A missing entry falls back to the id rather than throwing. A game that refuses to start
 * because one translation is missing is worse than one that shows `stone_hatchet` for a
 * moment - and `strings.test.ts` fails the build long before a player sees it.
 */
export function localize<T extends { id: string }>(
  kind: TextKind,
  defs: readonly T[],
  locale: Locale = DEFAULT_LOCALE,
): (T & { name: string })[] {
  const table = stringTable(locale)[kind];
  return defs.map((def) => {
    const text = table[def.id];
    return {
      ...def,
      name: text?.name ?? def.id,
      // Only when there is one. An empty string here would be a real field on a recipe or
      // a crop, which declare no description at all - and `computeDataVersion` hashes the
      // tables, so inventing a field would change the content version for every save.
      ...(text?.description === undefined ? {} : { description: text.description }),
    };
  });
}

/**
 * The same, for kinds whose definition type *requires* a description.
 *
 * Items and structures do. The fallback is an empty string rather than the id, because an
 * id repeated under its own name reads as a bug; a blank description just looks sparse.
 */
export function localizeDescribed<T extends { id: string }>(
  kind: TextKind,
  defs: readonly T[],
  locale: Locale = DEFAULT_LOCALE,
): (T & { name: string; description: string })[] {
  const table = stringTable(locale)[kind];
  return defs.map((def) => {
    const text = table[def.id];
    return { ...def, name: text?.name ?? def.id, description: text?.description ?? '' };
  });
}
