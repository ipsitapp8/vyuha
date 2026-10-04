import { describe, expect, it } from 'vitest';
import { haversineM } from './geometry';
import { mulberry32 } from './prng';
import { currentJamming, getUnit, satcomUp } from './state';
import { step } from './step';
import { jam, ofType, run, sendText, spoof, type Plan } from './testrun';
import { BBOX, makeRoster, makeScenario, makeState, makeTerrain } from './testkit';
import type { EngineInput } from './types';

describe('step basics', () => {
  it('advances the tick and never mutates the input state', () => {
    const s0 = makeState();
    const before = JSON.stringify(s0);
    const { state } = step(s0, [], mulberry32(s0.rngState));
    expect(state.tick).toBe(1);
    expect(s0.tick).toBe(0);
    expect(JSON.stringify(s0)).toBe(before);
    expect(state.terrain).toBe(s0.terrain);
  });

  it('is deterministic: same seed + inputs = identical state and events after 600 ticks', () => {
    const scenario = makeScenario({
      msel: [
        jam('j1', 40, 'VHF', 0.5, 200),
        spoof(100),
        {
          id: 'c1',
          tick: 120,
          title: 'conflict',
          type: 'CONFLICTING_REPORTS',
          unitId: 'r-recce',
          altPosition: { lat: 34.19, lon: 77.19 },
          altType: 'MECH_INFANTRY_SECTION',
        },
        {
          id: 'w1',
          tick: 200,
          title: 'w',
          type: 'WEATHER_CHANGE',
          visibilityM: 900,
          precipitationMm: 5,
          windKph: 30,
        },
        { id: 's1', tick: 300, title: 's', type: 'SATCOM_OUTAGE', durationTicks: 100 },
        {
          id: 'a1',
          tick: 150,
          title: 'a',
          type: 'ADVERSARY_MOVE',
          unitId: 'r-recce',
          destination: { lat: 34.12, lon: 77.06 },
        },
      ],
    });
    const plan: Plan = {};
    for (let t = 10; t <= 580; t += 20) plan[t] = [sendText(`Report at grid ${t}`)];
    plan[60] = [{ type: 'REQUEST_ISR', playerId: 'p-pl', target: { lat: 34.11, lon: 77.05 } }];
    const a = run(makeState({ scenario, seed: 123 }), 600, plan);
    const b = run(makeState({ scenario, seed: 123 }), 600, plan);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.events.length).toBeGreaterThan(100);
    const c = run(makeState({ scenario, seed: 124 }), 600, plan);
    expect(JSON.stringify(c.events)).not.toBe(JSON.stringify(a.events));
  });

  it('stores the rng state so a run can resume exactly where it stopped', () => {
    const s0 = makeState({ seed: 55 });
    const full = run(s0, 120);
    const first = run(s0, 70);
    const resumed = run(first.state, 50);
    expect(JSON.stringify(resumed.state)).toBe(JSON.stringify(full.state));
  });

  it('only shows truth-bearing events to the instructor', () => {
    const scenario = makeScenario({ msel: [spoof(20), jam('j', 10, 'VHF', 0.4, 100)] });
    const { events } = run(makeState({ scenario }), 300, { 5: [sendText()], 30: [] });
    const truthTypes = [
      'MESSAGE_OUTCOME',
      'REPORT_GENERATED',
      'SPOOF_INJECTED',
      'JAMMING_CHANGED',
      'DRIFT_SAMPLE',
      'INJECT_FIRED',
    ];
    for (const t of truthTypes) {
      const list = ofType(events, t);
      expect(list.length).toBeGreaterThan(0);
      for (const e of list) expect(e.visibleTo).toEqual(['instructor']);
    }
    for (const e of events) expect(e.visibleTo.length).toBeGreaterThan(0);
  });
});

