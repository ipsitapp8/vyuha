import { CONTACT_TTL_TICKS } from './config';
import { haversineM } from './geometry';
import { getPlayer, getUnit } from './state';
import type { DecisionRecord, EngineEvent, PictureDrift, TruthState } from './types';

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Picture drift: how far a player's perceived picture is from truth (server-side only).
 * missed = live hostile units with no current contact; ghost = contacts with no real subject;
 * position error = distance from the freshest contact to the unit's true position (metres).
 */
export function computePictureDrift(truth: TruthState, playerId: string): PictureDrift {
  const player = getPlayer(truth, playerId);
  const knowledge = truth.knowledge[playerId];
  if (!player || !knowledge) throw new RangeError(`Unknown player ${playerId}`);

  const live = knowledge.reports.filter((r) => truth.tick - r.observedTick <= CONTACT_TTL_TICKS);
  let ghost = 0;
  const freshestBySubject = new Map<string, { observedTick: number; err: number }>();
  for (const contact of live) {
    const report = truth.reports.find((r) => r.id === contact.reportId);
    const subject = report?.subjectUnitId ? getUnit(truth, report.subjectUnitId) : undefined;
    if (!report || report.ghost || !subject) {
      ghost += 1;
      continue;
    }
    if (subject.side !== 'RED' || subject.status === 'DESTROYED') continue;
    const err = haversineM(contact.position, subject.position);
    const prev = freshestBySubject.get(subject.id);
    if (!prev || contact.observedTick > prev.observedTick) {
      freshestBySubject.set(subject.id, { observedTick: contact.observedTick, err });
    }
  }

  const hostiles = truth.units.filter((u) => u.side === 'RED' && u.status !== 'DESTROYED');
  const missed = hostiles.filter((u) => !freshestBySubject.has(u.id)).length;

  const friendlyErrs = Object.entries(knowledge.friendlies).flatMap(([unitId, fix]) => {
    const u = getUnit(truth, unitId);
    return u ? [haversineM(fix.position, u.position)] : [];
  });

  return {
    missed,
    ghost,
    avgPositionErrorM: mean([...freshestBySubject.values()].map((v) => v.err)),
    friendlyAvgErrorM: mean(friendlyErrs),
  };
}

/** Brier score of confidence forecasts: mean((confidence/100 - outcome)^2). Null when none are scorable. */
export function brierScore(
  items: readonly { confidence: number; outcome: 0 | 1 | null }[],
): number | null {
  const scored = items.filter(
    (i): i is { confidence: number; outcome: 0 | 1 } => i.outcome !== null,
  );
  if (scored.length === 0) return null;
  return mean(scored.map((i) => (i.confidence / 100 - i.outcome) ** 2));
}

/** 1 for an exact Admiralty grade, falling linearly with distance on both axes (0..1). */
export function gradeAccuracy(
  graded: { reliability: string; credibility: number },
  actual: { reliability: string; credibility: number },
): number {
  const rel = Math.abs(graded.reliability.charCodeAt(0) - actual.reliability.charCodeAt(0)) / 5;
  const cred = Math.abs(graded.credibility - actual.credibility) / 5;
  return Math.max(0, 1 - (rel + cred) / 2);
}

export interface PlayerMetrics {
  playerId: string;
  decisionCount: number;
  scoredDecisionCount: number;
  avgLatencyTicks: number | null;
  brierScore: number | null;
  gradeCount: number;
  gradingAccuracy: number | null;
  channelSwitchCount: number;
  spoofActedCount: number;
  drift: {
    samples: number;
    meanMissed: number;
    meanGhost: number;
    meanPositionErrorM: number;
    maxPositionErrorM: number;
  } | null;
}

export interface Metrics {
  players: Record<string, PlayerMetrics>;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Extracts decision records from DECISION_MADE events (the DB `Decision` rows carry the same data). */
export function decisionsFromEvents(events: readonly EngineEvent[]): DecisionRecord[] {
  return events
    .filter((e) => e.type === 'DECISION_MADE')
    .map((e) => {
      const outcome = e.payload['outcome'];
      const latency = e.payload['latencyTicks'];
      return {
        playerId: str(e.payload['playerId']),
        tick: e.tick,
        actionType: str(e.payload['actionType']),
        confidence: num(e.payload['confidence']),
        outcome: outcome === 0 || outcome === 1 ? outcome : null,
        latencyTicks: typeof latency === 'number' ? latency : null,
      };
    });
}

/** Per-player exercise metrics from the event log and the recorded decisions. */
export function computeMetrics(
  events: readonly EngineEvent[],
  decisions: readonly DecisionRecord[],
): Metrics {
  const ids = new Set<string>();
  for (const d of decisions) ids.add(d.playerId);
  for (const e of events) {
    const id = e.payload['playerId'];
    if (typeof id === 'string' && id !== '') ids.add(id);
  }

  const players: Record<string, PlayerMetrics> = {};
  for (const playerId of [...ids].sort()) {
    const mine = decisions.filter((d) => d.playerId === playerId);
    const latencies = mine.flatMap((d) => (d.latencyTicks === null ? [] : [d.latencyTicks]));
    const forPlayer = (type: string): EngineEvent[] =>
      events.filter((e) => e.type === type && e.payload['playerId'] === playerId);

    const grades = forPlayer('REPORT_GRADED').map((e) =>
      gradeAccuracy(
        {
          reliability: str(e.payload['gradedReliability']),
          credibility: num(e.payload['gradedCredibility']),
        },
        {
          reliability: str(e.payload['trueReliability']),
          credibility: num(e.payload['trueCredibility']),
        },
      ),
    );
    const drift = forPlayer('DRIFT_SAMPLE');
    const errs = drift.map((e) => num(e.payload['avgPositionErrorM']));

    players[playerId] = {
      playerId,
      decisionCount: mine.length,
      scoredDecisionCount: mine.filter((d) => d.outcome !== null).length,
      avgLatencyTicks: latencies.length ? mean(latencies) : null,
      brierScore: brierScore(mine),
      gradeCount: grades.length,
      gradingAccuracy: grades.length ? mean(grades) : null,
      channelSwitchCount: forPlayer('CHANNEL_SWITCHED').length,
      spoofActedCount: forPlayer('SPOOF_ACTED').length,
      drift: drift.length
        ? {
            samples: drift.length,
            meanMissed: mean(drift.map((e) => num(e.payload['missed']))),
            meanGhost: mean(drift.map((e) => num(e.payload['ghost']))),
            meanPositionErrorM: mean(errs),
            maxPositionErrorM: Math.max(...errs),
          }
        : null,
    };
  }
  return { players };
}
