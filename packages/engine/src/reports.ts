import type { LatLon } from '@vyuha/shared';
import {
  GHOST_RATE_PER_TICK,
  HOSTILE_TYPES,
  POSITION_SIGMA_M,
  profileFor,
  RELIABILITY_GRADES,
  SENSOR_COOLDOWN_TICKS,
  WRONG_TYPE_PROB,
} from './config';
import { clamp, haversineM, offsetByBearing, offsetByMeters } from './geometry';
import { gaussian, pick, randRange, type Rng } from './prng';
import { lineOfSight } from './radio';
import type {
  CredibilityGrade,
  EngineUnit,
  Report,
  ReliabilityGrade,
  TruthState,
  Weather,
} from './types';

export const reliabilityIndex = (g: ReliabilityGrade): number => RELIABILITY_GRADES.indexOf(g);
export const reliabilityFromIndex = (i: number): ReliabilityGrade =>
  RELIABILITY_GRADES[clamp(Math.round(i), 0, 5)] ?? 'F';

export function isSensor(u: EngineUnit): boolean {
  return (
    u.side === 'BLUE' &&
    (u.status === 'ACTIVE' || u.status === 'DAMAGED') &&
    (u.domain === 'LAND' || u.domain === 'AIR') &&
    profileFor(u.type).sensorRangeM > 0
  );
}

/** Weather degrades optical sensors: poor visibility or precipitation pushes reliability down. */
export function sensorReliabilityIndex(unit: EngineUnit, w: Weather): number {
  let idx = profileFor(unit.type).reliabilityIndex;
  if (w.visibilityM < 3000) idx += 1;
  if (w.visibilityM < 800) idx += 1;
  if (w.precipitationMm > 2) idx += 1;
  if (unit.status === 'DAMAGED') idx += 1;
  return clamp(idx, 0, 5);
}

export function effectiveSensorRange(unit: EngineUnit, w: Weather, boosted: boolean): number {
  const visFactor = clamp(w.visibilityM / 10_000, 0.25, 1);
  return profileFor(unit.type).sensorRangeM * visFactor * (boosted ? 1.5 : 1);
}

function nextReportId(state: TruthState): string {
  state.counters.report += 1;
  return `rpt-${state.counters.report}`;
}

/** Credibility 1 (confirmed) .. 6 (cannot be judged), correlated with source reliability. */
function drawCredibility(rng: Rng, relIdx: number): CredibilityGrade {
  const c = Math.round(relIdx * 0.8 + (rng.next() - 0.5) * 2) + 1;
  return clamp(c, 1, 6) as CredibilityGrade;
}

/** Draws the per-report reliability: the sensor's grade with a small seeded jitter. */
function drawReliabilityIndex(rng: Rng, sensorIdx: number): number {
  const u = rng.next();
  if (u < 0.15) return clamp(sensorIdx - 1, 0, 5);
  if (u > 0.85) return clamp(sensorIdx + 1, 0, 5);
  return sensorIdx;
}

/**
 * Builds a report about a real unit. Lower reliability => more position noise and a higher chance
 * the sensor mis-identifies the unit type.
 */
export function makeRealReport(
  state: TruthState,
  rng: Rng,
  sensor: EngineUnit,
  subject: EngineUnit,
): Report {
  const relIdx = drawReliabilityIndex(rng, sensorReliabilityIndex(sensor, state.weather));
  const sigma = POSITION_SIGMA_M[relIdx] ?? 2000;
  const east = gaussian(rng) * sigma;
  const north = gaussian(rng) * sigma;
  let type = subject.type;
  if (rng.next() < (WRONG_TYPE_PROB[relIdx] ?? 0.6)) {
    const others = HOSTILE_TYPES.filter((t) => t !== subject.type);
    type = pick(rng, others);
  }
  return {
    id: nextReportId(state),
    tick: state.tick,
    sensorUnitId: sensor.id,
    subjectUnitId: subject.id,
    position: offsetByMeters(subject.position, east, north),
    type,
    trueReliability: reliabilityFromIndex(relIdx),
    trueCredibility: drawCredibility(rng, relIdx),
    ghost: false,
    conflictGroup: null,
  };
}

