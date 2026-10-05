import { afterEach, describe, expect, it } from 'vitest';
import {
  aarDecisionDetailSchema,
  aarSnapshotSchema,
  aarSummarySchema,
  learningTextEn,
  type AarSummary,
  type PerceivedStateDto,
} from '@vyuha/shared';
import { csvCell, decisionsCsv } from './exports';
import { challengedText, describeProgress, displayName } from './pdf';
import { closeEnv, makeEnv, setupLobby, type Env } from '../sessions/testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const INST = 'inst@x.io';

/** Plays a short exercise: spoof + authentication, grading, decisions, jamming, a channel switch; then ends it. */
async function finishedExercise() {
  env = await makeEnv();
  const lobby = await setupLobby(env);
  await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
  const m = env.app.manager;
  const { sessionId, players } = lobby;

  await m.stepNow(sessionId, 120);
  const isr = await m.perceivedFor(sessionId, players.isr);
  const contactId = isr?.contacts[0]?.id ?? '';
  await m.enqueue(sessionId, players.isr, {
    type: 'GRADE_REPORT',
    reportId: contactId,
    reliability: 'F',
    credibility: 6,
  });
  await m.enqueue(sessionId, players.isr, {
    type: 'DECISION',
    actionType: 'ENGAGE',
    confidence: 90,
    rationale: 'Drone saw it directly, engaging now',
    targetContactId: contactId,
  });
  await m.enqueueInstructor(sessionId, {
    type: 'INJECT_NOW',
    inject: {
      id: 'x',
      tick: 0,
      title: 'Spoof',
      type: 'SPOOF_ORDER',
      purportedSender: 'Battalion HQ',
      targetUnitId: 'b-pl',
      orderText: 'Withdraw to grid 1234',
    },
  });
  await m.enqueueInstructor(sessionId, { type: 'SET_JAMMING', channel: 'VHF', intensity: 0.9 });
  await m.stepNow(sessionId, 5);
  const order = (await m.perceivedFor(sessionId, players.pl))?.inbox.find((x) =>
    x.text.includes('Withdraw'),
  );
  await m.enqueue(sessionId, players.pl, {
    type: 'DECISION',
    actionType: 'COMPLY_ORDER',
    confidence: 95,
    rationale: '=HYPERLINK("http://evil","click"), it said "withdraw"',
    basedOnMessageId: order?.id ?? '',
  });
  await m.stepNow(sessionId, 130);
  await m.enqueue(sessionId, players.pl, { type: 'SWITCH_CHANNEL', channel: 'HF' });
  await m.stepNow(sessionId, 60);

  // Capture what each trainee saw at two ticks, to compare with the replay later.
  const midTick = (await m.truthFor(sessionId))?.tick ?? 0;
  const midPerceived = await m.perceivedFor(sessionId, players.pl);
  await m.stepNow(sessionId, 40);
  const endTick = (await m.truthFor(sessionId))?.tick ?? 0;
  const endPerceived = await m.perceivedFor(sessionId, players.pl);
  const endTruth = await m.truthFor(sessionId);
  await env.api('POST', `/sessions/${sessionId}/end`, INST);
  return { env, ...lobby, midTick, midPerceived, endTick, endPerceived, endTruth, contactId };
}

describe('AAR access', () => {
  it('is instructor-only, 404 for unknown sessions, and 409 until the exercise has ended', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
    await env.app.manager.stepNow(lobby.sessionId, 3);
    expect((await env.api('GET', `/aar/${lobby.sessionId}`, INST)).status).toBe(409);
    expect((await env.api('GET', `/aar/${lobby.sessionId}`, 'pl@x.io')).status).toBe(403);
    expect((await env.api('GET', '/aar/nope', INST)).status).toBe(404);
    const anon = await env.app.fastify.inject({ method: 'GET', url: `/aar/${lobby.sessionId}` });
    expect(anon.statusCode).toBe(401);
    for (const path of ['export.pdf', 'export.csv', 'export.json']) {
      expect((await env.api('GET', `/aar/${lobby.sessionId}/${path}`, INST)).status).toBe(409);
    }
    await env.api('POST', `/sessions/${lobby.sessionId}/end`, INST);
    expect((await env.api('GET', `/aar/${lobby.sessionId}`, INST)).status).toBe(200);
  });

  it('a session that ended in the lobby has nothing to review', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    await env.api('POST', `/sessions/${lobby.sessionId}/end`, INST);
    const res = await env.api('GET', `/aar/${lobby.sessionId}`, INST);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('never started');
  });
});

