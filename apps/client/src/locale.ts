import type { Locale } from '@survive/game-data';
import { uiLocale } from './ui/strings';

/**
 * The language for this session.
 *
 * The choice itself is made where the interface strings live, as that module initialises -
 * see `ui/strings/detect.ts` for why it cannot wait until boot. This only reports it, marks
 * the document, and hands it to the content tables.
 *
 * There is no in-game switcher. Nothing re-renders on a change - the content tables are
 * built once at boot and several panels fill their label tables at import time - so a
 * switcher would have to reload the page, which is what `?lang=` already does.
 */
export function initLocale(): Locale {
  const locale = uiLocale();
  document.documentElement.lang = locale;
  return locale as Locale;
}