describe('injects', () => {
  it('fires a scheduled jam exactly once, jams the channel, announces it, and lets it expire', () => {
    const scenario = makeScenario({ msel: [jam('j1', 5, 'VHF', 0.6, 10)] });
    const s0 = makeState({ scenario });
    const during = run(s0, 8);
    expect(ofType(during.events, 'INJECT_FIRED')).toHaveLength(1);
    expect(currentJamming(during.state).VHF).toBeCloseTo(0.6, 9);
    expect(ofType(during.events, 'JAMMING_CHANGED').length).toBeGreaterThan(0);
    const after = run(s0, 30);
    expect(ofType(after.events, 'INJECT_FIRED')).toHaveLength(1);
    // the scripted window is gone; only the adaptive adversary's own (small) contribution remains
    expect(currentJamming(after.state).VHF).toBeCloseTo(after.state.adaptiveJam.VHF, 9);
    expect(currentJamming(after.state).VHF).toBeLessThan(0.2);
  });

  it('weather change updates the weather and tells everyone', () => {
    const scenario = makeScenario({
      msel: [
        {
          id: 'w',
          tick: 2,
          title: 'w',
          type: 'WEATHER_CHANGE',
          visibilityM: 700,
          precipitationMm: 3,
          windKph: 20,
        },
      ],
    });
    const { state, events } = run(makeState({ scenario }), 3);
    expect(state.weather).toEqual({ visibilityM: 700, precipitationMm: 3, windKph: 20 });
    expect(ofType(events, 'WEATHER_CHANGED')[0]?.visibleTo).toEqual([
      'instructor',
      'p-pl',
      'p-sec',
      'p-uav',
    ]);
  });

  it('SATCOM outage takes SATCOM down for its duration and drops SATCOM traffic', () => {
    const scenario = makeScenario({
      msel: [{ id: 's', tick: 3, title: 's', type: 'SATCOM_OUTAGE', durationTicks: 50 }],
    });
    const s0 = makeState({ scenario });
    const during = run(s0, 10, { 6: [sendText('hello', 'SATCOM')] });
    expect(satcomUp(during.state)).toBe(false);
    const outcome = ofType(during.events, 'MESSAGE_OUTCOME').find(
      (e) => e.payload['channel'] === 'SATCOM' && e.payload['kind'] === 'TEXT',
    );
    expect(outcome?.payload['outcome']).toBe('DROPPED');
    expect(satcomUp(run(s0, 60).state)).toBe(true);
  });

  it('adversary move sends a hostile unit towards its destination; bad references fail visibly', () => {
    const dest = { lat: 34.12, lon: 77.06 };
    const scenario = makeScenario({
      msel: [
        {
          id: 'a',
          tick: 1,
          title: 'a',
          type: 'ADVERSARY_MOVE',
          unitId: 'r-recce',
          destination: dest,
        },
        {
          id: 'b',
          tick: 1,
          title: 'b',
          type: 'ADVERSARY_MOVE',
          unitId: 'ghost-unit',
          destination: dest,
        },
        { id: 'c', tick: 1, title: 'c', type: 'ADVERSARY_MOVE', unitId: 'r-ew', destination: dest },
        {
          id: 'd',
          tick: 1,
          title: 'd',
          type: 'CONFLICTING_REPORTS',
          unitId: 'nope',
          altPosition: dest,
          altType: 'X',
        },
        {
          id: 'e',
          tick: 1,
          title: 'e',
          type: 'SPOOF_ORDER',
          purportedSender: 'HQ',
          targetUnitId: 'nope',
          orderText: 'x',
        },
        {
          id: 'f',
          tick: 1,
          title: 'f',
          type: 'RUNNER_DISPATCH',
          fromUnitId: 'nope',
          toUnitId: 'b-pl',
          messageText: 'x',
        },
      ],
    });
    const s0 = makeState({ scenario });
    const start = getUnit(s0, 'r-recce')!.position;
    const { state, events } = run(s0, 20);
    expect(haversineM(getUnit(state, 'r-recce')!.position, dest)).toBeLessThan(
      haversineM(start, dest),
    );
    expect(ofType(events, 'INJECT_FAILED')).toHaveLength(5);
  });

  it('conflicting reports yield two reports on one entity in two places', () => {
    const scenario = makeScenario({
      msel: [
        {
          id: 'c',
          tick: 1,
          title: 'c',
          type: 'CONFLICTING_REPORTS',
          unitId: 'r-recce',
          altPosition: { lat: 34.19, lon: 77.19 },
          altType: 'MECH_INFANTRY_SECTION',
        },
      ],
    });
    const { events } = run(makeState({ scenario }), 2);
    const gen = ofType(events, 'REPORT_GENERATED').filter((e) => e.payload['conflictGroup']);
    expect(gen).toHaveLength(2);
    expect(gen[0]?.payload['subjectUnitId']).toBe('r-recce');
    expect(gen[0]?.payload['position']).not.toEqual(gen[1]?.payload['position']);
  });

  it('live injects and manual jamming from the instructor work; duplicates and RUNNER are rejected', () => {
    const live = jam('live-1', 0, 'HF', 0.5, 20);
    const { state, events } = run(makeState(), 2, {
      1: [
        { type: 'INJECT', inject: live },
        { type: 'SET_JAMMING', channel: 'VHF', intensity: 0.3 },
      ],
      2: [
        { type: 'INJECT', inject: live },
        { type: 'SET_JAMMING', channel: 'RUNNER', intensity: 1 },
      ],
    });
    expect(currentJamming(state).HF).toBeCloseTo(0.5, 9);
    expect(currentJamming(state).VHF).toBeCloseTo(0.3, 9);
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(2);
    expect(ofType(events, 'JAMMING_SET')).toHaveLength(1);
  });
});

