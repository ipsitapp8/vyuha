import { afterEach, describe, expect, it } from 'vitest';
import { progressResponseSchema, type PublicUser } from '@vyuha/shared';
import { SILENT_RIDGE_ID } from '../seed/silentRidge';
import { closeEnv, makeEnv, type Env } from '../sessions/testenv';
import { SKILL_BY_SESSION, gradeContact } from './bots';
import { DEMO_TEAM, runDemoHistory } from './history';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const BOTS = ['Demo Bot Alpha', 'Demo Bot Bravo', 'Demo Bot Charlie'];

/** Fresh environment with three bot users, then the real 3-session history. */
async function played() {
  env = await makeEnv();
  const bots: PublicUser[] = BOTS.map((name, i) => {
    const user: PublicUser = {
      id: `bot-${i}`,
      name,
      email: `bot${i}@demo.local`,
      role: 'TRAINEE',
    };
    env?.mem.users.set(user.id, { ...user, passwordHash: 'x', isDemoBot: true });
    return user;
  });
  const results = await runDemoHistory({
    store: env.mem.sessions,
    scenarios: env.mem.deps.scenarios,
    geo: env.mem.deps.geo,
    scenarioId: SILENT_RIDGE_ID,
    bots,
  });
  return { env, bots, results };
}

const metricsOf = (e: Env, userId: string) =>
  e.mem.sessions.metrics
    .filter((m) => m.userId === userId)
    .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())
    .map(
      ({
        avgDecisionLatencyMs,
        latencyUnderJammingMs,
        brierScore,
        spoofsChallengedPct,
        reportGradingAccuracy,
      }) => ({
        avgDecisionLatencyMs,
        latencyUnderJammingMs,
        brierScore,
        spoofsChallengedPct,
        reportGradingAccuracy,
      }),
    );

describe('demo history', () => {
  it('plays three real sessions and stores one metric row per bot per session', async () => {
    const { env: e, bots, results } = await played();
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.code)).size).toBe(3);
    for (const r of results) {
      expect((await e.mem.sessions.getSession(r.sessionId))?.status).toBe('ENDED');
    }
    expect(e.mem.sessions.metrics).toHaveLength(3 * DEMO_TEAM.length);
    for (const bot of bots) expect(metricsOf(e, bot.id)).toHaveLength(3);
  }, 120_000);

  it('is deterministic: the same run twice gives identical metrics', async () => {
    const first = await played();
    const a = first.bots.map((b) => metricsOf(first.env, b.id));
    await closeEnv(env);
    env = undefined;
    const second = await played();
    const b = second.bots.map((x) => metricsOf(second.env, x.id));
    expect(b).toEqual(a);
  }, 240_000);

  it('uses only engine-computed numbers: stored rows match a recomputation from the event log', async () => {
    const { env: e, results } = await played();
    const { computeProgressMetrics } = await import('@vyuha/engine');
    const last = results[2];
    if (!last) throw new Error('no third session');
    const events = await e.mem.sessions.loadAllEvents(last.sessionId);
    const decisions = (await e.mem.sessions.listDecisions(last.sessionId)).map((d) => ({
      playerId: d.playerId,
      tick: d.tick,
      actionType: d.actionType,
      confidence: d.confidence,
      outcome: ((d.payload['outcome'] as 0 | 1 | null | undefined) ?? null) as 0 | 1 | null,
      latencyTicks: (d.payload['latencyTicks'] as number | null | undefined) ?? null,
    }));
    const players = await e.mem.sessions.listPlayers(last.sessionId);
    const recomputed = computeProgressMetrics(
      events,
      decisions,
      players.map((p) => p.id),
    );
    for (const p of players) {
      const stored = e.mem.sessions.metrics.find(
        (m) => m.sessionId === last.sessionId && m.userId === p.userId,
      );
      expect(stored?.avgDecisionLatencyMs ?? null).toEqual(recomputed[p.id]?.avgDecisionLatencyMs);
      expect(stored?.brierScore ?? null).toEqual(recomputed[p.id]?.brierScore);
      expect(stored?.spoofsChallengedPct ?? null).toEqual(recomputed[p.id]?.spoofsChallengedPct);
    }
  }, 120_000);

  it('produces a progress history the API serves, with the bots flagged', async () => {
    const { env: e, bots } = await played();
    const res = await e.api('GET', `/progress/${bots[1]?.id}`, 'inst@x.io');
    const body = progressResponseSchema.parse(res.body);
    expect(body.user).toMatchObject({ name: 'Demo Bot Bravo', isDemoBot: true });
    expect(body.sessions).toHaveLength(3);
  }, 120_000);

  it('shows the trainee learning: faster under jamming and challenging the fake order', async () => {
    const { env: e, bots } = await played();
    // The section commander complies with the fake order unchallenged at first, then always challenges it.
    const section = metricsOf(e, bots[1]?.id ?? '');
    expect(section[0]?.spoofsChallengedPct).toBe(0);
    expect(section[2]?.spoofsChallengedPct).toBe(100);
    // Everyone reacts faster, and the engine measures that, including for decisions taken under jamming.
    for (const bot of bots) {
      const m = metricsOf(e, bot.id);
      expect(m[2]?.avgDecisionLatencyMs ?? Infinity).toBeLessThan(m[0]?.avgDecisionLatencyMs ?? 0);
    }
    const pl = metricsOf(e, bots[0]?.id ?? '');
    expect(pl[0]?.latencyUnderJammingMs).not.toBeNull();
    expect(pl[2]?.latencyUnderJammingMs ?? Infinity).toBeLessThan(
      pl[0]?.latencyUnderJammingMs ?? 0,
    );
  }, 120_000);
});

describe('bot policy', () => {
  it('gets better with each session by construction of its habits, not of the scores', () => {
    const [s1, s2, s3] = SKILL_BY_SESSION;
    expect(s1?.reactTicks).toBeGreaterThan(s2?.reactTicks ?? 0);
    expect(s2?.reactTicks).toBeGreaterThan(s3?.reactTicks ?? 0);
    expect(s3?.authenticates).toBe('always');
  });

  it('grades a report only from what it can see', () => {
    const base = {
      id: 'c',
      position: { lat: 0, lon: 0 },
      type: 'RECCE',
      observedTick: 1,
      receivedTick: 2,
      source: 's',
      grade: null,
    } as const;
    expect(gradeContact({ ...base, ageTicks: 10, via: 'DIRECT' })).toEqual({
      reliability: 'B',
      credibility: 2,
    });
    expect(gradeContact({ ...base, ageTicks: 10, via: 'VHF' })).toEqual({
      reliability: 'C',
      credibility: 3,
    });
    expect(gradeContact({ ...base, ageTicks: 200, via: 'DIRECT' }).reliability).toBe('D');
  });
});
