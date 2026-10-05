import { afterEach, describe, expect, it } from 'vitest';
import {
  aarCompareSchema,
  aarSummarySchema,
  lobbyViewSchema,
  sessionListResponseSchema,
  type LobbyView,
} from '@vyuha/shared';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const INST = 'inst@x.io';
const events = (e: Env, sessionId: string) => e.mem.sessions.events.get(sessionId) ?? [];

/** Plays a session to tick 300 with one decision by the section commander, then ends it. */
async function play(e: Env, sessionId: string, secPlayerId: string): Promise<void> {
  await e.api('POST', `/sessions/${sessionId}/start`, INST);
  const m = e.app.manager;
  await m.stepNow(sessionId, 250);
  const seen = await m.perceivedFor(sessionId, secPlayerId);
  const contact = seen?.contacts[0];
  await m.enqueue(sessionId, secPlayerId, {
    type: 'DECISION',
    actionType: contact ? 'REPORT_UP' : 'HOLD',
    confidence: 70,
    rationale: 'Deciding on what has reached me so far',
    ...(contact ? { targetContactId: contact.id } : {}),
  });
  await m.stepNow(sessionId, 50);
  await e.api('POST', `/sessions/${sessionId}/end`, INST);
}

async function degradedDone() {
  env = await makeEnv();
  const lobby = await setupLobby(env);
  await play(env, lobby.sessionId, lobby.players.sec);
  return { env, ...lobby };
}

/** Joins the same three trainees to the baseline and assigns them as before. */
async function joinTwin(e: Env, twin: LobbyView): Promise<Record<'pl' | 'sec' | 'isr', string>> {
  const teamId = twin.teams[0]?.id ?? '';
  const out: Record<string, string> = {};
  for (const [key, email, role, unitId] of [
    ['pl', 'pl@x.io', 'PL_CDR', 'b-pl'],
    ['sec', 'sec@x.io', 'SECTION_CDR', 'b-sec1'],
    ['isr', 'isr@x.io', 'ISR_OPERATOR', 'b-uav'],
  ] as const) {
    const j = await e.api('POST', '/sessions/join', email, { code: twin.session.code });
    const playerId = (j.body as { playerId: string }).playerId;
    out[key] = playerId;
    await e.api('PUT', `/sessions/${twin.session.id}/players/${playerId}`, INST, {
      teamId,
      role,
      unitId,
    });
  }
  return { pl: out['pl'] ?? '', sec: out['sec'] ?? '', isr: out['isr'] ?? '' };
}

