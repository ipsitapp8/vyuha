import { describe, expect, it } from 'vitest';
import { adaptJamming, effectiveJamming, mostUsedChannel, zeroLevels, zeroUsage } from './ew';
import { haversineM } from './geometry';
import { mulberry32 } from './prng';
import {
  effectiveSensorRange,
  makeConflictingPair,
  makeGhostReport,
  makeRealReport,
  reliabilityFromIndex,
  reliabilityIndex,
  senseTick,
  sensorReliabilityIndex,
} from './reports';
import { getUnit } from './state';
import { makeScenario, makeState, makeTerrain, unit } from './testkit';

describe('effectiveJamming', () => {
  it('combines independent sources as 1 - prod(1 - level)', () => {
    const j = effectiveJamming(
      10,
      [
        { id: 'a', channel: 'VHF', intensity: 0.5, untilTick: 20 },
        { id: 'b', channel: 'VHF', intensity: 0.5, untilTick: 5 },
      ],
      { ...zeroLevels(), VHF: 0.5 },
      zeroLevels(),
      false,
    );
    expect(j.VHF).toBeCloseTo(0.75, 9); // expired window ignored: 1 - 0.5*0.5
  });
  it('ignores the adaptive component when the adversary EW is gone, and never jams RUNNER', () => {
    const adaptive = { ...zeroLevels(), HF: 0.6, RUNNER: 0.9 };
    expect(effectiveJamming(0, [], zeroLevels(), adaptive, false).HF).toBe(0);
    const on = effectiveJamming(0, [], zeroLevels(), adaptive, true);
    expect(on.HF).toBeCloseTo(0.6, 9);
    expect(on.RUNNER).toBe(0);
  });
});

describe('adaptive EW', () => {
  it('finds the most-used channel (ties by channel order) and null when idle', () => {
    expect(mostUsedChannel({ ...zeroUsage(), HF: 4, VHF: 4 })).toBe('VHF');
    expect(mostUsedChannel({ ...zeroUsage(), SATCOM: 2, HF: 1 })).toBe('SATCOM');
    expect(mostUsedChannel(zeroUsage())).toBeNull();
    expect(mostUsedChannel({ ...zeroUsage(), RUNNER: 99 })).toBeNull();
  });
  it('raises jamming on the most-used channel and decays the others', () => {
    const next = adaptJamming(
      { ...zeroLevels(), VHF: 0.2, HF: 0.2 },
      [{ usage: { ...zeroUsage(), VHF: 9, HF: 1 } }],
      0.1,
      0.05,
    );
    expect(next.VHF).toBeCloseTo(0.3, 9);
    expect(next.HF).toBeCloseTo(0.15, 9);
    expect(next.SATCOM).toBe(0);
  });
  it('caps at 0.9 and escalates when several teams rely on the same channel', () => {
    const teams = [{ usage: { ...zeroUsage(), VHF: 5 } }, { usage: { ...zeroUsage(), VHF: 7 } }];
    expect(adaptJamming(zeroLevels(), teams, 0.1).VHF).toBeCloseTo(0.2, 9);
    expect(adaptJamming({ ...zeroLevels(), VHF: 0.89 }, teams, 0.1).VHF).toBe(0.9);
  });
});

