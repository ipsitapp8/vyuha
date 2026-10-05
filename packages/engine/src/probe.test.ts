import { describe, expect, it } from 'vitest';
import { computePerceivedState } from './perceived';
import { jammedChannelOf, PROBE_WINDOW_TICKS, scoreProbe } from './probe';
import { getUnit } from './state';
import { makeScenario, makeState } from './testkit';
import { jam, ofType, run } from './testrun';
import type { EngineInput, ProbeScore, ProbeState } from './types';

const start = (probeId = 'probe-1'): EngineInput => ({ type: 'PROBE_START', probeId });
const scores = (events: ReturnType<typeof run>['events']): ProbeScore[] =>
  ofType(events, 'PROBE_SCORED').map((e) => e.payload as unknown as ProbeScore);

function opened() {
  const scenario = makeScenario({ msel: [jam('j', 1, 'VHF', 0.7, 500)] });
  const first = run(makeState({ scenario }), 5, { 5: [start()] });
  const probe = first.state.probes[0] as ProbeState;
  return { ...first, probe };
}

describe('SAGAT probe: lifecycle', () => {
  it('freezes the truth of the tick it starts on and tells trainees only that a probe is open', () => {
    const { state, events, probe } = opened();
    expect(probe.tick).toBe(5);
    expect(probe.hostiles.map((h) => h.unitId).sort()).toEqual(['r-ew', 'r-far', 'r-recce']);
    expect(probe.hostiles.find((h) => h.unitId === 'r-recce')?.position).toEqual(
      getUnit(state, 'r-recce')?.position,
    );
    expect(probe.jammedChannel).toBe('VHF');
    expect(probe.pending).toEqual(['p-pl', 'p-sec', 'p-uav']);

    const started = ofType(events, 'PROBE_STARTED')[0];
    expect(started?.visibleTo).toEqual(['p-pl', 'p-sec', 'p-uav', 'instructor']);
    expect(JSON.stringify(started?.payload)).not.toMatch(/r-recce|hostiles|jammedChannel/);
    expect(ofType(events, 'PROBE_TRUTH')[0]?.visibleTo).toEqual(['instructor']);

    const seen = computePerceivedState(state, 'p-sec');
    expect(seen.probe).toEqual({ id: 'probe-1', tick: 5, expiresAtTick: 5 + PROBE_WINDOW_TICKS });
    expect(JSON.stringify(seen.probe)).not.toMatch(/r-|hostile/);
  });

  it('scores an answer for the instructor only and never shows the trainee the score', () => {
    const { state, probe } = opened();
    const recce = probe.hostiles.find((h) => h.unitId === 'r-recce')!.position;
    const answer: EngineInput = {
      type: 'PROBE_ANSWER',
      playerId: 'p-pl',
      probeId: 'probe-1',
      contacts: [recce],
      teammates: [],
      jammedChannel: 'VHF',
    };
    const after = run(state, 1, { 6: [answer] });
    const [score] = scores(after.events);
    expect(score?.playerId).toBe('p-pl');
    expect(score?.answered).toBe(true);
    expect(score?.matched).toEqual([{ unitId: 'r-recce', marker: 0, errorM: 0 }]);
    expect(score?.missedUnitIds.sort()).toEqual(['r-ew', 'r-far']);
    expect(score?.channelCorrect).toBe(true);
    expect(ofType(after.events, 'PROBE_SCORED')[0]?.visibleTo).toEqual(['instructor']);

    const mine = after.events.filter((e) => e.visibleTo.includes('p-pl'));
    expect(mine.map((e) => e.type)).toContain('PROBE_ANSWERED');
    expect(JSON.stringify(mine)).not.toMatch(/"score"|missedUnitIds|r-recce/);
    expect(computePerceivedState(after.state, 'p-pl').probe).toBeNull();
    expect(computePerceivedState(after.state, 'p-sec').probe?.id).toBe('probe-1');
  });

  it('refuses a second answer, an unknown probe and an invalid position', () => {
    const { state } = opened();
    const base: Extract<EngineInput, { type: 'PROBE_ANSWER' }> = {
      type: 'PROBE_ANSWER',
      playerId: 'p-pl',
      probeId: 'probe-1',
      contacts: [],
      teammates: [],
      jammedChannel: 'NONE',
    };
    const after = run(state, 1, {
      6: [
        base,
        base,
        { ...base, playerId: 'p-sec', probeId: 'nope' },
        { ...base, playerId: 'p-uav', contacts: [{ lat: 999, lon: 0 }] },
      ],
    });
    expect(ofType(after.events, 'INPUT_REJECTED')).toHaveLength(3);
    expect(scores(after.events)).toHaveLength(1);
  });

  it('closes after the answer window and scores the silent trainees zero', () => {
    const { state } = opened();
    const answer: EngineInput = {
      type: 'PROBE_ANSWER',
      playerId: 'p-pl',
      probeId: 'probe-1',
      contacts: [],
      teammates: [],
      jammedChannel: 'VHF',
    };
    const later = run(state, PROBE_WINDOW_TICKS, { 6: [answer] });
    expect(later.state.probes).toEqual([]);
    const all = scores(later.events);
    expect(all.map((s) => [s.playerId, s.answered, s.score]).sort()).toEqual([
      ['p-pl', true, expect.any(Number)],
      ['p-sec', false, 0],
      ['p-uav', false, 0],
    ]);
    expect(ofType(later.events, 'PROBE_CLOSED')).toHaveLength(1);
    expect(computePerceivedState(later.state, 'p-sec').probe).toBeNull();
  });

  it('closes as soon as everyone has answered, and a new probe closes the one before it', () => {
    const { state } = opened();
    const all = (['p-pl', 'p-sec', 'p-uav'] as const).map((playerId): EngineInput => ({
      type: 'PROBE_ANSWER',
      playerId,
      probeId: 'probe-1',
      contacts: [],
      teammates: [],
      jammedChannel: 'NONE',
    }));
    const done = run(state, 1, { 6: all });
    expect(done.state.probes).toEqual([]);
    expect(ofType(done.events, 'PROBE_CLOSED')).toHaveLength(1);

    const second = run(state, 1, { 6: [start('probe-2')] });
    expect(second.state.probes.map((p) => p.id)).toEqual(['probe-2']);
    expect(scores(second.events).filter((s) => s.probeId === 'probe-1')).toHaveLength(3);
  });

  it('PROBE_CLOSE (the exercise is ending) scores answers queued before it and zeroes the rest', () => {
    const { state } = opened();
    const after = run(state, 1, {
      6: [
        {
          type: 'PROBE_ANSWER',
          playerId: 'p-sec',
          probeId: 'probe-1',
          contacts: [],
          teammates: [],
          jammedChannel: 'VHF',
        },
        { type: 'PROBE_CLOSE' },
      ],
    });
    expect(after.state.probes).toEqual([]);
    expect(
      scores(after.events)
        .map((s) => [s.playerId, s.answered])
        .sort(),
    ).toEqual([
      ['p-pl', false],
      ['p-sec', true],
      ['p-uav', false],
    ]);
  });

  it('is deterministic: the same inputs give the same scores', () => {
    const scenario = makeScenario();
    const plan = {
      20: [start()],
      24: [
        {
          type: 'PROBE_ANSWER',
          playerId: 'p-sec',
          probeId: 'probe-1',
          contacts: [{ lat: 34.11, lon: 77.05 }],
          teammates: [{ unitId: 'b-pl', position: { lat: 34.1, lon: 77.04 } }],
          jammedChannel: 'NONE',
        } satisfies EngineInput,
      ],
    };
    const a = run(makeState({ scenario }), 60, plan);
    const b = run(makeState({ scenario }), 60, plan);
    expect(scores(a.events)).toEqual(scores(b.events));
    expect(a.state.rngState).toBe(b.state.rngState);
  });
});

