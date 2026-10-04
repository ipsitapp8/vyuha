import { describe, expect, it } from 'vitest';
import {
  analyzeExercise,
  calibrationBins,
  channelSeries,
  driftSeries,
  keyTimeline,
  learningPoints,
  messageFlow,
  type AarDecision,
  type AarInput,
} from './aar';
import type { EngineEvent } from './types';

const ev = (tick: number, type: string, payload: Record<string, unknown>): EngineEvent => ({
  tick,
  type,
  payload,
  visibleTo: ['instructor'],
});

const players = [
  { id: 'p1', name: 'Asha', role: 'PL_CDR', teamId: 't1', unitId: 'b-pl' },
  { id: 'p2', name: 'Bilal', role: 'SECTION_CDR', teamId: 't1', unitId: 'b-sec' },
];
const teams = [{ id: 't1', name: 'Alpha', primary: 'VHF' as const }];

let n = 0;
const decision = (over: Partial<AarDecision> = {}): AarDecision => ({
  id: `d${++n}`,
  playerId: 'p1',
  tick: 100,
  actionType: 'HOLD',
  confidence: 60,
  rationale: 'because',
  targetContactId: null,
  basedOnMessageId: null,
  outcome: null,
  latencyTicks: null,
  spoofActed: false,
  ...over,
});

const input = (over: Partial<AarInput> = {}): AarInput => ({
  durationTicks: 600,
  players,
  teams,
  events: [],
  decisions: [],
  ...over,
});

const rules = (i: AarInput, playerId?: string): string[] =>
  learningPoints(i)
    .filter((p) => playerId === undefined || p.playerId === playerId)
    .map((p) => p.rule);

describe('calibrationBins', () => {
  it('bins stated confidence against actual correctness and skips unscored decisions', () => {
    const bins = calibrationBins([
      { confidence: 10, outcome: 0 },
      { confidence: 15, outcome: 1 },
      { confidence: 20, outcome: 1 }, // 20 belongs to the 20-40 bin
      { confidence: 90, outcome: 1 },
      { confidence: 100, outcome: 0 }, // the top edge belongs to the last bin
      { confidence: 50, outcome: null },
    ]);
    expect(bins).toEqual([
      { from: 0, to: 20, count: 2, meanConfidence: 12.5, accuracy: 50 },
      { from: 20, to: 40, count: 1, meanConfidence: 20, accuracy: 100 },
      { from: 80, to: 100, count: 2, meanConfidence: 95, accuracy: 50 },
    ]);
    expect(calibrationBins([])).toEqual([]);
  });
});

