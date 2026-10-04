import { afterEach, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@vyuha/shared';
import { buildApp, type App } from './app';
import { createMemoryDeps, testConfig } from './testing';

let app: App | undefined;
afterEach(async () => {
  app?.io.close();
  await app?.fastify.close();
  app = undefined;
});

describe('GET /health', () => {
  it('reports db:true when the probe succeeds', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps);
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(healthResponseSchema.parse(res.json())).toEqual({ ok: true, db: true });
  });
  it('reports db:false (not a crash) when the probe throws', async () => {
    const { deps } = createMemoryDeps();
    deps.db = {
      ping: async () => {
        throw new Error('down');
      },
    };
    app = await buildApp(testConfig, deps);
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: false });
  });
});
