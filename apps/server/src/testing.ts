import { randomUUID } from 'node:crypto';
import type { AreaBounds, ScenarioSummary, TerrainGridDto, WeatherDto } from '@vyuha/shared';
import type { GeoRepo } from './geo/ingest';
import { loadConfig } from './config';
import { EmailTakenError, type Deps, type UserRecord } from './repos';

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'http://localhost:5173',
});

export function memoryGeo(
  bounds: Record<string, AreaBounds> = { s1: { south: 1, west: 1, north: 2, east: 2 } },
): GeoRepo & {
  terrain: Map<string, TerrainGridDto>;
  weather: Map<string, WeatherDto>;
} {
  const terrain = new Map<string, TerrainGridDto>();
  const weather = new Map<string, WeatherDto>();
  return {
    terrain,
    weather,
    getScenarioBounds: async (id) => bounds[id] ?? null,
    getTerrain: async (id) => terrain.get(id) ?? null,
    getWeather: async (id) => weather.get(id) ?? null,
    saveTerrain: async (id, g) => void terrain.set(id, g),
    saveWeather: async (id, w) => void weather.set(id, w),
  };
}

export function createMemoryDeps(
  scenarios: ScenarioSummary[] = [],
  geoOverrides: Partial<Pick<Deps, 'geo' | 'geoNetwork' | 'bundledGeo'>> = {},
): {
  deps: Deps;
  users: Map<string, UserRecord>;
} {
  const users = new Map<string, UserRecord>();
  const deps: Deps = {
    db: { ping: async () => true },
    users: {
      findByEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
      findById: async (id) => users.get(id) ?? null,
      create: async (input) => {
        if ([...users.values()].some((u) => u.email === input.email)) throw new EmailTakenError();
        const rec: UserRecord = { id: randomUUID(), ...input };
        users.set(rec.id, rec);
        return rec;
      },
    },
    scenarios: { listSummaries: async () => scenarios },
    geo: geoOverrides.geo ?? memoryGeo(),
    geoNetwork: geoOverrides.geoNetwork ?? {
      fetchElevations: async (p) => p.map(() => 3000),
      fetchWeather: async () => ({ visibilityM: 9000, precipitationMm: 0, windKph: 5 }),
    },
    bundledGeo: geoOverrides.bundledGeo ?? (() => null),
  };
  return { deps, users };
}
