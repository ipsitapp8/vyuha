import { describe, expect, it } from 'vitest';
import { haversineM, offsetByMeters } from './geometry';
import {
  brierScore,
  computeMetrics,
  computePictureDrift,
  decisionsFromEvents,
  gradeAccuracy,
} from './metrics';
import { computePerceivedState } from './perceived';
import { mulberry32 } from './prng';
import { makeGhostReport, makeRealReport } from './reports';
import { replay } from './replay';
import { createTruthState, getUnit, recipientsForUnit } from './state';
import { step } from './step';
import { CLEAR, makeRoster, makeScenario, makeState, makeTerrain } from './testkit';
import { jam, ofType, run, spoof, type Plan } from './testrun';
import type { EngineEvent, EngineInput, InboxMessage, Report, TruthState } from './types';

/** Puts an order straight into a player's inbox (as if delivered `receivedTick`). */
function giveOrder(
  s: TruthState,
  playerId: string,
  id: string,
  opts: { spoof: boolean; receivedTick?: number; kind?: InboxMessage['kind'] },
): void {
  s.knowledge[playerId]?.inbox.push({
    id,
    kind: opts.kind ?? 'ORDER',
    fromLabel: 'Battalion HQ',
    channel: 'VHF',
    sentTick: 0,
    receivedTick: opts.receivedTick ?? 0,
    text: 'Move now',
    position: null,
    spoof: opts.spoof,
    authState: 'NONE',
  });
}

/** Gives a player a delivered contact built from a truth report. */
function giveContact(
  s: TruthState,
  playerId: string,
  report: Report,
  at = report.position,
  receivedTick = s.tick,
): void {
  s.reports.push(report);
  s.knowledge[playerId]?.reports.push({
    reportId: report.id,
    observedTick: report.tick,
    receivedTick,
    position: at,
    type: report.type,
    via: 'DIRECT',
    corrupted: false,
  });
}

const decide = (extra: Partial<Extract<EngineInput, { type: 'DECISION' }>> = {}): EngineInput => ({
  type: 'DECISION',
  playerId: 'p-pl',
  actionType: 'COMPLY_ORDER',
  confidence: 80,
  rationale: 'Order looks routine to me',
  ...extra,
});

const decisionOf = (events: EngineEvent[]) => ofType(events, 'DECISION_MADE')[0]?.payload;

describe('spoofed orders and authentication', () => {
  const scenario = makeScenario({ msel: [spoof(5)] });

  it('delivers a spoofed order as an ordinary-looking order that needs authentication', () => {
    const { state, events } = run(makeState({ scenario }), 8);
    const inbox = state.knowledge['p-pl']?.inbox ?? [];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.spoof).toBe(true);
    expect(ofType(events, 'SPOOF_INJECTED')).toHaveLength(1);
    const seen = computePerceivedState(state, 'p-pl').inbox[0];
    expect(seen?.from).toBe('Battalion HQ');
    expect(seen?.requiresAuth).toBe(true);
    expect(seen?.authState).toBe('NONE');
    expect(JSON.stringify(seen)).not.toMatch(/spoof/i);
  });

  it('authenticate takes 15 ticks and then reveals the spoof', () => {
    const s0 = makeState({ scenario });
    const mid = run(s0, 8);
    const id = mid.state.knowledge['p-pl']!.inbox[0]!.id;
    const start = run(mid.state, 1, {
      9: [{ type: 'AUTHENTICATE', playerId: 'p-pl', messageId: id }],
    });
    expect(computePerceivedState(start.state, 'p-pl').inbox[0]?.authState).toBe('PENDING');
    const early = run(start.state, 13);
    expect(computePerceivedState(early.state, 'p-pl').inbox[0]?.authState).toBe('PENDING');
    const done = run(early.state, 3);
    expect(computePerceivedState(done.state, 'p-pl').inbox[0]?.authState).toBe('FAILED');
    const resolved = ofType([...start.events, ...early.events, ...done.events], 'AUTH_RESOLVED');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload['result']).toBe('FAILED');
    expect(resolved[0]?.tick).toBe(9 + 15);
  });

  it('a genuine order verifies; repeat, non-order and unknown authentications are refused', () => {
    const s = makeState();
    giveOrder(s, 'p-pl', 'ord-1', { spoof: false });
    giveOrder(s, 'p-pl', 'txt-1', { spoof: false, kind: 'TEXT' });
    const auth = (messageId: string): EngineInput => ({
      type: 'AUTHENTICATE',
      playerId: 'p-pl',
      messageId,
    });
    const first = run(s, 1, { 1: [auth('ord-1'), auth('ord-1'), auth('txt-1'), auth('nope')] });
    expect(ofType(first.events, 'INPUT_REJECTED')).toHaveLength(3);
    const done = run(first.state, 20);
    expect(done.state.knowledge['p-pl']?.inbox.find((m) => m.id === 'ord-1')?.authState).toBe(
      'VERIFIED',
    );
  });
});

