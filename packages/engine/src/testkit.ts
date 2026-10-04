import type { ScenarioDefinition, ScenarioUnit } from '@vyuha/shared';
import { createTruthState } from './state';
import type { TerrainGridData } from './terrain';
import type { Roster, TruthState, Weather } from './types';

export const BBOX = { south: 34.0, west: 77.0, north: 34.2, east: 77.2 };
export const CLEAR: Weather = { visibilityM: 20_000, precipitationMm: 0, windKph: 5 };

/** 33x33 grid: flat at `base`, optionally with a N-S ridge `ridgeM` high on the middle columns. */
export function makeTerrain(base = 3000, ridgeM = 0): TerrainGridData {
  const rows = 33;
  const cols = 33;
  const elevations: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const onRidge = ridgeM > 0 && c >= 15 && c <= 17;
      elevations.push(onRidge ? ridgeM : base);
    }
  }
  return { rows, cols, bbox: BBOX, elevations };
}

export function unit(
  id: string,
  side: ScenarioUnit['side'],
  domain: ScenarioUnit['domain'],
  type: string,
  lat: number,
  lon: number,
  extra: Partial<ScenarioUnit> = {},
): ScenarioUnit {
  return {
    id,
    name: `${side === 'RED' ? 'Hostile ' : ''}${id}`,
    side,
    domain,
    type,
    position: { lat, lon },
    heading: 0,
    speed: domain === 'EW' || domain === 'CYBER' ? 0 : 1.5,
    strength: 100,
    status: 'ACTIVE',
    ...extra,
  };
}

/** West-side units (lon 77.03) and east-side units (lon 77.17) are separated by the ridge at lon ~77.1. */
export function makeScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    title: 'Test',
    description: 'Test scenario',
    areaBounds: BBOX,
    seed: 7,
    msel: [],
    paceDefaults: { primary: 'VHF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' },
    initialUnits: [
      unit('b-pl', 'BLUE', 'LAND', 'INFANTRY_PLATOON', 34.1, 77.03),
      unit('b-sec', 'BLUE', 'LAND', 'INFANTRY_SECTION', 34.1, 77.17),
      unit('b-uav', 'BLUE', 'AIR', 'DRONE', 34.12, 77.05, { speed: 20 }),
      unit('b-ew', 'BLUE', 'EW', 'EW_DETACHMENT', 34.08, 77.04),
      unit('b-hq', 'BLUE', 'LAND', 'HQ', 34.05, 77.04, { speed: 0 }),
      unit('r-recce', 'RED', 'LAND', 'RECCE', 34.105, 77.045),
      unit('r-far', 'RED', 'LAND', 'MECH_INFANTRY_COMPANY', 34.19, 77.19),
      unit('r-ew', 'RED', 'EW', 'EW_JAMMER', 34.15, 77.1),
      unit('n-convoy', 'NEUTRAL', 'LAND', 'CIVILIAN_CONVOY', 34.02, 77.02),
    ],
    ...overrides,
  };
}

export function makeRoster(): Roster {
  const pace = {
    primary: 'VHF',
    alternate: 'HF',
    contingency: 'SATCOM',
    emergency: 'RUNNER',
  } as const;
  return {
    teams: [{ id: 't1', name: 'Alpha', pace }],
    players: [
      { id: 'p-pl', teamId: 't1', unitId: 'b-pl', role: 'PL_CDR' },
      { id: 'p-sec', teamId: 't1', unitId: 'b-sec', role: 'SECTION_CDR' },
      { id: 'p-uav', teamId: 't1', unitId: 'b-uav', role: 'ISR_OPERATOR' },
    ],
  };
}

export function makeState(
  opts: {
    scenario?: ScenarioDefinition;
    terrain?: TerrainGridData;
    weather?: Weather;
    seed?: number;
    roster?: Roster;
  } = {},
): TruthState {
  return createTruthState(
    opts.scenario ?? makeScenario(),
    opts.terrain ?? makeTerrain(),
    opts.weather ?? CLEAR,
    opts.seed ?? 7,
    opts.roster ?? makeRoster(),
  );
}
