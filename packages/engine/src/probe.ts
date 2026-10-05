import { CHANNELS } from './config';
import { haversineM } from './geometry';
import { currentJamming, getUnit } from './state';
import type {
  Channel,
  EngineEvent,
  LatLon,
  ProbeAnswer,
  ProbeChannelAnswer,
  ProbeScore,
  ProbeState,
  TruthState,
} from './types';

/**
 * SAGAT (Situation Awareness Global Assessment Technique): the exercise is frozen, each trainee marks
 * where they believe hostile contacts and teammates are and which channel is jammed, and the answers
 * are scored against the ground truth of the tick at which the probe started.
 */

/** A marker within this distance of a real unit counts as that unit; beyond it, it is a ghost. */
export const PROBE_MATCH_RADIUS_M = 3000;
/** A channel counts as "the jammed one" from this effective jamming level. */
export const PROBE_JAMMED_LEVEL = 0.3;
/** Ticks of exercise time after the probe started in which a late answer is still accepted. */
export const PROBE_WINDOW_TICKS = 30;
export const PROBE_MAX_CONTACTS = 20;
/** Weights of the three questions in the 0..100 score. */
export const PROBE_WEIGHTS = { contacts: 0.5, teammates: 0.3, channel: 0.2 } as const;

/** The most heavily jammed channel, or NONE when nothing is jammed enough to notice. */
export function jammedChannelOf(jamming: Record<Channel, number>): ProbeChannelAnswer {
  let best: ProbeChannelAnswer = 'NONE';
  let level = PROBE_JAMMED_LEVEL;
  for (const c of CHANNELS) {
    if (c === 'RUNNER') continue;
    if (jamming[c] >= level && (best === 'NONE' || jamming[c] > level)) {
      best = c;
      level = jamming[c];
    }
  }
  return best;
}

/** Freezes the truth a probe is scored against. Hostile = live adversary units with a place on the map. */
export function createProbe(state: TruthState, id: string): ProbeState {
  return {
    id,
    tick: state.tick,
    expiresAtTick: state.tick + PROBE_WINDOW_TICKS,
    hostiles: state.units
      .filter((u) => u.side === 'RED' && u.status !== 'DESTROYED' && u.domain !== 'CYBER')
      .map((u) => ({ unitId: u.id, type: u.type, position: { ...u.position } })),
    friendlies: state.players.flatMap((p) => {
      const u = getUnit(state, p.unitId);
      return u ? [{ playerId: p.id, unitId: u.id, position: { ...u.position } }] : [];
    }),
    jammedChannel: jammedChannelOf(currentJamming(state)),
    pending: state.players.map((p) => p.id),
  };
}

const round = (n: number): number => Math.round(n);
const closeness = (errorM: number): number => Math.max(0, 1 - errorM / PROBE_MATCH_RADIUS_M);

/**
 * Scores one trainee's answer. Contacts are matched to hostile units nearest-pair first, each marker
 * and each unit used once; unmatched units are missed, unmatched markers are ghosts.
 */
