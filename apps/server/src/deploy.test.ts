import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME } from '@vyuha/shared';
import { buildApp, type App } from './app';
import { hashPassword } from './auth';
import { loadConfig } from './config';
import { RateLimiter } from './sessions/socket';
import { createMemoryDeps } from './testing';

/** The single-service deployment (Render): pages, API under /api and the socket from one address. */

let app: App | undefined;
let dist = '';

beforeEach(() => {
  dist = mkdtempSync(path.join(tmpdir(), 'vyuha-dist-'));
  mkdirSync(path.join(dist, 'assets'));
  mkdirSync(path.join(dist, 'tiles'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>VYUHA page</title>');
  writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  writeFileSync(path.join(dist, 'tiles', 'area.pmtiles'), 'PMTiles-0123456789');
});
afterEach(async () => {
  if (app) {
    app.io.close();
    await app.fastify.close();
  }
  app = undefined;
  rmSync(dist, { recursive: true, force: true });
});

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'https://vyuha.example.org',
};

async function start(
  env: Record<string, string> = {},
  options: Parameters<typeof buildApp>[2] = {},
) {
  const mem = createMemoryDeps();
  mem.users.set('inst', {
    id: 'inst',
    name: 'Instructor',
    email: 'i@x.io',
    role: 'INSTRUCTOR',
    passwordHash: await hashPassword('Vyuha@123'),
  });
  const config = loadConfig({ ...base, API_PREFIX: '/api', WEB_DIST_DIR: dist, ...env });
  app = await buildApp(config, mem.deps, options);
  return app.fastify;
}

describe('serving the web app and the API from one server', () => {
  it('puts the API under /api and serves the pages for every page address', async () => {
    const f = await start();
    const health = await f.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, db: true });

    // page addresses that look like API ones (/aar/:id, /progress/:id) belong to the app, not the API
    for (const url of [
      '/',
      '/login',
      '/login/instructor',
      '/aar/abc',
      '/progress/someone',
      '/session/ABC234',
    ]) {
      const res = await f.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
      expect(res.body, url).toContain('VYUHA page');
    }
    // the same addresses under /api are the real API, which wants a sign-in
    const api = await f.inject({ method: 'GET', url: '/api/aar/abc' });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('answers an unknown API address with a typed 404, never with the page', async () => {
    const f = await start();
    const res = await f.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await f.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404);
  });

  it('signs in through /api with a cookie that works for the whole site', async () => {
    const f = await start({ COOKIE_SECURE: 'true' });
    const res = await f.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'i@x.io', password: 'Vyuha@123', portal: 'INSTRUCTOR' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === AUTH_COOKIE_NAME);
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    const me = await f.inject({
      method: 'GET',
      url: '/api/scenarios',
      headers: { cookie: `${AUTH_COOKIE_NAME}=${cookie?.value}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('caches built files for a year, other files briefly, and serves tiles with Range requests', async () => {
    const f = await start();
    const asset = await f.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const page = await f.inject({ method: 'GET', url: '/' });
    expect(page.headers['cache-control']).toBe('public, max-age=300');

    const part = await f.inject({
      method: 'GET',
      url: '/tiles/area.pmtiles',
      headers: { range: 'bytes=0-6' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('PMTiles');
    expect(part.headers['content-range']).toBe('bytes 0-6/18');
  });

  it('refuses to start when the web build is missing', async () => {
    rmSync(path.join(dist, 'index.html'));
    await expect(start()).rejects.toThrow(/index\.html/);
  });

  it('allows the live socket and workers in the security policy, and upgrades to https only when secure', async () => {
    const plain = await start({ COOKIE_SECURE: 'false' });
    const a = String(
      (await plain.inject({ method: 'GET', url: '/' })).headers['content-security-policy'],
    );
    expect(a).toMatch(/connect-src 'self' ws: wss:/);
    expect(a).toMatch(/worker-src 'self' blob:/);
    expect(a).not.toContain('upgrade-insecure-requests');
    await app?.fastify.close();
    app?.io.close();
    app = undefined;

    const secure = await start({ COOKIE_SECURE: 'true' });
    const b = String(
      (await secure.inject({ method: 'GET', url: '/' })).headers['content-security-policy'],
    );
    expect(b).toContain('upgrade-insecure-requests');
  });

  it('throttles sign-ins per visitor behind the proxy when TRUST_PROXY is on, not per proxy', async () => {
    const f = await start({ TRUST_PROXY: 'true' }, { authLimiter: new RateLimiter(1, 0) });
    const login = (ip: string) =>
      f.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { email: 'nobody@x.io', password: 'wrong-password' },
      });
    expect((await login('203.0.113.1')).statusCode).toBe(401);
    expect((await login('203.0.113.1')).statusCode).toBe(429); // same visitor, over the limit
    expect((await login('203.0.113.2')).statusCode).toBe(401); // another visitor is unaffected
  });

  it('still throttles /api/auth/register under the prefix', async () => {
    const f = await start({}, { authLimiter: new RateLimiter(1, 0) });
    const reg = () =>
      f.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { name: 'a', email: 'bad', password: 'x' },
      });
    expect((await reg()).statusCode).toBe(400);
    expect((await reg()).statusCode).toBe(429);
  });
});

describe('deployment configuration', () => {
  it('defaults to the root API and no static serving', () => {
    const c = loadConfig(base);
    expect(c.API_PREFIX).toBe('');
    expect(c.WEB_DIST_DIR).toBeUndefined();
    expect(c.TRUST_PROXY).toBe(false);
  });

  it('allows the address Render reports when CORS_ORIGIN is not set', () => {
    const { CORS_ORIGIN: _unused, ...rest } = base;
    void _unused;
    expect(
      loadConfig({ ...rest, RENDER_EXTERNAL_URL: 'https://vyuha.onrender.com' }).CORS_ORIGIN,
    ).toEqual(['https://vyuha.onrender.com']);
    // an explicit setting wins
    expect(
      loadConfig({
        ...rest,
        CORS_ORIGIN: 'https://a.example',
        RENDER_EXTERNAL_URL: 'https://b.example',
      }).CORS_ORIGIN,
    ).toEqual(['https://a.example']);
    // and with neither, start-up still refuses
    expect(() => loadConfig(rest)).toThrow(/CORS_ORIGIN/);
  });

  it.each(['api', '/api/v1', '/API', '//', '/a b'])('rejects the API prefix %s', (prefix) => {
    expect(() => loadConfig({ ...base, API_PREFIX: prefix })).toThrow(/API_PREFIX/);
  });

  it('accepts /api and reads the proxy switch', () => {
    const c = loadConfig({
      ...base,
      API_PREFIX: '/api',
      TRUST_PROXY: 'true',
      WEB_DIST_DIR: '/srv/web',
    });
    expect(c).toMatchObject({ API_PREFIX: '/api', TRUST_PROXY: true, WEB_DIST_DIR: '/srv/web' });
  });
});
