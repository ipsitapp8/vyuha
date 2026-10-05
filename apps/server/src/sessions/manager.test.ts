import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerAction } from '@vyuha/shared';
import { HttpError } from '../errors';
import { LobbyService } from './lobby';
import { SessionManager } from './manager';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const log = { error: () => undefined, warn: () => undefined };

async function started(speedPatch?: 1 | 2 | 4) {
  env = await makeEnv();
  const lobby = await setupLobby(env);
  if (speedPatch)
    await env.api('POST', `/sessions/${lobby.sessionId}/speed`, 'inst@x.io', { speed: speedPatch });
  await env.api('POST', `/sessions/${lobby.sessionId}/start`, 'inst@x.io');
  return { env, ...lobby, manager: env.app.manager };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const events = (e: Env, sessionId: string) => e.mem.sessions.events.get(sessionId) ?? [];

describe('SessionManager: running an exercise', () => {
  it('persists SESSION_STARTED, advances ticks, and records the tick atomically with its events', async () => {
    const { env: e, sessionId, manager } = await started();
    expect(events(e, sessionId)[0]?.type).toBe('SESSION_STARTED');
    await manager.stepNow(sessionId, 30);
    const session = await e.mem.deps.sessions.getSession(sessionId);
    expect(session?.currentTick).toBe(30);
    expect(events(e, sessionId).some((x) => x.type === 'DRIFT_SAMPLE')).toBe(true);
    expect(events(e, sessionId).every((x) => x.tick >= 0 && x.tick <= 30)).toBe(true);
  });

  it('speed multiplies ticks per loop iteration', async () => {
    const { env: e, sessionId, manager } = await started(4);
    await manager.stepNow(sessionId, 3);
    expect((await e.mem.deps.sessions.getSession(sessionId))?.currentTick).toBe(12);
  });

  it('gives each trainee a different, degraded picture; the instructor sees truth', async () => {
    const { sessionId, players, manager } = await started();
    await manager.stepNow(sessionId, 240);
    const pl = await manager.perceivedFor(sessionId, players.pl);
    const sec = await manager.perceivedFor(sessionId, players.sec);
    const isr = await manager.perceivedFor(sessionId, players.isr);
    if (!pl || !sec || !isr) throw new Error('missing perceived state');
    const sig = (p: typeof pl): string =>
      JSON.stringify(p.contacts.map((c) => [c.id, c.receivedTick, c.via]));
    expect(new Set([sig(pl), sig(sec), sig(isr)]).size).toBeGreaterThan(1);
    expect(isr.contacts.some((c) => c.via === 'DIRECT')).toBe(true);
    expect(pl.self.unitId).toBe('b-pl');
    expect(sec.self.unitId).toBe('b-sec1');
    const truth = await manager.truthFor(sessionId);
    expect(truth?.units.some((u) => u.side === 'RED')).toBe(true);
    expect(JSON.stringify(pl)).not.toContain('r-recce');
    expect(await manager.perceivedFor(sessionId, 'nobody')).toBeNull();
  });

  it('logs inputs with their tick and persists decisions and report grades', async () => {
    const { env: e, sessionId, players, manager } = await started();
    await manager.stepNow(sessionId, 200);
    const isr = await manager.perceivedFor(sessionId, players.isr);
    const contact = isr?.contacts[0];
    expect(contact).toBeDefined();
    await manager.enqueue(sessionId, players.isr, {
      type: 'GRADE_REPORT',
      reportId: contact?.id ?? '',
      reliability: 'B',
      credibility: 2,
    });
    await manager.enqueue(sessionId, players.isr, {
      type: 'DECISION',
      actionType: 'HOLD',
      confidence: 70,
      rationale: 'Holding until the picture is clearer',
    });
    await manager.stepNow(sessionId, 1);
    const logged = events(e, sessionId).filter((x) => x.type === 'INPUT');
    expect(logged).toHaveLength(2);
    expect(logged.every((x) => x.tick === 201 && x.visibleTo.join() === 'instructor')).toBe(true);
    expect(e.mem.sessions.grades).toHaveLength(1);
    expect(e.mem.sessions.grades[0]?.gradedReliability).toBe('B');
    expect(e.mem.sessions.decisions).toHaveLength(1);
    const d = e.mem.sessions.decisions[0];
    expect(d?.confidence).toBe(70);
    expect(d?.perceivedSnapshot).toBeDefined();
    expect(d?.truthSnapshot).toBeDefined();
  });

  it('validates who may act and when', async () => {
    const { sessionId, players, manager } = await started();
    const act: PlayerAction = { type: 'AUTHENTICATE', messageId: 'x' };
    await expect(manager.enqueue(sessionId, 'stranger', act)).rejects.toMatchObject({
      status: 403,
    });
    await manager.pause(sessionId);
    await expect(manager.enqueue(sessionId, players.pl, act)).rejects.toMatchObject({
      status: 409,
    });
    await manager.resume(sessionId);
    await manager.end(sessionId);
    await expect(manager.enqueue(sessionId, players.pl, act)).rejects.toBeInstanceOf(HttpError);
    expect(await manager.perceivedFor(sessionId, players.pl)).toBeNull();
    expect(events(env!, sessionId).map((x) => x.type)).toEqual(
      expect.arrayContaining(['SESSION_PAUSED', 'SESSION_RESUMED', 'SESSION_ENDED']),
    );
  });

  it('rolls back and retries when persisting a batch fails, so memory and the log never diverge', async () => {
    const { env: e, sessionId, players, manager } = await started();
    await manager.stepNow(sessionId, 5);
    e.mem.sessions.failNextCommit();
    await manager.enqueue(sessionId, players.pl, { type: 'SWITCH_CHANNEL', channel: 'HF' });
    await manager.stepNow(sessionId, 1);
    expect((await e.mem.deps.sessions.getSession(sessionId))?.currentTick).toBe(5);
    expect((await manager.perceivedFor(sessionId, players.pl))?.tick).toBe(5);
    await manager.stepNow(sessionId, 1);
    expect((await manager.perceivedFor(sessionId, players.pl))?.comms.activeChannel).toBe('HF');
    expect(events(e, sessionId).filter((x) => x.type === 'INPUT')).toHaveLength(1);
  });
});

describe('SessionManager: ending an exercise', () => {
  const decision: PlayerAction = {
    type: 'DECISION',
    actionType: 'HOLD',
    confidence: 70,
    rationale: 'Holding until the picture is clearer.',
  };

  it('applies actions still queued when the instructor ends, so an acknowledged decision reaches the AAR', async () => {
    const { env: e, sessionId, players, manager } = await started(4);
    await manager.stepNow(sessionId, 2);
    await manager.enqueue(sessionId, players.sec, decision);
    await manager.end(sessionId);

    const log = events(e, sessionId);
    const types = log.map((x) => x.type);
    expect(types.at(-1)).toBe('SESSION_ENDED');
    expect(types.indexOf('DECISION_MADE')).toBeGreaterThan(-1);
    expect(types.indexOf('DECISION_MADE')).toBeLessThan(types.indexOf('SESSION_ENDED'));
    // one final tick, not a whole 4x batch
    expect((await e.mem.deps.sessions.getSession(sessionId))?.currentTick).toBe(9);

    const aar = await e.api('GET', `/aar/${sessionId}`, 'inst@x.io');
    expect(aar.status).toBe(200);
    const body = aar.body as { decisions: { playerId: string; actionType: string }[] };
    expect(body.decisions).toEqual([
      expect.objectContaining({ playerId: players.sec, actionType: 'HOLD' }),
    ]);
  });

  it('also applies what was queued before a pause, and adds no tick when nothing is queued', async () => {
    const { env: e, sessionId, players, manager } = await started();
    await manager.stepNow(sessionId, 3);
    await manager.enqueue(sessionId, players.pl, decision);
    await manager.pause(sessionId);
    await manager.end(sessionId);
    expect(events(e, sessionId).filter((x) => x.type === 'DECISION_MADE')).toHaveLength(1);

    const other = await started();
    await other.manager.stepNow(other.sessionId, 3);
    await other.manager.end(other.sessionId);
    expect((await other.env.mem.deps.sessions.getSession(other.sessionId))?.currentTick).toBe(3);
  });

  it('does not end the exercise when the last actions cannot be stored', async () => {
    const { env: e, sessionId, players, manager } = await started();
    await manager.stepNow(sessionId, 3);
    await manager.enqueue(sessionId, players.pl, decision);
    e.mem.sessions.failNextCommit();
    await expect(manager.end(sessionId)).rejects.toBeInstanceOf(HttpError);
    expect((await e.mem.deps.sessions.getSession(sessionId))?.status).toBe('RUNNING');
    await manager.end(sessionId);
    expect(events(e, sessionId).filter((x) => x.type === 'DECISION_MADE')).toHaveLength(1);
    expect((await e.mem.deps.sessions.getSession(sessionId))?.status).toBe('ENDED');
  });
});

describe('SessionManager: recovery from the event log', () => {
  it('a fresh manager rebuilds the exact state by replay and then stays in lock-step', async () => {
    const { env: e, sessionId, players, manager } = await started();
    await manager.stepNow(sessionId, 60);
    await manager.enqueue(sessionId, players.pl, { type: 'SWITCH_CHANNEL', channel: 'HF' });
    await manager.enqueue(sessionId, players.sec, {
      type: 'SEND_MESSAGE',
      toPlayerId: players.pl,
      channel: 'HF',
      text: 'Grid 1234 contact',
    });
    await manager.stepNow(sessionId, 100);

    const restarted = new SessionManager(
      e.mem.deps.sessions,
      e.mem.deps.scenarios,
      e.mem.deps.geo,
      new LobbyService(e.mem.deps.sessions, e.mem.deps.scenarios),
      e.app.io,
      log,
      e.scheduler,
    );
    for (const id of Object.values(players)) {
      expect(JSON.stringify(await restarted.perceivedFor(sessionId, id))).toBe(
        JSON.stringify(await manager.perceivedFor(sessionId, id)),
      );
    }
    expect(JSON.stringify(await restarted.truthFor(sessionId))).toBe(
      JSON.stringify(await manager.truthFor(sessionId)),
    );

    await manager.stepNow(sessionId, 40);
    await restarted.stepNow(sessionId, 40);
    expect(JSON.stringify(await restarted.truthFor(sessionId))).toBe(
      JSON.stringify(await manager.truthFor(sessionId)),
    );
  });

  it('resumeAll restarts RUNNING sessions and leaves PAUSED ones idle until needed', async () => {
    const { env: e, sessionId, manager } = await started();
    await manager.stepNow(sessionId, 20);
    const fresh = () =>
      new SessionManager(
        e.mem.deps.sessions,
        e.mem.deps.scenarios,
        e.mem.deps.geo,
        new LobbyService(e.mem.deps.sessions, e.mem.deps.scenarios),
        e.app.io,
        log,
        e.scheduler,
      );
    e.scheduler.timers.length = 0;
    await fresh().resumeAll();
    expect(e.scheduler.timers).toHaveLength(1);

    await manager.pause(sessionId);
    e.scheduler.timers.length = 0;
    const m2 = fresh();
    await m2.resumeAll();
    expect(e.scheduler.timers).toHaveLength(0);
    expect(
      (
        await m2.perceivedFor(
          sessionId,
          (await e.mem.deps.sessions.listPlayers(sessionId))[0]?.id ?? '',
        )
      )?.tick,
    ).toBe(20);
  });

  it('does not rebuild lobby or ended sessions', async () => {
    env = await makeEnv();
    const { sessionId } = await setupLobby(env);
    expect(await env.app.manager.ensureRuntime(sessionId)).toBeNull();
    expect(await env.app.manager.truthFor(sessionId)).toBeNull();
  });
});

describe('SessionManager: drift-corrected loop', () => {
  it('schedules every tick at a fixed offset, not one second after the last finished', async () => {
    const { env: e } = await started();
    const s = e.scheduler;
    expect(s.timers.map((t) => t.at)).toEqual([1000]);
    s.fireNext();
    await flush();
    expect(s.timers.map((t) => t.at)).toEqual([2000]);

    s.time = 2400; // the machine was late by 400 ms
    s.fireNext();
    await flush();
    expect(s.timers.map((t) => t.at)).toEqual([3000]); // 600 ms delay: caught up, not 1000

    s.time = 30_000; // far behind: no burst of catch-up ticks, just one timer
    s.fireNext();
    await flush();
    expect(s.timers).toHaveLength(1);
    expect(s.timers[0]?.at).toBe(30_000);
  });

  it('pause stops the loop and resume restarts it', async () => {
    const { env: e, sessionId, manager } = await started();
    await manager.pause(sessionId);
    expect(e.scheduler.timers).toHaveLength(0);
    await manager.resume(sessionId);
    expect(e.scheduler.timers).toHaveLength(1);
    await manager.end(sessionId);
    expect(e.scheduler.timers).toHaveLength(0);
  });
});
