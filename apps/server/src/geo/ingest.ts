import { isValidGrid, sampleGridPoints } from '@vyuha/engine';
import {
  GRID_COLS,
  GRID_ROWS,
  type AreaBounds,
  type GeoSource,
  type IngestGeoResponse,
  type TerrainGridDto,
  type WeatherDto,
} from '@vyuha/shared';
import type { GeoNetwork } from './openMeteo';

export interface GeoRepo {
  getScenarioBounds(scenarioId: string): Promise<AreaBounds | null>;
  getTerrain(scenarioId: string): Promise<TerrainGridDto | null>;
  getWeather(scenarioId: string): Promise<WeatherDto | null>;
  saveTerrain(scenarioId: string, grid: TerrainGridDto): Promise<void>;
  saveWeather(scenarioId: string, weather: WeatherDto): Promise<void>;
}

export interface BundledGeo {
  terrain: TerrainGridDto;
  weather: WeatherDto;
}

export class ScenarioNotFoundError extends Error {
  constructor() {
    super('Scenario not found');
    this.name = 'ScenarioNotFoundError';
  }
}

/** No live data, no cached data and no bundled data exist for this scenario. */
export class GeoUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'GeoUnavailableError';
  }
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Live Open-Meteo ingestion with graceful fallback: live -> last cached copy in the DB ->
 * bundled offline copy (only scenarios that ship one). Never throws on network failure alone.
 */
export async function ingestScenarioGeo(
  scenarioId: string,
  repo: GeoRepo,
  network: GeoNetwork,
  bundled: BundledGeo | null,
  opts: { now?: () => Date; onProgress?: (done: number, total: number) => void } = {},
): Promise<IngestGeoResponse> {
  const now = opts.now ?? ((): Date => new Date());
  const bbox = await repo.getScenarioBounds(scenarioId);
  if (!bbox) throw new ScenarioNotFoundError();
  const warnings: string[] = [];

  let terrain: TerrainGridDto | null = null;
  let terrainSource: GeoSource = 'LIVE';
  try {
    const points = sampleGridPoints(bbox, GRID_ROWS, GRID_COLS);
    const elevations = await network.fetchElevations(points, opts.onProgress);
    const grid: TerrainGridDto = { rows: GRID_ROWS, cols: GRID_COLS, bbox, elevations };
    if (!isValidGrid(grid)) throw new Error('received an invalid elevation grid');
    terrain = grid;
    await repo.saveTerrain(scenarioId, grid);
  } catch (err) {
    warnings.push(`Live elevation unavailable: ${reason(err)}.`);
    const cached = await repo.getTerrain(scenarioId);
    if (cached) {
      terrain = cached;
      terrainSource = 'CACHE';
      warnings.push('Using the last cached terrain grid.');
    } else if (bundled) {
      terrain = bundled.terrain;
      terrainSource = 'BUNDLED';
      await repo.saveTerrain(scenarioId, bundled.terrain);
      warnings.push('Using the terrain grid bundled with the application.');
    }
  }
  if (!terrain) {
    throw new GeoUnavailableError(
      `Could not reach Open-Meteo and no cached terrain exists for this scenario. ${warnings.join(' ')} ` +
        'Connect to the internet and try again.',
    );
  }

  let weather: WeatherDto | null = null;
  let weatherSource: GeoSource = 'LIVE';
  try {
    const centre = { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
    const w = await network.fetchWeather(centre);
    weather = { ...w, fetchedAt: now().toISOString() };
    await repo.saveWeather(scenarioId, weather);
  } catch (err) {
    warnings.push(`Live weather unavailable: ${reason(err)}.`);
    const cached = await repo.getWeather(scenarioId);
    if (cached) {
      weather = cached;
      weatherSource = 'CACHE';
      warnings.push('Using the last cached weather snapshot.');
    } else if (bundled) {
      weather = bundled.weather;
      weatherSource = 'BUNDLED';
      await repo.saveWeather(scenarioId, bundled.weather);
      warnings.push('Using the weather snapshot bundled with the application.');
    }
  }
  if (!weather) {
    throw new GeoUnavailableError(
      `Terrain is stored but weather could not be fetched and none is cached. ${warnings.join(' ')}`,
    );
  }

  return { terrain, weather, terrainSource, weatherSource, warnings };
}