describe('time series', () => {
  it('collects drift samples per player', () => {
    const s = driftSeries([
      ev(10, 'DRIFT_SAMPLE', {
        playerId: 'p1',
        missed: 2,
        ghost: 1,
        avgPositionErrorM: 300,
        friendlyAvgErrorM: 50,
      }),
      ev(20, 'DRIFT_SAMPLE', {
        playerId: 'p1',
        missed: 1,
        ghost: 0,
        avgPositionErrorM: 100,
        friendlyAvgErrorM: 80,
      }),
      ev(10, 'DRIFT_SAMPLE', {
        playerId: 'p2',
        missed: 3,
        ghost: 0,
        avgPositionErrorM: 900,
        friendlyAvgErrorM: 0,
      }),
    ]);
    expect(s['p1']?.map((p) => p.avgPositionErrorM)).toEqual([300, 100]);
    expect(s['p2']?.[0]).toMatchObject({ tick: 10, missed: 3 });
  });

  it('counts messages per channel per bucket and carries the jamming level at the end of each bucket', () => {
    const events = [
      ev(3, 'MESSAGE_OUTCOME', { channel: 'VHF' }),
      ev(4, 'MESSAGE_OUTCOME', { channel: 'VHF' }),
      ev(12, 'MESSAGE_OUTCOME', { channel: 'HF' }),
      ev(15, 'JAMMING_CHANGED', {
        jamming: { VHF: 0.7, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
        satcomUp: true,
      }),
      ev(25, 'JAMMING_CHANGED', {
        jamming: { VHF: 0.7, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
        satcomUp: false,
      }),
    ];
    const s = channelSeries(input({ events, durationTicks: 30 }), 10);
    expect(s.map((b) => b.tick)).toEqual([0, 10, 20, 30]);
    expect(s[0]?.usage.VHF).toBe(2);
    expect(s[1]?.usage.HF).toBe(1);
    expect(s[0]?.jamming.VHF).toBe(0);
    expect(s[1]?.jamming.VHF).toBe(0.7);
    expect(s[1]?.satcomUp).toBe(true);
    expect(s[2]?.satcomUp).toBe(false);
  });
});

describe('messageFlow', () => {
  it('aggregates who talked to whom, per channel, with what was lost; unmanned senders keep their unit id', () => {
    const m = (kind: string, from: string, to: string, channel: string, outcome: string) =>
      ev(5, 'MESSAGE_OUTCOME', { kind, fromUnitId: from, toPlayerId: to, channel, outcome });
    const flow = messageFlow(
      input({
        events: [
          m('TEXT', 'b-pl', 'p2', 'VHF', 'DELIVERED'),
          m('TEXT', 'b-pl', 'p2', 'VHF', 'DROPPED'),
          m('TEXT', 'b-pl', 'p2', 'VHF', 'CORRUPTED'),
          m('TEXT', 'b-pl', 'p2', 'HF', 'DELAYED'),
          m('REPORT', 'b-hq', 'p1', 'VHF', 'DELIVERED'),
        ],
      }),
    );
    expect(flow[0]).toEqual({
      from: 'p1',
      to: 'p2',
      kind: 'TEXT',
      channel: 'VHF',
      total: 3,
      outcomes: { DELIVERED: 1, DELAYED: 0, DROPPED: 1, CORRUPTED: 1 },
    });
    expect(flow.find((e) => e.from === 'b-hq')).toMatchObject({
      to: 'p1',
      kind: 'REPORT',
      total: 1,
    });
    expect(flow).toHaveLength(3);
  });
});

describe('keyTimeline', () => {
  it('lists the story of the exercise in time order', () => {
    const t = keyTimeline(
      input({
        events: [
          ev(50, 'INJECT_FIRED', { title: 'Heavy jam', source: 'MSEL' }),
          ev(80, 'SPOOF_INJECTED', { playerId: 'p1', text: 'Withdraw' }),
          ev(90, 'AUTH_RESOLVED', { playerId: 'p1', result: 'FAILED' }),
          ev(60, 'CHANNEL_SWITCHED', { playerId: 'p2', from: 'VHF', to: 'HF' }),
          ev(55, 'JAMMING_CHANGED', {
            jamming: { VHF: 0.8, HF: 0.1, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
          }),
        ],
        decisions: [decision({ tick: 70, outcome: 1, actionType: 'ENGAGE' })],
      }),
    );
    expect(t.map((x) => x.kind)).toEqual([
      'INJECT',
      'JAMMING',
      'CHANNEL_SWITCH',
      'DECISION',
      'SPOOF',
      'AUTH',
    ]);
    expect(t[1]?.params).toEqual({ channel: 'VHF', level: 80 });
    expect(t[3]?.params).toMatchObject({ action: 'ENGAGE', outcome: 'correct' });
  });
});

describe('learning points: individual judgement', () => {
  it('flags acting on a report the trainee themself graded D-F, and on ghost contacts', () => {
    const events = [
      ev(10, 'REPORT_GENERATED', { reportId: 'rpt-1', ghost: false }),
      ev(10, 'REPORT_GENERATED', { reportId: 'rpt-2', ghost: true }),
      ev(40, 'REPORT_GRADED', {
        playerId: 'p1',
        reportId: 'rpt-1',
        gradedReliability: 'F',
        gradedCredibility: 6,
        trueReliability: 'F',
        trueCredibility: 6,
      }),
      ev(200, 'REPORT_GRADED', {
        playerId: 'p1',
        reportId: 'rpt-3',
        gradedReliability: 'F',
        gradedCredibility: 6,
        trueReliability: 'A',
        trueCredibility: 1,
      }),
    ];
    const decisions = [
      decision({ actionType: 'ENGAGE', tick: 50, targetContactId: 'rpt-1' }),
      decision({ actionType: 'REPORT_UP', tick: 60, targetContactId: 'rpt-1' }),
      decision({ actionType: 'ENGAGE', tick: 70, targetContactId: 'rpt-2' }),
      decision({ actionType: 'HOLD', tick: 80, targetContactId: 'rpt-1' }), // not an action on the contact
      decision({ actionType: 'ENGAGE', tick: 90, targetContactId: 'rpt-3' }), // graded later: not counted
    ];
    const pts = learningPoints(input({ events, decisions }));
    expect(pts.find((p) => p.rule === 'ACTED_ON_LOW_GRADE')?.params).toEqual({ count: 2 });
    expect(pts.find((p) => p.rule === 'ACTED_ON_GHOST')?.params).toEqual({ count: 1 });
  });

  it('handles spoofs: acted on, never authenticated, or handled well', () => {
    const spoof = (playerId: string) => ev(50, 'SPOOF_INJECTED', { playerId, text: 'x' });
    const events = [
      spoof('p1'),
      spoof('p2'),
      ev(60, 'AUTH_STARTED', { playerId: 'p2', messageId: 'm' }),
      ev(70, 'SPOOF_ACTED', { playerId: 'p1' }),
    ];
    const decisions = [
      decision({ playerId: 'p1', outcome: 0 }),
      decision({ playerId: 'p2', outcome: 1, tick: 120 }),
    ];
    expect(rules(input({ events, decisions }), 'p1')).toEqual(
      expect.arrayContaining(['ACTED_ON_SPOOF', 'NEVER_AUTHENTICATED']),
    );
    expect(rules(input({ events, decisions }), 'p2')).toContain('SPOOF_HANDLED_WELL');
    expect(rules(input({ events, decisions }), 'p2')).not.toContain('NEVER_AUTHENTICATED');
  });

  it('judges confidence calibration only with at least three scored decisions', () => {
    const mk = (conf: number, outcomes: (0 | 1)[]) =>
      outcomes.map((o) => decision({ confidence: conf, outcome: o }));
    expect(rules(input({ decisions: mk(90, [0, 0, 1]) }), 'p1')).toContain('OVERCONFIDENT');
    expect(rules(input({ decisions: mk(20, [1, 1, 1]) }), 'p1')).toContain('UNDERCONFIDENT');
    expect(rules(input({ decisions: mk(70, [1, 1, 0]) }), 'p1')).toContain('WELL_CALIBRATED');
    expect(rules(input({ decisions: mk(90, [0, 0]) }), 'p1')).not.toContain('OVERCONFIDENT');
    const p = learningPoints(input({ decisions: mk(90, [0, 0, 1]) })).find(
      (x) => x.rule === 'OVERCONFIDENT',
    );
    expect(p?.params).toEqual({ confidence: 90, accuracy: 33, decisions: 3 });
  });

  it('flags no decisions, slow decisions, grading quality, never grading, and picture drift', () => {
    expect(rules(input(), 'p2')).toContain('NO_DECISIONS');
    expect(
      rules(
        input({ decisions: [decision({ latencyTicks: 90 }), decision({ latencyTicks: 100 })] }),
        'p1',
      ),
    ).toContain('SLOW_DECISIONS');
    expect(rules(input({ decisions: [decision({ latencyTicks: 10 })] }), 'p1')).not.toContain(
      'SLOW_DECISIONS',
    );

    const grade = (reportId: string, graded: string, truth: string) =>
      ev(30, 'REPORT_GRADED', {
        playerId: 'p1',
        reportId,
        gradedReliability: graded,
        gradedCredibility: graded === 'A' ? 1 : 6,
        trueReliability: truth,
        trueCredibility: truth === 'A' ? 1 : 6,
      });
    const poor = [grade('a', 'A', 'F'), grade('b', 'A', 'F'), grade('c', 'A', 'F')];
    expect(rules(input({ events: poor }), 'p1')).toContain('GRADING_POOR');
    const good = [grade('a', 'A', 'A'), grade('b', 'F', 'F'), grade('c', 'A', 'A')];
    expect(rules(input({ events: good }), 'p1')).toContain('GRADING_GOOD');

    const received = Array.from({ length: 6 }, (_, i) =>
      ev(5, 'REPORT_RECEIVED', { playerId: 'p2', contactId: `c${i}` }),
    );
    expect(rules(input({ events: received }), 'p2')).toContain('NEVER_GRADED');

    const drift = [
      ev(10, 'DRIFT_SAMPLE', {
        playerId: 'p1',
        missed: 4,
        ghost: 0,
        avgPositionErrorM: 1500,
        friendlyAvgErrorM: 0,
      }),
    ];
    expect(
      learningPoints(input({ events: drift })).find((p) => p.rule === 'HIGH_DRIFT')?.params,
    ).toEqual({ errorM: 1500, missed: 4 });
  });
});

describe('learning points: communications', () => {
  const jam = (tick: number, vhf: number, hf = 0) =>
    ev(tick, 'JAMMING_CHANGED', {
      jamming: { VHF: vhf, HF: hf, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
      satcomUp: true,
    });
  const swap = (tick: number, to: string) =>
    ev(tick, 'CHANNEL_SWITCHED', { playerId: 'p1', teamId: 't1', from: 'VHF', to });
  const team = (i: AarInput) =>
    learningPoints(i).filter((p) => p.teamId === 't1' && p.playerId === null);

  it('flags a team that never left a heavily jammed channel (with how long)', () => {
    const pts = team(input({ events: [jam(100, 0.8)], durationTicks: 600 }));
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({
      rule: 'NO_SWITCH_WHILE_JAMMED',
      severity: 'warn',
      params: { team: 'Alpha', channel: 'VHF', seconds: 500 },
    });
  });

  it('flags a slow switch and praises a quick one', () => {
    const slow = team(input({ events: [jam(100, 0.8), swap(250, 'HF')] }));
    expect(slow[0]).toMatchObject({
      rule: 'SLOW_SWITCH',
      params: { channel: 'VHF', seconds: 150 },
    });
    const quick = team(input({ events: [jam(100, 0.8), swap(130, 'HF')] }));
    expect(quick[0]).toMatchObject({
      rule: 'QUICK_SWITCH',
      severity: 'good',
      params: { seconds: 30 },
    });
  });

  it('says nothing for light jamming, a short jam, or jamming on a channel the team is not using', () => {
    expect(team(input({ events: [jam(100, 0.3)] }))).toEqual([]);
    expect(team(input({ events: [jam(100, 0.9), jam(150, 0)] }))).toEqual([]);
    expect(team(input({ events: [jam(100, 0, 0.9)] }))).toEqual([]);
  });

  it('follows the team to its new channel: jamming there later counts against the new channel', () => {
    const pts = team(input({ events: [swap(20, 'HF'), jam(100, 0, 0.9)], durationTicks: 400 }));
    expect(pts[0]).toMatchObject({
      rule: 'NO_SWITCH_WHILE_JAMMED',
      params: { channel: 'HF', seconds: 300 },
    });
  });

  it('lists warnings first, then information, then good news', () => {
    const decisions = [
      decision({ confidence: 70, outcome: 1 }),
      decision({ confidence: 70, outcome: 1 }),
      decision({ confidence: 70, outcome: 0 }),
    ];
    const pts = learningPoints(input({ decisions, events: [jam(100, 0.9)] }));
    const sev = pts.map((p) => p.severity);
    expect(sev).toEqual(
      [...sev].sort(
        (a, b) => ({ warn: 0, info: 1, good: 2 })[a] - { warn: 0, info: 1, good: 2 }[b],
      ),
    );
    expect(sev[0]).toBe('warn');
  });
});

describe('analyzeExercise', () => {
  it('assembles per-player summaries, calibration, series, flow, timeline and learning points', () => {
    const decisions = [
      decision({ playerId: 'p1', confidence: 80, outcome: 1, latencyTicks: 10 }),
      decision({ playerId: 'p1', confidence: 60, outcome: 0, latencyTicks: 30, tick: 150 }),
      decision({ playerId: 'p2', confidence: 50, outcome: null }),
    ];
    const events = [
      ev(10, 'DRIFT_SAMPLE', {
        playerId: 'p1',
        missed: 1,
        ghost: 0,
        avgPositionErrorM: 200,
        friendlyAvgErrorM: 0,
      }),
      ev(12, 'MESSAGE_OUTCOME', {
        kind: 'TEXT',
        fromUnitId: 'b-pl',
        toPlayerId: 'p2',
        channel: 'VHF',
        outcome: 'DELIVERED',
      }),
    ];
    const a = analyzeExercise(input({ decisions, events, durationTicks: 100 }));
    const p1 = a.players.find((p) => p.playerId === 'p1');
    expect(p1).toMatchObject({
      name: 'Asha',
      decisionCount: 2,
      scoredDecisionCount: 2,
      meanConfidence: 70,
      accuracy: 50,
      avgLatencyTicks: 20,
    });
    expect(p1?.brierScore).toBeCloseTo((0.04 + 0.36) / 2, 9);
    expect(a.players.find((p) => p.playerId === 'p2')).toMatchObject({
      meanConfidence: null,
      accuracy: null,
    });
    expect(a.calibration.overall.length).toBeGreaterThan(0);
    expect(a.calibration.byPlayer['p2']).toEqual([]);
    expect(a.drift['p1']).toHaveLength(1);
    expect(a.channels.length).toBe(11);
    expect(a.flow).toHaveLength(1);
    expect(a.timeline.length).toBe(3);
    expect(Array.isArray(a.learning)).toBe(true);
  });

  it('is deterministic', () => {
    const i = input({
      decisions: [decision({ outcome: 1 })],
      events: [ev(1, 'DRIFT_SAMPLE', { playerId: 'p1' })],
    });
    expect(JSON.stringify(analyzeExercise(i))).toBe(JSON.stringify(analyzeExercise(i)));
  });
});
