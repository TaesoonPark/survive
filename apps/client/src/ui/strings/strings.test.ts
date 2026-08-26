import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BODY_PART_IDS,
  HARMFUL_EFFECTS,
  SKILL_IDS,
  type EntitySnapshotKind,
} from '@survive/protocol';
import { EN_UI } from './en';
import { KO_UI } from './ko';
import { notifyText, rejectText, setUiLocale, t, type UiLocale } from './index';

/** Every `t('...')` and `t(\`...\`)` key the client actually asks for. */
function askedKeys(dir: string): { key: string; file: string }[] {
  const out: { key: string; file: string }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const source = readFileSync(full, 'utf8');
      // Any key-shaped literal, not only the ones directly after `t(`. Several call sites
      // choose between two keys with a ternary - `t(open ? 'a' : 'b')` - and a scan anchored
      // on the call would report both as unused.
      for (const match of source.matchAll(
        /'((?:panel|vital|hotbar|prompt|tip|toast|chip|inv|cb|build|map|session|menu|craft)\.[A-Za-z.]+)'/g,
      )) {
        out.push({ key: match[1]!, file: entry });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The interface asks for keys; the table has to have them.
 *
 * Text used to be written where it was displayed, so it could not be missing. Now that it
 * is a table, a typo in a key shows the key itself on screen - which is deliberately ugly,
 * but only helps if somebody looks. This is the somebody: it reads the client's own source
 * for every literal key and every closed set fed to a template key.
 */
describe('interface text', () => {
  const asked = askedKeys(join(import.meta.dirname, '..', '..'));

  it('finds the keys to check, so a broken scan cannot pass silently', () => {
    expect(asked.length).toBeGreaterThan(30);
  });

  it('has an entry for every key the client asks for', () => {
    const missing = [...new Set(asked.filter((a) => !EN_UI.ui[a.key]).map((a) => a.key))];
    expect(missing, `no interface text for: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no entry nothing asks for', () => {
    // Templated keys are built at runtime from closed sets, so they are listed by prefix
    // rather than found in the source.
    const templated = [
      'effect.',
      'bodyPart.',
      'skill.',
      'entity.',
      'damage.',
      'tool.',
      'station.',
      'medical.',
      'craft.cat.',
      'biome.',
    ];
    const literal = new Set(asked.map((a) => a.key));
    const orphans = Object.keys(EN_UI.ui).filter(
      (key) => !literal.has(key) && !templated.some((prefix) => key.startsWith(prefix)),
    );
    expect(orphans, `interface text nothing asks for: ${orphans.join(', ')}`).toEqual([]);
  });

  describe('closed sets fed to template keys', () => {
    it('names every status effect', () => {
      for (const id of HARMFUL_EFFECTS) expect(EN_UI.ui[`effect.${id}`], id).toBeTruthy();
    });

    it('names every body part', () => {
      for (const id of BODY_PART_IDS) expect(EN_UI.ui[`bodyPart.${id}`], id).toBeTruthy();
    });

    it('names every skill', () => {
      for (const id of SKILL_IDS) expect(EN_UI.ui[`skill.${id}`], id).toBeTruthy();
    });

    it('names every entity kind that can be pointed at', () => {
      const kinds: EntitySnapshotKind[] = [
        'player',
        'zombie',
        'animal',
        'item',
        'projectile',
        'structure',
        'node',
      ];
      for (const kind of kinds) expect(EN_UI.ui[`entity.${kind}`], kind).toBeTruthy();
    });
  });

  const locales: UiLocale[] = ['en', 'ko'];

  it.each(locales)('%s has every key, and no key nothing asks for', (locale) => {
    // Both directions, for every shipped language: a second locale is only useful if it is
    // as complete as the first, and a stale key is a translator's wasted afternoon.
    setUiLocale(locale);
    try {
      const table = locale === 'en' ? EN_UI : KO_UI;
      const expected = Object.keys(EN_UI.ui).sort();
      expect(Object.keys(table.ui).sort()).toEqual(expected);
      expect(Object.keys(table.notify).sort()).toEqual(Object.keys(EN_UI.notify).sort());
      expect(Object.keys(table.reject).sort()).toEqual(Object.keys(EN_UI.reject).sort());
    } finally {
      setUiLocale('en');
    }
  });

  it('keeps the same placeholders in every language', () => {
    // A dropped `{count}` is a sentence with a hole in it; an invented one renders literally.
    // Word *order* is free to change - that is the whole reason these are templates.
    const holes = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const section of ['notify', 'reject', 'ui'] as const) {
      for (const [key, english] of Object.entries(EN_UI[section])) {
        expect(holes(KO_UI[section][key]!), `ko ${section}.${key}`).toEqual(holes(english));
      }
    }
  });

  it('actually translates, rather than copying the English', () => {
    // Some entries legitimately read the same in both languages: a product name, a unit,
    // an abbreviation, or a string that is nothing but placeholders. What none of them may
    // be is *prose* - so instead of tolerating a magic number of matches, this asks what is
    // left of a matching entry once the placeholders and punctuation are removed. More than
    // one word left means an English sentence was copied across and never translated.
    const proseWords = (value: string): string[] =>
      value
        .replace(/\{\w+\}/g, ' ')
        .replace(/[^A-Za-z ]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 0);
    for (const section of ['notify', 'reject', 'ui'] as const) {
      for (const [key, english] of Object.entries(EN_UI[section])) {
        if (KO_UI[section][key] !== english) continue;
        const words = proseWords(english);
        expect(words.length, `untranslated ${section}.${key}: ${english}`).toBeLessThan(2);
      }
    }
  });

  it('renders a Korean message with its values in Korean word order', () => {
    setUiLocale('ko');
    try {
      const text = notifyText({
        code: 'notify.addedToStation',
        params: { count: 3, item: '통나무', station: '모닥불' },
      });
      // The station leads and the verb trails, the reverse of the English. This is the case
      // that a `text: string` from the server could not have produced.
      expect(text).toBe('모닥불에 통나무 3개를 넣었습니다.');
      expect(text.indexOf('모닥불')).toBeLessThan(text.indexOf('통나무'));
    } finally {
      setUiLocale('en');
    }
  });

  it('fills in the values a message carries', () => {
    expect(
      notifyText({ code: 'notify.structureFinished', params: { structure: 'Campfire' } }),
    ).toBe('Campfire finished.');
    // Named, not positional: a translation is free to reorder or drop one.
    expect(
      notifyText({
        code: 'notify.addedToStation',
        params: { count: 3, item: 'Log', station: 'Fire' },
      }),
    ).toBe('Added 3 x Log to the Fire.');
  });

  it('leaves a placeholder alone when no value is supplied', () => {
    // Better a visible `{structure}` than a sentence with a hole in it.
    expect(notifyText({ code: 'notify.structureFinished' })).toBe('{structure} finished.');
  });

  it('turns a refusal code into something a person would write', () => {
    // These used to reach the player exactly as the simulation sent them.
    expect(rejectText('toolIneffective')).not.toBe('toolIneffective');
    expect(rejectText('outOfRange')).not.toBe('outOfRange');
    expect(rejectText('missingMaterials')).not.toBe('missingMaterials');
  });

  it('falls back to the key rather than throwing', () => {
    expect(t('no.such.key')).toBe('no.such.key');
    expect(notifyText({ code: 'notify.nonexistent' })).toBe('notify.nonexistent');
    expect(rejectText('nonexistentReason')).toBe('nonexistentReason');
  });
});
