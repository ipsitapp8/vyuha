import {
  computeMetrics,
  decisionsFromEvents,
  type DecisionRecord,
  type EngineEvent,
} from '@vyuha/engine';
import type { PlayerMetricsView } from '@vyuha/shared';

const METRIC_EVENT_TYPES = new Set([
  'REPORT_GRADED',
  'CHANNEL_SWITCHED',
  'SPOOF_ACTED',
  'DRIFT_SAMPLE',
]);
const KEEP_DRIFT_PER_PLAYER = 60;
const PRUNE_AT = 4000;

interface LastDecision {
  tick: number;
  actionType: string;
  confidence: number;
  outcome: 0 | 1 | null;
  rationale: string;
}

/**
 * Running per-trainee metrics for the instructor dashboard, folded in event by event so a view costs
 * the same at minute 5 and minute 90. Rebuilt from the replayed log after a restart.
 */
export class LiveMetrics {
  private decisions: DecisionRecord[] = [];
  private events: EngineEvent[] = [];
  private readonly last = new Map<string, LastDecision>();
  /** Situation-awareness probe scores per trainee, in the order they were scored. */
  private readonly sa = new Map<string, number[]>();

  ingest(batch: readonly EngineEvent[]): void {
    for (const e of batch) {
      if (e.type === 'DECISION_MADE') {
        const d = decisionsFromEvents([e])[0];
        if (!d) continue;
        this.decisions.push(d);
        this.last.set(d.playerId, {
          tick: d.tick,
          actionType: d.actionType,
          confidence: d.confidence,
          outcome: d.outcome,
          rationale: typeof e.payload['rationale'] === 'string' ? e.payload['rationale'] : '',
        });
      } else if (e.type === 'PROBE_SCORED') {
        const id = e.payload['playerId'];
        const score = e.payload['score'];
        if (typeof id === 'string' && typeof score === 'number')
          this.sa.set(id, [...(this.sa.get(id) ?? []), score]);
      } else if (METRIC_EVENT_TYPES.has(e.type)) {
        this.events.push(e);
      }
    }
    if (this.events.length > PRUNE_AT) this.pruneDrift();
  }

  /** Drift samples arrive every 10 ticks per player; keep only the recent ones. */
  private pruneDrift(): void {
    const perPlayer = new Map<string, EngineEvent[]>();
    const rest: EngineEvent[] = [];
    for (const e of this.events) {
      if (e.type !== 'DRIFT_SAMPLE') {
        rest.push(e);
        continue;
      }
      const id = String(e.payload['playerId']);
      perPlayer.set(id, [...(perPlayer.get(id) ?? []), e]);
    }
    const kept = [...perPlayer.values()].flatMap((list) => list.slice(-KEEP_DRIFT_PER_PLAYER));
    this.events = [...rest, ...kept].sort((a, b) => a.tick - b.tick);
  }

  view(playerIds: readonly string[]): Record<string, PlayerMetricsView> {
    const m = computeMetrics(this.events, this.decisions);
    const out: Record<string, PlayerMetricsView> = {};
    for (const id of playerIds) {
      const p = m.players[id];
      const scored = this.decisions.filter((d) => d.playerId === id && d.outcome !== null);
      const sa = this.sa.get(id) ?? [];
      out[id] = {
        probeCount: sa.length,
        lastSaScore: sa.at(-1) ?? null,
        saScore: sa.length ? Math.round(sa.reduce((a, b) => a + b, 0) / sa.length) : null,
        decisionCount: p?.decisionCount ?? 0,
        scoredDecisionCount: p?.scoredDecisionCount ?? 0,
        avgLatencyTicks: p?.avgLatencyTicks ?? null,
        brierScore: p?.brierScore ?? null,
        meanConfidence: scored.length
          ? scored.reduce((a, d) => a + d.confidence, 0) / scored.length
          : null,
        accuracy: scored.length
          ? (scored.filter((d) => d.outcome === 1).length / scored.length) * 100
          : null,
        gradeCount: p?.gradeCount ?? 0,
        gradingAccuracy: p?.gradingAccuracy ?? null,
        channelSwitchCount: p?.channelSwitchCount ?? 0,
        spoofActedCount: p?.spoofActedCount ?? 0,
        lastDecision: this.last.get(id) ?? null,
      };
    }
    return out;
  }
}