describe('AAR summary (built only from the recorded log)', () => {
  it('has per-trainee metrics, decisions, calibration, drift, channels, flow, timeline and learning points', async () => {
    const x = await finishedExercise();
    const res = await x.env.api('GET', `/aar/${x.sessionId}`, INST);
    expect(res.status).toBe(200);
    const s = aarSummarySchema.parse(res.body);
    expect(s.meta.code).toBe(x.code);
    expect(s.meta.durationTicks).toBe(x.endTick);
    expect(s.meta.players.map((p) => p.name).sort()).toEqual(['Asha PL', 'Bilal SEC', 'Chen ISR']);
    expect(s.decisions).toHaveLength(2);
    const spoofDecision = s.decisions.find((d) => d.actionType === 'COMPLY_ORDER');
    expect(spoofDecision).toMatchObject({ outcome: 0, spoofActed: true, confidence: 95 });
    const pl = s.analysis.players.find((p) => p.name === 'Asha PL');
    expect(pl).toMatchObject({ decisionCount: 1, spoofActedCount: 1, channelSwitchCount: 1 });
    expect(pl?.brierScore).toBeCloseTo(0.9025, 6);
    expect(s.analysis.drift[x.players.pl]?.length).toBeGreaterThan(10);
    expect(s.analysis.channels.length).toBe(Math.floor(x.endTick / 10) + 1);
    expect(s.analysis.channels.some((b) => b.jamming.VHF > 0.8)).toBe(true);
    expect(s.analysis.flow.length).toBeGreaterThan(0);
    expect(s.analysis.timeline.some((t) => t.kind === 'SPOOF')).toBe(true);
    expect(s.analysis.timeline.some((t) => t.kind === 'CHANNEL_SWITCH')).toBe(true);
    const rules = s.analysis.learning.map((l) => l.rule);
    expect(rules).toEqual(expect.arrayContaining(['ACTED_ON_SPOOF', 'NEVER_AUTHENTICATED']));
    expect(rules).toContain('ACTED_ON_LOW_GRADE');
  });
});

describe('Ghost replay snapshots', () => {
  const same = (a: PerceivedStateDto | null, b: PerceivedStateDto | null) =>
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

  it('rebuilds exactly what the trainee saw at any tick, and the true state, by deterministic replay', async () => {
    const x = await finishedExercise();
    const snap = async (tick: number, playerId: string) =>
      aarSnapshotSchema.parse(
        (
          await x.env.api(
            'GET',
            `/aar/${x.sessionId}/snapshot?tick=${tick}&playerId=${playerId}`,
            INST,
          )
        ).body,
      );

    const end = await snap(x.endTick, x.players.pl);
    same(end.perceived, x.endPerceived);
    expect(JSON.stringify(end.truth.units.map((u) => u.position))).toBe(
      JSON.stringify(x.endTruth?.units.map((u) => u.position)),
    );
    expect(end.truth.jamming.VHF).toBeCloseTo(x.endTruth?.jamming.VHF ?? -1, 9);

    const mid = await snap(x.midTick, x.players.pl);
    same(mid.perceived, x.midPerceived);
    expect(mid.tick).toBe(x.midTick);
    // The picture really changes over time: the end picture is not the mid picture.
    expect(JSON.stringify(mid.perceived)).not.toBe(JSON.stringify(end.perceived));
  });

  it('works at tick 0, clamps beyond the end, omits perception without a trainee, and validates input', async () => {
    const x = await finishedExercise();
    const get = (qs: string) => x.env.api('GET', `/aar/${x.sessionId}/snapshot?${qs}`, INST);
    const start = aarSnapshotSchema.parse((await get(`tick=0&playerId=${x.players.sec}`)).body);
    expect(start.tick).toBe(0);
    expect(start.perceived?.playerId).toBe(x.players.sec);
    const beyond = aarSnapshotSchema.parse(
      (await get(`tick=999999&playerId=${x.players.sec}`)).body,
    );
    expect(beyond.tick).toBe(x.endTick);
    const truthOnly = aarSnapshotSchema.parse((await get('tick=50')).body);
    expect(truthOnly.perceived).toBeNull();
    expect(truthOnly.truth.units.some((u) => u.side === 'RED')).toBe(true);
    expect((await get('tick=-1')).status).toBe(400);
    expect((await get('tick=abc')).status).toBe(400);
    expect((await get('')).status).toBe(400);
    expect((await get('tick=5&playerId=nobody')).status).toBe(404);
  });
});

