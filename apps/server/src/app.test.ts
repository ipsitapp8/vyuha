import { afterEach, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@vyuha/shared';
import { buildApp, type App } from './app';
import { loadConfig } from './config';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'http://localhost:5173',
});

let app: App | undefined;
afterEach(async () => {
  app?.io.close();
  await app?.fastify.close();
  app = undefined;
});

describe('GET /health', () => {
  it('reports db:true when the probe succeeds', async () => {
    app = await buildApp(config, { ping: async () => true });
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(healthResponseSchema.parse(res.json())).toEqual({ ok: true, db: true });
  });
  it('reports db:false (not a crash) when the probe throws', async () => {
    app = await buildApp(config, {
      ping: async () => {
        throw new Error('down');
      },
    });
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: false });
  });
});
