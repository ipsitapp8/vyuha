import { afterEach, describe, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
import { buildApp, originAllowed, proxyHops, type App } from './app';
import { hashPassword } from './auth';
import { loadConfig } from './config';
import { RateLimiter } from './sessions/socket';
import { closeEnv, makeEnv, setupLobby, type Env } from './sessions/testenv';
import { createMemoryDeps, testConfig } from './testing';

/**
 * Operational safety: socket handshakes from foreign pages, bounded rate-limit memory, per-account login
 * throttling, health/readiness and the token-protected metrics endpoint.
 */

let app: App | undefined;
let env: Env | undefined;
afterEach(async () => {
  if (app) {
    app.io.close();
    await app.fastify.close();
  }
  app = undefined;
  await closeEnv(env);
  env = undefined;
});

describe('Socket.IO handshake origin', () => {
  it('only lets allow-listed browser origins (or non-browser clients) open a socket', () => {
    const allowed = ['http://localhost:5173'];
    expect(originAllowed('http://localhost:5173', allowed)).toBe(true);
    expect(originAllowed(undefined, allowed)).toBe(true);
    expect(originAllowed('http://localhost:3000', allowed)).toBe(false); // same site, other port
    expect(originAllowed('https://evil.example', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
  });

  it('refuses a WebSocket from a foreign page even with a valid sign-in cookie', async () => {
    env = await makeEnv();
    await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const address = env.app.fastify.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const cookie = await env.cookie('inst@x.io');
    const attempt = (origin: string) =>
      new Promise<string>((resolve) => {
        const s = connect(`http://127.0.0.1:${address.port}`, {
          transports: ['websocket'],
          reconnection: false,
          extraHeaders: { cookie, origin },
        });
        s.once('connect', () => {
          s.disconnect();
          resolve('connected');
        });
        s.once('connect_error', () => {
          s.disconnect();
          resolve('refused');
        });
      });
    expect(await attempt('http://localhost:3000')).toBe('refused');
    expect(await attempt('https://evil.example')).toBe('refused');
    expect(await attempt('http://localhost:5173')).toBe('connected');
  });
});

describe('RateLimiter memory', () => {
  it('forgets buckets that have refilled, without changing any decision', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 1, () => t);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    limiter.allow('b');
    t = 1_000; // 'a' has one token back, 'b' is full again
    limiter.prune();
    expect(limiter.size).toBe(1);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
  });

  it('stays bounded under a flood of distinct keys', () => {
    const limiter = new RateLimiter(5, 0.001, () => 0, 100);
    for (let i = 0; i < 5_000; i++) limiter.allow(`ip-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
    // The most recent keys are still tracked.
    for (let i = 0; i < 4; i++) expect(limiter.allow('ip-4999')).toBe(true);
    expect(limiter.allow('ip-4999')).toBe(false);
  });
});

describe('login throttling per account', () => {
  it('limits guesses at one account even when every attempt comes from a new address', async () => {
    const mem = createMemoryDeps();
    const passwordHash = await hashPassword('Vyuha@123');
    mem.users.set('u1', { id: 'u1', name: 'A', email: 'a@x.io', role: 'TRAINEE', passwordHash });
    mem.users.set('u2', { id: 'u2', name: 'B', email: 'b@x.io', role: 'TRAINEE', passwordHash });
    app = await buildApp(testConfig, mem.deps, { accountLimiter: new RateLimiter(3, 0, () => 0) });
    const guess = (email: string, n: number) =>
      app?.fastify.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: `10.0.0.${n}`,
        payload: { email, password: 'wrong-password-1' },
      });
    const codes: number[] = [];
    for (let n = 1; n <= 5; n++) codes.push((await guess(' A@X.io ', n))?.statusCode ?? 0);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    expect((await guess('b@x.io', 9))?.statusCode).toBe(401); // other accounts are unaffected
  });
});

describe('health and readiness', () => {
  it('is ready only while the database answers', async () => {
    const { deps } = createMemoryDeps();
    let up = true;
    deps.db = {
      ping: async () => {
        if (!up) throw new Error('down');
        return true;
      },
    };
    app = await buildApp(testConfig, deps);
    const get = (url: string) => app?.fastify.inject({ method: 'GET', url });
    expect((await get('/health/ready'))?.statusCode).toBe(200);
    expect((await get('/health/live'))?.json()).toEqual({ ok: true });
    up = false;
    const ready = await get('/health/ready');
    expect(ready?.statusCode).toBe(503);
    expect(ready?.json()).toEqual({ ok: false, db: false });
    expect((await get('/health/live'))?.statusCode).toBe(200); // the process itself is fine
  });
});

describe('GET /metrics', () => {
  const TOKEN = 'm'.repeat(40);

  it('does not exist unless METRICS_TOKEN is set', async () => {
    app = await buildApp(testConfig, createMemoryDeps().deps);
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('treats an empty METRICS_TOKEN as unset (Compose passes unset variables through as "")', () => {
    expect(loadConfig({ ...baseEnv, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
  });

  it('rejects a short token at start-up', () => {
    expect(() => loadConfig({ ...baseEnv, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });

  it('needs the bearer token and exposes aggregate numbers only', async () => {
    const config = loadConfig({ ...baseEnv, NODE_ENV: 'test', METRICS_TOKEN: TOKEN });
    const e = await makeEnvWith(config);
    const lobby = await setupLobby(e);
    await e.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
    await e.app.manager.stepNow(lobby.sessionId, 3);

    const scrape = (authorization?: string) =>
      e.app.fastify.inject({
        method: 'GET',
        url: '/metrics',
        headers: authorization ? { authorization } : {},
      });
    expect((await scrape()).statusCode).toBe(401);
    expect((await scrape(`Bearer ${'x'.repeat(40)}`)).statusCode).toBe(401);
    expect((await scrape(TOKEN)).statusCode).toBe(401); // scheme required

    const ok = await scrape(`Bearer ${TOKEN}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.body).toMatch(/^vyuha_up 1$/m);
    expect(ok.body).toMatch(/^vyuha_db_up 1$/m);
    expect(ok.body).toMatch(/^vyuha_sessions_running 1$/m);
    expect(ok.body).toMatch(/^vyuha_ticks_processed_total [1-9]\d*$/m);
    // Nothing that identifies a session, a user or a secret.
    for (const secret of [
      lobby.sessionId,
      lobby.code,
      'u-inst',
      'inst@x.io',
      TOKEN,
      'x'.repeat(32),
    ]) {
      expect(ok.body).not.toContain(secret);
    }
  });
});

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'http://localhost:5173',
};