describe('messaging', () => {
  it('delivers surviving messages to the recipient inbox and accounts for every outcome', () => {
    const plan: Plan = {};
    for (let t = 1; t <= 20; t++) plan[t] = [sendText(`Message ${t}`)];
    const { state, events } = run(makeState(), 200, plan);
    const outcomes = ofType(events, 'MESSAGE_OUTCOME').filter((e) => e.payload['kind'] === 'TEXT');
    expect(outcomes).toHaveLength(20);
    const survived = outcomes.filter((e) => e.payload['outcome'] !== 'DROPPED').length;
    expect(survived).toBeGreaterThan(10);
    expect(state.knowledge['p-uav']?.inbox).toHaveLength(survived);
    expect(ofType(events, 'MESSAGE_SENT')).toHaveLength(20);
  });

  it('corrupted messages arrive altered, with no flag visible to the recipient', () => {
    const plan: Plan = {};
    for (let t = 1; t <= 60; t++) plan[t] = [sendText(`Grid ${1000 + t} ${2000 + t}`)];
    const s0 = makeState({ scenario: makeScenario({ msel: [jam('j', 0, 'VHF', 0.55, 500)] }) });
    const { state, events } = run(s0, 300, plan);
    const corrupted = ofType(events, 'MESSAGE_OUTCOME').filter(
      (e) => e.payload['outcome'] === 'CORRUPTED',
    );
    expect(corrupted.length).toBeGreaterThan(0);
    for (const c of corrupted)
      expect(c.payload['deliveredText']).not.toBe(c.payload['originalText']);
    const received = ofType(events, 'MESSAGE_RECEIVED').filter(
      (e) => e.payload['playerId'] === 'p-uav',
    );
    for (const r of received) expect(JSON.stringify(r.payload)).not.toMatch(/corrupt/i);
    expect(state.knowledge['p-uav']?.inbox.length).toBeGreaterThan(0);
  });

  it('a ridge cripples VHF between the two sides while HF still gets through', () => {
    const count = (channel: 'VHF' | 'HF'): number => {
      const plan: Plan = {};
      for (let t = 1; t <= 80; t++) plan[t] = [sendText(`m${t}`, channel, 'p-pl', 'p-sec')];
      const { events } = run(makeState({ terrain: makeTerrain(3000, 4800) }), 80, plan);
      return ofType(events, 'MESSAGE_OUTCOME').filter(
        (e) => e.payload['outcome'] !== 'DROPPED' && e.payload['kind'] === 'TEXT',
      ).length;
    };
    expect(count('HF')).toBeGreaterThan(count('VHF') + 8);
  });

  it('runner messages travel physically, arrive late, and ignore total jamming', () => {
    const s0 = makeState({ scenario: makeScenario({ msel: [] }) });
    const target = getUnit(s0, 'b-uav')!;
    const dist = haversineM(getUnit(s0, 'b-pl')!.position, target.position);
    const jamAll: EngineInput[] = (['VHF', 'HF', 'SATCOM', 'DATALINK'] as const).map((channel) => ({
      type: 'SET_JAMMING' as const,
      channel,
      intensity: 1,
    }));
    const stay = { ...s0, units: s0.units.map((u) => (u.id === 'b-uav' ? { ...u, speed: 0 } : u)) };
    const { state, events } = run(stay, 1000, { 1: [...jamAll, sendText('By hand', 'RUNNER')] });
    const arrived = ofType(events, 'RUNNER_ARRIVED')[0];
    expect(arrived).toBeDefined();
    expect(
      state.knowledge['p-uav']?.inbox.some((m) => m.text === 'By hand' && m.channel === 'RUNNER'),
    ).toBe(true);
    const expected = Math.ceil((dist - 50) / 4);
    expect(Math.abs((arrived?.tick ?? 0) - expected)).toBeLessThan(8);
  });

  it('bandwidth: a burst on a thin channel queues up, spreading deliveries over later ticks', () => {
    const burst: EngineInput[] = Array.from({ length: 5 }, (_, i) => sendText(`b${i}`, 'HF'));
    const { events } = run(makeState(), 1, { 1: burst });
    const q = ofType(events, 'MESSAGE_OUTCOME')
      .filter((e) => e.payload['kind'] === 'TEXT')
      .map((e) => e.payload['queueDelayTicks']);
    expect(q).toEqual([0, 1, 2, 3, 4]);
  });

  it('switching channel costs latency for a while, then clears', () => {
    const { state, events } = run(makeState(), 12, {
      2: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'HF' }],
    });
    expect(state.teams[0]?.activeChannel).toBe('HF');
    expect(ofType(events, 'CHANNEL_SWITCHED')[0]?.visibleTo).toEqual([
      'p-pl',
      'p-sec',
      'p-uav',
      'instructor',
    ]);
    const during = run(makeState(), 3, {
      2: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'HF' }],
      3: [sendText('after switch', 'HF')],
    });
    const penalised = ofType(during.events, 'MESSAGE_OUTCOME').find(
      (e) => e.payload['kind'] === 'TEXT',
    );
    expect(penalised?.payload['switchDelayTicks']).toBe(5);
    const later = run(makeState(), 20, {
      2: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'HF' }],
      15: [sendText('later', 'HF')],
    });
    const clear = ofType(later.events, 'MESSAGE_OUTCOME').find((e) => e.payload['kind'] === 'TEXT');
    expect(clear?.payload['switchDelayTicks']).toBe(0);
  });

  it('relays contact reports to teammates and sends position beacons', () => {
    const { state, events } = run(makeState({ seed: 3 }), 400);
    const received = ofType(events, 'REPORT_RECEIVED');
    expect(received.some((e) => e.payload['via'] === 'DIRECT')).toBe(true);
    expect(received.some((e) => e.payload['via'] === 'VHF' || e.payload['via'] === 'HF')).toBe(
      true,
    );
    const fix = state.knowledge['p-pl']?.friendlies['b-uav'];
    expect(state.tick - (fix?.observedTick ?? 0)).toBeLessThan(120);
  });
});

