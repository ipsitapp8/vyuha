import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_COOKIE_NAME,
  apiErrorSchema,
  authResponseSchema,
  scenarioListResponseSchema,
  sessionResponseSchema,
} from '@vyuha/shared';
import { buildApp, type App } from './app';
import { hashPassword } from './auth';
import { createMemoryDeps, testConfig } from './testing';

let app: App | undefined;
afterEach(async () => {
  app?.io.close();
  await app?.fastify.close();
  app = undefined;
});

const creds = { name: 'Asha Rao', email: 'Asha@Example.com', password: 'Secret123' };

async function setup() {
  const mem = createMemoryDeps([
    {
      id: 's1',
      title: 'Op Test',
      description: 'd',
      areaBounds: { south: 1, west: 1, north: 2, east: 2 },
      seed: 1,
      injectCount: 2,
      unitCount: 3,
    },
  ]);
  mem.users.set('inst', {
    id: 'inst',
    name: 'Instructor',
    email: 'i@vyuha.local',
    role: 'INSTRUCTOR',
    passwordHash: await hashPassword('Vyuha@123'),
  });
  app = await buildApp(testConfig, mem.deps);
  return app.fastify;
}

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === AUTH_COOKIE_NAME);
  if (!c) throw new Error('no auth cookie');
  return `${AUTH_COOKIE_NAME}=${c.value}`;
}

describe('auth', () => {
  it('registers a TRAINEE (ignoring a requested role), lowercases email, sets httpOnly cookie', async () => {
    const f = await setup();
    const res = await f.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...creds, role: 'INSTRUCTOR' },
    });
    expect(res.statusCode).toBe(201);
    const body = authResponseSchema.parse(res.json());
    expect(body.user.role).toBe('TRAINEE');
    expect(body.user.email).toBe('asha@example.com');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(res.cookies.find((c) => c.name === AUTH_COOKIE_NAME)?.httpOnly).toBe(true);
  });

  it('rejects duplicate email with 409 and weak password with 400', async () => {
    const f = await setup();
    await f.inject({ method: 'POST', url: '/auth/register', payload: creds });
    const dup = await f.inject({ method: 'POST', url: '/auth/register', payload: creds });
    expect(dup.statusCode).toBe(409);
    expect(apiErrorSchema.parse(dup.json()).error.code).toBe('EMAIL_TAKEN');
    const weak = await f.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...creds, email: 'b@example.com', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(apiErrorSchema.parse(weak.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in, serves /auth/me from the cookie, and logs out', async () => {
    const f = await setup();
    const login = await f.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'i@vyuha.local', password: 'Vyuha@123' },
    });
    expect(login.statusCode).toBe(200);
    const me = await f.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: cookieOf(login) },
    });
    expect(authResponseSchema.parse(me.json()).user.role).toBe('INSTRUCTOR');
    const out = await f.inject({ method: 'POST', url: '/auth/logout' });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((c) => c.name === AUTH_COOKIE_NAME)?.value).toBe('');
  });

  it('gives the same error for wrong password and unknown email', async () => {
    const f = await setup();
    const a = await f.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'i@vyuha.local', password: 'wrong-pass1' },
    });
    const b = await f.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@vyuha.local', password: 'wrong-pass1' },
    });
    expect(a.statusCode).toBe(401);
    expect(b.json()).toEqual(a.json());
  });

  it('/auth/session answers 200 with null when signed out, and the user when signed in', async () => {
    const f = await setup();
    const anon = await f.inject({ method: 'GET', url: '/auth/session' });
    expect(anon.statusCode).toBe(200);
    expect(sessionResponseSchema.parse(anon.json())).toEqual({ user: null });
    const login = await f.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'i@vyuha.local', password: 'Vyuha@123' },
    });
    const me = await f.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: cookieOf(login) },
    });
    expect(sessionResponseSchema.parse(me.json()).user?.role).toBe('INSTRUCTOR');
    const bad = await f.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `${AUTH_COOKIE_NAME}=junk` },
    });
    expect(sessionResponseSchema.parse(bad.json())).toEqual({ user: null });
  });

  it('rejects /auth/me without a cookie or with a tampered token', async () => {
    const f = await setup();
    expect((await f.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    const bad = await f.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `${AUTH_COOKIE_NAME}=not.a.jwt` },
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe('role guard on GET /scenarios', () => {
  it('401 anonymous, 403 trainee, 200 instructor', async () => {
    const f = await setup();
    expect((await f.inject({ method: 'GET', url: '/scenarios' })).statusCode).toBe(401);

    const reg = await f.inject({ method: 'POST', url: '/auth/register', payload: creds });
    const trainee = await f.inject({
      method: 'GET',
      url: '/scenarios',
      headers: { cookie: cookieOf(reg) },
    });
    expect(trainee.statusCode).toBe(403);

    const login = await f.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'i@vyuha.local', password: 'Vyuha@123' },
    });
    const ok = await f.inject({
      method: 'GET',
      url: '/scenarios',
      headers: { cookie: cookieOf(login) },
    });
    expect(ok.statusCode).toBe(200);
    expect(scenarioListResponseSchema.parse(ok.json()).scenarios).toHaveLength(1);
  });

  it('keeps the two sign-in portals apart: the wrong kind of account is refused and not signed in', async () => {
    const f = await setup();
    await f.inject({ method: 'POST', url: '/auth/register', payload: creds });
    const login = (email: string, portal?: 'INSTRUCTOR' | 'TRAINEE', password = 'Secret123') =>
      f.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password, ...(portal ? { portal } : {}) },
      });

    // a trainee cannot use the instructor portal, and gets no cookie
    const wrongForTrainee = await login(creds.email, 'INSTRUCTOR');
    expect(wrongForTrainee.statusCode).toBe(403);
    expect(apiErrorSchema.parse(wrongForTrainee.json()).error.code).toBe('FORBIDDEN');
    expect(wrongForTrainee.cookies.find((c) => c.name === AUTH_COOKIE_NAME)).toBeUndefined();

    // an instructor cannot use the trainee portal
    const wrongForInstructor = await login('i@vyuha.local', 'TRAINEE', 'Vyuha@123');
    expect(wrongForInstructor.statusCode).toBe(403);
    expect(wrongForInstructor.cookies.find((c) => c.name === AUTH_COOKIE_NAME)).toBeUndefined();

    // the matching portal, and no portal at all, still work
    expect((await login(creds.email, 'TRAINEE')).statusCode).toBe(200);
    expect((await login('i@vyuha.local', 'INSTRUCTOR', 'Vyuha@123')).statusCode).toBe(200);
    expect((await login(creds.email)).statusCode).toBe(200);

    // a wrong password is a plain 401 whatever the portal, so the 403 never reveals an account
    expect((await login(creds.email, 'INSTRUCTOR', 'nope-nope-1')).statusCode).toBe(401);
    expect((await login('nobody@example.com', 'INSTRUCTOR')).statusCode).toBe(401);
    // an unknown portal value is rejected
    const bad = await f.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: creds.email, password: 'Secret123', portal: 'ADMIN' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