/** makeEnv with a different config (here: metrics on). */
async function makeEnvWith(config: ReturnType<typeof loadConfig>): Promise<Env> {
  const e = await makeEnv({ config });
  env = e;
  return e;
}

describe('client address behind reverse proxies', () => {
  const PROXY = '10.1.1.1'; // the socket peer: the nearest trusted proxy
  async function hitsFrom(trust: string, forwardedFor: (i: number) => string, n = 5) {
    const config = loadConfig({ ...baseEnv, NODE_ENV: 'test', TRUST_PROXY: trust });
    app = await buildApp(config, createMemoryDeps().deps, {
      authLimiter: new RateLimiter(2, 0, () => 0),
    });
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await app.fastify.inject({
        method: 'POST',
        url: '/auth/register',
        remoteAddress: PROXY,
        headers: { 'x-forwarded-for': forwardedFor(i) },
        payload: {}, // malformed on purpose: 400 unless the address limit answers 429 first
      });
      codes.push(res.statusCode);
    }
    app.io.close();
    await app.fastify.close();
    app = undefined;
    return codes;
  }

  it('cannot be spoofed by prepending addresses when one proxy is trusted', async () => {
    // A client sends its own X-Forwarded-For; the proxy appends the address it really saw.
    for (const trust of ['true', '1']) {
      expect(await hitsFrom(trust, (i) => `198.51.100.${i}, 203.0.113.7`)).toEqual([
        400, 400, 429, 429, 429,
      ]);
    }
  });

  it('reads the right entry for a two-proxy chain and ignores the client-written part', async () => {
    // client-written, real client (seen by the outer proxy), outer proxy (seen by the inner one)
    expect(await hitsFrom('2', (i) => `198.51.100.${i}, 203.0.113.7, 172.70.0.1`)).toEqual([
      400, 400, 429, 429, 429,
    ]);
  });

  it('still tells real visitors apart behind the proxy', async () => {
    expect(await hitsFrom('1', (i) => `203.0.113.${i}`)).toEqual([400, 400, 400, 400, 400]);
  });

  it('ignores X-Forwarded-For entirely unless a proxy is configured', async () => {
    expect(await hitsFrom('false', (i) => `203.0.113.${i}`)).toEqual([400, 400, 429, 429, 429]);
  });

  it('parses the setting strictly', () => {
    const parse = (v: string) => loadConfig({ ...baseEnv, TRUST_PROXY: v }).TRUST_PROXY;
    expect(parse('false')).toBe(false);
    expect(parse('0')).toBe(false);
    expect(parse('true')).toBe(true);
    expect(parse('2')).toBe(2);
    for (const bad of ['yes', '6', '-1', '1.5', 'loopback']) {
      expect(() => parse(bad), bad).toThrow(/TRUST_PROXY/);
    }
    expect(proxyHops(true)).toBe(1);
    expect(proxyHops(false)).toBe(0);
    expect(proxyHops(3)).toBe(3);
  });
});

describe('registration budget', () => {
  it('caps new accounts server-wide whatever address they claim, without touching sign-in', async () => {
    const mem = createMemoryDeps();
    const passwordHash = await hashPassword('Vyuha@123');
    mem.users.set('u1', { id: 'u1', name: 'A', email: 'a@x.io', role: 'TRAINEE', passwordHash });
    app = await buildApp(testConfig, mem.deps, {
      registrationLimiter: new RateLimiter(2, 0, () => 0),
    });
    const register = (i: number, payload: object) =>
      app?.fastify.inject({
        method: 'POST',
        url: '/auth/register',
        remoteAddress: `10.9.0.${i}`,
        payload,
      });
    // Malformed attempts are refused before the budget is touched, so they cannot drain it.
    for (let i = 0; i < 5; i++) expect((await register(i, {}))?.statusCode).toBe(400);
    const valid = (i: number) => ({
      name: `Bot ${i}`,
      email: `bot${i}@x.io`,
      password: 'Passw0rd!',
    });
    expect((await register(10, valid(1)))?.statusCode).toBe(201);
    expect((await register(11, valid(2)))?.statusCode).toBe(201);
    const third = await register(12, valid(3));
    expect(third?.statusCode).toBe(429);
    expect(mem.users.size).toBe(3);
    const login = await app.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@x.io', password: 'Vyuha@123' },
    });
    expect(login.statusCode).toBe(200);
  });
});
