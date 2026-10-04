import { effectiveJamming, zeroLevels, zeroUsage } from './ew';
import { mulberry32 } from './prng';
import type { TerrainGridData } from './terrain';
import { isValidGrid } from './terrain';
import type {
  Channel,
  EngineUnit,
  PlayerKnowledge,
  PlayerSpec,
  Roster,
  ScenarioDefinition,
  TeamState,
  TruthState,
  Weather,
} from './types';

/** Builds the initial hidden ground truth. Throws RangeError on an invalid terrain grid or roster. */
export function createTruthState(
  scenario: ScenarioDefinition,
  terrain: TerrainGridData,
  weather: Weather,
  seed: number,
  roster: Roster = { teams: [], players: [] },
): TruthState {
  if (!isValidGrid(terrain)) throw new RangeError('Terrain grid is invalid');
  const units: EngineUnit[] = scenario.initialUnits.map((u) => ({
    ...u,
    position: { ...u.position },
    destination: null,
    isrUntilTick: 0,
  }));
  const unitIds = new Set(units.map((u) => u.id));
  const teamIds = new Set(roster.teams.map((t) => t.id));
  const seenUnits = new Set<string>();
  const seenPlayers = new Set<string>();
  for (const p of roster.players) {
    if (!teamIds.has(p.teamId)) throw new RangeError(`Player ${p.id} references unknown team`);
    if (!unitIds.has(p.unitId)) throw new RangeError(`Player ${p.id} references unknown unit`);
    if (seenUnits.has(p.unitId)) throw new RangeError(`Unit ${p.unitId} is assigned twice`);
    if (seenPlayers.has(p.id)) throw new RangeError(`Duplicate player ${p.id}`);
    seenUnits.add(p.unitId);
    seenPlayers.add(p.id);
  }

  const teams: TeamState[] = roster.teams.map((t) => ({
    ...t,
    pace: { ...t.pace },
    activeChannel: t.pace.primary,
    switchedAtTick: null,
    usage: zeroUsage(),
  }));

  const knowledge: Record<string, PlayerKnowledge> = {};
  for (const p of roster.players) {
    const friendlies: PlayerKnowledge['friendlies'] = {};
    for (const mate of roster.players) {
      if (mate.teamId !== p.teamId || mate.id === p.id) continue;
      const unit = units.find((u) => u.id === mate.unitId);
      if (unit)
        friendlies[unit.id] = { position: { ...unit.position }, observedTick: 0, receivedTick: 0 };
    }
    knowledge[p.id] = { reports: [], inbox: [], friendlies, grades: {}, auth: [] };
  }

  return {
    tick: 0,
    seed,
    rngState: mulberry32(seed).state(),
    terrain,
    weather: { ...weather },
    units,
    teams,
    players: roster.players.map((p) => ({ ...p })),
    msel: [...scenario.msel].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)),
    firedInjectIds: [],
    jamWindows: [],
    manualJam: zeroLevels(),
    adaptiveJam: zeroLevels(),
    satcomDownUntilTick: 0,
    reports: [],
    lastDetectionTick: {},
    inFlight: [],
    runners: [],
    knowledge,
    counters: { message: 0, report: 0, runner: 0, group: 0, liveInject: 0 },
  };
}

/** Recursive copy of plain JSON-like data (numbers, strings, booleans, null, arrays, objects). */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v: unknown) => deepClone(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/** Deep copy of the mutable parts; the (large, immutable) terrain grid is shared by reference. */
export function cloneState(state: TruthState): TruthState {
  const { terrain, ...rest } = state;
  return { ...deepClone(rest), terrain };
}

export function getUnit(state: TruthState, id: string): EngineUnit | undefined {
  return state.units.find((u) => u.id === id);
}

export function getPlayer(state: TruthState, id: string): PlayerSpec | undefined {
  return state.players.find((p) => p.id === id);
}

export function getTeam(state: TruthState, id: string): TeamState | undefined {
  return state.teams.find((t) => t.id === id);
}

/** Players who receive traffic addressed to a unit: its owner, else every platoon commander. */
export function recipientsForUnit(state: TruthState, unitId: string): PlayerSpec[] {
  const owner = state.players.find((p) => p.unitId === unitId);
  if (owner) return [owner];
  return state.players.filter((p) => p.role === 'PL_CDR');
}

export function adversaryActive(state: TruthState): boolean {
  return state.units.some((u) => u.side === 'RED' && u.domain === 'EW' && u.status === 'ACTIVE');
}

export function currentJamming(state: TruthState): Record<Channel, number> {
  return effectiveJamming(
    state.tick,
    state.jamWindows,
    state.manualJam,
    state.adaptiveJam,
    adversaryActive(state),
  );
}

export function satcomUp(state: TruthState): boolean {
  return state.tick >= state.satcomDownUntilTick;
}
