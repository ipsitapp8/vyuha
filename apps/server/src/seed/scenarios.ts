import type { ScenarioDefinition } from '@vyuha/shared';
import { HIM_PRAHARI_ID, himPrahari } from './himPrahari';
import { SILENT_RIDGE_ID, silentRidge } from './silentRidge';
import { THAR_KAVACH_ID, tharKavach } from './tharKavach';

export interface SeedScenario {
  id: string;
  definition: ScenarioDefinition;
  /** File under src/seed with the real terrain and weather captured for offline use. */
  geoFile: string;
}

/** Every scenario the seed installs, in the order the instructor sees them. */
export const SEED_SCENARIOS: readonly SeedScenario[] = [
  { id: SILENT_RIDGE_ID, definition: silentRidge, geoFile: 'silent-ridge-geo.json' },
  { id: HIM_PRAHARI_ID, definition: himPrahari, geoFile: 'him-prahari-geo.json' },
  { id: THAR_KAVACH_ID, definition: tharKavach, geoFile: 'thar-kavach-geo.json' },
];
