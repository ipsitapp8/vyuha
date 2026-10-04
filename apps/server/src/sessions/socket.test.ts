import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  ackSchema,
  joinAckSchema,
  lobbyViewSchema,
  perceivedStateSchema,
  truthViewSchema,
  type JoinAck,
  type LobbyView,
  type PerceivedStateDto,
} from '@vyuha/shared';
import { RateLimiter, readCookie } from './socket';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await closeEnv(env);
  env = undefined;
});

interface Recorded {
  socket: Socket;
  events: { name: string; payload: unknown }[];
}

async function open(e: Env, email: string | null): Promise<Recorded> {
  const address = e.app.fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  const socket = connect(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
    ...(email ? { extraHeaders: { cookie: await e.cookie(email) } } : {}),
  });
  sockets.push(socket);
  const rec: Recorded = { socket, events: [] };
  socket.onAny((name: string, payload: unknown) => rec.events.push({ name, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  return rec;
}

const joinSession = (rec: Recorded, code: string): Promise<JoinAck> =>
  new Promise((resolve) => {
    rec.socket.emit(SOCKET_EVENTS.join, { code }, (ack: unknown) =>
      resolve(joinAckSchema.parse(ack)),
    );
  });

const act = (rec: Recorded, action: unknown) =>
  new Promise<ReturnType<typeof ackSchema.parse>>((resolve) => {
    rec.socket.emit(SOCKET_EVENTS.action, action, (ack: unknown) => resolve(ackSchema.parse(ack)));
  });

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));
const named = (rec: Recorded, name: string) => rec.events.filter((x) => x.name === name);
const lastPerceived = (rec: Recorded): PerceivedStateDto => {
  const last = named(rec, SOCKET_EVENTS.perceived).at(-1);
  if (!last) throw new Error('no perceived state received');
  return perceivedStateSchema.parse(last.payload);
};

async function runningSession() {
  env = await makeEnv();
  await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const lobby = await setupLobby(env);
  const instructor = await open(env, 'inst@x.io');
  const pl = await open(env, 'pl@x.io');
  const sec = await open(env, 'sec@x.io');
  const isr = await open(env, 'isr@x.io');
  for (const r of [instructor, pl, sec, isr])
    expect((await joinSession(r, lobby.code)).ok).toBe(true);
  await env.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
  await settle();
  return { env, lobby, instructor, pl, sec, isr };
}

