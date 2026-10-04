import { computeMetrics, spoofChallenge } from './metrics';
import { jamAt, jamSteps } from './aar';
import type { DecisionRecord, EngineEvent } from './types';

/** One engine tick is one second of exercise time. */
export const TICK_MS = 1000;
/** A decision counts as "under jamming" when any channel is jammed at least this hard (0..1). */
export const JAMMING_THRESHOLD = 0.3;

/** What is tracked for a trainee across sessions. Null means "nothing to measure in that session". */
export interface ProgressMetrics {
  avgDecisionLatencyMs: number | null;
  /** Mean decision latency over decisions taken while a channel was jammed (see JAMMING_THRESHOLD). */
  latencyUnderJammingMs: number | null;
  brierScore: number | null;
  /** Share (0..100) of spoofed orders received that the trainee challenged with Authenticate. */
  spoofsChallengedPct: number | null;
  /** Admiralty grading accuracy, 0..1. */
  reportGradingAccuracy: number | null;
}

export const PROGRESS_METRIC_KEYS = [
  'avgDecisionLatencyMs',
  'latencyUnderJammingMs',
  'brierScore',
  'spoofsChallengedPct',
  'reportGradingAccuracy',
] as const;
export type ProgressMetricKey = (typeof PROGRESS_METRIC_KEYS)[number];

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean of the values that exist; null when none do. */
export function average(values: readonly (number | null)[]): number | null {
  return mean(values.filter((v): v is number => v !== null));
}

/**
 * Per-player progress metrics for one finished exercise, built on `computeMetrics` plus the spoof and
 * jamming context that only the event log has. Pure: the same events give the same numbers.
 */
export function computeProgressMetrics(
  events: readonly EngineEvent[],
  decisions: readonly DecisionRecord[],
  playerIds: readonly string[],
): Record<string, ProgressMetrics> {
  const base = computeMetrics(events, decisions).players;
  const steps = jamSteps(events);
  const out: Record<string, ProgressMetrics> = {};

  for (const playerId of playerIds) {
    const m = base[playerId];
    const mine = decisions.filter((d) => d.playerId === playerId);

    const jammed = mine.flatMap((d) => {
      if (d.latencyTicks === null) return [];
      const jam = jamAt(steps, d.tick).jamming;
      return Math.max(...Object.values(jam)) >= JAMMING_THRESHOLD ? [d.latencyTicks] : [];
    });

    const latency = m?.avgLatencyTicks ?? null;
    const jammedLatency = mean(jammed);
    out[playerId] = {
      avgDecisionLatencyMs: latency === null ? null : latency * TICK_MS,
      latencyUnderJammingMs: jammedLatency === null ? null : jammedLatency * TICK_MS,
      brierScore: m?.brierScore ?? null,
      spoofsChallengedPct: spoofChallenge(events, playerId).pct,
      reportGradingAccuracy: m?.gradingAccuracy ?? null,
    };
  }
  return out;
}

// ---- Trend math ------------------------------------------------------------------------------

/** Percent change from `from` to `to`: -25 means a quarter lower. Null when either is missing or `from` is 0. */
export function percentChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export interface SessionComparison {
  /** 1-based session numbers being compared. */
  fromSession: number;
  toSession: number;
  from: number | null;
  to: number | null;
  /** Percent change, negative = lower (for delays, better). Null when it cannot be computed. */
  changePct: number | null;
}

/**
 * The Nth session against the 1st (the 3rd by default). With fewer than N sessions the latest one is
 * used instead; with fewer than 2 there is nothing to compare, so the result is null.
 */
export function compareToFirst(
  series: readonly (number | null)[],
  nth = 3,
): SessionComparison | null {
  if (series.length < 2) return null;
  const toIndex = Math.min(nth, series.length) - 1;
  const from = series[0] ?? null;
  const to = series[toIndex] ?? null;
  return {
    fromSession: 1,
    toSession: toIndex + 1,
    from,
    to,
    changePct: percentChange(from, to),
  };
}

export type TrendDirection = 'improving' | 'worsening' | 'flat';

/**
 * Direction of a series: the latest value against the mean of the earlier ones. `tolerance` is the
 * smallest change that counts, in the metric's own units.
 */
export function trendDirection(
  series: readonly (number | null)[],
  lowerIsBetter: boolean,
  tolerance: number,
): TrendDirection | null {
  const values = series.filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  const latest = values[values.length - 1] as number;
  const earlier = average(values.slice(0, -1)) as number;
  const delta = latest - earlier;
  if (Math.abs(delta) <= tolerance) return 'flat';
  return delta < 0 === lowerIsBetter ? 'improving' : 'worsening';
}

/** Brier trend: lower is better, a move of 0.02 or less is noise. */
export const brierTrend = (series: readonly (number | null)[]): TrendDirection | null =>
  trendDirection(series, true, 0.02);
