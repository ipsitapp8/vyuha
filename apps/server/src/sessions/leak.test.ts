import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { SOCKET_EVENTS } from '@vyuha/shared';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await closeEnv(env);
  env = undefined;
});

interface Tap {
  email: string;
  traffic: { name: string; payload: unknown }[];
}

async function tap(e: Env, email: string, code: string): Promise<Tap> {
  const address = e.app.fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  const socket = connect(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie: await e.cookie(email) },
  });
  sockets.push(socket);
  const t: Tap = { email, traffic: [] };
  socket.onAny((name: string, payload: unknown) => t.traffic.push({ name, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
  await new Promise<void>((resolve) => socket.emit(SOCKET_EVENTS.join, { code }, () => resolve()));
  return t;
}

/** Field names and ids that only exist in ground truth or in the instructor's God View. */
const FORBIDDEN = [
  'trueReliability',
  'trueCredibility',
  'subjectUnitId',
  'rngState',
  'truthSnapshot',
  'perceivedSnapshot',
  'isSpoof',
  'genuine',
  'drift',
  // hostile and neutral unit ids from the scenario file are never sent to trainees
  'r-recce',
  'r-mech',
  'r-ew',
  'r-uav',
  'r-cyber',
  'n-convoy',
];

describe('payload leak guard', () => {
  it('no trainee-bound socket event ever carries ground truth, across 300 ticks with a spoof', async () => {
    env = await makeEnv();
    await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
    const lobby = await setupLobby(env);
    const trainees = [
      await tap(env, 'pl@x.io', lobby.code),
      await tap(env, 'sec@x.io', lobby.code),
      await tap(env, 'isr@x.io', lobby.code),
    ];
    const instructor = await tap(env, 'inst@x.io', lobby.code);
    await env.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
    await env.app.manager.stepNow(lobby.sessionId, 300);
    await new Promise((r) => setTimeout(r, 400));

    for (const t of trainees) {
      expect(t.traffic.length).toBeGreaterThan(10);
      expect(t.traffic.some((x) => x.name === SOCKET_EVENTS.truth)).toBe(false);
      expect(t.traffic.some((x) => x.name === SOCKET_EVENTS.truthEvents)).toBe(false);
      const wire = JSON.stringify(t.traffic);
      for (const word of FORBIDDEN) {
        expect(wire, `${t.email} received "${word}"`).not.toContain(word);
      }
    }
    // Sanity: the guard is not vacuous. The instructor does receive truth-only material.
    const instructorWire = JSON.stringify(instructor.traffic);
    expect(instructorWire).toContain('r-recce');
  });

  it('trainees and anonymous users are refused every instructor endpoint', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    const s = lobby.sessionId;
    const endpoints: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string }[] = [
      { method: 'GET', url: '/scenarios' },
      { method: 'POST', url: '/sessions' },
      { method: 'POST', url: `/sessions/${s}/start` },
      { method: 'POST', url: `/sessions/${s}/end` },
      { method: 'POST', url: `/sessions/${s}/teams` },
      { method: 'POST', url: `/sessions/${s}/speed` },
      { method: 'POST', url: `/sessions/${s}/pause` },
      { method: 'POST', url: `/sessions/${s}/resume` },
      { method: 'GET', url: `/aar/${s}` },
      { method: 'GET', url: `/aar/${s}/snapshot?tick=0` },
      { method: 'GET', url: `/aar/${s}/export.json` },
      { method: 'GET', url: `/aar/${s}/export.csv` },
      { method: 'GET', url: `/aar/${s}/export.pdf` },
    ];
    for (const ep of endpoints) {
      const asTrainee = await env.api(ep.method, ep.url, 'pl@x.io', {});
      expect(asTrainee.status, `${ep.method} ${ep.url} as trainee`).toBe(403);
      const anon = await env.app.fastify.inject({ method: ep.method, url: ep.url, payload: {} });
      expect(anon.statusCode, `${ep.method} ${ep.url} anonymous`).toBe(401);
    }
  });
});
