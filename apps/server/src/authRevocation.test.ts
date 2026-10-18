import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { AUTH_COOKIE_NAME, SOCKET_EVENTS, ackSchema, joinAckSchema, type Ack } from '@vyuha/shared';
import { closeEnv, makeEnv, setupLobby, type Env } from './sessions/testenv';
import { testConfig } from './testing';

/**
 * Sign-in tokens are versioned per user: signing out increments the version, so every token issued
 * before it stops working on HTTP and on sockets, and the user's open sockets are dropped. Expired,
 * malformed or forged tokens are refused; rights always come from the current database record.
 */

let env: Env | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await closeEnv(env);
  env = undefined;
});

const cookieOf = (token: string) => `${AUTH_COOKIE_NAME}=${token}`;

/** A fresh login (not the env's cached cookie), so each call is a separate device. */
async function login(e: Env, email: string): Promise<string> {
  const res = await e.app.fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: 'Vyuha@123' },
  });
  const c = res.cookies.find((x) => x.name === AUTH_COOKIE_NAME);
  if (!c) throw new Error('login failed');
  return cookieOf(c.value);
}

const get = async (e: Env, url: string, cookie: string) =>
  (await e.app.fastify.inject({ method: 'GET', url, headers: { cookie } })).statusCode;

const logout = (e: Env, cookie: string) =>
  e.app.fastify.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });

const sign = (payload: object, options: jwt.SignOptions, secret = testConfig.JWT_SECRET) =>
  cookieOf(jwt.sign(payload, secret, { algorithm: 'HS256', ...options }));

async function listening() {
  env = await makeEnv({ socketRevalidateMs: 60 });
  await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
  return env;
}

interface Client {
  socket: Socket;
  errors: string[];
  closed: Promise<void>;
}

function open(e: Env, cookie: string): Promise<Client> {
  const address = e.app.fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  const socket = connect(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie },
  });
  sockets.push(socket);
  const errors: string[] = [];
  socket.on(SOCKET_EVENTS.error, (err: { code?: string }) => errors.push(err.code ?? ''));
  const closed = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve({ socket, errors, closed }));
    socket.once('connect_error', (err) => reject(err));
  });
}

const refusedAtHandshake = async (e: Env, cookie: string): Promise<string> => {
  try {
    await open(e, cookie);
    return 'connected';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

const emitAck = (c: Client, event: string, payload: unknown): Promise<Ack> =>
  new Promise((resolve) => {
    c.socket.emit(event, payload, (ack: unknown) => resolve(ackSchema.parse(ack)));
  });

const join = (c: Client, code: string) =>
  new Promise((resolve) => {
    c.socket.emit(SOCKET_EVENTS.join, { code }, (raw: unknown) =>
      resolve(joinAckSchema.parse(raw)),
    );
  });

const decision = {
  type: 'DECISION',
  actionType: 'HOLD',
  confidence: 55,
  rationale: 'Holding until the picture is clearer',
} as const;

describe('sign-out revokes tokens', () => {
  it('makes the signed-out token, and every other token of that user, unusable', async () => {
    const e = (env = await makeEnv());
    const laptop = await login(e, 'inst@x.io');
    const phone = await login(e, 'inst@x.io');
    expect(await get(e, '/auth/me', laptop)).toBe(200);
    expect(await get(e, '/sessions', phone)).toBe(200);

    const out = await logout(e, laptop);
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === AUTH_COOKIE_NAME);
    expect(cleared?.value).toBe('');
    expect(cleared?.httpOnly).toBe(true);

    for (const cookie of [laptop, phone]) {
      expect(await get(e, '/auth/me', cookie)).toBe(401);
      expect(await get(e, '/sessions', cookie)).toBe(401);
      const session = await e.app.fastify.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie },
      });
      expect(session.json()).toEqual({ user: null });
    }
    // Signing in again issues a working token; other users are unaffected.
    expect(await get(e, '/auth/me', await login(e, 'inst@x.io'))).toBe(200);
    expect(await get(e, '/auth/me', await login(e, 'sec@x.io'))).toBe(200);
  });

  it('is harmless without a valid token', async () => {
    const e = (env = await makeEnv());
    expect((await logout(e, '')).statusCode).toBe(204);
    expect((await logout(e, cookieOf('not-a-jwt'))).statusCode).toBe(204);
    expect(e.mem.users.get('u-inst')?.tokenVersion ?? 0).toBe(0);
  });

  it('drops the user’s open sockets at once and refuses the old token at the next handshake', async () => {
    const e = await listening();
    const lobby = await setupLobby(e);
    const cookie = await login(e, 'sec@x.io');
    const sec = await open(e, cookie);
    expect(await join(sec, lobby.code)).toMatchObject({ ok: true });
    const other = await open(e, await login(e, 'pl@x.io'));

    expect((await logout(e, cookie)).statusCode).toBe(204);
    await sec.closed;
    expect(other.socket.connected).toBe(true);
    expect(await refusedAtHandshake(e, cookie)).toBe('UNAUTHENTICATED');
  });

  it('rejects a sensitive action on a socket whose token was revoked elsewhere', async () => {
    env = await makeEnv(); // default 30 s timer: only the action itself can notice
    const e = env;
    await e.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const lobby = await setupLobby(e);
    await e.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
    const sec = await open(e, await login(e, 'sec@x.io'));
    expect(await join(sec, lobby.code)).toMatchObject({ ok: true });
    const inst = await open(e, await login(e, 'inst@x.io'));
    expect(await join(inst, lobby.code)).toMatchObject({ ok: true });

    await e.mem.deps.users.revokeTokens('u-sec');
    await e.mem.deps.users.revokeTokens('u-inst');
    expect(await emitAck(sec, SOCKET_EVENTS.action, decision)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
    const jam = { type: 'SET_JAMMING', channel: 'VHF', intensity: 0.5 };
    expect(await emitAck(inst, SOCKET_EVENTS.instructorInput, jam)).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
    await Promise.all([sec.closed, inst.closed]);
    await e.app.manager.stepNow(lobby.sessionId, 2);
    expect(e.mem.sessions.decisions.filter((d) => d.playerId === lobby.players.sec)).toHaveLength(
      0,
    );
  });

  it('drops an idle socket whose token was revoked elsewhere on the next revalidation', async () => {
    const e = await listening();
    const sec = await open(e, await login(e, 'sec@x.io'));
    await e.mem.deps.users.revokeTokens('u-sec');
    await sec.closed;
    expect(sec.errors).toContain('UNAUTHENTICATED');
  });
});

