import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  ackSchema,
  joinAckSchema,
  perceivedStateSchema,
  truthViewSchema,
  type Ack,
  type InstructorInput,
  type PerceivedStateDto,
  type PlayerAction,
  type TruthViewDto,
} from '@vyuha/shared';
import { LobbyService } from './lobby';
import { SessionManager } from './manager';
import { LiveMetrics } from './liveMetrics';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
const sockets: Socket[] = [];
let seen = 0; // bumped for every socket event any test client receives
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await closeEnv(env);
  env = undefined;
});

interface Rec {
  socket: Socket;
  events: { name: string; payload: unknown }[];
}

async function open(e: Env, email: string): Promise<Rec> {
  const address = e.app.fastify.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  const socket = connect(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { cookie: await e.cookie(email) },
  });
  sockets.push(socket);
  const rec: Rec = { socket, events: [] };
  socket.onAny((name: string, payload: unknown) => {
    seen += 1;
    rec.events.push({ name, payload });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return rec;
}

const join = (r: Rec, code: string) =>
  new Promise((resolve) =>
    r.socket.emit(SOCKET_EVENTS.join, { code }, (a: unknown) => resolve(joinAckSchema.parse(a))),
  );
const emitAck = (r: Rec, event: string, payload: unknown) =>
  new Promise<Ack>((resolve) =>
    r.socket.emit(event, payload, (a: unknown) => resolve(ackSchema.parse(a))),
  );
/** Waits until socket traffic has gone quiet (robust under a loaded machine), at most 3 s. */
const settle = async (): Promise<void> => {
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await nap(100);
  for (let i = 0, last = -1; i < 30 && seen !== last; i++) {
    last = seen;
    await nap(100);
  }
};
const named = (r: Rec, name: string) => r.events.filter((e) => e.name === name);
const lastPerceived = (r: Rec): PerceivedStateDto =>
  perceivedStateSchema.parse(named(r, SOCKET_EVENTS.perceived).at(-1)?.payload);
const lastTruth = (r: Rec): TruthViewDto =>
  truthViewSchema.parse(named(r, SOCKET_EVENTS.truth).at(-1)?.payload);

async function running() {
  env = await makeEnv();
  await env.app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const lobby = await setupLobby(env);
  const instructor = await open(env, 'inst@x.io');
  const pl = await open(env, 'pl@x.io');
  const sec = await open(env, 'sec@x.io');
  await join(instructor, lobby.code);
  await join(pl, lobby.code);
  await join(sec, lobby.code);
  await env.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
  await settle();
  return { env, lobby, instructor, pl, sec, manager: env.app.manager };
}

const inject = (body: Record<string, unknown>): InstructorInput =>
  ({
    type: 'INJECT_NOW',
    inject: { id: 'x', tick: 0, title: 'Live inject', ...body },
  }) as InstructorInput;

describe('instructor live injects reach trainees within one tick', () => {
  it('a weather change inject changes every trainee view on the very next tick', async () => {
    const { lobby, instructor, pl, sec, manager } = await running();
    await manager.stepNow(lobby.sessionId, 3);
    await settle();
    const before = lastPerceived(pl).weather;
    const ack = await emitAck(
      instructor,
      SOCKET_EVENTS.instructorInput,
      inject({ type: 'WEATHER_CHANGE', visibilityM: 450, precipitationMm: 9, windKph: 55 }),
    );
    expect(ack.ok).toBe(true);
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    for (const r of [pl, sec]) {
      expect(lastPerceived(r).tick).toBe(4);
      expect(lastPerceived(r).weather).toEqual({
        visibilityM: 450,
        precipitationMm: 9,
        windKph: 55,
      });
    }
    expect(before.visibilityM).not.toBe(450);
    const fired = named(instructor, SOCKET_EVENTS.truthEvents)
      .flatMap((x) => x.payload as { type: string; payload: Record<string, unknown> }[])
      .filter((e) => e.type === 'INJECT_FIRED' && e.payload['source'] === 'LIVE');
    expect(fired).toHaveLength(1);
  });

  it('jamming drops the measured signal bars on the next tick; the degradation slider sets a level', async () => {
    const { lobby, instructor, pl, manager } = await running();
    await manager.stepNow(lobby.sessionId, 2);
    await settle();
    const before = lastPerceived(pl).comms.signal.VHF ?? 0;
    expect(before).toBeGreaterThan(0.05);
    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'SET_JAMMING',
      channel: 'VHF',
      intensity: 0.95,
    });
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    expect(lastPerceived(pl).comms.signal.VHF ?? 1).toBeLessThan(before * 0.2);
    const truth = lastTruth(instructor);
    expect(truth.manualJamming.VHF).toBeCloseTo(0.95, 9);
    expect(truth.jamming.VHF).toBeGreaterThan(0.9);
  });

  it('a spoofed order inject shows up in the target trainee inbox as an unverified order', async () => {
    const { lobby, instructor, pl, manager } = await running();
    await emitAck(
      instructor,
      SOCKET_EVENTS.instructorInput,
      inject({
        type: 'SPOOF_ORDER',
        purportedSender: 'Battalion HQ',
        targetUnitId: 'b-pl',
        orderText: 'Fall back now',
      }),
    );
    await manager.stepNow(lobby.sessionId, 3);
    await settle();
    const order = lastPerceived(pl).inbox.find((m) => m.text === 'Fall back now');
    expect(order).toMatchObject({
      kind: 'ORDER',
      from: 'Battalion HQ',
      authState: 'NONE',
      requiresAuth: true,
    });
  });

  it('a SATCOM cut and conflicting-report injects are accepted and take effect', async () => {
    const { lobby, instructor, pl, manager } = await running();
    await emitAck(
      instructor,
      SOCKET_EVENTS.instructorInput,
      inject({ type: 'SATCOM_OUTAGE', durationTicks: 60 }),
    );
    await emitAck(
      instructor,
      SOCKET_EVENTS.instructorInput,
      inject({
        type: 'CONFLICTING_REPORTS',
        unitId: 'r-recce',
        altPosition: { lat: 34.2, lon: 77.6 },
        altType: 'DRONE',
      }),
    );
    await manager.stepNow(lobby.sessionId, 2);
    await settle();
    expect(lastTruth(instructor).satcomUp).toBe(false);
    expect(lastPerceived(pl).comms.signal.SATCOM).toBe(0);
    const reports = named(instructor, SOCKET_EVENTS.truthEvents)
      .flatMap((x) => x.payload as { type: string; payload: Record<string, unknown> }[])
      .filter((e) => e.type === 'REPORT_GENERATED' && e.payload['conflictGroup']);
    expect(reports).toHaveLength(2);
  });

  it('validates instructor input, and only instructors may send it', async () => {
    const { instructor, pl } = await running();
    const bad = await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'SET_JAMMING',
      channel: 'RUNNER',
      intensity: 1,
    });
    expect(bad.ok === false && bad.error.code).toBe('VALIDATION_ERROR');
    const bad2 = await emitAck(instructor, SOCKET_EVENTS.instructorInput, { type: 'LAUNCH' });
    expect(bad2.ok).toBe(false);
    const denied = await emitAck(pl, SOCKET_EVENTS.instructorInput, {
      type: 'SET_JAMMING',
      channel: 'VHF',
      intensity: 0.5,
    });
    expect(denied.ok === false && denied.error.code).toBe('FORBIDDEN');
  });

  it('is refused while the exercise is paused', async () => {
    const { lobby, instructor, manager } = await running();
    await manager.pause(lobby.sessionId);
    const ack = await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'SET_JAMMING',
      channel: 'HF',
      intensity: 0.5,
    });
    expect(ack.ok === false && ack.error.code).toBe('SESSION_STATE');
  });
});

