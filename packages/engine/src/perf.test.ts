import { describe, expect, it } from 'vitest';
import type { ScenarioUnit } from '@vyuha/shared';
import { mulberry32 } from './prng';
import { computePerceivedState } from './perceived';
import { step } from './step';
import { makeScenario, makeState, makeTerrain, unit } from './testkit';
import type { Roster } from './types';
import { jam } from './testrun';

const TEAMS = 4;
const PLAYERS_PER_TEAM = 4;
const ROLES = ['PL_CDR', 'SECTION_CDR', 'EW_OFFICER', 'ISR_OPERATOR'] as const;
const pace = {
  primary: 'VHF',
  alternate: 'HF',
  contingency: 'SATCOM',
  emergency: 'RUNNER',
} as const;

/** 4 teams of 4 players, each with an own unit, against a red force, on ridged terrain. */
function bigExercise() {
  const units: ScenarioUnit[] = [];
  const roster: Roster = { teams: [], players: [] };
  for (let t = 0; t < TEAMS; t++) {
    roster.teams.push({ id: `t${t}`, name: `Team ${t}`, pace });
    for (let p = 0; p < PLAYERS_PER_TEAM; p++) {
      const id = `b-${t}-${p}`;
      const lon = 77.02 + t * 0.04 + p * 0.005;
      const lat = 34.04 + p * 0.03;
      const role = ROLES[p] as (typeof ROLES)[number];
      units.push(
        role === 'ISR_OPERATOR'
          ? unit(id, 'BLUE', 'AIR', 'DRONE', lat, lon, { speed: 20 })
          : role === 'EW_OFFICER'
            ? unit(id, 'BLUE', 'EW', 'EW_DETACHMENT', lat, lon)
            : unit(id, 'BLUE', 'LAND', 'INFANTRY_SECTION', lat, lon),
      );
      roster.players.push({ id: `p-${t}-${p}`, teamId: `t${t}`, unitId: id, role });
    }
  }
  for (let r = 0; r < 12; r++) {
    units.push(unit(`r-${r}`, 'RED', 'LAND', 'RECCE', 34.05 + r * 0.01, 77.05 + r * 0.012));
  }
  units.push(unit('r-ew', 'RED', 'EW', 'EW_JAMMER', 34.15, 77.1));
  const scenario = makeScenario({
    initialUnits: units,
    msel: [jam('j1', 5, 'VHF', 0.8, 400), jam('j2', 20, 'HF', 0.5, 400)],
  });
  return makeState({ scenario, terrain: makeTerrain(3000, 3400), roster });
}

describe('performance: 4 teams x 4 players', () => {
  it('computes a tick plus every player perceived state in under 100 ms (p95) over 600 ticks', () => {
    let state = bigExercise();
    const rng = mulberry32(state.rngState);
    const players = state.players.map((p) => p.id);
    const samples: number[] = [];
    for (let i = 0; i < 600; i++) {
      const t0 = performance.now();
      const r = step(state, [], rng);
      state = r.state;
      for (const id of players) computePerceivedState(state, id);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] as number;
    const max = samples[samples.length - 1] as number;
    expect(state.tick).toBe(600);
    expect(p95).toBeLessThan(100);
    expect(max).toBeLessThan(500);
  });
});