describe('socket authentication and joining', () => {
  it('refuses sockets without a valid auth cookie', async () => {
    env = await makeEnv();
    await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    await expect(open(env, null)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('parses the auth cookie out of a cookie header', () => {
    expect(readCookie('a=1; vyuha_token=abc%20d; b=2', 'vyuha_token')).toBe('abc d');
    expect(readCookie('a=1', 'vyuha_token')).toBeUndefined();
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('x=%E0%A4%A', 'x')).toBeUndefined();
  });

  it('only joined trainees and instructors may join; bad codes get typed errors', async () => {
    env = await makeEnv();
    await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const lobby = await setupLobby(env);
    const outsider = await open(env, 'out@x.io');
    const denied = await joinSession(outsider, lobby.code);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('NOT_IN_SESSION');
    const missing = await joinSession(outsider, 'ZZZZZZ');
    if (!missing.ok) expect(missing.error.code).toBe('SESSION_NOT_FOUND');
    const bad = await new Promise<JoinAck>((resolve) =>
      outsider.socket.emit(SOCKET_EVENTS.join, { code: 'x' }, (a: unknown) =>
        resolve(joinAckSchema.parse(a)),
      ),
    );
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION_ERROR');
    expect(named(outsider, SOCKET_EVENTS.error).length).toBeGreaterThan(0);
  });

  it('sends the lobby on join and pushes live lobby updates to everyone in the room', async () => {
    env = await makeEnv();
    await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const lobby = await setupLobby(env);
    const pl = await open(env, 'pl@x.io');
    const ack = await joinSession(pl, lobby.code);
    expect(ack.ok && ack.role === 'TRAINEE' && ack.playerId === lobby.players.pl).toBe(true);
    await settle();
    expect(
      lobbyViewSchema.parse(named(pl, SOCKET_EVENTS.lobbyUpdate)[0]?.payload).players,
    ).toHaveLength(3);
    await env.api('POST', `/sessions/${lobby.sessionId}/teams`, 'inst@x.io', { name: 'Bravo' });
    await settle();
    const latest = named(pl, SOCKET_EVENTS.lobbyUpdate).at(-1)?.payload as LobbyView;
    expect(latest.teams.map((t) => t.name)).toEqual(['Alpha', 'Bravo']);
  });
});

describe('live multiplayer over sockets', () => {
  it('trainees see different pictures, only the instructor receives truth', async () => {
    const { env: e, lobby, instructor, pl, sec, isr } = await runningSession();
    await e.app.manager.stepNow(lobby.sessionId, 240);
    await settle();

    const views = [pl, sec, isr].map(lastPerceived);
    expect(views.map((v) => v.self.unitId)).toEqual(['b-pl', 'b-sec1', 'b-uav']);
    expect(views.every((v) => v.tick === 240)).toBe(true);
    const sig = (v: PerceivedStateDto): string =>
      JSON.stringify(v.contacts.map((c) => [c.id, c.receivedTick]));
    expect(new Set(views.map(sig)).size).toBeGreaterThan(1);

    // Each trainee only ever got their own perceived state, and never a truth event.
    for (const rec of [pl, sec, isr]) {
      const own = named(rec, SOCKET_EVENTS.perceived).map(
        (x) => perceivedStateSchema.parse(x.payload).playerId,
      );
      expect(new Set(own).size).toBe(1);
      expect(named(rec, SOCKET_EVENTS.truth)).toHaveLength(0);
      expect(named(rec, SOCKET_EVENTS.truthEvents)).toHaveLength(0);
      expect(JSON.stringify(rec.events)).not.toMatch(
        /r-recce|trueReliability|"ghost"|subjectUnitId/,
      );
    }

    const truth = truthViewSchema.parse(named(instructor, SOCKET_EVENTS.truth).at(-1)?.payload);
    expect(truth.tick).toBe(240);
    expect(truth.units.some((u) => u.id === 'r-recce')).toBe(true);
    expect(Object.keys(truth.drift)).toHaveLength(3);
    expect(named(instructor, SOCKET_EVENTS.perceived)).toHaveLength(0);
    expect(named(instructor, SOCKET_EVENTS.truthEvents).length).toBeGreaterThan(0);
  });

  it('messages travel through terrain/jamming: outcomes are recorded and delivery follows them', async () => {
    const { env: e, lobby, instructor, pl, sec } = await runningSession();
    for (let i = 0; i < 12; i++) {
      const ack = await act(sec, {
        type: 'SEND_MESSAGE',
        toPlayerId: lobby.players.pl,
        channel: 'VHF',
        text: `Contact report grid 12${i} 45${i}`,
      });
      expect(ack.ok).toBe(true);
      await e.app.manager.stepNow(lobby.sessionId, 1);
    }
    await e.app.manager.stepNow(lobby.sessionId, 150);
    await settle();

    const outcomes = named(instructor, SOCKET_EVENTS.truthEvents)
      .flatMap((x) => x.payload as { type: string; payload: Record<string, unknown> }[])
      .filter((ev) => ev.type === 'MESSAGE_OUTCOME' && ev.payload['kind'] === 'TEXT');
    expect(outcomes).toHaveLength(12);
    const survived = outcomes.filter((o) => o.payload['outcome'] !== 'DROPPED').length;
    const received = lastPerceived(pl).inbox.filter((m) => m.kind === 'TEXT');
    expect(received).toHaveLength(survived);
    const sent = named(sec, SOCKET_EVENTS.playerEvents).flatMap(
      (x) => x.payload as { type: string }[],
    );
    expect(sent.filter((x) => x.type === 'MESSAGE_SENT')).toHaveLength(12);
  });

  it('validates actions with Zod and rejects the unauthorised, with typed errors', async () => {
    const { lobby, instructor, pl } = await runningSession();
    const bad = await act(pl, {
      type: 'SEND_MESSAGE',
      toPlayerId: lobby.players.sec,
      channel: 'CARRIER_PIGEON',
      text: 'x',
    });
    expect(bad.ok === false && bad.error.code).toBe('VALIDATION_ERROR');
    const shortRationale = await act(pl, {
      type: 'DECISION',
      actionType: 'HOLD',
      confidence: 50,
      rationale: 'short',
    });
    expect(shortRationale.ok === false && shortRationale.error.message).toContain('Rationale');
    const confidence = await act(pl, {
      type: 'DECISION',
      actionType: 'HOLD',
      confidence: 150,
      rationale: 'long enough rationale',
    });
    expect(confidence.ok).toBe(false);
    const unknown = await act(pl, { type: 'LAUNCH_NUKES' });
    expect(unknown.ok).toBe(false);
    const asInstructor = await act(instructor, { type: 'SWITCH_CHANNEL', channel: 'HF' });
    expect(asInstructor.ok === false && asInstructor.error.code).toBe('FORBIDDEN');
    const fresh = await open(env!, 'pl@x.io');
    const notJoined = await act(fresh, { type: 'SWITCH_CHANNEL', channel: 'HF' });
    expect(notJoined.ok === false && notJoined.error.code).toBe('NOT_IN_SESSION');
  });

  it('applies accepted actions on the next tick and tells the player when the engine refuses one', async () => {
    const { env: e, lobby, pl } = await runningSession();
    expect((await act(pl, { type: 'SWITCH_CHANNEL', channel: 'HF' })).ok).toBe(true);
    expect((await act(pl, { type: 'REQUEST_ISR', target: { lat: 34.2, lon: 77.6 } })).ok).toBe(
      true,
    );
    await e.app.manager.stepNow(lobby.sessionId, 1);
    await settle();
    expect(lastPerceived(pl).comms.activeChannel).toBe('HF');
    const refused = named(pl, SOCKET_EVENTS.playerEvents)
      .flatMap((x) => x.payload as { type: string }[])
      .filter((x) => x.type === 'INPUT_REJECTED' || x.type === 'ISR_REQUESTED');
    expect(refused.length).toBeGreaterThan(0);
  });

  it('rate-limits a flooding player without affecting others', async () => {
    env = await makeEnv({ limiter: new RateLimiter(3, 0) });
    await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const lobby = await setupLobby(env);
    const pl = await open(env, 'pl@x.io');
    const sec = await open(env, 'sec@x.io');
    await joinSession(pl, lobby.code); // join has its own bucket
    await joinSession(sec, lobby.code);
    await env.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await act(pl, { type: 'SWITCH_CHANNEL', channel: i % 2 ? 'VHF' : 'HF' }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    const limited = results[3];
    expect(limited?.ok === false && limited.error.code).toBe('RATE_LIMITED');
    expect((await act(sec, { type: 'SWITCH_CHANNEL', channel: 'HF' })).ok).toBe(true);
  });

  it('a trainee who refreshes rejoins and immediately gets the current picture', async () => {
    const { env: e, lobby, pl } = await runningSession();
    await e.app.manager.stepNow(lobby.sessionId, 90);
    await settle();
    const before = lastPerceived(pl);
    pl.socket.disconnect();

    const again = await open(e, 'pl@x.io');
    expect((await joinSession(again, lobby.code)).ok).toBe(true);
    await settle();
    const after = lastPerceived(again);
    expect(after.tick).toBe(90);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(named(again, SOCKET_EVENTS.status).at(-1)?.payload).toMatchObject({
      status: 'RUNNING',
      tick: 90,
    });
  });

  it('a late-connecting instructor gets the current truth; ended sessions only report status', async () => {
    const { env: e, lobby } = await runningSession();
    await e.app.manager.stepNow(lobby.sessionId, 20);
    const late = await open(e, 'inst@x.io');
    await joinSession(late, lobby.code);
    await settle();
    expect(truthViewSchema.parse(named(late, SOCKET_EVENTS.truth)[0]?.payload).tick).toBe(20);

    await e.api('POST', `/sessions/${lobby.sessionId}/end`, 'inst@x.io');
    const afterEnd = await open(e, 'pl@x.io');
    expect((await joinSession(afterEnd, lobby.code)).ok).toBe(true);
    await settle();
    expect(named(afterEnd, SOCKET_EVENTS.perceived)).toHaveLength(0);
    expect(named(afterEnd, SOCKET_EVENTS.status).at(-1)?.payload).toMatchObject({
      status: 'ENDED',
    });
  });
});
