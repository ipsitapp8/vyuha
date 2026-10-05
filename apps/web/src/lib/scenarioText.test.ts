import { afterEach, describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import hi from '@/i18n/hi.json';
import { i18n, setLanguage } from '@/i18n';
import { scenarioDescription, scenarioTitle, TRANSLATED_SCENARIO_TITLES } from './scenarioText';

const t = i18n.t.bind(i18n);
afterEach(() => setLanguage('en'));

describe('scenario titles and descriptions', () => {
  it('has English and Hindi text for all three seeded scenarios', () => {
    expect(TRANSLATED_SCENARIO_TITLES).toEqual([
      'Op Silent Ridge',
      'Op Him Prahari',
      'Op Thar Kavach',
    ]);
    expect(Object.keys(en.scenarios).sort()).toEqual(Object.keys(hi.scenarios).sort());
    for (const key of Object.keys(en.scenarios) as (keyof typeof en.scenarios)[]) {
      // the English title is the stored title, so lookups by title keep working
      expect(TRANSLATED_SCENARIO_TITLES).toContain(en.scenarios[key].title);
      expect(hi.scenarios[key].title).toMatch(/[ऀ-ॿ]/);
      expect(hi.scenarios[key].description).toMatch(/[ऀ-ॿ]/);
      expect(hi.scenarios[key].description.length).toBeGreaterThan(80);
    }
  });

  it('follows the selected language', () => {
    expect(scenarioTitle(t, 'Op Thar Kavach')).toBe('Op Thar Kavach');
    expect(scenarioDescription(t, 'Op Him Prahari', 'stored')).toContain('5,300 m pass');
    setLanguage('hi');
    expect(scenarioTitle(t, 'Op Thar Kavach')).toBe('ऑप थार कवच');
    expect(scenarioTitle(t, 'Op Him Prahari')).toBe('ऑप हिम प्रहरी');
    expect(scenarioDescription(t, 'Op Silent Ridge', 'stored')).toMatch(/[ऀ-ॿ]/);
  });

  it('shows a scenario it does not know exactly as stored', () => {
    setLanguage('hi');
    expect(scenarioTitle(t, 'Op Custom')).toBe('Op Custom');
    expect(scenarioDescription(t, 'Op Custom', 'Written by an instructor.')).toBe(
      'Written by an instructor.',
    );
  });
});
