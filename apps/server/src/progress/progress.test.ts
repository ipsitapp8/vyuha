import { afterEach, describe, expect, it } from 'vitest';
import { progressResponseSchema, progressTraineesResponseSchema } from '@vyuha/shared';
import { closeEnv, makeEnv, setupLobby, type Env } from '../sessions/testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

/** Plays one session: the section commander authenticates the scripted spoof, then decides. */
async function playSession(e: Env, opts: { authenticate: boolean }) {
  const lobby = await setupLobby(e);
  await e.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
  const { manager } = e.app;
  await manager.stepNow(lobby.sessionId, 250);
  const view = await manager.perceivedFor(lobby.sessionId, lobby.players.sec);
  const order = view?.inbox.find((m) => m.requiresAuth);
  if (!order) throw new Error('the scripted spoof never reached the section commander');
  if (opts.authenticate) {
    await manager.enqueue(lobby.sessionId, lobby.players.sec, {
      type: 'AUTHENTICATE',
      messageId: order.id,
    });
    await manager.stepNow(lobby.sessionId, 20);
  }
  await manager.enqueue(lobby.sessionId, lobby.players.sec, {
    type: 'DECISION',
    actionType: opts.authenticate ? 'IGNORE_ORDER' : 'COMPLY_ORDER',
    confidence: 80,
    rationale: 'Judged on what reached me',
    basedOnMessageId: order.id,
  });
  await manager.stepNow(lobby.sessionId, 5);
  await e.api('POST', `/sessions/${lobby.sessionId}/end`, 'inst@x.io');
  return lobby;
}

const progressOf = async (e: Env, userId: string, as: string) => {
  const res = await e.api('GET', `/progress/${userId}`, as);
  return {
    status: res.status,
    body: res.status === 200 ? progressResponseSchema.parse(res.body) : res.body,
  };
};

describe('progress across sessions', () => {
  it('stores one row per trainee when a session ends, computed from the real event log', async () => {
    env = await makeEnv();
    await playSession(env, { authenticate: false });
    expect(env.mem.sessions.metrics.map((m) => m.userId).sort()).toEqual([
      'u-isr',
      'u-pl',
      'u-sec',
    ]);

    const sec = await progressOf(env, 'u-sec', 'inst@x.io');
    expect(sec.status).toBe(200);
    const only = (sec.body as ReturnType<typeof progressResponseSchema.parse>).sessions;
    expect(only).toHaveLength(1);
    const m = only[0]?.metrics;
    expect(m?.avgDecisionLatencyMs).not.toBeNull();
    expect(m?.spoofsChallengedPct).toBe(0); // received the spoof, never challenged it
    expect(m?.brierScore).not.toBeNull();

    const pl = (await progressOf(env, 'u-pl', 'inst@x.io')).body as ReturnType<
      typeof progressResponseSchema.parse
    >;
    expect(pl.sessions[0]?.metrics).toMatchObject({
      avgDecisionLatencyMs: null,
      brierScore: null,
      spoofsChallengedPct: null,
    });
  });

  it('records a challenged spoof and keeps sessions oldest first', async () => {
    env = await makeEnv();
    await playSession(env, { authenticate: false });
    env.scheduler.time += 60_000;
    await playSession(env, { authenticate: true });

    const body = (await progressOf(env, 'u-sec', 'inst@x.io')).body as ReturnType<
      typeof progressResponseSchema.parse
    >;
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.map((s) => s.metrics.spoofsChallengedPct)).toEqual([0, 100]);
    const times = body.sessions.map((s) => Date.parse(s.endedAt));
    expect(times[0]).toBeLessThanOrEqual(times[1] ?? 0);
    expect(body.user).toEqual({ id: 'u-sec', name: 'Bilal SEC', isDemoBot: false });
  });

  it('is idempotent: recording the same session twice keeps one row per trainee', async () => {
    env = await makeEnv();
    const lobby = await playSession(env, { authenticate: false });
    const { ProgressService } = await import('./service');
    await new ProgressService(env.mem.sessions, console).recordSession(lobby.sessionId);
    expect(env.mem.sessions.metrics).toHaveLength(3);
  });

  it('records nothing for a session ended from the lobby', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    await env.api('POST', `/sessions/${lobby.sessionId}/end`, 'inst@x.io');
    expect(env.mem.sessions.metrics).toHaveLength(0);
  });

  it('lets a trainee see only themself and an instructor see everyone', async () => {
    env = await makeEnv();
    await playSession(env, { authenticate: false });

    expect((await progressOf(env, 'u-sec', 'sec@x.io')).status).toBe(200);
    expect((await progressOf(env, 'u-pl', 'sec@x.io')).status).toBe(403);
    expect((await env.api('GET', '/progress/trainees', 'sec@x.io')).status).toBe(403);
    expect((await progressOf(env, 'nobody', 'inst@x.io')).status).toBe(404);
    const anon = await env.app.fastify.inject({ method: 'GET', url: '/progress/u-sec' });
    expect(anon.statusCode).toBe(401);

    const list = await env.api('GET', '/progress/trainees', 'inst@x.io');
    const trainees = progressTraineesResponseSchema.parse(list.body).trainees;
    expect(trainees.map((t) => t.id).sort()).toEqual(['u-isr', 'u-out', 'u-pl', 'u-sec']);
    expect(trainees.find((t) => t.id === 'u-sec')?.sessionCount).toBe(1);
    expect(trainees.find((t) => t.id === 'u-out')?.sessionCount).toBe(0);
  });

  it('flags demo bots in progress, the lobby and the review', async () => {
    env = await makeEnv();
    const sec = env.mem.users.get('u-sec');
    if (sec) env.mem.users.set('u-sec', { ...sec, isDemoBot: true });
    const lobby = await playSession(env, { authenticate: false });

    const body = (await progressOf(env, 'u-sec', 'inst@x.io')).body as ReturnType<
      typeof progressResponseSchema.parse
    >;
    expect(body.user.isDemoBot).toBe(true);
    const view = await env.api('GET', `/sessions/${lobby.sessionId}/lobby`, 'inst@x.io');
    const players = (view.body as { players: { userId: string; isDemoBot: boolean }[] }).players;
    expect(players.find((p) => p.userId === 'u-sec')?.isDemoBot).toBe(true);
    expect(players.find((p) => p.userId === 'u-pl')?.isDemoBot).toBe(false);
    const aar = await env.api('GET', `/aar/${lobby.sessionId}`, 'inst@x.io');
    const meta = (aar.body as { meta: { players: { name: string; isDemoBot: boolean }[] } }).meta;
    expect(meta.players.find((p) => p.name === 'Bilal SEC')?.isDemoBot).toBe(true);
  });
});
