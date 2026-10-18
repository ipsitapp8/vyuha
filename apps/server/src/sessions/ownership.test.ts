import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  ackSchema,
  aarSummarySchema,
  joinAckSchema,
  lobbyViewSchema,
  sessionInstructorsResponseSchema,
  sessionListResponseSchema,
  type Ack,
  type JoinAck,
} from '@vyuha/shared';
import { hashPassword } from '../auth';
import { SILENT_RIDGE_ID } from '../seed/silentRidge';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

/**
 * Session ownership: only the instructor who created a session, or an instructor that owner added,
 * may run or review it. Every instructor-only REST route and socket handler is checked here, both
 * ways round (allowed for owner / co-instructor, refused for any other instructor).
 */

const OWNER = 'inst@x.io';
const OUTSIDER = 'other@x.io';
const CO = 'co@x.io';

let env: Env | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await closeEnv(env);
  env = undefined;
});

async function withInstructors(): Promise<Env> {
  const e = await makeEnv();
  const passwordHash = await hashPassword('Vyuha@123');
  e.mem.users.set('u-other', {
    id: 'u-other',
    name: 'Other Instructor',
    email: OUTSIDER,
    role: 'INSTRUCTOR',
    passwordHash,
  });
  e.mem.users.set('u-co', {
    id: 'u-co',
    name: 'Co Instructor',
    email: CO,
    role: 'INSTRUCTOR',
    passwordHash,
  });
  return e;
}

async function lobbyEnv() {
  env = await withInstructors();
  return { env, ...(await setupLobby(env)) };
}

/** Starts, plays 40 ticks and ends the session, so the review endpoints have something to show. */
async function playAndEnd(e: Env, sessionId: string): Promise<void> {
  expect((await e.api('POST', `/sessions/${sessionId}/start`, OWNER)).status).toBe(200);
  await e.app.manager.stepNow(sessionId, 40);
  expect((await e.api('POST', `/sessions/${sessionId}/end`, OWNER)).status).toBe(200);
}

const errorCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;

