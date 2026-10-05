import { describe, expect, it } from 'vitest';
import type { Inject } from '@vyuha/shared';
import { keyTimeline, learningPoints, type AarInput } from './aar';
import { haversineM } from './geometry';
import { computePictureDrift } from './metrics';
import { computePerceivedState } from './perceived';
import { mulberry32 } from './prng';
import { makeRealReport } from './reports';
import { C2_MAX_DRIFT_M, getUnit } from './state';
import { makeScenario, makeState, unit } from './testkit';
import { ofType, run } from './testrun';
import type { EngineEvent, EngineInput, Report } from './types';

const gpsSpoof = (over: Partial<Extract<Inject, { type: 'GPS_SPOOF' }>> = {}): Inject => ({
  id: 'gps-1',
  tick: 5,
  title: 'GPS spoof',
  type: 'GPS_SPOOF',
  unitId: 'b-uav',
  offsetM: 2000,
  bearingDeg: 90,
  durationTicks: 300,
  ...over,
});
const c2 = (over: Partial<Extract<Inject, { type: 'C2_COMPROMISE' }>> = {}): Inject => ({
  id: 'c2-1',
  tick: 5,
  title: 'C2 node compromised',
  type: 'C2_COMPROMISE',
  targetUnitId: 'b-pl',
  driftMps: 10,
  durationTicks: 600,
  ...over,
});
const uavReports = (events: EngineEvent[]): EngineEvent[] =>
  ofType(events, 'REPORT_GENERATED').filter((e) => e.payload['sensorUnitId'] === 'b-uav');

describe('UAV ISR asset', () => {
  it('a UAV tasked through REQUEST_ISR reports one reliability grade better', () => {
    const s = makeState();
    const uav = getUnit(s, 'b-uav')!;
    const subject = getUnit(s, 'r-recce')!;
    const plain = makeRealReport(s, mulberry32(11), uav, subject);
    uav.isrUntilTick = 500;
    const tasked = makeRealReport(s, mulberry32(11), uav, subject);
    expect(plain.trueReliability).toBe('B');
    expect(tasked.trueReliability).toBe('A');
    expect(haversineM(tasked.position, subject.position)).toBeLessThan(
      haversineM(plain.position, subject.position),
    );
  });
});