/** Builds a fabricated contact that looks exactly like a real report but has no subject. */
export function makeGhostReport(state: TruthState, rng: Rng, sensor: EngineUnit): Report {
  const relIdx = drawReliabilityIndex(rng, sensorReliabilityIndex(sensor, state.weather));
  const range = effectiveSensorRange(sensor, state.weather, false);
  const position = offsetByBearing(
    sensor.position,
    randRange(rng, 0, 360),
    randRange(rng, range * 0.2, range),
  );
  return {
    id: nextReportId(state),
    tick: state.tick,
    sensorUnitId: sensor.id,
    subjectUnitId: null,
    position,
    type: pick(rng, HOSTILE_TYPES),
    trueReliability: reliabilityFromIndex(relIdx),
    trueCredibility: drawCredibility(rng, relIdx),
    ghost: true,
    conflictGroup: null,
  };
}

/**
 * Two reports on the same entity with different positions/types: one near the truth, one at the
 * injected alternative. Sensors are the two closest friendly sensors (or one sensor twice).
 */
export function makeConflictingPair(
  state: TruthState,
  rng: Rng,
  subject: EngineUnit,
  altPosition: LatLon,
  altType: string,
): Report[] {
  const sensors = state.units
    .filter(isSensor)
    .sort(
      (a, b) =>
        haversineM(a.position, subject.position) - haversineM(b.position, subject.position) ||
        a.id.localeCompare(b.id),
    );
  const first = sensors[0];
  if (!first) return [];
  const second = sensors[1] ?? first;
  state.counters.group += 1;
  const group = `grp-${state.counters.group}`;

  const honest = makeRealReport(state, rng, first, subject);
  honest.conflictGroup = group;
  const altRelIdx = clamp(sensorReliabilityIndex(second, state.weather) + 2, 0, 5);
  const alt: Report = {
    id: nextReportId(state),
    tick: state.tick,
    sensorUnitId: second.id,
    subjectUnitId: subject.id,
    position: { ...altPosition },
    type: altType,
    trueReliability: reliabilityFromIndex(altRelIdx),
    trueCredibility: drawCredibility(rng, altRelIdx),
    ghost: false,
    conflictGroup: group,
  };
  return [honest, alt];
}

/**
 * One tick of friendly sensing: real detections (range, terrain LOS, weather-scaled range, per-pair
 * cooldown, boosted while an ISR task is active) plus background ghost contacts for unreliable sensors.
 */
export function senseTick(state: TruthState, rng: Rng): Report[] {
  const out: Report[] = [];
  const targets = state.units.filter((u) => u.side !== 'BLUE' && u.status !== 'DESTROYED');
  for (const sensor of state.units) {
    if (!isSensor(sensor)) continue;
    const boosted = sensor.isrUntilTick > state.tick;
    const range = effectiveSensorRange(sensor, state.weather, boosted);
    const sensorProfile = profileFor(sensor.type);

    for (const target of targets) {
      const key = `${sensor.id}|${target.id}`;
      const last = state.lastDetectionTick[key];
      if (last !== undefined && state.tick - last < SENSOR_COOLDOWN_TICKS) continue;
      const d = haversineM(sensor.position, target.position);
      if (d > range) continue;
      const visible = lineOfSight(state.terrain, sensor.position, target.position, {
        aHeightM: sensorProfile.antennaM,
        bHeightM: profileFor(target.type).antennaM,
      });
      if (!visible) continue;
      const p = Math.min(0.9, 0.12 * (1 - 0.5 * (d / range)) * (boosted ? 3 : 1));
      if (rng.next() >= p) continue;
      state.lastDetectionTick[key] = state.tick;
      out.push(makeRealReport(state, rng, sensor, target));
    }

    const ghostRate = GHOST_RATE_PER_TICK[sensorReliabilityIndex(sensor, state.weather)] ?? 0;
    if (ghostRate > 0 && rng.next() < ghostRate) out.push(makeGhostReport(state, rng, sensor));
  }
  return out;
}