describe('sensor model', () => {
  it('grade helpers round-trip and clamp', () => {
    expect(reliabilityIndex('C')).toBe(2);
    expect(reliabilityFromIndex(2)).toBe('C');
    expect(reliabilityFromIndex(99)).toBe('F');
    expect(reliabilityFromIndex(-4)).toBe('A');
  });
  it('fog, rain and damage push sensor reliability down (higher index)', () => {
    const s = makeState();
    const drone = getUnit(s, 'b-uav')!;
    const clear = sensorReliabilityIndex(drone, s.weather);
    expect(
      sensorReliabilityIndex(drone, { visibilityM: 2000, precipitationMm: 0, windKph: 0 }),
    ).toBe(clear + 1);
    expect(
      sensorReliabilityIndex(drone, { visibilityM: 500, precipitationMm: 5, windKph: 0 }),
    ).toBe(clear + 3);
    expect(sensorReliabilityIndex({ ...drone, status: 'DAMAGED' }, s.weather)).toBe(clear + 1);
  });
  it('visibility shrinks effective range; an ISR task extends it', () => {
    const s = makeState();
    const pl = getUnit(s, 'b-pl')!;
    const full = effectiveSensorRange(pl, s.weather, false);
    expect(
      effectiveSensorRange(pl, { visibilityM: 2500, precipitationMm: 0, windKph: 0 }, false),
    ).toBeLessThan(full);
    expect(effectiveSensorRange(pl, s.weather, true)).toBeCloseTo(full * 1.5, 6);
  });

  it('noise and mis-identification grow as reliability worsens', () => {
    const meanError = (visibilityM: number): { err: number; wrong: number } => {
      const s = makeState({ weather: { visibilityM, precipitationMm: 6, windKph: 0 } });
      const rng = mulberry32(5);
      const sensor = getUnit(s, 'b-pl')!;
      const target = getUnit(s, 'r-recce')!;
      let err = 0;
      let wrong = 0;
      for (let i = 0; i < 400; i++) {
        const r = makeRealReport(s, rng, sensor, target);
        err += haversineM(r.position, target.position);
        if (r.type !== target.type) wrong += 1;
      }
      return { err: err / 400, wrong };
    };
    const clear = meanError(20_000);
    const bad = meanError(500);
    expect(bad.err).toBeGreaterThan(clear.err * 2);
    expect(bad.wrong).toBeGreaterThan(clear.wrong);
  });

  it('ghost contacts have no subject but are otherwise ordinary reports', () => {
    const s = makeState();
    const ghost = makeGhostReport(s, mulberry32(3), getUnit(s, 'b-pl')!);
    expect(ghost.ghost).toBe(true);
    expect(ghost.subjectUnitId).toBeNull();
    expect(ghost.id).toMatch(/^rpt-\d+$/);
    expect(haversineM(ghost.position, getUnit(s, 'b-pl')!.position)).toBeLessThan(4000);
  });

  it('conflicting reports put the same entity in two places with a shared group', () => {
    const s = makeState();
    const subject = getUnit(s, 'r-recce')!;
    const alt = { lat: 34.19, lon: 77.19 };
    const [a, b] = makeConflictingPair(s, mulberry32(2), subject, alt, 'MECH_INFANTRY_SECTION');
    expect(a && b).toBeTruthy();
    expect(a!.subjectUnitId).toBe(b!.subjectUnitId);
    expect(a!.conflictGroup).toBe(b!.conflictGroup);
    expect(a!.conflictGroup).not.toBeNull();
    expect(b!.position).toEqual(alt);
    expect(b!.type).toBe('MECH_INFANTRY_SECTION');
    expect(a!.id).not.toBe(b!.id);
  });
  it('conflicting reports need a friendly sensor', () => {
    const s = makeState({
      scenario: makeScenario({
        initialUnits: [unit('r-1', 'RED', 'LAND', 'RECCE', 34.1, 77.1)],
      }),
      roster: { teams: [], players: [] },
    });
    expect(
      makeConflictingPair(s, mulberry32(1), getUnit(s, 'r-1')!, { lat: 34, lon: 77 }, 'X'),
    ).toEqual([]);
  });

  it('senses a hostile unit in range with line of sight, never one behind a ridge or out of range', () => {
    const s = makeState();
    const rng = mulberry32(9);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      s.tick = i * 30; // beyond the per-pair cooldown each time
      for (const r of senseTick(s, rng))
        if (r.subjectUnitId) seen.add(`${r.sensorUnitId}>${r.subjectUnitId}`);
    }
    expect(seen.has('b-pl>r-recce')).toBe(true);
    expect([...seen].some((k) => k.endsWith('>r-far'))).toBe(false);

    const ridge = makeState({ terrain: makeTerrain(3000, 4800) });
    const seenRidge = new Set<string>();
    for (let i = 0; i < 200; i++) {
      ridge.tick = i * 30;
      for (const r of senseTick(ridge, rng))
        if (r.subjectUnitId) seenRidge.add(`${r.sensorUnitId}>${r.subjectUnitId}`);
    }
    // b-sec is east of the ridge and r-recce is west of it
    expect([...seenRidge].some((k) => k === 'b-sec>r-recce')).toBe(false);
  });

  it('respects the per-pair detection cooldown', () => {
    const s = makeState();
    const rng = mulberry32(1);
    let count = 0;
    for (let i = 1; i <= 15; i++) {
      s.tick = i;
      count += senseTick(s, rng).filter(
        (r) => r.sensorUnitId === 'b-pl' && r.subjectUnitId === 'r-recce',
      ).length;
    }
    expect(count).toBeLessThanOrEqual(1);
  });
});