describe('decisions: confidence, latency, correctness, spoof logging', () => {
  it('acting on an unauthenticated spoof is logged and scored wrong', () => {
    const s = makeState();
    giveOrder(s, 'p-pl', 'o1', { spoof: true });
    const { events } = run(s, 1, { 1: [decide({ basedOnMessageId: 'o1' })] });
    const d = decisionOf(events);
    expect(d?.['outcome']).toBe(0);
    expect(d?.['spoofActed']).toBe(true);
    expect(ofType(events, 'SPOOF_ACTED')).toHaveLength(1);
  });

  it('ignoring a spoof is correct and not logged as acted on', () => {
    const s = makeState();
    giveOrder(s, 'p-pl', 'o1', { spoof: true });
    const { events } = run(s, 1, {
      1: [decide({ actionType: 'IGNORE_ORDER', basedOnMessageId: 'o1' })],
    });
    expect(decisionOf(events)?.['outcome']).toBe(1);
    expect(ofType(events, 'SPOOF_ACTED')).toHaveLength(0);
  });

  it('complying after authentication exposed the spoof is wrong but not "unauthenticated"', () => {
    const s = makeState();
    giveOrder(s, 'p-pl', 'o1', { spoof: true });
    s.knowledge['p-pl']!.inbox[0]!.authState = 'FAILED';
    const { events } = run(s, 1, { 1: [decide({ basedOnMessageId: 'o1' })] });
    expect(decisionOf(events)?.['outcome']).toBe(0);
    expect(ofType(events, 'SPOOF_ACTED')).toHaveLength(0);
  });

  it('complying with a genuine order is correct; ignoring it is wrong', () => {
    const s = makeState();
    giveOrder(s, 'p-pl', 'g1', { spoof: false });
    expect(
      decisionOf(run(s, 1, { 1: [decide({ basedOnMessageId: 'g1' })] }).events)?.['outcome'],
    ).toBe(1);
    expect(
      decisionOf(
        run(s, 1, { 1: [decide({ actionType: 'IGNORE_ORDER', basedOnMessageId: 'g1' })] }).events,
      )?.['outcome'],
    ).toBe(0);
  });

  it('measures decision latency from the arrival of the relevant information', () => {
    const s = makeState();
    s.tick = 30;
    giveOrder(s, 'p-pl', 'g1', { spoof: false, receivedTick: 20 });
    const { events } = run(s, 1, { 31: [decide({ basedOnMessageId: 'g1' })] });
    expect(decisionOf(events)?.['latencyTicks']).toBe(11);
    expect(
      decisionOf(run(makeState(), 1, { 1: [decide({ actionType: 'HOLD' })] }).events)?.[
        'latencyTicks'
      ],
    ).toBeNull();
  });

  it('scores engaging a real hostile as correct and engaging a ghost as wrong', () => {
    const s = makeState();
    const rng = mulberry32(1);
    const real = makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', real, getUnit(s, 'r-recce')!.position);
    const ghost = makeGhostReport(s, rng, getUnit(s, 'b-pl')!);
    giveContact(s, 'p-pl', ghost);
    const off = makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', off, offsetByMeters(getUnit(s, 'r-recce')!.position, 1500, 0));

    const out = (extra: Partial<Extract<EngineInput, { type: 'DECISION' }>>) =>
      decisionOf(run(s, 1, { 1: [decide(extra)] }).events)?.['outcome'];
    expect(out({ actionType: 'ENGAGE', targetContactId: real.id })).toBe(1);
    expect(out({ actionType: 'ENGAGE', targetContactId: ghost.id })).toBe(0);
    expect(out({ actionType: 'REPORT_UP', targetContactId: off.id })).toBe(0);
    expect(out({ actionType: 'HOLD', targetContactId: real.id })).toBeNull();
  });

  it('requires 0-100 confidence, a 10+ character rationale and known references', () => {
    const s = makeState();
    const bad: EngineInput[] = [
      decide({ confidence: 101 }),
      decide({ confidence: -1 }),
      decide({ confidence: Number.NaN }),
      decide({ rationale: 'too short' }),
      decide({ targetContactId: 'rpt-404' }),
      decide({ basedOnMessageId: 'msg-404' }),
    ];
    const { events } = run(s, 1, { 1: bad });
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(6);
    expect(ofType(events, 'DECISION_MADE')).toHaveLength(0);
  });

  it('records both snapshots for the AAR, visible to the instructor only', () => {
    const s = makeState();
    const { events } = run(s, 1, { 1: [decide({ actionType: 'HOLD' })] });
    const made = ofType(events, 'DECISION_MADE')[0];
    expect(made?.visibleTo).toEqual(['instructor']);
    expect(made?.payload['perceivedSnapshot']).toBeDefined();
    const truth = made?.payload['truthSnapshot'] as { units: unknown[] };
    expect(truth.units.length).toBe(s.units.length);
    expect(ofType(events, 'DECISION_RECORDED')[0]?.visibleTo).toEqual(['p-pl']);
    expect(JSON.stringify(ofType(events, 'DECISION_RECORDED')[0]?.payload)).not.toMatch(/truth/);
  });
});

