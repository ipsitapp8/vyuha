import type { AarCompare, AarCompareSide } from '@vyuha/shared';

type Trainee = AarCompare['trainees'][number];

export interface MetricRow {
  key: 'decisions' | 'latency' | 'accuracy' | 'brier' | 'positionError' | 'missed';
  degraded: number | null;
  baseline: number | null;
  /** degraded minus baseline; null when either side has no value. */
  delta: number | null;
  /** For this metric a lower number is the better one. */
  lowerIsBetter: boolean;
  digits: number;
}

const player = (side: AarCompareSide, playerId: string) =>
  side.players.find((p) => p.playerId === playerId);

/** The headline numbers of one trainee in both runs, and how far degradation moved each. */
export function compareMetrics(cmp: AarCompare, trainee: Trainee): MetricRow[] {
  const d = player(cmp.degraded, trainee.degradedPlayerId);
  const b = player(cmp.baseline, trainee.baselinePlayerId);
  const row = (
    key: MetricRow['key'],
    degraded: number | null | undefined,
    baseline: number | null | undefined,
    lowerIsBetter: boolean,
    digits: number,
  ): MetricRow => {
    const x = degraded ?? null;
    const y = baseline ?? null;
    return {
      key,
      degraded: x,
      baseline: y,
      delta: x === null || y === null ? null : x - y,
      lowerIsBetter,
      digits,
    };
  };
  return [
    row('decisions', d?.decisionCount, b?.decisionCount, false, 0),
    row('latency', d?.avgLatencyTicks, b?.avgLatencyTicks, true, 0),
    row('accuracy', d?.accuracy, b?.accuracy, false, 0),
    row('brier', d?.brierScore, b?.brierScore, true, 2),
    row('positionError', d?.meanPositionErrorM, b?.meanPositionErrorM, true, 0),
    row('missed', d?.meanMissed, b?.meanMissed, true, 1),
  ];
}

export interface TimelineMark {
  id: string;
  tick: number;
  /** 0..100: where the decision sits along the run. */
  percent: number;
  actionType: string;
  outcome: 0 | 1 | null;
  latencyTicks: number | null;
  confidence: number;
}

/** One trainee's decisions in one run, in time order, placed along that run's length. */
export function decisionMarks(side: AarCompareSide, playerId: string): TimelineMark[] {
  const span = Math.max(1, side.durationTicks);
  return side.decisions
    .filter((d) => d.playerId === playerId)
    .sort((a, b) => a.tick - b.tick)
    .map((d) => ({
      id: d.id,
      tick: d.tick,
      percent: Math.min(100, Math.max(0, (d.tick / span) * 100)),
      actionType: d.actionType,
      outcome: d.outcome,
      latencyTicks: d.latencyTicks,
      confidence: d.confidence,
    }));
}

export interface LatencyRow {
  n: number;
  degraded: number | null;
  baseline: number | null;
}

/** Latency of the 1st, 2nd, 3rd ... decision in each run (decisions without a latency are left out). */
export function latencyRows(cmp: AarCompare, trainee: Trainee): LatencyRow[] {
  const of = (side: AarCompareSide, id: string): number[] =>
    decisionMarks(side, id).flatMap((m) => (m.latencyTicks === null ? [] : [m.latencyTicks]));
  const d = of(cmp.degraded, trainee.degradedPlayerId);
  const b = of(cmp.baseline, trainee.baselinePlayerId);
  return Array.from({ length: Math.max(d.length, b.length) }, (_, i) => ({
    n: i + 1,
    degraded: d[i] ?? null,
    baseline: b[i] ?? null,
  }));
}

export interface DriftRow {
  tick: number;
  degraded: number | null;
  baseline: number | null;
}

/** Picture drift (position error, m) over time for both runs on one time axis. */
export function driftRows(cmp: AarCompare, trainee: Trainee): DriftRow[] {
  const byTick = new Map<number, DriftRow>();
  const put = (side: 'degraded' | 'baseline', playerId: string): void => {
    for (const p of cmp[side].drift[playerId] ?? []) {
      const row = byTick.get(p.tick) ?? { tick: p.tick, degraded: null, baseline: null };
      row[side] = Math.round(p.avgPositionErrorM);
      byTick.set(p.tick, row);
    }
  };
  put('degraded', trainee.degradedPlayerId);
  put('baseline', trainee.baselinePlayerId);
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}