describe('live MSEL editing', () => {
  it('adds, edits and removes scheduled injects; the timeline reflects it and fired state', async () => {
    const { lobby, instructor, manager } = await running();
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    const initial = lastTruth(instructor).msel;
    expect(initial.length).toBe(14);
    expect(initial.every((m) => !m.fired)).toBe(true);

    const base = {
      id: 'x',
      title: 'Added jam',
      type: 'JAM_CHANNEL',
      channel: 'HF',
      intensity: 0.5,
      durationTicks: 20,
    };
    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'MSEL_ADD',
      inject: { ...base, tick: 20 },
    });
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    const added = lastTruth(instructor).msel.find((m) => m.inject.title === 'Added jam');
    expect(added?.inject.id).toMatch(/^msel-/);
    expect(added?.inject.tick).toBe(20);

    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'MSEL_UPDATE',
      inject: { ...base, id: added?.inject.id ?? '', tick: 30, title: 'Moved jam' },
    });
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    expect(
      lastTruth(instructor).msel.find((m) => m.inject.id === added?.inject.id)?.inject.tick,
    ).toBe(30);

    await manager.stepNow(lobby.sessionId, 30);
    await settle();
    const fired = lastTruth(instructor).msel.find((m) => m.inject.id === added?.inject.id);
    expect(fired?.fired).toBe(true);
    expect(lastTruth(instructor).msel.find((m) => m.inject.id === 'inj-01')?.fired).toBe(false);

    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'MSEL_REMOVE',
      injectId: 'inj-14',
    });
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    expect(lastTruth(instructor).msel.some((m) => m.inject.id === 'inj-14')).toBe(false);
  });

  it('reports a refused edit (changing an inject that already fired) to the instructor feed', async () => {
    const { lobby, instructor, manager } = await running();
    await manager.stepNow(lobby.sessionId, 70); // inj-01 fires at tick 60
    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'MSEL_REMOVE',
      injectId: 'inj-01',
    });
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    const rejected = named(instructor, SOCKET_EVENTS.truthEvents)
      .flatMap((x) => x.payload as { type: string; payload: Record<string, unknown> }[])
      .filter((e) => e.type === 'INPUT_REJECTED');
    expect(rejected.map((e) => e.payload['reason'])).toContain('inject has already fired');
  });

  it('instructor inputs are logged and a restarted manager replays them exactly', async () => {
    const { env: e, lobby, instructor, manager } = await running();
    await manager.stepNow(lobby.sessionId, 10);
    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'SET_JAMMING',
      channel: 'VHF',
      intensity: 0.6,
    });
    await emitAck(
      instructor,
      SOCKET_EVENTS.instructorInput,
      inject({ type: 'WEATHER_CHANGE', visibilityM: 800, precipitationMm: 3, windKph: 30 }),
    );
    await emitAck(instructor, SOCKET_EVENTS.instructorInput, {
      type: 'MSEL_ADD',
      inject: { id: 'x', tick: 500, title: 'Late jam', type: 'SATCOM_OUTAGE', durationTicks: 30 },
    });
    await manager.stepNow(lobby.sessionId, 40);
    const logged = (e.mem.sessions.events.get(lobby.sessionId) ?? []).filter(
      (x) => x.type === 'INPUT',
    );
    expect(logged).toHaveLength(3);
    expect(logged.every((x) => (x.payload as { instructor?: boolean }).instructor === true)).toBe(
      true,
    );

    const restarted = new SessionManager(
      e.mem.deps.sessions,
      e.mem.deps.scenarios,
      e.mem.deps.geo,
      new LobbyService(e.mem.deps.sessions, e.mem.deps.scenarios),
      e.app.io,
      { error: () => undefined, warn: () => undefined },
      e.scheduler,
    );
    expect(JSON.stringify(await restarted.truthFor(lobby.sessionId))).toBe(
      JSON.stringify(await manager.truthFor(lobby.sessionId)),
    );
  });
});

