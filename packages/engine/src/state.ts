import { effectiveJamming, zeroLevels, zeroUsage } from './ew';
import { offsetByBearing, offsetByMeters } from './geometry';
import { mulberry32 } from './prng';
import type { TerrainGridData } from './terrain';
import { isValidGrid } from './terrain';
import type {
  Channel,
  EngineUnit,
  FriendlyFix,
  LatLon,
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

/** How far a compromised C2 node can push a teammate's marker (m). */
export const C2_MAX_DRIFT_M = 4000;

/** The position a unit reports for itself: the truth, unless its navigation is being spoofed. */
export function reportedPosition(state: TruthState, unit: EngineUnit): LatLon {
  const spoof = state.gpsSpoofs.find((g) => g.unitId === unit.id && state.tick < g.untilTick);
  return spoof ? offsetByMeters(unit.position, spoof.eastM, spoof.northM) : { ...unit.position };
}

export function gpsSpoofOf(
  state: TruthState,
  unitId: string,
): TruthState['gpsSpoofs'][number] | null {
  return state.gpsSpoofs.find((g) => g.unitId === unitId && state.tick < g.untilTick) ?? null;
}

/** How far (m) a compromised C2 node has pushed this player's teammate markers by now. */
export function c2DriftM(state: TruthState, playerId: string): number {
  const c = state.c2Compromises.find((x) => x.playerId === playerId);
  if (!c) return 0;
  return Math.min(C2_MAX_DRIFT_M, c.driftMps * Math.max(0, state.tick - c.sinceTick));
}

/**
 * Where a player believes a teammate is: the last fix they received, pushed off by a compromised C2
 * node when there is one. The stored fix itself stays honest, so the drift ends the moment it is caught.
 */
export function believedFriendlyPosition(
  state: TruthState,
  playerId: string,
  unitId: string,
  fix: FriendlyFix,
): LatLon {
  const c = state.c2Compromises.find((x) => x.playerId === playerId);
  const bearing = c?.bearings[unitId];
  if (!c || bearing === undefined) return { ...fix.position };
  return offsetByBearing(fix.position, bearing, c2DriftM(state, playerId));
}
