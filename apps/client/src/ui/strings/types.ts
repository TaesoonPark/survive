/**
 * Interface text, split by where the key comes from.
 *
 * `notify` and `reject` are keyed by what the *server* sends, so those keys are a contract
 * with the simulation rather than a naming choice. `ui` is keyed by this client's own
 * dotted names and is free to be reorganised.
 */
export interface UiStringTable {
  /** Messages the simulation raises, keyed by the code in its `notification` event. */
  notify: Record<string, string>;
  /** Why a command was refused, keyed by the `reason` the simulation sends. */
  reject: Record<string, string>;
  /** Interface chrome: titles, labels, buttons, prompts. */
  ui: Record<string, string>;
}

/** Languages the interface ships text for. */
export type UiLocale = 'en';