describe('session ownership over REST', () => {
  it('makes the creating instructor the owner and lists a session only for its instructors', async () => {
    const x = await lobbyEnv();
    expect((await x.env.mem.sessions.getSession(x.sessionId))?.ownerId).toBe('u-inst');

    const mine = sessionListResponseSchema.parse((await x.env.api('GET', '/sessions', OWNER)).body);
    expect(mine.sessions.map((s) => s.id)).toEqual([x.sessionId]);
    const theirs = sessionListResponseSchema.parse(
      (await x.env.api('GET', '/sessions', OUTSIDER)).body,
    );
    expect(theirs.sessions).toEqual([]);

    // A session the outsider creates is theirs alone.
    const created = await x.env.api('POST', '/sessions', OUTSIDER, { scenarioId: SILENT_RIDGE_ID });
    expect(created.status).toBe(201);
    const ownSession = lobbyViewSchema.parse(created.body).session.id;
    const again = sessionListResponseSchema.parse(
      (await x.env.api('GET', '/sessions', OUTSIDER)).body,
    );
    expect(again.sessions.map((s) => s.id)).toEqual([ownSession]);
    const ownerAgain = sessionListResponseSchema.parse(
      (await x.env.api('GET', '/sessions', OWNER)).body,
    );
    expect(ownerAgain.sessions.map((s) => s.id)).toEqual([x.sessionId]);
  });

  it('refuses every lobby, lifecycle and assignment route to another instructor and changes nothing', async () => {
    const x = await lobbyEnv();
    const s = x.sessionId;
    const before = lobbyViewSchema.parse(
      (await x.env.api('GET', `/sessions/${s}/lobby`, OWNER)).body,
    );
    const pace = before.teams[0]?.pace;

    const attempts: [
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      body?: unknown,
    ][] = [
      ['GET', `/sessions/${s}/lobby`],
      ['GET', `/sessions/code/${x.code}/lobby`],
      ['POST', `/sessions/${s}/teams`, { name: 'Bravo' }],
      ['PATCH', `/sessions/${s}/teams/${x.teamId}`, { name: 'Renamed' }],
      ['PATCH', `/sessions/${s}/teams/${x.teamId}/pace`, { pace }],
      ['DELETE', `/sessions/${s}/teams/${x.teamId}`],
      ['PUT', `/sessions/${s}/players/${x.players.sec}`, { role: null }],
      ['POST', `/sessions/${s}/start`],
      ['POST', `/sessions/${s}/pause`],
      ['POST', `/sessions/${s}/resume`],
      ['POST', `/sessions/${s}/probe`],
      ['POST', `/sessions/${s}/speed`, { speed: 4 }],
      ['POST', `/sessions/${s}/end`],
      ['POST', `/sessions/${s}/baseline`],
      ['GET', `/sessions/${s}/instructors`],
      ['POST', `/sessions/${s}/instructors`, { email: OUTSIDER }],
      ['DELETE', `/sessions/${s}/instructors/u-other`],
    ];
    for (const [method, url, body] of attempts) {
      const res = await x.env.api(method, url, OUTSIDER, body);
      expect({ method, url, status: res.status, code: errorCode(res.body) }).toEqual({
        method,
        url,
        status: 403,
        code: 'FORBIDDEN',
      });
    }

    const after = lobbyViewSchema.parse(
      (await x.env.api('GET', `/sessions/${s}/lobby`, OWNER)).body,
    );
    expect(after).toEqual(before);
    expect(after.session.status).toBe('LOBBY');
    expect(await x.env.mem.sessions.listCoInstructors(s)).toEqual([]);
    expect(await x.env.mem.sessions.isCoInstructor(s, 'u-other')).toBe(false);
  });

  it('refuses the review, comparison and every export to another instructor', async () => {
    const x = await lobbyEnv();
    await playAndEnd(x.env, x.sessionId);
    const decision = x.env.mem.sessions.decisions[0];
    const s = x.sessionId;
    const urls = [
      `/aar/${s}`,
      `/aar/${s}/compare`,
      `/aar/${s}/snapshot?tick=10`,
      `/aar/${s}/decisions/${decision?.id ?? 'none'}`,
      `/aar/${s}/export.json`,
      `/aar/${s}/export.csv`,
      `/aar/${s}/export.pdf`,
    ];
    for (const url of urls) {
      const res = await x.env.app.fastify.inject({
        method: 'GET',
        url,
        headers: { cookie: await x.env.cookie(OUTSIDER) },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
      expect(res.body).not.toContain('"truth"');
    }
    // The owner still gets all of them.
    for (const url of urls.filter((u) => !u.endsWith('/compare') && !u.includes('/decisions/'))) {
      const res = await x.env.app.fastify.inject({
        method: 'GET',
        url,
        headers: { cookie: await x.env.cookie(OWNER) },
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it('lets an added co-instructor run and review the session but not manage who instructs it', async () => {
    const x = await lobbyEnv();
    const s = x.sessionId;
    const added = await x.env.api('POST', `/sessions/${s}/instructors`, OWNER, { email: CO });
    expect(added.status).toBe(201);
    expect(sessionInstructorsResponseSchema.parse(added.body)).toEqual({
      owner: { id: 'u-inst', name: 'Instructor', email: OWNER },
      coInstructors: [{ id: 'u-co', name: 'Co Instructor', email: CO }],
    });

    const listed = sessionListResponseSchema.parse((await x.env.api('GET', '/sessions', CO)).body);
    expect(listed.sessions.map((r) => r.id)).toEqual([s]);
    expect((await x.env.api('GET', `/sessions/${s}/lobby`, CO)).status).toBe(200);
    expect((await x.env.api('POST', `/sessions/${s}/teams`, CO, { name: 'Bravo' })).status).toBe(
      201,
    );
    expect((await x.env.api('POST', `/sessions/${s}/start`, CO)).status).toBe(200);
    expect((await x.env.api('POST', `/sessions/${s}/speed`, CO, { speed: 2 })).status).toBe(200);
    await x.env.app.manager.stepNow(s, 40);
    expect((await x.env.api('POST', `/sessions/${s}/end`, CO)).status).toBe(200);
    expect((await x.env.api('GET', `/aar/${s}`, CO)).status).toBe(200);
    expect((await x.env.api('GET', `/sessions/${s}/instructors`, CO)).status).toBe(200);

    // Managing co-instructors stays with the owner.
    expect(
      (await x.env.api('POST', `/sessions/${s}/instructors`, CO, { email: OUTSIDER })).status,
    ).toBe(403);
    expect((await x.env.api('DELETE', `/sessions/${s}/instructors/u-co`, CO)).status).toBe(403);

    // Once withdrawn, the co-instructor is an outsider again.
    expect((await x.env.api('DELETE', `/sessions/${s}/instructors/u-co`, OWNER)).status).toBe(200);
    expect((await x.env.api('GET', `/aar/${s}`, CO)).status).toBe(403);
    expect((await x.env.api('GET', `/sessions/${s}/lobby`, CO)).status).toBe(403);
    const none = sessionListResponseSchema.parse((await x.env.api('GET', '/sessions', CO)).body);
    expect(none.sessions).toEqual([]);
  });

  it('adds only existing instructor accounts as co-instructors', async () => {
    const x = await lobbyEnv();
    const add = (email: string) =>
      x.env.api('POST', `/sessions/${x.sessionId}/instructors`, OWNER, { email });
    const trainee = await add('pl@x.io');
    expect(trainee.status).toBe(404);
    expect((await add('nobody@x.io')).status).toBe(404);
    expect((await add(OWNER)).status).toBe(409);
    expect((await add('not-an-email')).status).toBe(400);
    expect(await x.env.mem.sessions.listCoInstructors(x.sessionId)).toEqual([]);
    // A trainee who joined the session still cannot reach the instructor routes.
    expect((await x.env.api('GET', `/sessions/${x.sessionId}/instructors`, 'pl@x.io')).status).toBe(
      403,
    );
    expect(
      (await x.env.api('DELETE', `/sessions/${x.sessionId}/instructors/u-co`, OWNER)).status,
    ).toBe(404);
  });

  it('locks a session without an owner for every instructor', async () => {
    const x = await lobbyEnv();
    x.env.mem.sessions.clearOwner(x.sessionId);
    for (const who of [OWNER, OUTSIDER]) {
      expect((await x.env.api('GET', `/sessions/${x.sessionId}/lobby`, who)).status).toBe(403);
      expect((await x.env.api('POST', `/sessions/${x.sessionId}/start`, who)).status).toBe(403);
      const listed = sessionListResponseSchema.parse(
        (await x.env.api('GET', '/sessions', who)).body,
      );
      expect(listed.sessions).toEqual([]);
    }
    // The trainees who joined keep their own view of the lobby.
    expect((await x.env.api('GET', `/sessions/${x.sessionId}/lobby`, 'pl@x.io')).status).toBe(200);
  });

  it('keeps trainee access to their own session and assessment, and nothing else', async () => {
    const x = await lobbyEnv();
    expect((await x.env.api('GET', `/sessions/${x.sessionId}/lobby`, 'sec@x.io')).status).toBe(200);
    expect((await x.env.api('GET', `/sessions/code/${x.code}/lobby`, 'sec@x.io')).status).toBe(200);
    expect((await x.env.api('GET', `/sessions/${x.sessionId}/lobby`, 'out@x.io')).status).toBe(403);
    const pace = lobbyViewSchema.parse(
      (await x.env.api('GET', `/sessions/${x.sessionId}/lobby`, 'sec@x.io')).body,
    ).teams[0]?.pace;
    expect(
      (
        await x.env.api('PATCH', `/sessions/${x.sessionId}/teams/${x.teamId}/pace`, 'sec@x.io', {
          pace,
        })
      ).status,
    ).toBe(200);

    await playAndEnd(x.env, x.sessionId);
    expect((await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, 'sec@x.io')).status).toBe(200);
    expect((await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, 'out@x.io')).status).toBe(403);
    expect((await x.env.api('GET', `/aar/${x.sessionId}`, 'sec@x.io')).status).toBe(403);
    expect((await x.env.api('GET', `/aar/${x.sessionId}/export.json`, 'sec@x.io')).status).toBe(
      403,
    );
    // Instructors have no my-sa: it is the trainee's own record.
    expect((await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, OWNER)).status).toBe(403);
  });
});

describe('baseline twins and comparisons', () => {
  it('gives the twin to the instructor who asked for it and shares it with the source instructors', async () => {
    const x = await lobbyEnv();
    await x.env.api('POST', `/sessions/${x.sessionId}/instructors`, OWNER, { email: CO });
    await playAndEnd(x.env, x.sessionId);

    const made = await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, CO);
    expect(made.status).toBe(201);
    const twin = lobbyViewSchema.parse(made.body).session.id;
    expect((await x.env.mem.sessions.getSession(twin))?.ownerId).toBe('u-co');
    expect(await x.env.mem.sessions.listCoInstructors(twin)).toEqual(['u-inst']);
    expect((await x.env.api('GET', `/sessions/${twin}/lobby`, OWNER)).status).toBe(200);
    expect((await x.env.api('GET', `/sessions/${twin}/lobby`, OUTSIDER)).status).toBe(403);
    expect((await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, OUTSIDER)).status).toBe(
      403,
    );
  });

  it('refuses a comparison and hides the twin when the caller cannot open the other run', async () => {
    const x = await lobbyEnv();
    await playAndEnd(x.env, x.sessionId);
    const made = await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, OWNER);
    const twin = lobbyViewSchema.parse(made.body).session;
    // Shared after the twin was made: the co-instructor may review the source run only.
    await x.env.api('POST', `/sessions/${x.sessionId}/instructors`, OWNER, { email: CO });

    const seenByCo = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, CO)).body,
    );
    expect(seenByCo.meta.twin).toBeNull();
    expect((await x.env.api('GET', `/aar/${x.sessionId}/compare`, CO)).status).toBe(403);

    const seenByOwner = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, OWNER)).body,
    );
    expect(seenByOwner.meta.twin?.sessionId).toBe(twin.id);
    // The owner may compare; the twin has not been played, so the answer is about state, not access.
    expect((await x.env.api('GET', `/aar/${x.sessionId}/compare`, OWNER)).status).toBe(409);
  });
});