describe('baseline twin of a finished session', () => {
  it('is instructor-only and needs a session that was played and ended', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    const url = `/sessions/${lobby.sessionId}/baseline`;
    expect((await env.api('POST', url, INST)).status).toBe(409); // still in the lobby
    expect((await env.api('POST', url, 'pl@x.io')).status).toBe(403);
    expect((await env.app.fastify.inject({ method: 'POST', url })).statusCode).toBe(401);
    await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
    expect((await env.api('POST', url, INST)).status).toBe(409); // running
    expect((await env.api('POST', '/sessions/nope/baseline', INST)).status).toBe(404);
  });

  it('creates a new lobby: same scenario, teams and PACE plans, flagged clean and linked', async () => {
    const x = await degradedDone();
    const res = await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, INST);
    expect(res.status).toBe(201);
    const twin = lobbyViewSchema.parse(res.body);
    expect(twin.session.clean).toBe(true);
    expect(twin.session.baselineOfId).toBe(x.sessionId);
    expect(twin.session.status).toBe('LOBBY');
    expect(twin.session.code).not.toBe(x.code);
    expect(twin.session.scenarioId).toBe('scenario-op-silent-ridge');
    expect(twin.teams.map((t) => t.name)).toEqual(['Alpha']);
    expect(twin.players).toEqual([]);

    const list = sessionListResponseSchema.parse((await x.env.api('GET', '/sessions', INST)).body);
    expect(list.sessions.find((s) => s.id === twin.session.id)).toMatchObject({
      clean: true,
      baselineOfId: x.sessionId,
    });
    // a baseline of a baseline makes no sense
    await x.env.api('POST', `/sessions/${twin.session.id}/end`, INST);
    expect((await x.env.api('POST', `/sessions/${twin.session.id}/baseline`, INST)).status).toBe(
      409,
    );
  });

  it('runs with the same seed and no degradation: nothing jammed, spoofed, dropped or delayed', async () => {
    const x = await degradedDone();
    const twin = lobbyViewSchema.parse(
      (await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, INST)).body,
    );
    const players = await joinTwin(x.env, twin);
    await play(x.env, twin.session.id, players.sec);

    const startedOf = (id: string) =>
      events(x.env, id).find((e) => e.type === 'SESSION_STARTED')?.payload as {
        seed: number;
        clean?: boolean;
      };
    expect(startedOf(twin.session.id).seed).toBe(startedOf(x.sessionId).seed);
    expect(startedOf(twin.session.id).clean).toBe(true);
    expect(startedOf(x.sessionId).clean).toBe(false);

    const clean = events(x.env, twin.session.id);
    const outcomes = clean.filter((e) => e.type === 'MESSAGE_OUTCOME');
    expect(outcomes.length).toBeGreaterThan(20);
    expect(new Set(outcomes.map((e) => e.payload['outcome']))).toEqual(new Set(['DELIVERED']));
    expect(clean.some((e) => e.type === 'SPOOF_INJECTED')).toBe(false);
    expect(clean.some((e) => e.type === 'JAMMING_CHANGED')).toBe(false);
    expect(clean.filter((e) => e.type === 'INJECT_SKIPPED').length).toBeGreaterThan(2);
    // while the degraded run really was degraded
    const degraded = events(x.env, x.sessionId);
    expect(degraded.some((e) => e.type === 'SPOOF_INJECTED')).toBe(true);
    expect(
      degraded.some((e) => e.type === 'MESSAGE_OUTCOME' && e.payload['outcome'] !== 'DELIVERED'),
    ).toBe(true);

    // the baseline is for comparison: it adds no row to the progress record
    expect(x.env.mem.sessions.metrics.filter((m) => m.sessionId === twin.session.id)).toEqual([]);
    expect(x.env.mem.sessions.metrics.filter((m) => m.sessionId === x.sessionId)).toHaveLength(3);
  });

  it('compares the two runs side by side for the trainees who played both', async () => {
    const x = await degradedDone();
    const url = `/aar/${x.sessionId}/compare`;
    expect((await x.env.api('GET', url, INST)).status).toBe(404); // no baseline yet

    const twin = lobbyViewSchema.parse(
      (await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, INST)).body,
    );
    expect((await x.env.api('GET', url, INST)).status).toBe(409); // baseline not played yet
    const before = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    expect(before.meta.twin).toEqual({
      sessionId: twin.session.id,
      code: twin.session.code,
      status: 'LOBBY',
    });

    const players = await joinTwin(x.env, twin);
    await play(x.env, twin.session.id, players.sec);

    const cmp = aarCompareSchema.parse((await x.env.api('GET', url, INST)).body);
    expect(cmp.degraded.sessionId).toBe(x.sessionId);
    expect(cmp.baseline.sessionId).toBe(twin.session.id);
    expect(cmp.trainees.map((t) => t.userId).sort()).toEqual(['u-isr', 'u-pl', 'u-sec']);
    const sec = cmp.trainees.find((t) => t.userId === 'u-sec');
    expect(sec?.degradedPlayerId).toBe(x.players.sec);
    expect(sec?.baselinePlayerId).toBe(players.sec);
    expect(cmp.degraded.decisions.filter((d) => d.playerId === x.players.sec)).toHaveLength(1);
    expect(cmp.baseline.decisions.filter((d) => d.playerId === players.sec)).toHaveLength(1);
    expect(cmp.degraded.drift[x.players.sec]?.length).toBeGreaterThan(10);
    expect(cmp.baseline.drift[players.sec]?.length).toBeGreaterThan(10);
    // asking from the baseline's side gives the same pair, the same way round
    const fromTwin = aarCompareSchema.parse(
      (await x.env.api('GET', `/aar/${twin.session.id}/compare`, INST)).body,
    );
    expect(fromTwin.degraded.sessionId).toBe(x.sessionId);
    expect(fromTwin.baseline.sessionId).toBe(twin.session.id);

    const after = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${twin.session.id}`, INST)).body,
    );
    expect(after.meta.clean).toBe(true);
    expect(after.meta.twin?.sessionId).toBe(x.sessionId);
    expect((await x.env.api('GET', url, 'sec@x.io')).status).toBe(403);
  });

  it('a trainee who only played one of the two runs is left out of the comparison', async () => {
    const x = await degradedDone();
    const twin = lobbyViewSchema.parse(
      (await x.env.api('POST', `/sessions/${x.sessionId}/baseline`, INST)).body,
    );
    const teamId = twin.teams[0]?.id ?? '';
    const j = await x.env.api('POST', '/sessions/join', 'pl@x.io', { code: twin.session.code });
    const playerId = (j.body as { playerId: string }).playerId;
    await x.env.api('PUT', `/sessions/${twin.session.id}/players/${playerId}`, INST, {
      teamId,
      role: 'PL_CDR',
      unitId: 'b-pl',
    });
    await x.env.api('POST', `/sessions/${twin.session.id}/start`, INST);
    await x.env.app.manager.stepNow(twin.session.id, 60);
    await x.env.api('POST', `/sessions/${twin.session.id}/end`, INST);
    const cmp = aarCompareSchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}/compare`, INST)).body,
    );
    expect(cmp.trainees.map((t) => t.userId)).toEqual(['u-pl']);
    expect(cmp.degraded.players).toHaveLength(3);
    expect(cmp.baseline.players).toHaveLength(1);
  });
});
