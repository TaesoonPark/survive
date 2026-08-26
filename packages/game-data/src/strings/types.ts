/** What the player reads for one piece of content. */
export interface DisplayText {
  name: string;
  description?: string;
}

/**
 * Display text for every piece of game content, keyed by definition id.
 *
 * Completeness is checked by `strings.test.ts`, not by the type: the def id types are
 * aliases for `string` rather than literal unions - they have to be, because the unions
 * would come from the content tables and the content tables would then depend on this
 * file. So the test asserts both directions, that every definition has text and that no
 * text names a definition that has been removed.
 */
export interface StringTable {
  items: Record<string, DisplayText>;
  recipes: Record<string, DisplayText>;
  structures: Record<string, DisplayText>;
  nodes: Record<string, DisplayText>;
  zombies: Record<string, DisplayText>;
  animals: Record<string, DisplayText>;
  crops: Record<string, DisplayText>;
}

/** Content kinds that carry display text. */
export type TextKind = keyof StringTable;

/** Languages the game ships text for. */
export type Locale = 'en';
