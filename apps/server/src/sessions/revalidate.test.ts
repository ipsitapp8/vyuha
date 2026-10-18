import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS, ackSchema, joinAckSchema, type Ack } from '@vyuha/shared';
import { hashPassword } from '../auth';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

/**
 * Sockets outlive the moment they were authenticated. A trainee action is accepted only for an account
 * that still exists, is still a trainee and is still that session's player; a deleted or re-roled
 * account is disconnected. Idle sockets are re-checked on a slow timer, never per simulation tick.
 */

let env: Env | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await closeEnv(env);
  env = undefined;
});

interface Client {
  socket: Socket;
  events: string[];
  closed: Promise<void>;
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
  const events: string[] = [];
  socket.onAny((name: string) => events.push(name));
  const closed = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  return { socket, events, closed };
}

const emitAck = (c: Client, event: string, payload: unknown): Promise<Ack> =>
  new Promise((resolve) => {
    c.socket.emit(event, payload, (ack: unknown) => resolve(ackSchema.parse(ack)));
  });

const join = async (c: Client, code: string): Promise<void> => {
  const ack = await new Promise((resolve) => {
    c.socket.emit(SOCKET_EVENTS.join, { code }, (raw: unknown) =>
      resolve(joinAckSchema.parse(raw)),
    );
  });
  expect(ack).toMatchObject({ ok: true });
};

const decision = {
  type: 'DECISION',
  actionType: 'HOLD',
  confidence: 60,
  rationale: 'Holding until the picture is clearer',
} as const;

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const perceivedCount = (c: Client) => c.events.filter((n) => n === SOCKET_EVENTS.perceived).length;

