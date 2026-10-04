import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE_NAME,
  ingestJobSchema,
  scenarioGeoResponseSchema,
  terrainGridSchema,
} from '@vyuha/shared';
import { buildApp, type App } from '../app';
import { hashPassword } from '../auth';
import { createMemoryDeps, memoryGeo, testConfig } from '../testing';
import type { GeoNetwork } from './openMeteo';

let app: App | undefined;
afterEach(async () => {
  app?.io.close();
  await app?.fastify.close();
  app = undefined;
});

async function setup(network?: GeoNetwork) {
  const geo = memoryGeo();
  const mem = createMemoryDeps([], network ? { geo, geoNetwork: network } : { geo });
  for (const [id, role] of [
    ['inst', 'INSTRUCTOR'],
    ['trn', 'TRAINEE'],
  ] as const) {
    mem.users.set(id, {
      id,
      name: id,
      email: `${id}@x.io`,
      role,
      passwordHash: await hashPassword('Vyuha@123'),
    });
  }
  app = await buildApp(testConfig, mem.deps);
  const login = async (email: string): Promise<string> => {
    const res = await app!.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'Vyuha@123' },
    });
    return `${AUTH_COOKIE_NAME}=${res.cookies.find((c) => c.name === AUTH_COOKIE_NAME)?.value}`;
  };
  return {
    f: app.fastify,
    geo,
    instructor: await login('inst@x.io'),
    trainee: await login('trn@x.io'),
  };
}

const waitDone = async (f: App['fastify'], cookie: string) => {
  for (let i = 0; i < 50; i++) {
    const res = await f.inject({
      method: 'GET',
      url: '/scenarios/s1/ingest-geo',
      headers: { cookie },
    });
    const job = ingestJobSchema.parse(res.json());
    if (job.status !== 'RUNNING') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
};

describe('geo routes', () => {
  it('requires the instructor role on every geo endpoint', async () => {
    const { f, trainee } = await setup();
    for (const [method, url] of [
      ['POST', '/scenarios/s1/ingest-geo'],
      ['GET', '/scenarios/s1/ingest-geo'],
      ['GET', '/scenarios/s1/geo'],
    ] as const) {
      expect((await f.inject({ method, url })).statusCode).toBe(401);
      expect((await f.inject({ method, url, headers: { cookie: trainee } })).statusCode).toBe(403);
    }
  });

  it('runs ingestion as a background job and then serves the stored grid', async () => {
    const { f, instructor } = await setup();
    const empty = await f.inject({
      method: 'GET',
      url: '/scenarios/s1/geo',
      headers: { cookie: instructor },
    });
    expect(scenarioGeoResponseSchema.parse(empty.json())).toEqual({ terrain: null, weather: null });

    const start = await f.inject({
      method: 'POST',
      url: '/scenarios/s1/ingest-geo',
      headers: { cookie: instructor },
    });
    expect(start.statusCode).toBe(202);
    const job = await waitDone(f, instructor);
    expect(job.status).toBe('DONE');
    expect(job.result?.terrainSource).toBe('LIVE');

    const geo = scenarioGeoResponseSchema.parse(
      (
        await f.inject({ method: 'GET', url: '/scenarios/s1/geo', headers: { cookie: instructor } })
      ).json(),
    );
    expect(geo.terrain?.elevations).toHaveLength(4096);
    expect(geo.weather?.windKph).toBe(5);
  });

  it('reports a FAILED job with a clear message when offline and nothing is cached', async () => {
    const offline: GeoNetwork = {
      fetchElevations: async () => {
        throw new Error('offline');
      },
      fetchWeather: async () => {
        throw new Error('offline');
      },
    };
    const { f, instructor } = await setup(offline);
    await f.inject({
      method: 'POST',
      url: '/scenarios/s1/ingest-geo',
      headers: { cookie: instructor },
    });
    const job = await waitDone(f, instructor);
    expect(job.status).toBe('FAILED');
    expect(job.error?.code).toBe('GEO_UNAVAILABLE');
    expect(job.error?.message).toMatch(/no cached terrain/);
  });

  it('404s for unknown scenarios and for status before any ingestion', async () => {
    const { f, instructor } = await setup();
    const h = { cookie: instructor };
    expect(
      (await f.inject({ method: 'POST', url: '/scenarios/zzz/ingest-geo', headers: h })).statusCode,
    ).toBe(404);
    expect(
      (await f.inject({ method: 'GET', url: '/scenarios/zzz/geo', headers: h })).statusCode,
    ).toBe(404);
    expect(
      (await f.inject({ method: 'GET', url: '/scenarios/s1/ingest-geo', headers: h })).statusCode,
    ).toBe(404);
  });

  it('serves just the terrain grid to any signed-in user, for the hillshade map fallback', async () => {
    const { f, geo, instructor, trainee } = await setup();
    const url = '/scenarios/s1/terrain';
    expect((await f.inject({ method: 'GET', url })).statusCode).toBe(401);
    const missing = await f.inject({ method: 'GET', url, headers: { cookie: trainee } });
    expect(missing.statusCode).toBe(404);

    geo.terrain.set('s1', {
      rows: 2,
      cols: 2,
      bbox: { south: 1, west: 1, north: 2, east: 2 },
      elevations: [10, 20, 30, 40],
    });
    for (const cookie of [trainee, instructor]) {
      const res = await f.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(terrainGridSchema.parse(res.json()).elevations).toEqual([10, 20, 30, 40]);
    }
  });
});