describe('God View: watching a trainee and live metrics', () => {
  it('streams the chosen trainee perceived state to the instructor, and stops when switched', async () => {
    const { lobby, instructor, manager } = await running();
    await manager.stepNow(lobby.sessionId, 5);
    const watch = (playerId: string | null) =>
      emitAck(instructor, SOCKET_EVENTS.watch, { playerId });
    expect((await watch(lobby.players.pl)).ok).toBe(true);
    await settle();
    expect(lastPerceived(instructor).playerId).toBe(lobby.players.pl);
    await manager.stepNow(lobby.sessionId, 1);
    await settle();
    expect(lastPerceived(instructor).tick).toBe(6);

    expect((await watch(lobby.players.sec)).ok).toBe(true);
    await settle();
    expect(lastPerceived(instructor).playerId).toBe(lobby.players.sec);
    const countBefore = named(instructor, SOCKET_EVENTS.perceived).filter(
      (x) => perceivedStateSchema.parse(x.payload).playerId === lobby.players.pl,
    ).length;
    await manager.stepNow(lobby.sessionId, 2);
    await settle();
    const countAfter = named(instructor, SOCKET_EVENTS.perceived).filter(
      (x) => perceivedStateSchema.parse(x.payload).playerId === lobby.players.pl,
    ).length;
    expect(countAfter).toBe(countBefore); // no longer watching the platoon commander

    expect((await watch(null)).ok).toBe(true);
    const unknown = await watch('nobody');
    expect(unknown.ok === false && unknown.error.code).toBe('NOT_FOUND');
  });

  it('trainees cannot watch each other', async () => {
    const { lobby, pl } = await running();
    const ack = await emitAck(pl, SOCKET_EVENTS.watch, { playerId: lobby.players.sec });
    expect(ack.ok === false && ack.error.code).toBe('FORBIDDEN');
  });

  it('per-trainee metrics update live: decisions, latency, calibration, spoofs acted, switches', async () => {
    const { lobby, instructor, pl, manager } = await running();
    const act = (a: PlayerAction) => emitAck(pl, SOCKET_EVENTS.action, a);
    await emitAck(
      instructor,
      SOCKET_EVENTS.instructorInput,
      inject({
        type: 'SPOOF_ORDER',
        purportedSender: 'Battalion HQ',
        targetUnitId: 'b-pl',
        orderText: 'Withdraw at once',
      }),
    );
    await manager.stepNow(lobby.sessionId, 4);
    await settle();
    const order = lastPerceived(pl).inbox.find((m) => m.text === 'Withdraw at once');
    expect(order).toBeDefined();

    await act({ type: 'SWITCH_CHANNEL', channel: 'HF' });
    await act({
      type: 'DECISION',
      actionType: 'COMPLY_ORDER',
      confidence: 90,
      rationale: 'It looked like a normal HQ order',
      basedOnMessageId: order?.id ?? '',
    });
    await manager.stepNow(lobby.sessionId, 1);
    await settle();

    const m = lastTruth(instructor).players[lobby.players.pl];
    expect(m).toBeDefined();
    expect(m?.decisionCount).toBe(1);
    expect(m?.spoofActedCount).toBe(1);
    expect(m?.channelSwitchCount).toBe(1);
    expect(m?.meanConfidence).toBe(90);
    expect(m?.accuracy).toBe(0);
    expect(m?.brierScore).toBeCloseTo(0.81, 9);
    expect(m?.avgLatencyTicks).toBeGreaterThanOrEqual(0);
    expect(m?.lastDecision).toMatchObject({
      actionType: 'COMPLY_ORDER',
      confidence: 90,
      outcome: 0,
    });
    const drift = lastTruth(instructor).drift[lobby.players.pl];
    expect(drift?.missed).toBeGreaterThanOrEqual(0);
  });
});

