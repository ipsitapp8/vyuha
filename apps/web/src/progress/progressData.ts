import {
  PROGRESS_METRIC_KEYS,
  average,
  brierTrend,
  compareToFirst,
  type ProgressMetricKey,
  type SessionComparison,
  type TrendDirection,
} from '@vyuha/engine';
import type { ProgressSession } from '@vyuha/shared';

export { PROGRESS_METRIC_KEYS };
export type { ProgressMetricKey };

/** How each stored metric is shown: stored units are ms, 0..1 and 0..100; charts use s, % and %. */
export const METRIC_VIEW: Record<ProgressMetricKey, { scale: number; digits: number }> = {
  avgDecisionLatencyMs: { scale: 1 / 1000, digits: 0 },
  latencyUnderJammingMs: { scale: 1 / 1000, digits: 0 },
  brierScore: { scale: 1, digits: 2 },
  spoofsChallengedPct: { scale: 1, digits: 0 },
  reportGradingAccuracy: { scale: 100, digits: 0 },
  saScore: { scale: 1, digits: 0 },
};

/** The metric's values per session in display units, null where it could not be measured. */
export function metricSeries(
  sessions: readonly ProgressSession[],
  key: ProgressMetricKey,
): (number | null)[] {
  const { scale } = METRIC_VIEW[key];
  return sessions.map((s) => {
    const v = s.metrics[key];
    return v === null ? null : v * scale;
  });
}

export interface ChartRow {
  session: number;
  date: string;
  value: number | null;
}

export function chartRows(
  sessions: readonly ProgressSession[],
  key: ProgressMetricKey,
): ChartRow[] {
  return metricSeries(sessions, key).map((value, i) => ({
    session: i + 1,
    date: (sessions[i]?.endedAt ?? '').slice(0, 10),
    value,
  }));
}

/** Sessions with a stored value for the metric. */
export const measuredCount = (rows: readonly ChartRow[]): number =>
  rows.filter((r) => r.value !== null).length;

/** "3rd session vs 1st session" change in decision delay under jamming (fewer than 3: the latest). */
export function delayComparison(sessions: readonly ProgressSession[]): SessionComparison | null {
  return compareToFirst(metricSeries(sessions, 'latencyUnderJammingMs'));
}

export interface BrierSummary {
  trend: TrendDirection | null;
  latest: number | null;
  average: number | null;
}

export function brierSummary(sessions: readonly ProgressSession[]): BrierSummary {
  const series = metricSeries(sessions, 'brierScore');
  return {
    trend: brierTrend(series),
    latest: [...series].reverse().find((v) => v !== null) ?? null,
    average: average(series),
  };
}

/** A trend needs at least two sessions. */
export const MIN_SESSIONS_FOR_TREND = 2;