describe('adaptive EW (reliance-adaptive adversary)', () => {
  it('jams the most-used channel harder each window and decays channels the team abandons', () => {
    const plan: Plan = {};
    for (let t = 1; t <= 119; t++) plan[t] = [sendText(`v${t}`, 'VHF')];
    const first = run(makeState(), 120, plan);
    const vhf = first.state.adaptiveJam.VHF;
    expect(vhf).toBeGreaterThan(0.2);
    expect(ofType(first.events, 'EW_ADAPTED').length).toBe(4);

    const plan2: Plan = { 121: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'HF' }] };
    for (let t = 122; t <= 239; t++) plan2[t] = [sendText(`h${t}`, 'HF')];
    const second = run(first.state, 120, plan2);
    expect(second.state.adaptiveJam.HF).toBeGreaterThan(0.2);
    expect(second.state.adaptiveJam.VHF).toBeLessThan(vhf);
  });

  it('does nothing once the adversary EW unit is out of action', () => {
    const scenario = makeScenario();
    scenario.initialUnits = scenario.initialUnits.map((u) =>
      u.id === 'r-ew' ? { ...u, status: 'DESTROYED' as const } : u,
    );
    const plan: Plan = {};
    for (let t = 1; t <= 60; t++) plan[t] = [sendText(`v${t}`, 'VHF')];
    const { state, events } = run(makeState({ scenario }), 60, plan);
    expect(ofType(events, 'EW_ADAPTED')).toHaveLength(0);
    expect(currentJamming(state).VHF).toBe(0);
  });
});