async function running(opts: { socketRevalidateMs?: number } = {}) {
  const e = await makeEnv(opts);
  env = e;
  await e.app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const lobby = await setupLobby(e);
  expect((await e.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io')).status).toBe(200);
  const sec = await open(e, 'sec@x.io');
  await join(sec, lobby.code);
  return { e, ...lobby, sec };
}

const decisionsBy = (e: Env, playerId: string) =>
  e.mem.sessions.decisions.filter((d) => d.playerId === playerId).length;

describe('trainee actions re-check the account', () => {
  it('accepts an action from a trainee who is still the session’s player', async () => {
    const x = await running();
    expect((await emitAck(x.sec, SOCKET_EVENTS.action, decision)).ok).toBe(true);
    await x.e.app.manager.stepNow(x.sessionId, 1);
    expect(decisionsBy(x.e, x.players.sec)).toBe(1);
  });

  it('refuses and disconnects a trainee whose account was deleted', async () => {
    const x = await running();
    x.e.mem.users.delete('u-sec');
    const ack = await emitAck(x.sec, SOCKET_EVENTS.action, decision);
    expect(ack).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    await x.sec.closed;
    await x.e.app.manager.stepNow(x.sessionId, 2);
    expect(decisionsBy(x.e, x.players.sec)).toBe(0);
  });

  it('refuses and disconnects a trainee whose role changed', async () => {
    const x = await running();
    const record = x.e.mem.users.get('u-sec');
    if (!record) throw new Error('missing trainee');
    x.e.mem.users.set('u-sec', { ...record, role: 'INSTRUCTOR' });
    const ack = await emitAck(x.sec, SOCKET_EVENTS.action, decision);
    expect(ack).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    await x.sec.closed;
    await x.e.app.manager.stepNow(x.sessionId, 2);
    expect(decisionsBy(x.e, x.players.sec)).toBe(0);
  });

  it('still refuses (without disconnecting) an instructor socket that sends a trainee action', async () => {
    const x = await running();
    const inst = await open(x.e, 'inst@x.io');
    await join(inst, x.code);
    const ack = await emitAck(inst, SOCKET_EVENTS.action, decision);
    expect(ack).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(inst.socket.connected).toBe(true);
  });
});

describe('idle sockets', () => {
  it('drops a deleted trainee on the revalidation timer, so the pictures stop', async () => {
    const x = await running({ socketRevalidateMs: 60 });
    await x.e.app.manager.stepNow(x.sessionId, 1);
    await nap(100);
    expect(perceivedCount(x.sec)).toBeGreaterThan(0);

    x.e.mem.users.delete('u-sec');
    await x.sec.closed;
    const seen = perceivedCount(x.sec);
    await x.e.app.manager.stepNow(x.sessionId, 3);
    await nap(100);
    expect(perceivedCount(x.sec)).toBe(seen);
  });

  it('drops an instructor demoted to trainee, so the truth view stops', async () => {
    const x = await running({ socketRevalidateMs: 60 });
    const inst = await open(x.e, 'inst@x.io');
    await join(inst, x.code);
    const record = x.e.mem.users.get('u-inst');
    if (!record) throw new Error('missing instructor');
    x.e.mem.users.set('u-inst', { ...record, role: 'TRAINEE' });
    await inst.closed;
    const truth = inst.events.filter((n) => n === SOCKET_EVENTS.truth).length;
    await x.e.app.manager.stepNow(x.sessionId, 3);
    await nap(100);
    expect(inst.events.filter((n) => n === SOCKET_EVENTS.truth).length).toBe(truth);
  });

  it('never reads the account on simulation ticks', async () => {
    const x = await running(); // default 30 s timer: it cannot fire during this test
    const users = x.e.mem.deps.users;
    const original = users.findById.bind(users);
    let lookups = 0;
    users.findById = async (id) => {
      lookups += 1;
      return original(id);
    };
    await x.e.app.manager.stepNow(x.sessionId, 25);
    await nap(100);
    expect(lookups).toBe(0);
    expect(perceivedCount(x.sec)).toBeGreaterThan(0);
    // One action = one account lookup.
    expect((await emitAck(x.sec, SOCKET_EVENTS.action, decision)).ok).toBe(true);
    expect(lookups).toBe(1);
  });
});

describe('instructor access lost outside the sharing API', () => {
  const truthCount = (c: Client) => c.events.filter((n) => n === SOCKET_EVENTS.truth).length;

  async function coInstructorWatching(opts: { socketRevalidateMs?: number } = {}) {
    const x = await running(opts);
    const passwordHash = await hashPassword('Vyuha@123');
    x.e.mem.users.set('u-co', {
      id: 'u-co',
      name: 'Co',
      email: 'co@x.io',
      role: 'INSTRUCTOR',
      passwordHash,
    });
    await x.e.api('POST', `/sessions/${x.sessionId}/instructors`, 'inst@x.io', {
      email: 'co@x.io',
    });
    const co = await open(x.e, 'co@x.io');
    await join(co, x.code);
    await x.e.app.manager.stepNow(x.sessionId, 1);
    await nap(100);
    expect(truthCount(co)).toBeGreaterThan(0);
    return { ...x, co };
  }

  it('takes an idle socket out of the truth feed on the next revalidation', async () => {
    const x = await coInstructorWatching({ socketRevalidateMs: 60 });
    // Withdrawn straight in the database: the API's disconnect hook never runs.
    await x.e.mem.sessions.removeCoInstructor(x.sessionId, 'u-co');
    await nap(250);
    const seen = truthCount(x.co);
    await x.e.app.manager.stepNow(x.sessionId, 3);
    await nap(150);
    expect(truthCount(x.co)).toBe(seen);
    expect(x.co.events).toContain(SOCKET_EVENTS.error);
  });

  it('takes the socket out of the truth feed when a command is refused', async () => {
    const x = await coInstructorWatching(); // 30 s timer: only the command can notice
    x.e.mem.sessions.clearOwner(x.sessionId); // e.g. the owner's account was deleted
    const jam = { type: 'SET_JAMMING', channel: 'VHF', intensity: 0.5 };
    expect(await emitAck(x.co, SOCKET_EVENTS.instructorInput, jam)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    const seen = truthCount(x.co);
    await x.e.app.manager.stepNow(x.sessionId, 3);
    await nap(150);
    expect(truthCount(x.co)).toBe(seen);
    expect(x.co.events.filter((n) => n === SOCKET_EVENTS.perceived)).toHaveLength(0);
  });
});
