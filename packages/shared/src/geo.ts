import { z } from 'zod';
import { areaBoundsSchema } from './scenario';

export const GRID_ROWS = 64;
export const GRID_COLS = 64;

export const terrainGridSchema = z
  .object({
    rows: z.number().int().min(2),
    cols: z.number().int().min(2),
    bbox: areaBoundsSchema,
    elevations: z.array(z.number().finite()),
  })
  .refine((g) => g.elevations.length === g.rows * g.cols, {
    message: 'elevations length must equal rows*cols',
  });
export type TerrainGridDto = z.infer<typeof terrainGridSchema>;

export const weatherSchema = z.object({
  visibilityM: z.number().min(0),
  precipitationMm: z.number().min(0),
  windKph: z.number().min(0),
  fetchedAt: z.string(),
});
export type WeatherDto = z.infer<typeof weatherSchema>;

export const geoSourceSchema = z.enum(['LIVE', 'CACHE', 'BUNDLED']);
export type GeoSource = z.infer<typeof geoSourceSchema>;

export const scenarioGeoResponseSchema = z.object({
  terrain: terrainGridSchema.nullable(),
  weather: weatherSchema.nullable(),
});
export type ScenarioGeoResponse = z.infer<typeof scenarioGeoResponseSchema>;

export const ingestGeoResponseSchema = z.object({
  terrain: terrainGridSchema,
  weather: weatherSchema,
  terrainSource: geoSourceSchema,
  weatherSource: geoSourceSchema,
  warnings: z.array(z.string()),
});
export type IngestGeoResponse = z.infer<typeof ingestGeoResponseSchema>;

export const ingestJobSchema = z.object({
  scenarioId: z.string(),
  status: z.enum(['RUNNING', 'DONE', 'FAILED']),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  result: ingestGeoResponseSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type IngestJob = z.infer<typeof ingestJobSchema>;