describe('movement and tasking', () => {
  it('moves a unit towards its destination, turns it, and reports arrival', () => {
    const s0 = makeState();
    const dest = { lat: 34.1, lon: 77.04 };
    const { state, events } = run(s0, 1200, {
      1: [{ type: 'MOVE_UNIT', playerId: 'p-pl', unitId: 'b-pl', destination: dest }],
    });
    const u = getUnit(state, 'b-pl')!;
    expect(u.position).toEqual(dest);
    expect(u.destination).toBeNull();
    expect(u.heading).toBeCloseTo(90, 0);
    expect(ofType(events, 'UNIT_ARRIVED')).toHaveLength(1);
  });

  it('steep ground slows land units; air units are unaffected', () => {
    const ramp = makeTerrain();
    for (let r = 0; r < ramp.rows; r++)
      for (let c = 0; c < ramp.cols; c++)
        (ramp.elevations as number[])[r * ramp.cols + c] = 3000 + c * 150;
    const travelled = (
      terrain: ReturnType<typeof makeTerrain>,
      unitId: string,
      player: string,
    ): number => {
      const s0 = makeState({ terrain });
      const start = getUnit(s0, unitId)!.position;
      const { state } = run(s0, 20, {
        1: [
          {
            type: 'MOVE_UNIT',
            playerId: player,
            unitId,
            destination: { lat: start.lat, lon: start.lon + 0.05 },
          },
        ],
      });
      return haversineM(start, getUnit(state, unitId)!.position);
    };
    expect(travelled(ramp, 'b-pl', 'p-pl')).toBeLessThan(
      travelled(makeTerrain(), 'b-pl', 'p-pl') * 0.8,
    );
    expect(travelled(ramp, 'b-uav', 'p-uav')).toBeCloseTo(
      travelled(makeTerrain(), 'b-uav', 'p-uav'),
      3,
    );
  });

  it('only lets you command your own unit (or a teammate if you are PL_CDR) and only inside the area', () => {
    const dest = { lat: 34.1, lon: 77.05 };
    const mv = (playerId: string, unitId: string, destination = dest): EngineInput => ({
      type: 'MOVE_UNIT',
      playerId,
      unitId,
      destination,
    });
    const { events } = run(makeState(), 1, {
      1: [
        mv('p-sec', 'b-pl'), // not yours
        mv('p-pl', 'b-sec'), // PL may command a teammate -> accepted
        mv('p-pl', 'b-pl', { lat: BBOX.north + 1, lon: 77.1 }), // out of area
        mv('p-pl', 'b-hq'), // unowned -> refused
      ],
    });
    expect(ofType(events, 'UNIT_MOVE_ORDERED')).toHaveLength(1);
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(3);
  });

  it('rejects orders for units that cannot move', () => {
    const roster = makeRoster();
    const scenario = makeScenario();
    scenario.initialUnits = scenario.initialUnits.map((u) =>
      u.id === 'b-sec' ? { ...u, speed: 0 } : u,
    );
    const { events } = run(makeState({ scenario, roster }), 1, {
      1: [
        {
          type: 'MOVE_UNIT',
          playerId: 'p-sec',
          unitId: 'b-sec',
          destination: { lat: 34.1, lon: 77.1 },
        },
      ],
    });
    expect(ofType(events, 'INPUT_REJECTED')[0]?.payload['reason']).toBe('unit cannot move');
  });

  it('an ISR request tasks the team drone and boosts it; teams without a drone are refused', () => {
    const target = { lat: 34.11, lon: 77.06 };
    const { state, events } = run(makeState(), 1, {
      1: [{ type: 'REQUEST_ISR', playerId: 'p-pl', target }],
    });
    const drone = getUnit(state, 'b-uav')!;
    expect(drone.destination).toEqual(target);
    expect(drone.isrUntilTick).toBeGreaterThan(state.tick);
    expect(ofType(events, 'ISR_REQUESTED')).toHaveLength(1);

    const roster = makeRoster();
    roster.players = roster.players.filter((p) => p.unitId !== 'b-uav');
    const none = run(makeState({ roster }), 1, {
      1: [{ type: 'REQUEST_ISR', playerId: 'p-pl', target }],
    });
    expect(ofType(none.events, 'INPUT_REJECTED')[0]?.payload['reason']).toBe(
      'no ISR asset on your team',
    );
  });
});

describe('input validation', () => {
  it('rejects unknown players, destroyed units, bad recipients and bad text', () => {
    const scenario = makeScenario();
    scenario.initialUnits = scenario.initialUnits.map((u) =>
      u.id === 'b-sec' ? { ...u, status: 'DESTROYED' as const } : u,
    );
    const { events } = run(makeState({ scenario }), 1, {
      1: [
        sendText('x', 'VHF', 'nobody', 'p-uav'),
        sendText('x', 'VHF', 'p-sec', 'p-uav'),
        sendText('x', 'VHF', 'p-pl', 'p-pl'),
        sendText('   ', 'VHF', 'p-pl', 'p-uav'),
        sendText('y'.repeat(501), 'VHF', 'p-pl', 'p-uav'),
        sendText('x', 'VHF', 'p-pl', 'ghost'),
      ],
    });
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(6);
    expect(ofType(events, 'MESSAGE_SENT')).toHaveLength(0);
  });

  it('switching to the channel already in use is refused', () => {
    const { events } = run(makeState(), 1, {
      1: [{ type: 'SWITCH_CHANNEL', playerId: 'p-pl', channel: 'VHF' }],
    });
    expect(ofType(events, 'INPUT_REJECTED')).toHaveLength(1);
  });
});
