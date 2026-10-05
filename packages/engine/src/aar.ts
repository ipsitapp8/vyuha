import type { Channel } from '@vyuha/shared';
import { CHANNELS } from './config';
import { computeMetrics, spoofChallenge, type PlayerMetrics } from './metrics';
import { meanSaScore, probeReviews, probeScoresFromEvents, type ProbeReview } from './probe';
import type { EngineEvent } from './types';

/**
 * After-action analysis. Pure functions over the recorded event log and decisions: the same input
 * always yields the same charts, tables and learning points, so the on-screen review and the exported
 * report can never disagree.
 */

export interface AarPlayer {
  id: string;
  name: string;
  role: string;
  teamId: string;
  unitId: string;
}

export interface AarTeam {
  id: string;
  name: string;
  /** The team's PACE primary channel: where it starts. */
  primary: Channel;
}

export interface AarDecision {
  id: string;
  playerId: string;
  tick: number;
  actionType: string;
  confidence: number;
  rationale: string;
  targetContactId: string | null;
  basedOnMessageId: string | null;
  outcome: 0 | 1 | null;
  latencyTicks: number | null;
  spoofActed: boolean;
}

export interface AarInput {
  durationTicks: number;
  players: readonly AarPlayer[];
  teams: readonly AarTeam[];
  events: readonly EngineEvent[];
  decisions: readonly AarDecision[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clockOf = (tick: number): string => {
  const t = Math.max(0, Math.floor(tick));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const isChannel = (v: unknown): v is Channel => CHANNELS.some((c) => c === v);
const mean = (xs: readonly number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

// ---- Calibration -----------------------------------------------------------------------

export interface CalibrationBin {
  /** Inclusive lower and upper edge of the confidence bin (percent). */
  from: number;
  to: number;
  count: number;
  /** Average stated confidence in the bin (percent). */
  meanConfidence: number;
  /** Share of decisions in the bin that were correct (percent). */
  accuracy: number;
}

/** Confidence vs actual correctness in equal-width bins; perfectly calibrated means accuracy == confidence. */
export function calibrationBins(
  decisions: readonly Pick<AarDecision, 'confidence' | 'outcome'>[],
  bins = 5,
): CalibrationBin[] {
  const width = 100 / bins;
  const out: CalibrationBin[] = [];
  for (let i = 0; i < bins; i++) {
    const from = Math.round(i * width);
    const to = Math.round((i + 1) * width);
    const inBin = decisions.filter(
      (d) =>
        d.outcome !== null &&
        d.confidence >= from &&
        (i === bins - 1 ? d.confidence <= to : d.confidence < to),
    );
    if (inBin.length === 0) continue;
    out.push({
      from,
      to,
      count: inBin.length,
      meanConfidence: mean(inBin.map((d) => d.confidence)),
      accuracy: (inBin.filter((d) => d.outcome === 1).length / inBin.length) * 100,
    });
  }
  return out;
}

// ---- Drift -------------------------------------------------------------------------------

export interface DriftPoint {
  tick: number;
  missed: number;
  ghost: number;
  avgPositionErrorM: number;
  friendlyAvgErrorM: number;
}

export function driftSeries(events: readonly EngineEvent[]): Record<string, DriftPoint[]> {
  const out: Record<string, DriftPoint[]> = {};
  for (const e of events) {
    if (e.type !== 'DRIFT_SAMPLE') continue;
    const id = str(e.payload['playerId']);
    (out[id] ??= []).push({
      tick: e.tick,
      missed: num(e.payload['missed']),
      ghost: num(e.payload['ghost']),
      avgPositionErrorM: num(e.payload['avgPositionErrorM']),
      friendlyAvgErrorM: num(e.payload['friendlyAvgErrorM']),
    });
  }
  return out;
}

// ---- Channel usage vs jamming ------------------------------------------------------------

export interface ChannelBucket {
  /** Bucket start tick. */
  tick: number;
  usage: Record<Channel, number>;
  /** Effective jamming (0..1) at the end of the bucket. */
  jamming: Record<Channel, number>;
  satcomUp: boolean;
}

const zeroChannels = (): Record<Channel, number> => ({
  VHF: 0,
  HF: 0,
  SATCOM: 0,
  DATALINK: 0,
  RUNNER: 0,
});

export interface JamStep {
  tick: number;
  jamming: Record<Channel, number>;
  satcomUp: boolean;
}

export function jamSteps(events: readonly EngineEvent[]): JamStep[] {
  const steps: JamStep[] = [{ tick: 0, jamming: zeroChannels(), satcomUp: true }];
  for (const e of events) {
    if (e.type !== 'JAMMING_CHANGED') continue;
    const raw = e.payload['jamming'];
    const jamming = zeroChannels();
    if (raw !== null && typeof raw === 'object') {
      for (const c of CHANNELS) jamming[c] = num((raw as Record<string, unknown>)[c]);
    }
    steps.push({ tick: e.tick, jamming, satcomUp: e.payload['satcomUp'] !== false });
  }
  return steps;
}

export const jamAt = (steps: readonly JamStep[], tick: number): JamStep => {
  let cur = steps[0] as JamStep;
  for (const s of steps) {
    if (s.tick <= tick) cur = s;
    else break;
  }
  return cur;
};

/** Messages sent per channel and the jamming level they were sent into, per time bucket. */
export function channelSeries(input: AarInput, bucket = 10): ChannelBucket[] {
  const steps = jamSteps(input.events);
  const buckets: ChannelBucket[] = [];
  for (let t = 0; t <= input.durationTicks; t += bucket) {
    const end = jamAt(steps, t + bucket - 1);
    buckets.push({
      tick: t,
      usage: zeroChannels(),
      jamming: { ...end.jamming },
      satcomUp: end.satcomUp,
    });
  }
  for (const e of input.events) {
    if (e.type !== 'MESSAGE_OUTCOME' || !isChannel(e.payload['channel'])) continue;
    const b = buckets[Math.min(buckets.length - 1, Math.floor(e.tick / bucket))];
    if (b) b.usage[e.payload['channel']] += 1;
  }
  return buckets;
}

// ---- Message flow -------------------------------------------------------------------------

export type Outcome = 'DELIVERED' | 'DELAYED' | 'DROPPED' | 'CORRUPTED';
const OUTCOMES: readonly Outcome[] = ['DELIVERED', 'DELAYED', 'DROPPED', 'CORRUPTED'];

export interface FlowEdge {
  /** Player id, or the unit id of an unmanned sender (e.g. HQ sensors). */
  from: string;
  to: string;
  kind: string;
  channel: Channel;
  total: number;
  outcomes: Record<Outcome, number>;
}

/** Who talked to whom, on which channel, and what got lost on the way. */
export function messageFlow(input: AarInput): FlowEdge[] {
  const ownerOf = new Map(input.players.map((p) => [p.unitId, p.id]));
  const edges = new Map<string, FlowEdge>();
  for (const e of input.events) {
    if (e.type !== 'MESSAGE_OUTCOME' || !isChannel(e.payload['channel'])) continue;
    const unitId = str(e.payload['fromUnitId']);
    const from = ownerOf.get(unitId) ?? unitId;
    const to = str(e.payload['toPlayerId']);
    const kind = str(e.payload['kind']);
    const channel = e.payload['channel'];
    const key = `${kind}|${from}|${to}|${channel}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = {
        from,
        to,
        kind,
        channel,
        total: 0,
        outcomes: { DELIVERED: 0, DELAYED: 0, DROPPED: 0, CORRUPTED: 0 },
      };
      edges.set(key, edge);
    }
    const outcome = OUTCOMES.find((o) => o === e.payload['outcome']);
    edge.total += 1;
    if (outcome) edge.outcomes[outcome] += 1;
  }
  return [...edges.values()].sort((a, b) => b.total - a.total || a.from.localeCompare(b.from));
}

// ---- Timeline -----------------------------------------------------------------------------

export type TimelineKind = 'INJECT' | 'SPOOF' | 'AUTH' | 'CHANNEL_SWITCH' | 'DECISION' | 'JAMMING';

export interface TimelineItem {
  tick: number;
  kind: TimelineKind;
  playerId: string | null;
  params: Record<string, string | number>;
}

const MAIN_CHANNELS: readonly Channel[] = ['VHF', 'HF', 'SATCOM', 'DATALINK'];

/** The story of the exercise: injects, spoofs, authentications, switches, decisions and jamming changes. */
export function keyTimeline(input: AarInput): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const e of input.events) {
    const p = e.payload;
    switch (e.type) {
      case 'INJECT_FIRED':
        items.push({
          tick: e.tick,
          kind: 'INJECT',
          playerId: null,
          params: { title: str(p['title']), source: str(p['source']) },
        });
        break;
      case 'SPOOF_INJECTED':
        items.push({
          tick: e.tick,
          kind: 'SPOOF',
          playerId: str(p['playerId']),
          params: { text: str(p['text']) },
        });
        break;
      case 'AUTH_RESOLVED':
        items.push({
          tick: e.tick,
          kind: 'AUTH',
          playerId: str(p['playerId']),
          params: { result: str(p['result']) },
        });
        break;
      case 'CHANNEL_SWITCHED':
        items.push({
          tick: e.tick,
          kind: 'CHANNEL_SWITCH',
          playerId: str(p['playerId']),
          params: { from: str(p['from']), to: str(p['to']) },
        });
        break;
      case 'JAMMING_CHANGED': {
        const raw = (p['jamming'] ?? {}) as Record<string, unknown>;
        const worst = MAIN_CHANNELS.reduce(
          (best, c) => (num(raw[c]) > num(raw[best]) ? c : best),
          'VHF' as Channel,
        );
        items.push({
          tick: e.tick,
          kind: 'JAMMING',
          playerId: null,
          params: { channel: worst, level: Math.round(num(raw[worst]) * 100) },
        });
        break;
      }
      default:
        break;
    }
  }
  for (const d of input.decisions) {
    items.push({
      tick: d.tick,
      kind: 'DECISION',
      playerId: d.playerId,
      params: {
        action: d.actionType,
        confidence: d.confidence,
        outcome: d.outcome === null ? 'unscored' : d.outcome === 1 ? 'correct' : 'wrong',
      },
    });
  }
  return items.sort((a, b) => a.tick - b.tick);
}

// ---- Learning points -----------------------------------------------------------------------

export type Severity = 'good' | 'info' | 'warn';

export interface LearningPoint {
  /** Stable rule id; the UI looks the wording up by this id (English or Hindi). */
  rule: string;
  severity: Severity;
  playerId: string | null;
  teamId: string | null;
  params: Record<string, string | number>;
}

const LOW_RELIABILITY = new Set(['D', 'E', 'F']);
const ACTING_ON_CONTACT = new Set(['ENGAGE', 'REPORT_UP']);
const JAM_LEVEL = 0.5;
const JAM_GRACE_TICKS = 90;
const QUICK_SWITCH_TICKS = 45;

interface Grade {
  tick: number;
  reliability: string;
  credibility: number;
}

/** Rule-based observations (no AI, works offline): the same input always yields the same points. */
export function learningPoints(input: AarInput): LearningPoint[] {
  const points: LearningPoint[] = [];
  const metrics = computeMetrics(input.events, input.decisions.map(toRecord)).players;
  const ghosts = new Set(
    input.events
      .filter((e) => e.type === 'REPORT_GENERATED' && e.payload['ghost'] === true)
      .map((e) => str(e.payload['reportId'])),
  );
  const grades = new Map<string, Grade[]>();
  for (const e of input.events) {
    if (e.type !== 'REPORT_GRADED') continue;
    const key = `${str(e.payload['playerId'])}|${str(e.payload['reportId'])}`;
    (grades.get(key) ?? grades.set(key, []).get(key))?.push({
      tick: e.tick,
      reliability: str(e.payload['gradedReliability']),
      credibility: num(e.payload['gradedCredibility']),
    });
  }
  const spoofsReceived = new Map<string, number>();
  for (const e of input.events) {
    if (e.type === 'SPOOF_INJECTED') {
      const id = str(e.payload['playerId']);
      spoofsReceived.set(id, (spoofsReceived.get(id) ?? 0) + 1);
    }
  }
  const authStarted = new Map<string, number>();
  for (const e of input.events) {
    if (e.type === 'AUTH_STARTED') {
      const id = str(e.payload['playerId']);
      authStarted.set(id, (authStarted.get(id) ?? 0) + 1);
    }
  }
  const contactsReceived = new Map<string, number>();
  for (const e of input.events) {
    if (e.type === 'REPORT_RECEIVED') {
      const id = str(e.payload['playerId']);
      contactsReceived.set(id, (contactsReceived.get(id) ?? 0) + 1);
    }
  }

  for (const p of input.players) {
    const m: PlayerMetrics | undefined = metrics[p.id];
    const mine = input.decisions.filter((d) => d.playerId === p.id);
    const add = (
      rule: string,
      severity: Severity,
      params: Record<string, string | number> = {},
    ): void => {
      points.push({ rule, severity, playerId: p.id, teamId: p.teamId, params });
    };

    if (mine.length === 0) add('NO_DECISIONS', 'warn');

    // Acting on reports the trainee themself graded as unreliable.
    const lowGrade = mine.filter((d) => {
      if (!d.targetContactId || !ACTING_ON_CONTACT.has(d.actionType)) return false;
      const g = [...(grades.get(`${p.id}|${d.targetContactId}`) ?? [])]
        .filter((x) => x.tick <= d.tick)
        .at(-1);
      return !!g && (LOW_RELIABILITY.has(g.reliability) || g.credibility >= 5);
    }).length;
    if (lowGrade > 0) add('ACTED_ON_LOW_GRADE', 'warn', { count: lowGrade });

    const ghostActs = mine.filter(
      (d) =>
        d.targetContactId && ghosts.has(d.targetContactId) && ACTING_ON_CONTACT.has(d.actionType),
    ).length;
    if (ghostActs > 0) add('ACTED_ON_GHOST', 'warn', { count: ghostActs });

    const spoofActed = m?.spoofActedCount ?? 0;
    const received = spoofsReceived.get(p.id) ?? 0;
    // Acting on an order that authentication had already shown to be fake is its own, worse, mistake.
    const knownFake = input.events.filter(
      (e) =>
        e.type === 'SPOOF_ACTED' &&
        e.payload['playerId'] === p.id &&
        e.payload['authState'] === 'FAILED',
    ).length;
    if (spoofActed - knownFake > 0)
      add('ACTED_ON_SPOOF', 'warn', { count: spoofActed - knownFake });
    if (knownFake > 0) add('ACTED_ON_FAILED_AUTH', 'warn', { count: knownFake });
    if (received > 0 && (authStarted.get(p.id) ?? 0) === 0)
      add('NEVER_AUTHENTICATED', 'warn', { received });
    if (received > 0 && spoofActed === 0 && (authStarted.get(p.id) ?? 0) > 0) {
      add('SPOOF_HANDLED_WELL', 'good', { received });
    }

    const scored = m?.scoredDecisionCount ?? 0;
    if (scored >= 3) {
      const conf = mean(mine.filter((d) => d.outcome !== null).map((d) => d.confidence));
      const acc = (mine.filter((d) => d.outcome === 1).length / scored) * 100;
      const params = { confidence: Math.round(conf), accuracy: Math.round(acc), decisions: scored };
      if (conf - acc >= 25) add('OVERCONFIDENT', 'warn', params);
      else if (acc - conf >= 25) add('UNDERCONFIDENT', 'info', params);
      else if (Math.abs(conf - acc) <= 10) add('WELL_CALIBRATED', 'good', params);
    }

    if (m?.avgLatencyTicks != null && m.avgLatencyTicks > 60) {
      add('SLOW_DECISIONS', 'warn', { seconds: Math.round(m.avgLatencyTicks) });
    }

    if (m && m.gradeCount >= 3 && m.gradingAccuracy !== null) {
      const pct = Math.round(m.gradingAccuracy * 100);
      if (m.gradingAccuracy < 0.5)
        add('GRADING_POOR', 'warn', { accuracy: pct, grades: m.gradeCount });
      else if (m.gradingAccuracy >= 0.8)
        add('GRADING_GOOD', 'good', { accuracy: pct, grades: m.gradeCount });
    }
    if ((contactsReceived.get(p.id) ?? 0) >= 6 && (m?.gradeCount ?? 0) === 0) {
      add('NEVER_GRADED', 'info', { contacts: contactsReceived.get(p.id) ?? 0 });
    }

    if (m?.drift && (m.drift.meanPositionErrorM > 1000 || m.drift.meanMissed >= 3)) {
      add('HIGH_DRIFT', 'warn', {
        errorM: Math.round(m.drift.meanPositionErrorM),
        missed: Math.round(m.drift.meanMissed * 10) / 10,
      });
    }
  }

  points.push(...channelPoints(input));
  const order: Record<Severity, number> = { warn: 0, info: 1, good: 2 };
  return points.sort((a, b) => order[a.severity] - order[b.severity]);
}

const toRecord = (d: AarDecision) => ({
  playerId: d.playerId,
  tick: d.tick,
  actionType: d.actionType,
  confidence: d.confidence,
  outcome: d.outcome,
  latencyTicks: d.latencyTicks,
});

/** Did each team leave a heavily jammed channel, and how quickly? */
function channelPoints(input: AarInput): LearningPoint[] {
  const out: LearningPoint[] = [];
  const steps = jamSteps(input.events);
  for (const team of input.teams) {
    const switches = input.events
      .filter((e) => e.type === 'CHANNEL_SWITCHED' && str(e.payload['teamId']) === team.id)
      .map((e) => ({ tick: e.tick, to: e.payload['to'] }))
      .filter((s): s is { tick: number; to: Channel } => isChannel(s.to));
    // Active channel as a step function of time.
    const activeAt = (tick: number): Channel => {
      let c = team.primary;
      for (const s of switches) if (s.tick <= tick) c = s.to;
      return c;
    };
    const boundaries = [
      ...new Set([
        0,
        input.durationTicks,
        ...steps.map((s) => s.tick),
        ...switches.map((s) => s.tick),
      ]),
    ].sort((a, b) => a - b);

    let runStart: number | null = null;
    let runChannel: Channel | null = null;
    const flush = (end: number, endedBySwitch: boolean): void => {
      if (runStart === null || runChannel === null) return;
      const length = end - runStart;
      if (length >= JAM_GRACE_TICKS && !endedBySwitch) {
        out.push({
          rule: 'NO_SWITCH_WHILE_JAMMED',
          severity: 'warn',
          playerId: null,
          teamId: team.id,
          params: { team: team.name, channel: runChannel, seconds: length },
        });
      } else if (endedBySwitch && length >= JAM_GRACE_TICKS) {
        out.push({
          rule: 'SLOW_SWITCH',
          severity: 'warn',
          playerId: null,
          teamId: team.id,
          params: { team: team.name, channel: runChannel, seconds: length },
        });
      } else if (endedBySwitch && length <= QUICK_SWITCH_TICKS) {
        out.push({
          rule: 'QUICK_SWITCH',
          severity: 'good',
          playerId: null,
          teamId: team.id,
          params: { team: team.name, channel: runChannel, seconds: length },
        });
      }
      runStart = null;
      runChannel = null;
    };

    for (let i = 0; i < boundaries.length - 1; i++) {
      const t = boundaries[i] as number;
      const next = boundaries[i + 1] as number;
      const channel = activeAt(t);
      const jammed = channel !== 'RUNNER' && jamAt(steps, t).jamming[channel] >= JAM_LEVEL;
      if (jammed) {
        if (runStart === null || runChannel !== channel) {
          flush(t, false);
          runStart = t;
          runChannel = channel;
        }
        // A switch at `next` ends this run: the team left the jammed channel.
        if (switches.some((s) => s.tick === next) && activeAt(next) !== channel) flush(next, true);
      } else {
        flush(t, false);
      }
    }
    flush(input.durationTicks, false);
  }
  return out;
}

// ---- Everything together -------------------------------------------------------------------

export interface PlayerSummary extends PlayerMetrics {
  name: string;
  role: string;
  teamId: string;
  /** Spoofed orders delivered to this player, how many they challenged with Authenticate, and the share (0..100). */
  spoofsReceived: number;
  spoofsChallenged: number;
  spoofsChallengedPct: number | null;
  meanConfidence: number | null;
  /** Percent of scored decisions that were correct. */
  accuracy: number | null;
  /** Situation-awareness probes scored for this trainee and their mean score (0..100). */
  probeCount: number;
  saScore: number | null;
}

export interface AarAnalysis {
  players: PlayerSummary[];
  drift: Record<string, DriftPoint[]>;
  calibration: { overall: CalibrationBin[]; byPlayer: Record<string, CalibrationBin[]> };
  channels: ChannelBucket[];
  flow: FlowEdge[];
  timeline: TimelineItem[];
  learning: LearningPoint[];
  /** Situation-awareness probes (SAGAT), in time order, with each trainee's answers and the truth. */
  probes: ProbeReview[];
}

export function analyzeExercise(input: AarInput): AarAnalysis {
  const records = input.decisions.map(toRecord);
  const m = computeMetrics(input.events, records).players;
  const scoredProbes = probeScoresFromEvents(input.events);
  const players: PlayerSummary[] = input.players.map((p) => {
    const base: PlayerMetrics = m[p.id] ?? {
      playerId: p.id,
      decisionCount: 0,
      scoredDecisionCount: 0,
      avgLatencyTicks: null,
      brierScore: null,
      gradeCount: 0,
      gradingAccuracy: null,
      channelSwitchCount: 0,
      spoofActedCount: 0,
      drift: null,
    };
    const scored = input.decisions.filter((d) => d.playerId === p.id && d.outcome !== null);
    const spoof = spoofChallenge(input.events, p.id);
    return {
      ...base,
      probeCount: scoredProbes.filter((s) => s.playerId === p.id).length,
      saScore: meanSaScore(input.events, p.id),
      spoofsReceived: spoof.received,
      spoofsChallenged: spoof.challenged,
      spoofsChallengedPct: spoof.pct,
      name: p.name,
      role: p.role,
      teamId: p.teamId,
      meanConfidence: scored.length ? mean(scored.map((d) => d.confidence)) : null,
      accuracy: scored.length
        ? (scored.filter((d) => d.outcome === 1).length / scored.length) * 100
        : null,
    };
  });
  const byPlayer: Record<string, CalibrationBin[]> = {};
  for (const p of input.players)
    byPlayer[p.id] = calibrationBins(input.decisions.filter((d) => d.playerId === p.id));
  return {
    players,
    drift: driftSeries(input.events),
    calibration: { overall: calibrationBins(input.decisions), byPlayer },
    channels: channelSeries(input),
    flow: messageFlow(input),
    timeline: keyTimeline(input),
    learning: learningPoints(input),
    probes: probeReviews(input.events),
  };
}
