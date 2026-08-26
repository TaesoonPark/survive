/** Languages the game ships text for. Shared by the interface and the content tables. */
export const SUPPORTED_LOCALES = ['en', 'ko'] as const;

export type UiLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

function fromQuery(search: string): UiLocale | null {
  const requested = new URLSearchParams(search).get('lang');
  return SUPPORTED_LOCALES.find((locale) => locale === requested) ?? null;
}

function fromLanguages(languages: readonly string[]): UiLocale | null {
  for (const tag of languages) {
    // Match on the primary subtag, so `ko-KR` and `ko` both land on Korean.
    const primary = tag.toLowerCase().split('-')[0];
    const match = SUPPORTED_LOCALES.find((locale) => locale === primary);
    if (match) return match;
  }
  return null;
}

/** `?lang=` wins, then what the browser asks for, then English. */
export function resolveLocale(search: string, languages: readonly string[]): UiLocale {
  return fromQuery(search) ?? fromLanguages(languages) ?? DEFAULT_UI_LOCALE;
}

/**
 * The language for this session, read from the environment.
 *
 * Called while the string module is initialising, *before* any module that imports it - which
 * is the point. Several panels build their label tables as module constants, so `t()` runs at
 * import time; if the locale were chosen later, in a boot scene, those tables would already
 * have been filled in English and nothing would look wrong until someone read the screen.
 *
 * Guarded for the non-browser case because the unit tests import these modules under Node.
 */
export function detectLocale(): UiLocale {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return DEFAULT_UI_LOCALE;
  }
  const languages = navigator.languages ?? (navigator.language ? [navigator.language] : []);
  return resolveLocale(window.location.search, languages);
}
