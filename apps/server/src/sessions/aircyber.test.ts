import { afterEach, describe, expect, it } from 'vitest';
import { haversineM } from '@vyuha/engine';
import { aarSnapshotSchema, aarSummarySchema, type Inject } from '@vyuha/shared';
import { SILENT_RIDGE_ID, silentRidge } from '../seed/silentRidge';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const INST = 'inst@x.io';
const events = (e: Env, sessionId: string) => e.mem.sessions.events.get(sessionId) ?? [];

async function running() {
  env = await makeEnv();
  const lobby = await setupLobby(env);
  await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
  const manager = env.app.manager;
  await manager.stepNow(lobby.sessionId, 20);
  return { env, ...lobby, manager };
}

const gps: Inject = {
  id: 'x',
  tick: 0,
  title: 'UAV GPS spoofed',
  type: 'GPS_SPOOF',
  unitId: 'b-uav',
  offsetM: 3000,
  bearingDeg: 0,
  durationTicks: 400,
};
const c2: Inject = {
  id: 'x',
  tick: 0,
  title: 'C2 node compromised',
  type: 'C2_COMPROMISE',
  targetUnitId: 'b-sec1',
  driftMps: 20,
  durationTicks: 900,
};

describe('air domain: UAV GPS spoof as a live inject', () => {
  it('shifts what the UAV reports, shows the instructor, tells no trainee, and replays exactly', async () => {
    const x = await running();
    await x.manager.enqueueInstructor(x.sessionId, { type: 'INJECT_NOW', inject: gps });
    await x.manager.stepNow(x.sessionId, 120);

    const truth = await x.manager.truthFor(x.sessionId);
    expect(truth?.effects.gpsSpoofs).toEqual([
      { unitId: 'b-uav', offsetM: 3000, untilTick: expect.any(Number) },
    ]);
    const uav = truth?.units.find((u) => u.id === 'b-uav');
    const isr = await x.manager.perceivedFor(x.sessionId, x.players.isr);
    if (!uav || !isr) throw new Error('missing state');
    const off = haversineM(isr.self.position, uav.position);
    expect(off).toBeGreaterThan(2950);
    expect(off).toBeLessThan(3050);

    // truth stays in the instructor room
    const log = events(x.env, x.sessionId);
    const started = log.filter((e) => e.type === 'GPS_SPOOF_STARTED');
    expect(started).toHaveLength(1);
    expect(started[0]?.visibleTo).toEqual(['instructor']);
    const toTrainees = log.filter((e) => e.visibleTo.some((v) => v !== 'instructor'));
    expect(JSON.stringify(toTrainees)).not.toMatch(/gpsSpoofed|GPS_SPOOF/);
    for (const id of Object.values(x.players)) {
      expect(JSON.stringify(await x.manager.perceivedFor(x.sessionId, id))).not.toMatch(/spoof/i);
    }
    const spoofedReports = log.filter(
      (e) => e.type === 'REPORT_GENERATED' && e.payload['gpsSpoofed'] === true,
    );
    expect(spoofedReports.length).toBeGreaterThan(0);
    expect(spoofedReports.every((e) => e.payload['sensorUnitId'] === 'b-uav')).toBe(true);

    // Ghost Replay rebuilds the same (spoofed) picture from the log alone
    const tick = truth?.tick ?? 0;
    await x.env.api('POST', `/sessions/${x.sessionId}/end`, INST);
    const snap = aarSnapshotSchema.parse(
      (
        await x.env.api(
          'GET',
          `/aar/${x.sessionId}/snapshot?tick=${tick}&playerId=${x.players.isr}`,
          INST,
        )
      ).body,
    );
    expect(snap.perceived?.self.position).toEqual(isr.self.position);
  });

  it('acting on a contact from the spoofed UAV becomes a learning point', async () => {
    const x = await running();
    await x.manager.enqueueInstructor(x.sessionId, { type: 'INJECT_NOW', inject: gps });
    let contactId: string | undefined;
    for (let i = 0; i < 40 && !contactId; i++) {
      await x.manager.stepNow(x.sessionId, 10);
      const spoofed = new Set(
        events(x.env, x.sessionId)
          .filter((e) => e.type === 'REPORT_GENERATED' && e.payload['gpsSpoofed'] === true)
          .map((e) => String(e.payload['reportId'])),
      );
      const seen = await x.manager.perceivedFor(x.sessionId, x.players.isr);
      contactId = seen?.contacts.find((c) => spoofed.has(c.id))?.id;
    }
    expect(contactId, 'the UAV reported something while spoofed').toBeDefined();
    await x.manager.enqueue(x.sessionId, x.players.isr, {
      type: 'DECISION',
      actionType: 'REPORT_UP',
      confidence: 85,
      rationale: 'UAV has the contact in sight',
      targetContactId: contactId ?? '',
    });
    await x.manager.stepNow(x.sessionId, 2);
    await x.env.api('POST', `/sessions/${x.sessionId}/end`, INST);

    const summary = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    const mine = summary.analysis.learning.filter((p) => p.playerId === x.players.isr);
    expect(mine.map((p) => p.rule)).toContain('ACTED_ON_SPOOFED_UAV');
    expect(summary.analysis.timeline.map((t) => t.kind)).toContain('UAV_SPOOF_ACTED');
    expect(summary.decisions.find((d) => d.playerId === x.players.isr)?.outcome).toBe(0);
  });
});

