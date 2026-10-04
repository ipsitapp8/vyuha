import { describe, expect, it } from 'vitest';
import en from './en.json';
import hi from './hi.json';
import { REASON_TEXTS, VALIDATION_TEXTS } from '@/lib/messages';
import { initI18n, setLanguage, i18n } from './index';

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  return Object.entries(tree).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'string' ? { ...acc, [key]: v } : { ...acc, ...flatten(v, key) };
  }, {});
}

const vars = (s: string): string[] =>
  [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] ?? '').sort();
const flatEn = flatten(en);
const flatHi = flatten(hi);

describe('locale files', () => {
  it('Hindi has exactly the same keys as English', () => {
    expect(Object.keys(flatHi).sort()).toEqual(Object.keys(flatEn).sort());
  });

  it('every string is non-empty and uses the same {{placeholders}} in both languages', () => {
    for (const [key, text] of Object.entries(flatEn)) {
      expect(text.trim().length, key).toBeGreaterThan(0);
      expect(flatHi[key]?.trim().length, key).toBeGreaterThan(0);
      expect(vars(flatHi[key] ?? ''), key).toEqual(vars(text));
    }
  });

  it('Hindi strings are actually translated (Devanagari) except brand and technical terms', () => {
    const keep = new Set([
      'app.name',
      'app.tagline',
      'lang.en',
      'channels.SATCOM',
      'cockpit.radio.pace',
    ]);
    const untranslated = Object.entries(flatHi).filter(
      ([k, v]) => !keep.has(k) && !/[ऀ-ॿ]/.test(v) && v === flatEn[k],
    );
    expect(untranslated.map(([k]) => k)).toEqual([]);
  });

  it('every translatable engine reason and form message has a locale string', () => {
    expect(REASON_TEXTS.length).toBe(Object.keys(en.reasons).length);
    expect(VALIDATION_TEXTS.length).toBe(Object.keys(en.validation).length);
  });
});

describe('language switching', () => {
  it('switches the active language and the document language, and persists the choice', async () => {
    await initI18n('en');
    expect(i18n.t('common.signOut')).toBe('Sign out');
    setLanguage('hi');
    expect(i18n.t('common.signOut')).toBe(hi.common.signOut);
    expect(document.documentElement.lang).toBe('hi');
    expect(window.localStorage.getItem('vyuha.lang')).toBe('hi');
    setLanguage('en');
    expect(i18n.t('common.signOut')).toBe('Sign out');
  });

  it('interpolates values in Hindi too', () => {
    setLanguage('hi');
    expect(i18n.t('age.seconds', { n: 42 })).toContain('42');
    setLanguage('en');
  });
});
