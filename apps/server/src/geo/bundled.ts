import { z } from 'zod';
import { terrainGridSchema, weatherSchema } from '@vyuha/shared';
import silentRidgeGeoJson from '../seed/silent-ridge-geo.json';
import { SILENT_RIDGE_ID } from '../seed/silentRidge';
import type { BundledGeo } from './ingest';

const bundledSchema = z.object({ terrain: terrainGridSchema, weather: weatherSchema });

// Real Open-Meteo elevation/weather captured for Op Silent Ridge so the demo works fully offline.
const silentRidgeGeo: BundledGeo = bundledSchema.parse(silentRidgeGeoJson);

export function bundledGeo(scenarioId: string): BundledGeo | null {
  return scenarioId === SILENT_RIDGE_ID ? silentRidgeGeo : null;
}