describe('GPS spoof on the UAV', () => {
  it('shifts everything the UAV reports by one consistent offset and tells no trainee', () => {
    const clean = run(makeState({ scenario: makeScenario() }), 200);
    const spoofed = run(makeState({ scenario: makeScenario({ msel: [gpsSpoof()] }) }), 200);

    const started = ofType(spoofed.events, 'GPS_SPOOF_STARTED');
    expect(started).toHaveLength(1);
    expect(started[0]?.visibleTo).toEqual(['instructor']);

    // the spoof draws no random numbers, so the two runs sense the same things: only the place differs
    const a = uavReports(clean.events).filter((e) => e.tick >= 5);
    const b = uavReports(spoofed.events).filter((e) => e.tick >= 5);
    expect(b.length).toBeGreaterThan(0);
    expect(b.map((e) => e.payload['reportId'])).toEqual(a.map((e) => e.payload['reportId']));
    b.forEach((e, i) => {
      const was = a[i]?.payload['position'] as { lat: number; lon: number };
      const is = e.payload['position'] as { lat: number; lon: number };
      expect(e.payload['gpsSpoofed']).toBe(true);
      expect(haversineM(was, is)).toBeGreaterThan(1960);
      expect(haversineM(was, is)).toBeLessThan(2040);
      expect(is.lon).toBeGreaterThan(was.lon); // east
      expect(Math.abs(is.lat - was.lat)).toBeLessThan(0.0005);
    });
    // reports from the other sensors are untouched
    const others = ofType(spoofed.events, 'REPORT_GENERATED').filter(
      (e) => e.payload['sensorUnitId'] !== 'b-uav',
    );
    expect(others.every((e) => e.payload['gpsSpoofed'] === false)).toBe(true);

    // nothing a trainee receives says "spoof"
    const toTrainees = spoofed.events.filter((e) => e.visibleTo.some((v) => v !== 'instructor'));
    expect(JSON.stringify(toTrainees)).not.toMatch(/gpsSpoofed|GPS_SPOOF/);
    expect(JSON.stringify(computePerceivedState(spoofed.state, 'p-uav'))).not.toMatch(/spoof/i);
  });

  it("the operator's own marker and the teammates' fix on the UAV carry the same offset", () => {
    const { state } = run(makeState({ scenario: makeScenario({ msel: [gpsSpoof()] }) }), 60);
    const truth = getUnit(state, 'b-uav')!.position;
    const self = computePerceivedState(state, 'p-uav').self.position;
    expect(haversineM(self, truth)).toBeGreaterThan(1960);
    expect(haversineM(self, truth)).toBeLessThan(2040);
    const seenByPl = computePerceivedState(state, 'p-pl').friendlies.find(
      (f) => f.unitId === 'b-uav',
    );
    expect(seenByPl).toBeDefined();
    expect(haversineM(seenByPl!.position, truth)).toBeGreaterThan(1500);
    // other units report honestly
    expect(computePerceivedState(state, 'p-pl').self.position).toEqual(
      getUnit(state, 'b-pl')!.position,
    );
  });

  it('ends after its duration, and is refused for anything but a friendly air unit', () => {
    const scenario = makeScenario({
      msel: [
        gpsSpoof({ durationTicks: 20 }),
        gpsSpoof({ id: 'gps-land', unitId: 'b-pl' }),
        gpsSpoof({ id: 'gps-red', unitId: 'r-recce' }),
        gpsSpoof({ id: 'gps-none', unitId: 'nope' }),
      ],
    });
    const { state, events } = run(makeState({ scenario }), 40);
    expect(ofType(events, 'INJECT_FAILED')).toHaveLength(3);
    expect(ofType(events, 'GPS_SPOOF_ENDED')).toHaveLength(1);
    expect(state.gpsSpoofs).toEqual([]);
    expect(computePerceivedState(state, 'p-uav').self.position).toEqual(
      getUnit(state, 'b-uav')!.position,
    );
  });

  it('engaging a contact from the spoofed UAV is wrong and is logged for the review', () => {
    const first = run(makeState({ scenario: makeScenario({ msel: [gpsSpoof()] }) }), 200);
    const contact = first.state.knowledge['p-uav']!.reports.find((r) => {
      const truth = first.state.reports.find((x: Report) => x.id === r.reportId);
      return truth?.gpsSpoofed && !truth.ghost;
    });
    expect(contact).toBeDefined();
    const decide: EngineInput = {
      type: 'DECISION',
      playerId: 'p-uav',
      actionType: 'ENGAGE',
      confidence: 90,
      rationale: 'UAV has eyes on the target',
      targetContactId: contact!.reportId,
    };
    const { events } = run(first.state, 1, { 201: [decide] });
    expect(ofType(events, 'DECISION_MADE')[0]?.payload['outcome']).toBe(0);
    const acted = ofType(events, 'SPOOFED_UAV_ACTED');
    expect(acted).toHaveLength(1);
    expect(acted[0]?.visibleTo).toEqual(['instructor']);
  });
});