describe('report grading', () => {
  it('records the grade for the player and the truth comparison for the instructor only', () => {
    const s = makeState();
    const r = makeRealReport(s, mulberry32(4), getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', r);
    const grade: EngineInput = {
      type: 'GRADE_REPORT',
      playerId: 'p-pl',
      reportId: r.id,
      reliability: 'A',
      credibility: 1,
    };
    const { state, events } = run(s, 1, {
      1: [grade, { ...grade, reportId: 'rpt-404' }],
    });
    const graded = ofType(events, 'REPORT_GRADED')[0];
    expect(graded?.visibleTo).toEqual(['instructor']);
    expect(graded?.payload['trueReliability']).toBe(r.trueReliability);
    const recorded = ofType(events, 'REPORT_GRADE_RECORDED')[0];
    expect(recorded?.visibleTo).toEqual(['p-pl']);
    expect(JSON.stringify(recorded?.payload)).not.toMatch(/true/i);
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(1);
    expect(computePerceivedState(state, 'p-pl').contacts.find((c) => c.id === r.id)?.grade).toEqual(
      {
        reliability: 'A',
        credibility: 1,
      },
    );
  });
});

describe('perceived state never leaks truth', () => {
  const scenario = makeScenario({
    msel: [
      spoof(40),
      jam('j', 20, 'VHF', 0.4, 200),
      {
        id: 'c',
        tick: 60,
        title: 'c',
        type: 'CONFLICTING_REPORTS',
        unitId: 'r-recce',
        altPosition: { lat: 34.19, lon: 77.19 },
        altType: 'RECCE',
      },
    ],
  });
  const FORBIDDEN = [
    'r-recce',
    'r-far',
    'r-ew',
    'n-convoy',
    'Hostile',
    'trueReliability',
    'trueCredibility',
    '"ghost"',
    '"spoof"',
    'subjectUnitId',
    'conflictGroup',
    'jamming',
    'adaptive',
    'sensorUnitId',
    'satcomDown',
  ];

  it('contains no hidden units, report truth, spoof flags or jamming levels', () => {
    const { state } = run(makeState({ scenario, seed: 21 }), 400);
    for (const p of ['p-pl', 'p-sec', 'p-uav']) {
      const json = JSON.stringify(computePerceivedState(state, p));
      for (const token of FORBIDDEN) expect(json).not.toContain(token);
    }
  });

  it('events visible to players carry no truth either', () => {
    const { events } = run(makeState({ scenario, seed: 21 }), 400, {
      10: [decide({ actionType: 'HOLD' })],
    });
    const playerVisible = events.filter((e) => e.visibleTo.some((v) => v !== 'instructor'));
    expect(playerVisible.length).toBeGreaterThan(20);
    for (const e of playerVisible) {
      const json = JSON.stringify(e.payload);
      for (const token of FORBIDDEN.filter((t) => t !== 'Hostile'))
        expect(json).not.toContain(token);
    }
  });

  it('gives teammates different pictures (information asymmetry)', () => {
    const { state } = run(makeState({ scenario, seed: 21 }), 400);
    const ids = (p: string): string =>
      computePerceivedState(state, p)
        .contacts.map((c) => c.id)
        .sort()
        .join(',');
    expect(new Set([ids('p-pl'), ids('p-sec'), ids('p-uav')]).size).toBeGreaterThan(1);
  });

  it('shows ghost contacts exactly like real ones', () => {
    const s = makeState();
    const rng = mulberry32(2);
    giveContact(s, 'p-pl', makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!));
    giveContact(s, 'p-pl', makeGhostReport(s, rng, getUnit(s, 'b-pl')!));
    const [a, b] = computePerceivedState(s, 'p-pl').contacts;
    expect(Object.keys(a!).sort()).toEqual(Object.keys(b!).sort());
    expect(Object.keys(a!.grade ?? {})).toEqual(Object.keys(b!.grade ?? {}));
  });

  it('never shows a hostile nobody has detected', () => {
    const { state } = run(makeState({ seed: 5 }), 30);
    const seenTypes = computePerceivedState(state, 'p-sec').contacts.map((c) => c.source);
    expect(seenTypes.length).toBeLessThanOrEqual(state.reports.length);
  });

  it('expires old contacts, labels own sensors, and rejects unknown players', () => {
    const s = makeState();
    const r = makeRealReport(s, mulberry32(2), getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', r);
    expect(computePerceivedState(s, 'p-pl').contacts[0]?.source).toBe('Own sensor');
    s.tick = 700;
    expect(computePerceivedState(s, 'p-pl').contacts).toHaveLength(0);
    expect(() => computePerceivedState(s, 'nobody')).toThrow(RangeError);
  });

  it('reports measured link quality: terrain, jamming and a SATCOM outage show on the signal bars', () => {
    const open = makeState({ terrain: makeTerrain(3000, 0) });
    const ridge = makeState({ terrain: makeTerrain(3000, 4800) });
    const sigOpen = computePerceivedState(open, 'p-sec').comms.signal;
    const sigRidge = computePerceivedState(ridge, 'p-sec').comms.signal;
    expect(sigRidge.VHF!).toBeLessThan(sigOpen.VHF!);
    expect(sigRidge.HF!).toBeGreaterThan(sigRidge.VHF!);
    expect(sigOpen.RUNNER).toBeNull();
    const jammed = { ...open, manualJam: { ...open.manualJam, VHF: 0.8 } };
    expect(computePerceivedState(jammed, 'p-sec').comms.signal.VHF!).toBeLessThan(
      sigOpen.VHF! * 0.3,
    );
    const down = { ...open, satcomDownUntilTick: 100 };
    expect(computePerceivedState(down, 'p-sec').comms.signal.SATCOM).toBe(0);
    const solo = makeRoster();
    solo.players = solo.players.slice(0, 1);
    expect(computePerceivedState(makeState({ roster: solo }), 'p-pl').comms.signal.VHF).toBeNull();
  });
});

describe('picture drift', () => {
  it('starts with every hostile missed, then falls as contacts arrive; ghosts and errors count', () => {
    const s = makeState();
    const base = computePictureDrift(s, 'p-pl');
    expect(base).toEqual({ missed: 3, ghost: 0, avgPositionErrorM: 0, friendlyAvgErrorM: 0 });

    const rng = mulberry32(8);
    const real = makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', real, offsetByMeters(getUnit(s, 'r-recce')!.position, 400, 300));
    const ghost = makeGhostReport(s, rng, getUnit(s, 'b-pl')!);
    giveContact(s, 'p-pl', ghost);
    const d = computePictureDrift(s, 'p-pl');
    expect(d.missed).toBe(2);
    expect(d.ghost).toBe(1);
    expect(d.avgPositionErrorM).toBeGreaterThan(450);
    expect(d.avgPositionErrorM).toBeLessThan(550);
  });

  it('uses the freshest contact per hostile and ignores neutrals', () => {
    const s = makeState();
    const rng = mulberry32(1);
    const old = makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', old, offsetByMeters(getUnit(s, 'r-recce')!.position, 2000, 0));
    s.tick = 10;
    const fresh = makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', fresh, getUnit(s, 'r-recce')!.position);
    const civ = makeRealReport(s, rng, getUnit(s, 'b-pl')!, getUnit(s, 'n-convoy')!);
    giveContact(s, 'p-pl', civ);
    const d = computePictureDrift(s, 'p-pl');
    expect(d.avgPositionErrorM).toBeLessThan(1);
    expect(d.ghost).toBe(0);
    expect(d.missed).toBe(2);
  });

  it('measures how stale friendly positions are, and is sampled every 10 ticks per player', () => {
    const s = makeState();
    const uav = getUnit(s, 'b-uav')!;
    uav.position = offsetByMeters(uav.position, 1000, 0);
    const d = computePictureDrift(s, 'p-pl');
    expect(d.friendlyAvgErrorM).toBeGreaterThan(400);
    const { events } = run(makeState(), 30);
    expect(ofType(events, 'DRIFT_SAMPLE')).toHaveLength(9);
    expect(() => computePictureDrift(s, 'nobody')).toThrow(RangeError);
  });
});

describe('metrics', () => {
  it('Brier score: mean squared error of confidence vs outcome', () => {
    expect(
      brierScore([
        { confidence: 90, outcome: 1 },
        { confidence: 80, outcome: 0 },
      ]),
    ).toBeCloseTo(0.325, 9);
    expect(brierScore([{ confidence: 100, outcome: 1 }])).toBe(0);
    expect(brierScore([{ confidence: 100, outcome: 0 }])).toBe(1);
    expect(brierScore([{ confidence: 50, outcome: null }])).toBeNull();
    expect(brierScore([])).toBeNull();
  });

  it('Admiralty grading accuracy is 1 when exact and 0 when maximally wrong', () => {
    expect(
      gradeAccuracy({ reliability: 'C', credibility: 3 }, { reliability: 'C', credibility: 3 }),
    ).toBe(1);
    expect(
      gradeAccuracy({ reliability: 'A', credibility: 1 }, { reliability: 'F', credibility: 6 }),
    ).toBe(0);
    expect(
      gradeAccuracy({ reliability: 'B', credibility: 2 }, { reliability: 'A', credibility: 1 }),
    ).toBeCloseTo(0.8, 9);
  });

  it('aggregates latency, calibration, grading, switches, spoofs and drift per player', () => {
    const ev = (type: string, payload: Record<string, unknown>): EngineEvent => ({
      tick: 1,
      type,
      payload,
      visibleTo: ['instructor'],
    });
    const events: EngineEvent[] = [
      ev('DRIFT_SAMPLE', { playerId: 'p1', missed: 2, ghost: 0, avgPositionErrorM: 100 }),
      ev('DRIFT_SAMPLE', { playerId: 'p1', missed: 0, ghost: 2, avgPositionErrorM: 300 }),
      ev('REPORT_GRADED', {
        playerId: 'p1',
        gradedReliability: 'B',
        gradedCredibility: 2,
        trueReliability: 'A',
        trueCredibility: 1,
      }),
      ev('CHANNEL_SWITCHED', { playerId: 'p1' }),
      ev('CHANNEL_SWITCHED', { playerId: 'p1' }),
      ev('SPOOF_ACTED', { playerId: 'p1' }),
      ev('MESSAGE_RECEIVED', { playerId: 'p0' }),
    ];
    const decisions = [
      {
        playerId: 'p1',
        tick: 5,
        actionType: 'HOLD',
        confidence: 80,
        outcome: 1 as const,
        latencyTicks: 10,
      },
      {
        playerId: 'p1',
        tick: 9,
        actionType: 'HOLD',
        confidence: 60,
        outcome: 0 as const,
        latencyTicks: 30,
      },
      {
        playerId: 'p1',
        tick: 9,
        actionType: 'HOLD',
        confidence: 50,
        outcome: null,
        latencyTicks: null,
      },
    ];
    const m = computeMetrics(events, decisions);
    expect(Object.keys(m.players)).toEqual(['p0', 'p1']);
    const p1 = m.players['p1']!;
    expect(p1.decisionCount).toBe(3);
    expect(p1.scoredDecisionCount).toBe(2);
    expect(p1.avgLatencyTicks).toBe(20);
    expect(p1.brierScore).toBeCloseTo(0.2, 9);
    expect(p1.gradingAccuracy).toBeCloseTo(0.8, 9);
    expect(p1.channelSwitchCount).toBe(2);
    expect(p1.spoofActedCount).toBe(1);
    expect(p1.drift).toEqual({
      samples: 2,
      meanMissed: 1,
      meanGhost: 1,
      meanPositionErrorM: 200,
      maxPositionErrorM: 300,
    });
    const p0 = m.players['p0']!;
    expect(p0.brierScore).toBeNull();
    expect(p0.avgLatencyTicks).toBeNull();
    expect(p0.gradingAccuracy).toBeNull();
    expect(p0.drift).toBeNull();
  });

  it('rebuilds decision records from engine events and feeds them back into the metrics', () => {
    const s = makeState();
    giveOrder(s, 'p-pl', 'o1', { spoof: true });
    const { events } = run(s, 12, { 5: [decide({ basedOnMessageId: 'o1', confidence: 90 })] });
    const decisions = decisionsFromEvents(events);
    expect(decisions).toEqual([
      {
        playerId: 'p-pl',
        tick: 5,
        actionType: 'COMPLY_ORDER',
        confidence: 90,
        outcome: 0,
        latencyTicks: 5,
      },
    ]);
    const m = computeMetrics(events, decisions);
    expect(m.players['p-pl']?.brierScore).toBeCloseTo(0.81, 9);
    expect(m.players['p-pl']?.spoofActedCount).toBe(1);
    expect(m.players['p-pl']?.drift?.samples).toBe(1);
  });
});

describe('state construction, helpers and replay', () => {
  it('validates terrain and roster', () => {
    const scenario = makeScenario();
    const terrain = makeTerrain();
    const mk =
      (roster: ReturnType<typeof makeRoster>, t = terrain) =>
      () =>
        createTruthState(scenario, t, CLEAR, 1, roster);
    expect(mk(makeRoster(), { ...terrain, elevations: [1, 2] })).toThrow(/Terrain/);
    const r1 = makeRoster();
    r1.players[0] = { ...r1.players[0]!, teamId: 'zzz' };
    expect(mk(r1)).toThrow(/team/);
    const r2 = makeRoster();
    r2.players[0] = { ...r2.players[0]!, unitId: 'zzz' };
    expect(mk(r2)).toThrow(/unit/);
    const r3 = makeRoster();
    r3.players[1] = { ...r3.players[1]!, unitId: 'b-pl' };
    expect(mk(r3)).toThrow(/twice/);
    const r4 = makeRoster();
    r4.players[1] = { ...r4.players[1]!, id: 'p-pl', unitId: 'b-ew' };
    expect(mk(r4)).toThrow(/Duplicate/);
  });

  it("seeds each player with their teammates' initial positions (at age 0) and sorts the MSEL", () => {
    const scenario = makeScenario({
      msel: [jam('b', 50, 'VHF', 0.1, 5), jam('a', 10, 'VHF', 0.1, 5)],
    });
    const s = makeState({ scenario });
    expect(s.msel.map((i) => i.id)).toEqual(['a', 'b']);
    expect(Object.keys(s.knowledge['p-pl']!.friendlies).sort()).toEqual(['b-sec', 'b-uav']);
    expect(s.knowledge['p-pl']?.friendlies['b-uav']?.observedTick).toBe(0);
  });

  it('routes traffic for unmanned units to every platoon commander', () => {
    const s = makeState();
    expect(recipientsForUnit(s, 'b-sec').map((p) => p.id)).toEqual(['p-sec']);
    expect(recipientsForUnit(s, 'b-hq').map((p) => p.id)).toEqual(['p-pl']);
  });

  it('replay reproduces direct stepping exactly', () => {
    const scenario = makeScenario({ msel: [spoof(15), jam('j', 5, 'VHF', 0.5, 50)] });
    const s0 = makeState({ scenario, seed: 77 });
    const plan: Plan = {
      3: [decide({ actionType: 'HOLD' })],
      20: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'HF' }],
    };
    const direct = run(s0, 80, plan);
    const replayed = replay(s0, new Map(Object.entries(plan).map(([k, v]) => [Number(k), v])), 80);
    expect(JSON.stringify(replayed.state)).toBe(JSON.stringify(direct.state));
    expect(JSON.stringify(replayed.events)).toBe(JSON.stringify(direct.events));
  });

  it('prunes old reports so long exercises stay bounded', () => {
    const s = makeState();
    const r = makeRealReport(s, mulberry32(1), getUnit(s, 'b-pl')!, getUnit(s, 'r-recce')!);
    giveContact(s, 'p-pl', r);
    s.tick = 1000;
    const { state } = step(s, [], mulberry32(1));
    expect(state.reports.find((x) => x.id === r.id)).toBeUndefined();
    expect(state.knowledge['p-pl']?.reports.find((x) => x.reportId === r.id)).toBeUndefined();
    expect(haversineM(r.position, r.position)).toBe(0);
  });
});
