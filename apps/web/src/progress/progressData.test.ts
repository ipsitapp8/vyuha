import { describe, expect, it } from 'vitest';
import type { ProgressSession } from '@vyuha/shared';
import {
  brierSummary,
  chartRows,
  delayComparison,
  measuredCount,
  metricSeries,
} from './progressData';

const session = (n: number, m: Partial<ProgressSession['metrics']> = {}): ProgressSession => ({
  sessionId: `s${n}`,
  code: `CODE${n}`,
  scenarioTitle: 'Op',
  endedAt: `2026-01-0${n}T10:00:00.000Z`,
  metrics: {
    avgDecisionLatencyMs: 30_000,
    latencyUnderJammingMs: 40_000,
    brierScore: 0.4,
    spoofsChallengedPct: 50,
    reportGradingAccuracy: 0.6,
    ...m,
  },
});

describe('progress data', () => {
  it('converts stored units to display units and keeps gaps as null', () => {
    const s = [
      session(1),
      session(2, { latencyUnderJammingMs: null, reportGradingAccuracy: 0.75 }),
    ];
    expect(metricSeries(s, 'latencyUnderJammingMs')).toEqual([40, null]);
    expect(metricSeries(s, 'reportGradingAccuracy')).toEqual([60, 75]);
    expect(metricSeries(s, 'brierScore')).toEqual([0.4, 0.4]);
    const rows = chartRows(s, 'latencyUnderJammingMs');
    expect(rows).toEqual([
      { session: 1, date: '2026-01-01', value: 40 },
      { session: 2, date: '2026-01-02', value: null },
    ]);
    expect(measuredCount(rows)).toBe(1);
  });

  it('compares the 3rd session with the 1st for delay under jamming', () => {
    const s = [
      session(1, { latencyUnderJammingMs: 40_000 }),
      session(2, { latencyUnderJammingMs: 35_000 }),
      session(3, { latencyUnderJammingMs: 30_000 }),
    ];
    const c = delayComparison(s);
    expect(c).toMatchObject({ fromSession: 1, toSession: 3, from: 40, to: 30 });
    expect(c?.changePct).toBeCloseTo(-25);
    expect(delayComparison([session(1)])).toBeNull();
  });

  it('summarises the Brier trend, latest and average', () => {
    const s = [
      session(1, { brierScore: 0.6 }),
      session(2, { brierScore: null }),
      session(3, { brierScore: 0.2 }),
    ];
    const b = brierSummary(s);
    expect(b.trend).toBe('improving');
    expect(b.latest).toBeCloseTo(0.2);
    expect(b.average).toBeCloseTo(0.4);
    expect(brierSummary([session(1, { brierScore: null })])).toEqual({
      trend: null,
      latest: null,
      average: null,
    });
  });
});