describe('C2 node compromised', () => {
  const errorOf = (state: ReturnType<typeof run>['state'], playerId: string, unitId: string) => {
    const seen = computePerceivedState(state, playerId).friendlies.find((f) => f.unitId === unitId);
    const fix = state.knowledge[playerId]!.friendlies[unitId]!;
    return haversineM(seen!.position, fix.position);
  };

  it('makes one trainee see teammates slide out of place, silently, up to a limit', () => {
    const scenario = makeScenario({ msel: [c2()] });
    const early = run(makeState({ scenario }), 25);
    const started = ofType(early.events, 'C2_COMPROMISED');
    expect(started).toHaveLength(1);
    expect(started[0]?.visibleTo).toEqual(['instructor']);
    expect(started[0]?.payload['channel']).toBe('VHF');
    const toVictim = early.events.filter((e) => e.visibleTo.includes('p-pl'));
    expect(JSON.stringify(toVictim)).not.toMatch(/C2_|compromis/i);

    // 20 ticks at 10 m/s
    expect(errorOf(early.state, 'p-pl', 'b-sec')).toBeGreaterThan(190);
    expect(errorOf(early.state, 'p-pl', 'b-sec')).toBeLessThan(210);
    // the other trainees' pictures are honest
    expect(errorOf(early.state, 'p-sec', 'b-pl')).toBe(0);

    const late = run(early.state, 575);
    expect(errorOf(late.state, 'p-pl', 'b-sec')).toBeLessThanOrEqual(C2_MAX_DRIFT_M + 1);
    expect(errorOf(late.state, 'p-pl', 'b-sec')).toBeGreaterThan(C2_MAX_DRIFT_M - 50);
    // and the drift meter the instructor sees reflects what the trainee believes
    const honest = run(makeState({ scenario: makeScenario() }), 400);
    const lied = run(makeState({ scenario }), 400);
    expect(computePictureDrift(lied.state, 'p-pl').friendlyAvgErrorM).toBeGreaterThan(
      computePictureDrift(honest.state, 'p-pl').friendlyAvgErrorM + 1000,
    );
  });

  it('traffic on the same net does not expose it; a teammate over another channel does', () => {
    const scenario = makeScenario({ msel: [c2()] });
    const text = (channel: 'VHF' | 'HF', from = 'p-uav'): EngineInput => ({
      type: 'SEND_MESSAGE',
      playerId: from,
      toPlayerId: 'p-pl',
      channel,
      text: 'My position is as sent',
    });
    const same = run(makeState({ scenario }), 60, { 20: [text('VHF')] });
    expect(
      ofType(same.events, 'MESSAGE_RECEIVED').some((e) => e.payload['playerId'] === 'p-pl'),
    ).toBe(true);
    expect(ofType(same.events, 'C2_COMPROMISE_DETECTED')).toHaveLength(0);
    expect(same.state.c2Compromises).toHaveLength(1);

    const other = run(makeState({ scenario }), 60, { 20: [text('HF')] });
    const detected = ofType(other.events, 'C2_COMPROMISE_DETECTED');
    expect(detected).toHaveLength(1);
    expect(detected[0]?.visibleTo).toEqual(['p-pl', 'instructor']);
    expect(detected[0]?.payload).toMatchObject({ playerId: 'p-pl', via: 'HF', sinceTick: 5 });
    expect(other.state.c2Compromises).toEqual([]);
    expect(errorOf(other.state, 'p-pl', 'b-sec')).toBe(0);
  });

  it('switching the team net exposes it on the next beacon; so does a runner', () => {
    const scenario = makeScenario({ msel: [c2()] });
    const switched = run(makeState({ scenario }), 80, {
      20: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'HF' }],
    });
    expect(ofType(switched.events, 'C2_COMPROMISE_DETECTED')[0]?.payload['via']).toBe('HF');

    const near = makeScenario({
      initialUnits: [
        unit('b-pl', 'BLUE', 'LAND', 'INFANTRY_PLATOON', 34.1, 77.03),
        unit('b-sec', 'BLUE', 'LAND', 'INFANTRY_SECTION', 34.1005, 77.0305),
        unit('b-uav', 'BLUE', 'AIR', 'DRONE', 34.12, 77.05, { speed: 20 }),
        unit('r-ew', 'RED', 'EW', 'EW_JAMMER', 34.15, 77.1),
      ],
      msel: [
        c2(),
        {
          id: 'run-1',
          tick: 10,
          title: 'runner',
          type: 'RUNNER_DISPATCH',
          fromUnitId: 'b-sec',
          toUnitId: 'b-pl',
          messageText: 'Section 1 is at the bridge',
        },
      ],
    });
    const byRunner = run(makeState({ scenario: near }), 80);
    expect(ofType(byRunner.events, 'RUNNER_ARRIVED')).toHaveLength(1);
    expect(ofType(byRunner.events, 'C2_COMPROMISE_DETECTED')[0]?.payload['via']).toBe('RUNNER');
  });

  it('runs out by itself if never caught, needs a trainee on the unit, and is deterministic', () => {
    const scenario = makeScenario({
      msel: [c2({ durationTicks: 30 }), c2({ id: 'c2-hq', targetUnitId: 'b-hq' })],
    });
    const a = run(makeState({ scenario }), 50);
    const b = run(makeState({ scenario }), 50);
    expect(ofType(a.events, 'INJECT_FAILED')).toHaveLength(1);
    expect(ofType(a.events, 'C2_COMPROMISE_ENDED')).toHaveLength(1);
    expect(a.state.c2Compromises).toEqual([]);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    const mid = run(makeState({ scenario }), 10);
    expect(Object.keys(mid.state.c2Compromises[0]!.bearings).sort()).toEqual(['b-sec', 'b-uav']);
  });
});