describe('SAGAT probe: scoring', () => {
  const probe: ProbeState = {
    id: 'p',
    tick: 10,
    expiresAtTick: 40,
    hostiles: [
      { unitId: 'r1', type: 'RECCE', position: { lat: 34.1, lon: 77.1 } },
      { unitId: 'r2', type: 'DRONE', position: { lat: 34.15, lon: 77.15 } },
    ],
    friendlies: [
      { playerId: 'me', unitId: 'b-me', position: { lat: 34.0, lon: 77.0 } },
      { playerId: 'mate', unitId: 'b-mate', position: { lat: 34.05, lon: 77.05 } },
      { playerId: 'other', unitId: 'b-other', position: { lat: 34.19, lon: 77.19 } },
    ],
    jammedChannel: 'HF',
    pending: ['me', 'mate', 'other'],
  };
  const team = ['me', 'mate'];

  it('a perfect answer scores 100', () => {
    const s = scoreProbe(probe, 'me', team, {
      contacts: [probe.hostiles[1]!.position, probe.hostiles[0]!.position],
      teammates: [{ unitId: 'b-mate', position: { lat: 34.05, lon: 77.05 } }],
      jammedChannel: 'HF',
    });
    expect(s.score).toBe(100);
    expect(s.missedUnitIds).toEqual([]);
    expect(s.ghostCount).toBe(0);
    expect(s.avgContactErrorM).toBe(0);
    expect(s.avgTeammateErrorM).toBe(0);
    // only the trainee's own team is asked about
    expect(s.teammateErrors.map((t) => t.unitId)).toEqual(['b-mate']);
  });

  it('counts missed units, ghost markers and position error', () => {
    const s = scoreProbe(probe, 'me', team, {
      // ~1.1 km north of r1, and one marker nowhere near anything
      contacts: [
        { lat: 34.11, lon: 77.1 },
        { lat: 34.0, lon: 77.19 },
      ],
      teammates: [],
      jammedChannel: 'VHF',
    });
    expect(s.matched).toHaveLength(1);
    expect(s.matched[0]?.unitId).toBe('r1');
    expect(s.matched[0]?.errorM).toBeGreaterThan(1000);
    expect(s.matched[0]?.errorM).toBeLessThan(1200);
    expect(s.missedUnitIds).toEqual(['r2']);
    expect(s.ghostCount).toBe(1);
    expect(s.channelCorrect).toBe(false);
    expect(s.teammateErrors).toEqual([{ unitId: 'b-mate', errorM: null }]);
    expect(s.teammateScore).toBe(0);
    // one of two contacts, about 63% close: 0.5 * 0.315 * 100
    expect(s.score).toBeGreaterThan(13);
    expect(s.score).toBeLessThan(18);
  });

  it('each unit and each marker is matched once, nearest pair first', () => {
    const s = scoreProbe(probe, 'me', team, {
      contacts: [
        { lat: 34.101, lon: 77.1 },
        { lat: 34.1, lon: 77.1 },
      ],
      teammates: [],
      jammedChannel: 'HF',
    });
    expect(s.matched).toEqual([{ unitId: 'r1', marker: 1, errorM: 0 }]);
    expect(s.ghostCount).toBe(1);
  });

  it('no answer scores zero; nothing to find and nothing marked scores the contact part in full', () => {
    expect(scoreProbe(probe, 'me', team, null)).toMatchObject({ answered: false, score: 0 });
    const empty: ProbeState = { ...probe, hostiles: [], jammedChannel: 'NONE' };
    const s = scoreProbe(empty, 'me', ['me'], {
      contacts: [],
      teammates: [],
      jammedChannel: 'NONE',
    });
    expect(s.score).toBe(100);
  });

  it('picks the most jammed channel, or NONE below the threshold', () => {
    const none = { VHF: 0.1, HF: 0.2, SATCOM: 0, DATALINK: 0.29, RUNNER: 0 };
    expect(jammedChannelOf(none)).toBe('NONE');
    expect(jammedChannelOf({ ...none, HF: 0.5, DATALINK: 0.8 })).toBe('DATALINK');
    expect(jammedChannelOf({ ...none, VHF: 0.3 })).toBe('VHF');
  });
});
