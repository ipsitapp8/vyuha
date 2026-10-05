import type { TFunction } from 'i18next';

/**
 * The seeded scenarios are stored once, in English. Their titles and descriptions are translated here
 * by title; a scenario this table does not know (authored later) is shown as stored.
 */
const KEYS = {
  'Op Silent Ridge': 'silentRidge',
  'Op Him Prahari': 'himPrahari',
  'Op Thar Kavach': 'tharKavach',
} as const;
type Key = (typeof KEYS)[keyof typeof KEYS];

const keyOf = (title: string): Key | undefined => (KEYS as Record<string, Key | undefined>)[title];

export function scenarioTitle(t: TFunction, title: string): string {
  const key = keyOf(title);
  return key ? t(`scenarios.${key}.title`) : title;
}

export function scenarioDescription(t: TFunction, title: string, stored: string): string {
  const key = keyOf(title);
  return key ? t(`scenarios.${key}.description`) : stored;
}

/** Titles of the scenarios that have a translation (kept in step with the seed by a test). */
export const TRANSLATED_SCENARIO_TITLES: readonly string[] = Object.keys(KEYS);
