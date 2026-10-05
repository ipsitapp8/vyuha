import { z } from 'zod';
import { terrainGridSchema, weatherSchema } from '@vyuha/shared';
import himPrahariGeoJson from '../seed/him-prahari-geo.json';
import { HIM_PRAHARI_ID } from '../seed/himPrahari';
import silentRidgeGeoJson from '../seed/silent-ridge-geo.json';
import { SILENT_RIDGE_ID } from '../seed/silentRidge';
import tharKavachGeoJson from '../seed/thar-kavach-geo.json';
import { THAR_KAVACH_ID } from '../seed/tharKavach';
import type { BundledGeo } from './ingest';

const bundledSchema = z.object({ terrain: terrainGridSchema, weather: weatherSchema });

// Real elevation and weather captured for every seeded scenario, so each one works fully offline.
// Silent Ridge and Him Prahari: Open-Meteo. Thar Kavach: SRTM 90 m through OpenTopoData.
const BUNDLED: Record<string, BundledGeo> = {
  [SILENT_RIDGE_ID]: bundledSchema.parse(silentRidgeGeoJson),
  [HIM_PRAHARI_ID]: bundledSchema.parse(himPrahariGeoJson),
  [THAR_KAVACH_ID]: bundledSchema.parse(tharKavachGeoJson),
};

export function bundledGeo(scenarioId: string): BundledGeo | null {
  return BUNDLED[scenarioId] ?? null;
}
