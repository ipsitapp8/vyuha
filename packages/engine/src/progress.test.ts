import { describe, expect, it } from 'vitest';
import {
  average,
  brierTrend,
  compareToFirst,
  computeProgressMetrics,
  percentChange,
  trendDirection,
} from './progress';
import type { DecisionRecord, EngineEvent } from './types';

const ev = (tick: number, type: string, payload: Record<string, unknown>): EngineEvent => ({
  tick,
  type,
  payload,
  visibleTo: [],
});

const dec = (
  tick: number,
  confidence: number,
  outcome: 0 | 1 | null,
  latencyTicks: number | null,
): DecisionRecord => ({
  playerId: 'p1',
  tick,
  actionType: 'ENGAGE',
  confidence,
  outcome,
  latencyTicks,
});

describe('percentChange', () => {
  it('is relative to the starting value', () => {
    expect(percentChange(40, 30)).toBeCloseTo(-25);
    expect(percentChange(20, 30)).toBeCloseTo(50);
    expect(percentChange(10, 10)).toBe(0);
  });

  it('is null when it cannot be defined', () => {
    expect(percentChange(null, 5)).toBeNull();
    expect(percentChange(5, null)).toBeNull();
    expect(percentChange(0, 5)).toBeNull();
  });
});

describe('average', () => {
  it('ignores missing values and is null when none exist', () => {
    expect(average([0.5, null, 0.3, 0.1])).toBeCloseTo(0.3);
    expect(average([null, null])).toBeNull();
    expect(average([])).toBeNull();
  });
});

describe('compareToFirst', () => {
  it('compares the 3rd session with the 1st', () => {
    const c = compareToFirst([40_000, 35_000, 30_000, 10_000]);
    expect(c).toMatchObject({ fromSession: 1, toSession: 3, from: 40_000, to: 30_000 });
    expect(c?.changePct).toBeCloseTo(-25);
  });

  it('uses the latest session when there are only two', () => {
    expect(compareToFirst([50, 25])).toMatchObject({ toSession: 2, changePct: -50 });
  });

  it('needs two sessions, and a value in both', () => {
    expect(compareToFirst([])).toBeNull();
    expect(compareToFirst([12])).toBeNull();
    expect(compareToFirst([null, 5, 6])?.changePct).toBeNull();
    expect(compareToFirst([5, 6, null])?.changePct).toBeNull();
  });
});

describe('trend direction', () => {
  it('compares the latest value with the mean of the earlier ones', () => {
    expect(trendDirection([10, 8, 6], true, 0.5)).toBe('improving');
    expect(trendDirection([10, 8, 12], true, 0.5)).toBe('worsening');
    expect(trendDirection([10, 8, 9.2], true, 0.5)).toBe('flat');
    expect(trendDirection([60, 70, 90], false, 1)).toBe('improving');
  });

  it('skips missing sessions and needs two real values', () => {
    expect(trendDirection([null, 0.4, null, 0.2], true, 0.02)).toBe('improving');
    expect(trendDirection([null, 0.4], true, 0.02)).toBeNull();
  });

  it('treats a Brier score falling by more than 0.02 as better', () => {
    expect(brierTrend([0.5, 0.35, 0.2])).toBe('improving');
    expect(brierTrend([0.2, 0.3, 0.5])).toBe('worsening');
    expect(brierTrend([0.3, 0.31, 0.3])).toBe('flat');
    expect(brierTrend([0.3])).toBeNull();
  });
});

describe('computeProgressMetrics', () => {
  const jam = (tick: number, vhf: number): EngineEvent =>
    ev(tick, 'JAMMING_CHANGED', {
      jamming: { VHF: vhf, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
      satcomUp: true,
    });

  it('separates latency under jamming and averages Brier over scored decisions', () => {
    const events = [jam(50, 0.8), jam(150, 0)];
    const decisions = [
      dec(20, 90, 1, 10), // before jamming
      dec(100, 80, 0, 40), // while jammed
      dec(120, 60, 1, 20), // while jammed
      dec(200, 50, null, 30), // after, unscored
    ];
    const m = computeProgressMetrics(events, decisions, ['p1'])['p1'];
    expect(m?.avgDecisionLatencyMs).toBeCloseTo(25_000);
    expect(m?.latencyUnderJammingMs).toBeCloseTo(30_000);
    // (0.1^2 + 0.8^2 + 0.4^2) / 3
    expect(m?.brierScore).toBeCloseTo((0.01 + 0.64 + 0.16) / 3);
  });

  it('counts only spoofs the trainee actually challenged', () => {
    const events = [
      ev(10, 'SPOOF_INJECTED', { playerId: 'p1', messageId: 'a' }),
      ev(20, 'SPOOF_INJECTED', { playerId: 'p1', messageId: 'b' }),
      ev(25, 'SPOOF_INJECTED', { playerId: 'p2', messageId: 'c' }),
      ev(30, 'AUTH_STARTED', { playerId: 'p1', messageId: 'a' }),
      ev(31, 'AUTH_STARTED', { playerId: 'p2', messageId: 'zz' }),
    ];
    const out = computeProgressMetrics(events, [], ['p1', 'p2']);
    expect(out['p1']?.spoofsChallengedPct).toBeCloseTo(50);
    expect(out['p2']?.spoofsChallengedPct).toBeCloseTo(0);
  });

  it('reports grading accuracy and leaves unmeasurable metrics null', () => {
    const graded = ev(5, 'REPORT_GRADED', {
      playerId: 'p1',
      gradedReliability: 'B',
      gradedCredibility: 2,
      trueReliability: 'B',
      trueCredibility: 2,
    });
    const out = computeProgressMetrics([graded], [], ['p1', 'nobody']);
    expect(out['p1']?.reportGradingAccuracy).toBe(1);
    expect(out['p1']).toMatchObject({
      avgDecisionLatencyMs: null,
      latencyUnderJammingMs: null,
      brierScore: null,
      spoofsChallengedPct: null,
    });
    expect(out['nobody']?.reportGradingAccuracy).toBeNull();
  });

  it('is deterministic', () => {
    const events = [jam(5, 0.5)];
    const decisions = [dec(10, 70, 1, 12)];
    expect(computeProgressMetrics(events, decisions, ['p1'])).toEqual(
      computeProgressMetrics(events, decisions, ['p1']),
    );
  });
});
