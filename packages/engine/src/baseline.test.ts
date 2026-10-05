import { describe, expect, it } from 'vitest';
import type { Inject } from '@vyuha/shared';
import { computePerceivedState } from './perceived';
import { createTruthState, currentJamming } from './state';
import { CLEAR, makeRoster, makeScenario, makeTerrain } from './testkit';
import { jam, ofType, run, sendText, spoof } from './testrun';
import type { EngineInput } from './types';

const msel: Inject[] = [
  jam('jam-vhf', 5, 'VHF', 0.8, 600),
  { id: 'sat', tick: 6, title: 'sat', type: 'SATCOM_OUTAGE', durationTicks: 600 },
  spoof(8),
  {
    id: 'conf',
    tick: 9,
    title: 'conf',
    type: 'CONFLICTING_REPORTS',
    unitId: 'r-recce',
    altPosition: { lat: 34.15, lon: 77.1 },
    altType: 'DRONE',
  },
  {
    id: 'gps',
    tick: 10,
    title: 'gps',
    type: 'GPS_SPOOF',
    unitId: 'b-uav',
    offsetM: 2000,
    bearingDeg: 0,
    durationTicks: 300,
  },
  {
    id: 'c2',
    tick: 11,
    title: 'c2',
    type: 'C2_COMPROMISE',
    targetUnitId: 'b-pl',
    driftMps: 10,
    durationTicks: 300,
  },
  {
    id: 'move',
    tick: 12,
    title: 'move',
    type: 'ADVERSARY_MOVE',
    unitId: 'r-recce',
    destination: { lat: 34.11, lon: 77.05 },
  },
  {
    id: 'wx',
    tick: 13,
    title: 'wx',
    type: 'WEATHER_CHANGE',
    visibilityM: 4000,
    precipitationMm: 1,
    windKph: 20,
  },
];
// a ridge between the two halves of the team makes VHF across it unreliable in a degraded run
const state = (clean: boolean) =>
  createTruthState(makeScenario({ msel }), makeTerrain(3000, 4500), CLEAR, 7, makeRoster(), {
    clean,
  });
const traffic = (): Record<number, EngineInput[]> => {
  const plan: Record<number, EngineInput[]> = {};
  for (let t = 20; t < 220; t += 4)
    plan[t] = [sendText(`Report ${t} grid 1234 5678`, 'VHF', 'p-pl', 'p-sec')];
  return plan;
};

describe('baseline (clean) run', () => {
  it('skips every degrading inject and keeps the tactical ones', () => {
    const { state: end, events } = run(state(true), 40);
    const skipped = ofType(events, 'INJECT_SKIPPED').map((e) => e.payload['type']);
    expect(skipped.sort()).toEqual(
      [
        'C2_COMPROMISE',
        'CONFLICTING_REPORTS',
        'GPS_SPOOF',
        'JAM_CHANNEL',
        'SATCOM_OUTAGE',
        'SPOOF_ORDER',
      ].sort(),
    );
    expect(
      ofType(events, 'INJECT_FIRED')
        .map((e) => e.payload['type'])
        .sort(),
    ).toEqual(['ADVERSARY_MOVE', 'WEATHER_CHANGE']);
    expect(ofType(events, 'SPOOF_INJECTED')).toEqual([]);
    expect(end.gpsSpoofs).toEqual([]);
    expect(end.c2Compromises).toEqual([]);
    expect(end.weather.visibilityM).toBe(4000);
    expect(Object.values(currentJamming(end)).every((v) => v === 0)).toBe(true);
    expect(computePerceivedState(end, 'p-pl').inbox.some((m) => m.kind === 'ORDER')).toBe(false);
  });

  it('delivers every message intact after the channel latency: no drop, delay or corruption', () => {
    const clean = run(state(true), 240, traffic());
    const outcomes = ofType(clean.events, 'MESSAGE_OUTCOME');
    expect(outcomes.length).toBeGreaterThan(50);
    expect(new Set(outcomes.map((e) => e.payload['outcome']))).toEqual(new Set(['DELIVERED']));
    expect(outcomes.every((e) => e.payload['deliveredText'] === e.payload['originalText'])).toBe(
      true,
    );
    const sent = outcomes.filter((e) => e.payload['kind'] === 'TEXT');
    expect(sent).toHaveLength(50);
    expect(
      sent.every((e) => e.payload['delayTicks'] === 1 && e.payload['queueDelayTicks'] === 0),
    ).toBe(true);
    expect(
      ofType(clean.events, 'MESSAGE_RECEIVED').filter((e) => e.payload['playerId'] === 'p-sec'),
    ).toHaveLength(50);

    // the same seed and inputs, degraded: the ridge and the jamming lose or damage traffic
    const degraded = run(state(false), 240, traffic());
    const bad = ofType(degraded.events, 'MESSAGE_OUTCOME').filter(
      (e) => e.payload['kind'] === 'TEXT' && e.payload['outcome'] !== 'DELIVERED',
    );
    expect(bad.length).toBeGreaterThan(10);
  });

  it('refuses live degradation: instructor jamming and degrading live injects', () => {
    const live: EngineInput[] = [
      { type: 'SET_JAMMING', channel: 'HF', intensity: 0.9 },
      { type: 'INJECT', inject: jam('live-jam', 30, 'HF', 0.9, 100) },
    ];
    const { state: end, events } = run(state(true), 32, { 30: live });
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(1);
    expect(ofType(events, 'INJECT_SKIPPED').some((e) => e.payload['injectId'] === 'live-jam')).toBe(
      true,
    );
    expect(currentJamming(end).HF).toBe(0);
  });

  it('never adapts jamming to the team, and is deterministic', () => {
    const a = run(state(true), 240, traffic());
    const b = run(state(true), 240, traffic());
    expect(ofType(a.events, 'EW_ADAPTED')).toEqual([]);
    expect(ofType(a.events, 'JAMMING_CHANGED')).toEqual([]);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.state.clean).toBe(true);
    // and an ordinary run is untouched by the flag's existence
    expect(state(false).clean).toBe(false);
  });
});
