import { afterEach, describe, expect, it } from 'vitest';
import {
  aarSummarySchema,
  mySaScoresResponseSchema,
  perceivedStateSchema,
  type PlayerAction,
} from '@vyuha/shared';
import { HttpError } from '../errors';
import { LobbyService } from './lobby';
import { SessionManager } from './manager';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const INST = 'inst@x.io';
const log = { error: () => undefined, warn: () => undefined };

async function frozen() {
  env = await makeEnv();
  const lobby = await setupLobby(env);
  await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
  const manager = env.app.manager;
  await manager.stepNow(lobby.sessionId, 90);
  const res = await env.api('POST', `/sessions/${lobby.sessionId}/probe`, INST);
  return { env, ...lobby, manager, res };
}

const events = (e: Env, sessionId: string) => e.mem.sessions.events.get(sessionId) ?? [];

function answerFor(probeId: string, extra: Partial<PlayerAction> = {}): PlayerAction {
  return {
    type: 'PROBE_ANSWER',
    probeId,
    contacts: [{ lat: 34.2, lon: 77.6 }],
    teammates: [],
    jammedChannel: 'VHF',
    ...extra,
  } as PlayerAction;
}

describe('Freeze and probe (SAGAT)', () => {
  it('is instructor-only, needs a running exercise, opens a probe and pauses', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    const url = `/sessions/${lobby.sessionId}/probe`;
    expect((await env.api('POST', url, INST)).status).toBe(409); // still in the lobby
    await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
    await env.app.manager.stepNow(lobby.sessionId, 10);
    expect((await env.api('POST', url, 'pl@x.io')).status).toBe(403);
    expect((await env.app.fastify.inject({ method: 'POST', url })).statusCode).toBe(401);

    const res = await env.api('POST', url, INST);
    expect(res.status).toBe(200);
    const session = await env.mem.deps.sessions.getSession(lobby.sessionId);
    expect(session?.status).toBe('PAUSED');
    expect(session?.currentTick).toBe(11); // the probe starts on one last tick
    expect(env.scheduler.timers).toHaveLength(0);
    expect((await env.api('POST', url, INST)).status).toBe(409); // already frozen

    const truth = await env.app.manager.truthFor(lobby.sessionId);
    expect(truth?.probe?.tick).toBe(11);
    expect(truth?.probe?.pending.sort()).toEqual(Object.values(lobby.players).sort());
  });

  it('shows trainees an open probe with no ground truth in it', async () => {
    const x = await frozen();
    expect(x.res.status).toBe(200);
    for (const id of Object.values(x.players)) {
      const seen = perceivedStateSchema.parse(await x.manager.perceivedFor(x.sessionId, id));
      expect(seen.probe).toMatchObject({ tick: 91 });
      expect(Object.keys(seen.probe ?? {}).sort()).toEqual(['expiresAtTick', 'id', 'tick']);
    }
    const toTrainees = events(x.env, x.sessionId).filter(
      (e) => e.type.startsWith('PROBE_') && e.visibleTo.some((v) => v !== 'instructor'),
    );
    expect(toTrainees.map((e) => e.type)).toEqual(['PROBE_STARTED']);
    expect(JSON.stringify(toTrainees)).not.toMatch(/r-recce|r-mech|hostiles|jammedChannel/);
  });

  it('takes answers while frozen, once per trainee, and refuses every other action', async () => {
    const x = await frozen();
    const probeId = (await x.manager.truthFor(x.sessionId))?.probe?.id ?? '';
    await x.manager.enqueue(x.sessionId, x.players.sec, answerFor(probeId));
    await expect(
      x.manager.enqueue(x.sessionId, x.players.sec, answerFor(probeId)),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      x.manager.enqueue(x.sessionId, x.players.pl, answerFor('probe-unknown')),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(
      x.manager.enqueue(x.sessionId, x.players.pl, { type: 'SWITCH_CHANNEL', channel: 'HF' }),
    ).rejects.toBeInstanceOf(HttpError);
    // nothing is scored until the clock runs again
    expect(events(x.env, x.sessionId).some((e) => e.type === 'PROBE_SCORED')).toBe(false);
  });

  it('scores on resume for the instructor only; trainees never see a score during the exercise', async () => {
    const x = await frozen();
    const probeId = (await x.manager.truthFor(x.sessionId))?.probe?.id ?? '';
    await x.manager.enqueue(x.sessionId, x.players.sec, answerFor(probeId));
    await x.env.api('POST', `/sessions/${x.sessionId}/resume`, INST);
    await x.manager.stepNow(x.sessionId, 1);

    const log2 = events(x.env, x.sessionId);
    const scored = log2.filter((e) => e.type === 'PROBE_SCORED');
    expect(scored).toHaveLength(1);
    expect(scored[0]?.visibleTo).toEqual(['instructor']);
    expect(scored[0]?.payload['playerId']).toBe(x.players.sec);
    const forSec = log2.filter((e) => e.visibleTo.includes(x.players.sec));
    expect(forSec.map((e) => e.type)).toContain('PROBE_ANSWERED');
    expect(JSON.stringify(forSec)).not.toMatch(/"score"|missedUnitIds|"truth"/);

    expect((await x.manager.perceivedFor(x.sessionId, x.players.sec))?.probe).toBeNull();
    expect((await x.manager.perceivedFor(x.sessionId, x.players.pl))?.probe?.id).toBe(probeId);
    const truth = await x.manager.truthFor(x.sessionId);
    expect(truth?.players[x.players.sec]?.probeCount).toBe(1);
    expect(truth?.players[x.players.sec]?.lastSaScore).toEqual(expect.any(Number));
    expect(truth?.probe?.pending).not.toContain(x.players.sec);

    // the late trainees score zero once the answer window closes
    await x.manager.stepNow(x.sessionId, 40);
    expect(events(x.env, x.sessionId).filter((e) => e.type === 'PROBE_SCORED')).toHaveLength(3);
    expect((await x.manager.truthFor(x.sessionId))?.probe).toBeNull();
  });

  it('a restarted server rebuilds the open probe and its queued scores exactly', async () => {
    const x = await frozen();
    const probeId = (await x.manager.truthFor(x.sessionId))?.probe?.id ?? '';
    await x.manager.enqueue(x.sessionId, x.players.sec, answerFor(probeId));
    await x.env.api('POST', `/sessions/${x.sessionId}/resume`, INST);
    await x.manager.stepNow(x.sessionId, 5);
    const restarted = new SessionManager(
      x.env.mem.deps.sessions,
      x.env.mem.deps.scenarios,
      x.env.mem.deps.geo,
      new LobbyService(x.env.mem.deps.sessions, x.env.mem.deps.scenarios),
      x.env.app.io,
      log,
      x.env.scheduler,
    );
    expect(JSON.stringify(await restarted.truthFor(x.sessionId))).toBe(
      JSON.stringify(await x.manager.truthFor(x.sessionId)),
    );
  });

  it('ending while frozen scores the answers given and zeroes the rest; the review and exports carry them', async () => {
    const x = await frozen();
    const probeId = (await x.manager.truthFor(x.sessionId))?.probe?.id ?? '';
    await x.manager.enqueue(x.sessionId, x.players.sec, answerFor(probeId));

    // not available to anyone before the end
    expect((await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, 'sec@x.io')).status).toBe(409);
    await x.env.api('POST', `/sessions/${x.sessionId}/end`, INST);

    const summary = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    expect(summary.analysis.probes).toHaveLength(1);
    const probe = summary.analysis.probes[0];
    expect(probe?.tick).toBe(91);
    expect(probe?.results.map((r) => [r.playerId, r.answered]).sort()).toEqual(
      [
        [x.players.pl, false],
        [x.players.sec, true],
        [x.players.isr, false],
      ].sort(),
    );
    const sec = probe?.results.find((r) => r.playerId === x.players.sec);
    expect(sec?.answer?.contacts).toEqual([{ lat: 34.2, lon: 77.6 }]);
    expect(sec?.truth.hostiles.length).toBeGreaterThan(0);
    const secSummary = summary.analysis.players.find((p) => p.playerId === x.players.sec);
    expect(secSummary?.probeCount).toBe(1);
    expect(secSummary?.saScore).toBe(sec?.score);

    // CSV: the decisions table, then the situation-awareness table
    const csv = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.csv`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    expect(csv.body).toContain('sa_score');
    expect(csv.body.split('\r\n').filter((l) => l.includes(',01:31,'))).toHaveLength(3);

    const json = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.json`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    const body = json.json() as { situationAwareness: { probes: unknown[]; scores: unknown[] } };
    expect(body.situationAwareness.probes).toHaveLength(1);
    expect(body.situationAwareness.scores).toHaveLength(3);

    // PDF: renders with the probe section on the trainee pages
    const pdf = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.pdf`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // progress: the sixth metric
    const metric = x.env.mem.sessions.metrics.find((m) => m.userId === 'u-sec');
    expect(metric?.saScore).toBe(sec?.score);
    expect(x.env.mem.sessions.metrics.find((m) => m.userId === 'u-pl')?.saScore).toBe(0);
  });

  it('after the end a trainee sees their own scores only, with no ground truth', async () => {
    const x = await frozen();
    const probeId = (await x.manager.truthFor(x.sessionId))?.probe?.id ?? '';
    await x.manager.enqueue(x.sessionId, x.players.sec, answerFor(probeId));
    await x.env.api('POST', `/sessions/${x.sessionId}/end`, INST);

    const mine = await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, 'sec@x.io');
    expect(mine.status).toBe(200);
    const parsed = mySaScoresResponseSchema.parse(mine.body);
    expect(parsed.probes).toHaveLength(1);
    expect(parsed.probes[0]?.answered).toBe(true);
    expect(parsed.saScore).toBe(parsed.probes[0]?.score);
    expect(JSON.stringify(mine.body)).not.toMatch(/r-recce|r-mech|position|hostiles|"lat"/);

    expect((await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, 'out@x.io')).status).toBe(403);
    expect((await x.env.api('GET', `/aar/${x.sessionId}/my-sa`, INST)).status).toBe(403);
    expect((await x.env.api('GET', '/aar/nope/my-sa', 'sec@x.io')).status).toBe(404);
    // the full review stays instructor-only
    expect((await x.env.api('GET', `/aar/${x.sessionId}`, 'sec@x.io')).status).toBe(403);
  });

  it('rejects malformed answers on the socket contract', async () => {
    const { playerActionSchema } = await import('@vyuha/shared');
    const ok = {
      type: 'PROBE_ANSWER',
      probeId: 'p',
      contacts: [],
      teammates: [],
      jammedChannel: 'NONE',
    };
    expect(playerActionSchema.safeParse(ok).success).toBe(true);
    const bad = [
      { ...ok, jammedChannel: 'WIFI' },
      { ...ok, contacts: [{ lat: 120, lon: 0 }] },
      { ...ok, contacts: Array.from({ length: 21 }, () => ({ lat: 1, lon: 1 })) },
      {
        ...ok,
        teammates: [
          { unitId: 'b-pl', position: { lat: 1, lon: 1 } },
          { unitId: 'b-pl', position: { lat: 2, lon: 2 } },
        ],
      },
      { ...ok, probeId: '' },
    ];
    for (const b of bad) expect(playerActionSchema.safeParse(b).success).toBe(false);
  });
});