describe('review of the air and cyber injects', () => {
  const ev = (tick: number, type: string, payload: Record<string, unknown>): EngineEvent => ({
    tick,
    type,
    payload,
    visibleTo: ['instructor'],
  });
  const input = (events: EngineEvent[]): AarInput => ({
    durationTicks: 600,
    players: [
      { id: 'p1', name: 'Asha', role: 'ISR_OPERATOR', teamId: 't', unitId: 'b-uav' },
      { id: 'p2', name: 'Bilal', role: 'PL_CDR', teamId: 't', unitId: 'b-pl' },
      { id: 'p3', name: 'Chen', role: 'SECTION_CDR', teamId: 't', unitId: 'b-sec' },
    ],
    teams: [{ id: 't', name: 'Alpha', primary: 'VHF' }],
    events,
    decisions: [],
  });
  const rules = (i: AarInput, playerId: string) =>
    learningPoints(i).filter((p) => p.playerId === playerId);

  it('names acting on spoofed UAV data, and credits grading it down', () => {
    const events = [
      ev(100, 'REPORT_GENERATED', { reportId: 'rpt-9', gpsSpoofed: true }),
      ev(130, 'SPOOFED_UAV_ACTED', { playerId: 'p1', reportId: 'rpt-9' }),
      ev(140, 'REPORT_GRADED', {
        playerId: 'p2',
        reportId: 'rpt-9',
        gradedReliability: 'E',
        gradedCredibility: 5,
      }),
    ];
    const p1 = rules(input(events), 'p1');
    expect(p1.find((p) => p.rule === 'ACTED_ON_SPOOFED_UAV')).toMatchObject({
      severity: 'warn',
      params: { count: 1 },
    });
    expect(rules(input(events), 'p2').map((p) => p.rule)).toContain('GPS_SPOOF_SUSPECTED');
    expect(keyTimeline(input(events)).map((t) => t.kind)).toContain('UAV_SPOOF_ACTED');
  });

  it('says when a C2 compromise was caught, and when it never was', () => {
    const events = [
      ev(60, 'C2_COMPROMISED', { playerId: 'p2', untilTick: 500 }),
      ev(185, 'C2_COMPROMISE_DETECTED', { playerId: 'p2', via: 'HF', afterTicks: 125 }),
      ev(200, 'C2_COMPROMISED', { playerId: 'p3', untilTick: 900 }),
    ];
    expect(rules(input(events), 'p2').find((p) => p.rule === 'C2_DETECTED')).toMatchObject({
      severity: 'good',
      params: { time: '03:05', tick: 185, seconds: 125, via: 'HF' },
    });
    expect(rules(input(events), 'p3').find((p) => p.rule === 'C2_NOT_DETECTED')).toMatchObject({
      severity: 'warn',
      params: { seconds: 400 },
    });
    const item = keyTimeline(input(events)).find((t) => t.kind === 'C2_DETECTED');
    expect(item).toMatchObject({ tick: 185, playerId: 'p2', params: { via: 'HF', seconds: 125 } });
  });
});