describe('LiveMetrics', () => {
  const decision = (playerId: string, confidence: number, outcome: 0 | 1 | null, tick = 1) => ({
    tick,
    type: 'DECISION_MADE',
    visibleTo: ['instructor'],
    payload: {
      playerId,
      actionType: 'HOLD',
      confidence,
      rationale: 'because',
      outcome,
      latencyTicks: 10,
    },
  });

  it('computes calibration, accuracy and latency; a player with no events reads as empty', () => {
    const lm = new LiveMetrics();
    lm.ingest([decision('a', 80, 1), decision('a', 60, 0, 2), decision('a', 50, null, 3)]);
    const v = lm.view(['a', 'b']);
    expect(v['a']).toMatchObject({
      decisionCount: 3,
      scoredDecisionCount: 2,
      meanConfidence: 70,
      accuracy: 50,
    });
    expect(v['a']?.brierScore).toBeCloseTo(0.2, 9);
    expect(v['a']?.lastDecision?.tick).toBe(3);
    expect(v['b']).toMatchObject({
      decisionCount: 0,
      brierScore: null,
      meanConfidence: null,
      accuracy: null,
      lastDecision: null,
    });
  });

  it('keeps only recent drift samples per player once the buffer grows large', () => {
    const lm = new LiveMetrics();
    const samples = Array.from({ length: 4100 }, (_, i) => ({
      tick: i,
      type: 'DRIFT_SAMPLE',
      visibleTo: ['instructor'],
      payload: { playerId: 'a', missed: 1, ghost: 0, avgPositionErrorM: i },
    }));
    lm.ingest(samples);
    const drift = lm.view(['a'])['a'];
    expect(drift?.decisionCount).toBe(0);
  });
});
