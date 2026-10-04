import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { buildApp, BODY_LIMIT_BYTES, LOG_REDACT, type App } from './app';
import { loadConfig } from './config';
import { RateLimiter } from './sessions/socket';
import { createMemoryDeps, testConfig } from './testing';

let app: App | undefined;
afterEach(async () => {
  if (app) {
    app.io.close();
    await app.fastify.close();
  }
  app = undefined;
});

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
};

describe('HTTP hardening', () => {
  it('sends security headers on every response', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps);
    const res = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('only echoes CORS headers for allow-listed origins', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps);
    const ok = await app.fastify.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await app.fastify.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('lets the web app use every method it calls, so browsers do not block delete, assign or PACE saves', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps);
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.fastify.inject({
        method: 'OPTIONS',
        url: '/sessions/s1/teams/t1',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type',
        },
      });
      expect(res.statusCode, method).toBe(204);
      const allowed = String(res.headers['access-control-allow-methods']).split(/\s*,\s*/);
      expect(allowed, `preflight for ${method}`).toContain(method);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    }
    // and still not for a stranger's origin
    const evil = await app.fastify.inject({
      method: 'OPTIONS',
      url: '/sessions/s1/teams/t1',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'DELETE' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects oversized bodies with a typed 413 instead of a 500', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps);
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.io', password: 'x'.repeat(BODY_LIMIT_BYTES + 10) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('throttles login and register attempts per client with a typed 429', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps, {
      authLimiter: new RateLimiter(3, 0),
    });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@x.io', password: 'wrong-password' },
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      }
    }
    expect(codes.slice(0, 3).every((c) => c === 401)).toBe(true);
    expect(codes.slice(3)).toEqual([429, 429]);
    // other endpoints are not throttled by the auth limiter
    const health = await app.fastify.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('redacts cookies and credentials from logs', async () => {
    const lines: string[] = [];
    const log = Fastify({
      logger: {
        level: 'info',
        redact: { paths: LOG_REDACT, censor: '[redacted]' },
        stream: { write: (s: string) => void lines.push(s) },
      },
    });
    log.get('/x', async (request) => {
      // A handler that carelessly logs the raw headers must still not leak the session cookie.
      request.log.info({ incoming: { headers: request.headers } }, 'debugging');
      return { ok: true };
    });
    await log.inject({ method: 'GET', url: '/x', headers: { cookie: 'vyuha_token=SECRET123' } });
    await log.close();
    expect(lines.join('')).not.toContain('SECRET123');
    expect(lines.join('')).toContain('[redacted]');
  });
});

describe('configuration validation', () => {
  it('parses a comma separated CORS allow-list', () => {
    const c = loadConfig({
      ...base,
      CORS_ORIGIN: 'http://localhost:5173, https://vyuha.example.mil',
    });
    expect(c.CORS_ORIGIN).toEqual(['http://localhost:5173', 'https://vyuha.example.mil']);
  });

  it.each(['*', 'http://*.example.com', 'localhost:5173', 'http://a.io/path', 'http://a.io, *'])(
    'refuses unsafe CORS origin %s',
    (origin) => {
      expect(() => loadConfig({ ...base, CORS_ORIGIN: origin })).toThrow(/CORS_ORIGIN/);
    },
  );

  it('defaults the log level and refuses unknown ones', () => {
    expect(loadConfig({ ...base, CORS_ORIGIN: 'http://a.io' }).LOG_LEVEL).toBe('info');
    expect(() => loadConfig({ ...base, CORS_ORIGIN: 'http://a.io', LOG_LEVEL: 'loud' })).toThrow(
      /LOG_LEVEL/,
    );
  });
});