interface Client {
  socket: Socket;
  events: { name: string; payload: unknown }[];
}

async function open(e: Env, email: string): Promise<Client> {
  const address = e.app.fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  const socket = connect(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie: await e.cookie(email) },
  });
  sockets.push(socket);
  const client: Client = { socket, events: [] };
  socket.onAny((name: string, payload: unknown) => client.events.push({ name, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  return client;
}

const join = (c: Client, code: string): Promise<JoinAck> =>
  new Promise((resolve) => {
    c.socket.emit(SOCKET_EVENTS.join, { code }, (ack: unknown) =>
      resolve(joinAckSchema.parse(ack)),
    );
  });

const emitAck = (c: Client, event: string, payload: unknown): Promise<Ack> =>
  new Promise((resolve) => {
    c.socket.emit(event, payload, (ack: unknown) => resolve(ackSchema.parse(ack)));
  });

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const truthCount = (c: Client) =>
  c.events.filter((x) => x.name === SOCKET_EVENTS.truth || x.name === SOCKET_EVENTS.truthEvents)
    .length;
const jam = { type: 'SET_JAMMING', channel: 'VHF', intensity: 0.5 } as const;

async function liveEnv() {
  env = await withInstructors();
  await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const lobby = await setupLobby(env);
  expect((await env.api('POST', `/sessions/${lobby.sessionId}/start`, OWNER)).status).toBe(200);
  return { env, ...lobby };
}

describe('session ownership over Socket.IO', () => {
  it('refuses another instructor at join, and that socket never receives truth', async () => {
    const x = await liveEnv();
    const outsider = await open(x.env, OUTSIDER);
    const ack = await join(outsider, x.code);
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');

    // Not joined, so instructor input and watch are refused too.
    const input = await emitAck(outsider, SOCKET_EVENTS.instructorInput, jam);
    expect(input.ok).toBe(false);
    const watch = await emitAck(outsider, SOCKET_EVENTS.watch, { playerId: x.players.sec });
    expect(watch.ok).toBe(false);

    await x.env.app.manager.stepNow(x.sessionId, 3);
    await nap(200);
    expect(truthCount(outsider)).toBe(0);
    expect(outsider.events.some((e) => e.name === SOCKET_EVENTS.perceived)).toBe(false);
    expect(outsider.events.some((e) => e.name === SOCKET_EVENTS.lobbyUpdate)).toBe(false);
  });

  it('lets the owner and a co-instructor join, inject and watch', async () => {
    const x = await liveEnv();
    await x.env.api('POST', `/sessions/${x.sessionId}/instructors`, OWNER, { email: CO });
    for (const email of [OWNER, CO]) {
      const c = await open(x.env, email);
      const ack = await join(c, x.code);
      expect(ack.ok).toBe(true);
      expect((await emitAck(c, SOCKET_EVENTS.instructorInput, jam)).ok).toBe(true);
      expect((await emitAck(c, SOCKET_EVENTS.watch, { playerId: x.players.sec })).ok).toBe(true);
      await x.env.app.manager.stepNow(x.sessionId, 1);
      await nap(150);
      expect(truthCount(c)).toBeGreaterThan(0);
    }
  });

  it('cannot watch a player of another session', async () => {
    const x = await liveEnv();
    const owner = await open(x.env, OWNER);
    expect((await join(owner, x.code)).ok).toBe(true);
    const ack = await emitAck(owner, SOCKET_EVENTS.watch, { playerId: 'someone-elses-player' });
    expect(ack.ok).toBe(false);
  });

  it('drops a co-instructor the moment the owner withdraws them, and refuses them on rejoin', async () => {
    const x = await liveEnv();
    await x.env.api('POST', `/sessions/${x.sessionId}/instructors`, OWNER, { email: CO });
    const co = await open(x.env, CO);
    expect((await join(co, x.code)).ok).toBe(true);
    const gone = new Promise<void>((resolve) => co.socket.once('disconnect', () => resolve()));

    expect(
      (await x.env.api('DELETE', `/sessions/${x.sessionId}/instructors/u-co`, OWNER)).status,
    ).toBe(200);
    await gone;
    const before = truthCount(co);
    await x.env.app.manager.stepNow(x.sessionId, 3);
    await nap(150);
    expect(truthCount(co)).toBe(before);

    const again = await open(x.env, CO);
    const ack = await join(again, x.code);
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');
  });

  it('re-checks access on every instructor action, not only at join', async () => {
    const x = await liveEnv();
    const owner = await open(x.env, OWNER);
    expect((await join(owner, x.code)).ok).toBe(true);
    x.env.mem.sessions.clearOwner(x.sessionId);
    const input = await emitAck(owner, SOCKET_EVENTS.instructorInput, jam);
    expect(input.ok).toBe(false);
    if (!input.ok) expect(input.error.code).toBe('FORBIDDEN');
    const watch = await emitAck(owner, SOCKET_EVENTS.watch, { playerId: x.players.sec });
    expect(watch.ok).toBe(false);
  });

  it('stops an instructor whose account was demoted from acting on a socket opened earlier', async () => {
    const x = await liveEnv();
    const owner = await open(x.env, OWNER);
    expect((await join(owner, x.code)).ok).toBe(true);
    const record = x.env.mem.users.get('u-inst');
    if (!record) throw new Error('missing instructor');
    x.env.mem.users.set('u-inst', { ...record, role: 'TRAINEE' });
    const input = await emitAck(owner, SOCKET_EVENTS.instructorInput, jam);
    expect(input.ok).toBe(false);
    if (!input.ok) expect(input.error.code).toBe('FORBIDDEN');
  });

  it('keeps trainees on their own player room only', async () => {
    const x = await liveEnv();
    const sec = await open(x.env, 'sec@x.io');
    const ack = await join(sec, x.code);
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.playerId).toBe(x.players.sec);
    expect((await emitAck(sec, SOCKET_EVENTS.instructorInput, jam)).ok).toBe(false);
    expect((await emitAck(sec, SOCKET_EVENTS.watch, { playerId: x.players.pl })).ok).toBe(false);
    await x.env.app.manager.stepNow(x.sessionId, 2);
    await nap(150);
    expect(truthCount(sec)).toBe(0);
    expect(sec.events.some((e) => e.name === SOCKET_EVENTS.perceived)).toBe(true);
  });
});