export function scoreProbe(
  probe: ProbeState,
  playerId: string,
  teamPlayerIds: readonly string[],
  answer: ProbeAnswer | null,
): ProbeScore {
  const mates = probe.friendlies.filter(
    (f) => f.playerId !== playerId && teamPlayerIds.includes(f.playerId),
  );
  const truth = {
    hostiles: probe.hostiles.map((h) => ({ ...h, position: { ...h.position } })),
    teammates: mates.map((m) => ({ unitId: m.unitId, position: { ...m.position } })),
    jammedChannel: probe.jammedChannel,
  };
  if (!answer) {
    return {
      probeId: probe.id,
      probeTick: probe.tick,
      playerId,
      answered: false,
      score: 0,
      contactScore: 0,
      teammateScore: 0,
      channelCorrect: false,
      matched: [],
      missedUnitIds: probe.hostiles.map((h) => h.unitId),
      ghostCount: 0,
      avgContactErrorM: null,
      teammateErrors: mates.map((m) => ({ unitId: m.unitId, errorM: null })),
      avgTeammateErrorM: null,
      answer: null,
      truth,
    };
  }

  const markers = answer.contacts.slice(0, PROBE_MAX_CONTACTS);
  const pairs: { marker: number; unitId: string; errorM: number }[] = [];
  markers.forEach((m: LatLon, marker) => {
    for (const h of probe.hostiles) {
      const errorM = haversineM(m, h.position);
      if (errorM <= PROBE_MATCH_RADIUS_M) pairs.push({ marker, unitId: h.unitId, errorM });
    }
  });
  pairs.sort(
    (a, b) => a.errorM - b.errorM || a.marker - b.marker || a.unitId.localeCompare(b.unitId),
  );
  const usedMarkers = new Set<number>();
  const usedUnits = new Set<string>();
  const matched: ProbeScore['matched'] = [];
  for (const p of pairs) {
    if (usedMarkers.has(p.marker) || usedUnits.has(p.unitId)) continue;
    usedMarkers.add(p.marker);
    usedUnits.add(p.unitId);
    matched.push({ unitId: p.unitId, marker: p.marker, errorM: round(p.errorM) });
  }
  const denominator = Math.max(probe.hostiles.length, markers.length);
  const contactScore =
    denominator === 0 ? 1 : matched.reduce((a, m) => a + closeness(m.errorM), 0) / denominator;

  const teammateErrors = mates.map((m) => {
    const said = answer.teammates.find((t) => t.unitId === m.unitId);
    return { unitId: m.unitId, errorM: said ? round(haversineM(said.position, m.position)) : null };
  });
  const teammateScore =
    teammateErrors.length === 0
      ? 1
      : teammateErrors.reduce((a, t) => a + (t.errorM === null ? 0 : closeness(t.errorM)), 0) /
        teammateErrors.length;
  const channelCorrect = answer.jammedChannel === probe.jammedChannel;

  const known = teammateErrors.flatMap((t) => (t.errorM === null ? [] : [t.errorM]));
  const mean = (xs: readonly number[]): number | null =>
    xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  return {
    probeId: probe.id,
    probeTick: probe.tick,
    playerId,
    answered: true,
    score: round(
      100 *
        (PROBE_WEIGHTS.contacts * contactScore +
          PROBE_WEIGHTS.teammates * teammateScore +
          PROBE_WEIGHTS.channel * (channelCorrect ? 1 : 0)),
    ),
    contactScore: Math.round(contactScore * 1000) / 1000,
    teammateScore: Math.round(teammateScore * 1000) / 1000,
    channelCorrect,
    matched,
    missedUnitIds: probe.hostiles.filter((h) => !usedUnits.has(h.unitId)).map((h) => h.unitId),
    ghostCount: markers.length - matched.length,
    avgContactErrorM: mean(matched.map((m) => m.errorM)),
    teammateErrors,
    avgTeammateErrorM: mean(known),
    answer: {
      contacts: markers.map((m) => ({ ...m })),
      teammates: answer.teammates.map((t) => ({ unitId: t.unitId, position: { ...t.position } })),
      jammedChannel: answer.jammedChannel,
    },
    truth,
  };
}

/** A probe as the review shows it: when it was taken and every trainee's result. */
export interface ProbeReview {
  probeId: string;
  tick: number;
  results: ProbeScore[];
}

const isScore = (p: Record<string, unknown>): boolean =>
  typeof p['probeId'] === 'string' &&
  typeof p['playerId'] === 'string' &&
  typeof p['score'] === 'number' &&
  typeof p['probeTick'] === 'number' &&
  Array.isArray(p['matched']) &&
  typeof p['truth'] === 'object' &&
  p['truth'] !== null;

/** Every probe result in the log, in the order they were scored. */
export function probeScoresFromEvents(events: readonly EngineEvent[]): ProbeScore[] {
  return events
    .filter((e) => e.type === 'PROBE_SCORED' && isScore(e.payload))
    .map((e) => e.payload as unknown as ProbeScore);
}

/** Probes in time order, each with its results sorted by player id. */
export function probeReviews(events: readonly EngineEvent[]): ProbeReview[] {
  const byId = new Map<string, ProbeReview>();
  for (const s of probeScoresFromEvents(events)) {
    const review = byId.get(s.probeId) ?? { probeId: s.probeId, tick: s.probeTick, results: [] };
    review.results.push(s);
    byId.set(s.probeId, review);
  }
  return [...byId.values()]
    .map((r) => ({
      ...r,
      results: [...r.results].sort((a, b) => a.playerId.localeCompare(b.playerId)),
    }))
    .sort((a, b) => a.tick - b.tick || a.probeId.localeCompare(b.probeId));
}

/** A trainee's mean situation-awareness score (0..100) over the probes of one exercise; null with none. */
export function meanSaScore(events: readonly EngineEvent[], playerId: string): number | null {
  const mine = probeScoresFromEvents(events).filter((s) => s.playerId === playerId);
  if (mine.length === 0) return null;
  return Math.round((mine.reduce((a, s) => a + s.score, 0) / mine.length) * 10) / 10;
}