describe('invalid tokens', () => {
  it('refuses expired, forged, malformed and incomplete tokens over HTTP and sockets', async () => {
    const e = await listening();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'u-inst', role: 'INSTRUCTOR' })).toString(
      'base64url',
    );
    const bad: Record<string, string> = {
      expired: sign({ role: 'INSTRUCTOR', ver: 0, exp: now - 10 }, { subject: 'u-inst' }),
      wrongSecret: sign(
        { role: 'INSTRUCTOR' },
        { subject: 'u-inst', expiresIn: 60 },
        'y'.repeat(32),
      ),
      algNone: cookieOf(`${header}.${body}.`),
      malformed: cookieOf('abc.def.ghi'),
      noSubject: sign({ role: 'INSTRUCTOR' }, { expiresIn: 60 }),
      noExpiry: sign({ role: 'INSTRUCTOR', ver: 0 }, { subject: 'u-inst' }),
      unknownUser: sign({ role: 'INSTRUCTOR' }, { subject: 'nobody', expiresIn: 60 }),
      oldVersion: sign({ role: 'INSTRUCTOR', ver: 3 }, { subject: 'u-inst', expiresIn: 60 }),
    };
    for (const [name, cookie] of Object.entries(bad)) {
      expect({ name, me: await get(e, '/auth/me', cookie) }).toEqual({ name, me: 401 });
      expect({ name, list: await get(e, '/sessions', cookie) }).toEqual({ name, list: 401 });
      expect({ name, socket: await refusedAtHandshake(e, cookie) }).toEqual({
        name,
        socket: 'UNAUTHENTICATED',
      });
    }
    // A token issued before versions existed (no `ver`) is version 0: valid until the next sign-out.
    const legacy = sign({ role: 'INSTRUCTOR' }, { subject: 'u-inst', expiresIn: 60 });
    expect(await get(e, '/auth/me', legacy)).toBe(200);
    await logout(e, legacy);
    expect(await get(e, '/auth/me', legacy)).toBe(401);
  });

  it('drops a socket when its token expires, with no request from the client', async () => {
    const e = (env = await makeEnv()); // revalidation timer cannot fire: the expiry timer does it
    await e.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const exp = Math.floor(Date.now() / 1000) + 2;
    const c = await open(e, sign({ role: 'TRAINEE', ver: 0, exp }, { subject: 'u-sec' }));
    await c.closed;
    expect(c.errors).toContain('UNAUTHENTICATED');
    expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000 - 50);
  });
});

describe('rights come from the current record, not the token', () => {
  it('ignores the role claimed in the token over HTTP', async () => {
    const e = (env = await makeEnv());
    const cookie = await login(e, 'inst@x.io');
    expect(await get(e, '/sessions', cookie)).toBe(200);
    const record = e.mem.users.get('u-inst');
    if (!record) throw new Error('missing instructor');
    e.mem.users.set('u-inst', { ...record, role: 'TRAINEE' });
    expect(await get(e, '/sessions', cookie)).toBe(403);
    // A token claiming INSTRUCTOR for a trainee account gives no instructor rights either.
    const forgedRole = sign({ role: 'INSTRUCTOR', ver: 0 }, { subject: 'u-sec', expiresIn: 60 });
    expect(await get(e, '/sessions', forgedRole)).toBe(403);
    e.mem.users.delete('u-inst');
    expect(await get(e, '/auth/me', cookie)).toBe(401);
  });
});