describe('Decision details', () => {
  it('returns the rationale with both recorded snapshots: what they saw vs what was true', async () => {
    const x = await finishedExercise();
    const summary = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    const d = summary.decisions.find((q) => q.actionType === 'ENGAGE');
    const res = await x.env.api('GET', `/aar/${x.sessionId}/decisions/${d?.id}`, INST);
    expect(res.status).toBe(200);
    const detail = aarDecisionDetailSchema.parse(res.body);
    expect(detail.decision.rationale).toBe('Drone saw it directly, engaging now');
    expect(detail.perceived.playerId).toBe(x.players.isr);
    expect(detail.perceived.contacts.some((c) => c.id === x.contactId)).toBe(true);
    expect(detail.truth.units.some((u) => u.side === 'RED')).toBe(true);
    expect((await x.env.api('GET', `/aar/${x.sessionId}/decisions/nope`, INST)).status).toBe(404);
  });
});

describe('Exports', () => {
  it('JSON is the complete event log', async () => {
    const x = await finishedExercise();
    const res = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.json`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(`vyuha-event-log-${x.code}.json`);
    const body = res.json() as {
      format: string;
      eventCount: number;
      events: { type: string }[];
      decisions: unknown[];
    };
    const stored = x.env.mem.sessions.events.get(x.sessionId) ?? [];
    expect(body.format).toBe('vyuha-aar/1');
    expect(body.events).toHaveLength(stored.length);
    expect(body.eventCount).toBe(stored.length);
    expect(body.events[0]?.type).toBe('SESSION_STARTED');
    expect(body.events.at(-1)?.type).toBe('SESSION_ENDED');
    expect(body.decisions).toHaveLength(2);
  });

  it('CSV has one row per decision, escapes free text and neutralises spreadsheet formulas', async () => {
    const x = await finishedExercise();
    const res = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.csv`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.body.replace(String.fromCharCode(0xfeff), '');
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'session_code,tick,time,trainee,role,team,action,confidence_pct,outcome,latency_s,target_contact,based_on_order,spoof_acted,rationale',
    );
    expect(lines).toHaveLength(3);
    const spoof = lines.find((l) => l.includes('COMPLY_ORDER')) ?? '';
    expect(spoof).toContain(',wrong,');
    expect(spoof).toContain(',true,');
    expect(spoof).toContain(`"'=HYPERLINK(""http://evil"",""click""), it said ""withdraw"""`);
    expect(lines.find((l) => l.includes('ENGAGE'))).toContain(',Chen ISR,');
  });

  it('PDF opens as a real PDF with cover, summary, charts, one page per trainee and the team timeline', async () => {
    const x = await finishedExercise();
    const started = Date.now();
    const res = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.pdf`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    const seconds = (Date.now() - started) / 1000;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`vyuha-aar-${x.code}.pdf`);
    const bytes = res.rawPayload;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(8000);
    expect(seconds).toBeLessThan(30); // the export must be ready long before the 5-minute target

    const { text, pages, pageHeads } = await extractPdf(bytes);
    expect(pageHeads[0]).toContain('V Y U H A');
    expect(pages).toBe(1 + 1 + 1 + 3 + 1); // cover, summary, charts, one per trainee, team timeline
    const summary = aarSummarySchema.parse(
      (await x.env.api('GET', `/aar/${x.sessionId}`, INST)).body,
    );
    for (const needle of [
      'VYUHA',
      'After Action Review',
      summary.meta.scenarioTitle,
      x.code,
      'Asha PL',
      'Bilal SEC',
      'Chen ISR',
      'Key learning points',
      'Team timeline',
      'Message flow',
      'Challenged',
      'Spoofs challenged',
    ]) {
      expect(text).toContain(needle);
    }
    // The PDF says exactly what the on-screen review says.
    for (const point of summary.analysis.learning) {
      expect(text.replace(/\s+/g, ' ')).toContain(
        learningTextEn(point).replace(/\s+/g, ' ').slice(0, 40),
      );
    }
  });
});

describe('CSV helpers', () => {
  it('escapes quotes, commas, newlines, and formula triggers', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    for (const bad of ['=1+1', '+1', '-1', '@SUM(A1)'])
      expect(csvCell(bad).startsWith("'")).toBe(true);
    expect(csvCell(-5)).toBe('-5'); // numbers stay numbers
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
  });

  it('writes a header-only file when there are no decisions', () => {
    const summary = {
      meta: { code: 'ABC234', players: [], teams: [] },
      decisions: [],
    } as unknown as AarSummary;
    expect(decisionsCsv(summary).trim().split('\r\n')).toHaveLength(1);
  });
});

describe('progress section of the PDF', () => {
  const pdfText = async (x: Awaited<ReturnType<typeof finishedExercise>>): Promise<string> => {
    const res = await x.env.app.fastify.inject({
      method: 'GET',
      url: `/aar/${x.sessionId}/export.pdf`,
      headers: { cookie: await x.env.cookie(INST) },
    });
    return (await extractPdf(res.rawPayload)).text.replace(/\s+/g, ' ');
  };

  it('appears only for a trainee with two or more sessions', async () => {
    const x = await finishedExercise();
    expect(await pdfText(x)).not.toContain('Progress so far');

    // An earlier session of the same trainee makes it two.
    const ended = (await x.env.mem.sessions.getSession(x.sessionId))?.endedAt ?? new Date();
    await x.env.mem.sessions.saveSessionMetrics([
      {
        userId: 'u-pl',
        sessionId: 'earlier-session',
        endedAt: new Date(ended.getTime() - 3_600_000),
        avgDecisionLatencyMs: 60_000,
        latencyUnderJammingMs: 80_000,
        brierScore: 0.5,
        spoofsChallengedPct: 0,
        reportGradingAccuracy: 0.4,
        saScore: 55,
      },
    ]);
    const text = await pdfText(x);
    expect(text).toContain('Progress so far (2 sessions)');
    expect(text).toContain('Brier score trend');
    expect(text.match(/Progress so far/g)).toHaveLength(1); // only Asha PL has two sessions
  });

  it('describes the 3rd-vs-1st delay change and the Brier trend', () => {
    const session = (latency: number | null, brier: number | null, day: number) => ({
      sessionId: `s${day}`,
      code: 'ABC234',
      scenarioTitle: 'Op',
      endedAt: `2026-01-0${day}T10:00:00.000Z`,
      metrics: {
        avgDecisionLatencyMs: latency,
        latencyUnderJammingMs: latency,
        brierScore: brier,
        spoofsChallengedPct: day === 1 ? 0 : 100,
        reportGradingAccuracy: 0.75,
        saScore: 62,
      },
    });
    const d = describeProgress([
      session(40_000, 0.5, 1),
      session(35_000, 0.4, 2),
      session(30_000, 0.2, 3),
    ]);
    expect(d.rows).toHaveLength(3);
    expect(d.rows[0]).toEqual(['1', '2026-01-01', '40 s', '40 s', '0.50', '0%', '75%', '62']);
    expect(d.delay).toContain('session 3 vs session 1: -25%');
    expect(d.brier).toBe('Brier score trend: improving (lower is better).');

    const none = describeProgress([session(null, null, 1), session(null, null, 2)]);
    expect(none.delay).toContain('not measurable');
    expect(none.brier).toContain('not enough');
  });

  it('writes the spoofs-challenged figure as a share with the counts', () => {
    expect(
      challengedText({
        spoofsReceived: 3,
        spoofsChallenged: 2,
        spoofsChallengedPct: (2 / 3) * 100,
      }),
    ).toBe('67% (2 of 3)');
    expect(
      challengedText({ spoofsReceived: 0, spoofsChallenged: 0, spoofsChallengedPct: null }),
    ).toBe('–');
  });

  it('marks demo bots in the report', () => {
    expect(displayName({ name: 'Asha', isDemoBot: true })).toBe('Asha (Demo bot)');
    expect(displayName({ name: 'Asha', isDemoBot: false })).toBe('Asha');
  });
});

async function extractPdf(
  bytes: Buffer,
): Promise<{ text: string; pages: number; pageHeads: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  let text = '';
  const pageHeads: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
    pageHeads.push(pageText.slice(0, 40));
    text += `${pageText}
`;
  }
  return { text, pages: doc.numPages, pageHeads };
}
