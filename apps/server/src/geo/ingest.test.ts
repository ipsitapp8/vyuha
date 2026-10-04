import { describe, expect, it } from 'vitest';
import type { TerrainGridDto, WeatherDto } from '@vyuha/shared';
import { memoryGeo } from '../testing';
import {
  GeoUnavailableError,
  ingestScenarioGeo,
  ScenarioNotFoundError,
  type BundledGeo,
} from './ingest';
import { GeoNetworkError, type GeoNetwork } from './openMeteo';

const bbox = { south: 1, west: 1, north: 2, east: 2 };
const okNet: GeoNetwork = {
  fetchElevations: async (p) => p.map((_, i) => 3000 + (i % 7)),
  fetchWeather: async () => ({ visibilityM: 9000, precipitationMm: 0.2, windKph: 11 }),
};
const downNet: GeoNetwork = {
  fetchElevations: async () => {
    throw new GeoNetworkError('offline');
  },
  fetchWeather: async () => {
    throw new GeoNetworkError('offline');
  },
};
const now = () => new Date('2026-01-01T00:00:00Z');

const cachedTerrain: TerrainGridDto = { rows: 2, cols: 2, bbox, elevations: [1, 2, 3, 4] };
const cachedWeather: WeatherDto = {
  visibilityM: 1,
  precipitationMm: 1,
  windKph: 1,
  fetchedAt: '2025-12-31T00:00:00.000Z',
};
const bundled: BundledGeo = {
  terrain: { rows: 2, cols: 2, bbox, elevations: [9, 9, 9, 9] },
  weather: { ...cachedWeather, visibilityM: 777 },
};

describe('ingestScenarioGeo', () => {
  it('stores a 64x64 live grid and the weather snapshot', async () => {
    const repo = memoryGeo();
    const progress: number[] = [];
    const net: GeoNetwork = {
      ...okNet,
      fetchElevations: async (p, cb) => {
        cb?.(p.length, p.length);
        return okNet.fetchElevations(p);
      },
    };
    const res = await ingestScenarioGeo('s1', repo, net, null, {
      now,
      onProgress: (d) => progress.push(d),
    });
    expect(res.terrainSource).toBe('LIVE');
    expect(res.weatherSource).toBe('LIVE');
    expect(res.terrain.rows * res.terrain.cols).toBe(4096);
    expect(res.terrain.elevations).toHaveLength(4096);
    expect(repo.terrain.get('s1')?.elevations).toHaveLength(4096);
    expect(repo.weather.get('s1')).toEqual({
      visibilityM: 9000,
      precipitationMm: 0.2,
      windKph: 11,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(res.warnings).toEqual([]);
    expect(progress).toEqual([4096]);
  });

  it('falls back to the cached grid and weather when offline', async () => {
    const repo = memoryGeo();
    repo.terrain.set('s1', cachedTerrain);
    repo.weather.set('s1', cachedWeather);
    const res = await ingestScenarioGeo('s1', repo, downNet, bundled);
    expect(res.terrainSource).toBe('CACHE');
    expect(res.weatherSource).toBe('CACHE');
    expect(res.terrain).toEqual(cachedTerrain);
    expect(res.warnings.join(' ')).toMatch(/cached terrain/);
  });

  it('uses bundled data when offline with no cache, and persists it', async () => {
    const repo = memoryGeo();
    const res = await ingestScenarioGeo('s1', repo, downNet, bundled);
    expect(res.terrainSource).toBe('BUNDLED');
    expect(res.weather.visibilityM).toBe(777);
    expect(repo.terrain.get('s1')).toEqual(bundled.terrain);
  });

  it('throws a clear GeoUnavailableError (not a crash) offline with nothing cached or bundled', async () => {
    const repo = memoryGeo();
    await expect(ingestScenarioGeo('s1', repo, downNet, null)).rejects.toThrow(GeoUnavailableError);
    await expect(ingestScenarioGeo('s1', repo, downNet, null)).rejects.toThrow(/no cached terrain/);
  });

  it('keeps live terrain but reports weather failure when no weather is available anywhere', async () => {
    const repo = memoryGeo();
    const net: GeoNetwork = { ...okNet, fetchWeather: downNet.fetchWeather };
    await expect(ingestScenarioGeo('s1', repo, net, null)).rejects.toThrow(
      /weather could not be fetched/,
    );
    expect(repo.terrain.get('s1')).toBeDefined();
  });

  it('rejects a malformed upstream grid instead of storing it', async () => {
    const repo = memoryGeo();
    const net: GeoNetwork = { ...okNet, fetchElevations: async () => [1, 2, 3] };
    await expect(ingestScenarioGeo('s1', repo, net, null)).rejects.toThrow(GeoUnavailableError);
    expect(repo.terrain.has('s1')).toBe(false);
  });

  it('throws ScenarioNotFoundError for unknown scenarios', async () => {
    await expect(ingestScenarioGeo('nope', memoryGeo(), okNet, null)).rejects.toThrow(
      ScenarioNotFoundError,
    );
  });
});
