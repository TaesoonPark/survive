import type { LocalizedMessage } from '@survive/protocol';
import { EN_UI } from './en';
import type { UiLocale, UiStringTable } from './types';

export type { UiLocale, UiStringTable };

const TABLES: Record<UiLocale, UiStringTable> = { en: EN_UI };

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

let active: UiLocale = DEFAULT_UI_LOCALE;

/**
 * Choose the interface language.
 *
 * Module state rather than something threaded through every widget, because the answer is
 * the same for every widget on screen and passing it down through seven panel files would
 * be ceremony. Set once at boot; nothing re-renders on a change.
 */
export function setUiLocale(locale: UiLocale): void {
  active = locale;
}

export function uiLocale(): UiLocale {
  return active;
}

function table(): UiStringTable {
  return TABLES[active] ?? EN_UI;
}

/**
 * Fill `{name}` placeholders in a template.
 *
 * Deliberately positional-by-name rather than by order: a translation is free to put the
 * count after the item, or to drop a value the English sentence happens to mention.
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Interface text for a key.
 *
 * Falls back to the key itself, which is deliberately ugly: a missing string should be
 * obvious in a screenshot rather than blank. `strings.test.ts` checks that every key the
 * client asks for exists, so this should never be reached in a shipped build.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(table().ui[key] ?? key, params);
}

/** Wording for a message the simulation asked for by code. */
export function notifyText(message: LocalizedMessage): string {
  const template = table().notify[message.code];
  return template === undefined ? message.code : interpolate(template, message.params);
}

/**
 * Wording for a refused command.
 *
 * The simulation's reasons are a mix of short codes and English phrases - `toolIneffective`
 * beside `too far away` - and they used to be shown to the player exactly as sent. Keyed by
 * the raw value, so the server did not have to change for these to become sentences.
 */
export function rejectText(reason: string): string {
  return table().reject[reason] ?? reason;
}