describe('cyber domain: C2 node compromised as a live inject', () => {
  it('drifts one trainee’s teammates silently, and a cross-check over another channel ends it', async () => {
    const x = await running();
    const before = await x.manager.perceivedFor(x.sessionId, x.players.sec);
    await x.manager.enqueueInstructor(x.sessionId, { type: 'INJECT_NOW', inject: c2 });
    await x.manager.stepNow(x.sessionId, 60);

    const truth = await x.manager.truthFor(x.sessionId);
    expect(truth?.effects.c2Compromises).toEqual([
      expect.objectContaining({ playerId: x.players.sec, channel: 'VHF' }),
    ]);
    expect(truth?.effects.c2Compromises[0]?.driftM).toBeGreaterThan(1000);
    // the instructor's drift meter sees it; the trainee's own events do not mention it
    expect(truth?.drift[x.players.sec]?.friendlyAvgErrorM).toBeGreaterThan(900);
    const log = events(x.env, x.sessionId);
    expect(log.filter((e) => e.type === 'C2_COMPROMISED')[0]?.visibleTo).toEqual(['instructor']);
    expect(JSON.stringify(log.filter((e) => e.visibleTo.includes(x.players.sec)))).not.toMatch(
      /C2_COMPROMISED|compromis/i,
    );
    const during = await x.manager.perceivedFor(x.sessionId, x.players.sec);
    expect(during?.friendlies.map((f) => f.unitId)).toEqual(
      before?.friendlies.map((f) => f.unitId),
    );

    // the platoon commander answers over HF: a different channel than the compromised VHF net
    let detected = false;
    for (let i = 0; i < 12 && !detected; i++) {
      await x.manager.enqueue(x.sessionId, x.players.pl, {
        type: 'SEND_MESSAGE',
        toPlayerId: x.players.sec,
        channel: 'HF',
        text: 'Confirming my position by HF',
      });
      await x.manager.stepNow(x.sessionId, 8);
      detected = events(x.env, x.sessionId).some((e) => e.type === 'C2_COMPROMISE_DETECTED');
    }
    expect(detected).toBe(true);
    const found = events(x.env, x.sessionId).find((e) => e.type === 'C2_COMPROMISE_DETECTED');
    expect(found?.visibleTo.sort()).toEqual(['instructor', x.players.sec].sort());
    expect(found?.payload['via']).toBe('HF');
    expect((await x.manager.truthFor(x.sessionId))?.effects.c2Compromises).toEqual([]);

    await x.env.api('POST', `/sessions/${x.sessionId}/end`, INST);
    const summary = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    const point = summary.analysis.learning.find(
      (p) => p.rule === 'C2_DETECTED' && p.playerId === x.players.sec,
    );
    expect(point?.params['via']).toBe('HF');
    expect(point?.params['tick']).toBe(found?.tick);
    expect(summary.analysis.timeline.map((t) => t.kind)).toContain('C2_DETECTED');
  });

  it('is reported as never detected when nobody cross-checks', async () => {
    const x = await running();
    await x.manager.enqueueInstructor(x.sessionId, {
      type: 'INJECT_NOW',
      inject: { ...c2, durationTicks: 60 },
    });
    await x.manager.stepNow(x.sessionId, 90);
    await x.env.api('POST', `/sessions/${x.sessionId}/end`, INST);
    const summary = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    expect(summary.analysis.learning.find((p) => p.rule === 'C2_NOT_DETECTED')?.playerId).toBe(
      x.players.sec,
    );
  });
});

describe('MSEL authoring accepts and checks the new injects', () => {
  it('saves a GPS spoof on the UAV and a C2 compromise, and refuses a land unit as the UAV', async () => {
    env = await makeEnv();
    const base = silentRidge.msel;
    const good: Inject[] = [
      ...base,
      { ...gps, id: 'gps-a', tick: 200 },
      { ...c2, id: 'c2-a', tick: 260 },
    ];
    const saved = await env.api('PUT', `/scenarios/${SILENT_RIDGE_ID}/msel`, INST, { msel: good });
    expect(saved.status).toBe(200);
    const bad = await env.api('PUT', `/scenarios/${SILENT_RIDGE_ID}/msel`, INST, {
      msel: [...base, { ...gps, id: 'gps-b', tick: 200, unitId: 'b-pl' }],
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('not an air unit');
  });
});
