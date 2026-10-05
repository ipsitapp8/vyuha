import { formatClock, type AarSummary } from '@vyuha/shared';
import type { EventRow } from '../sessions/store';

/**
 * A CSV cell. Quotes, commas and newlines are escaped, and cells that a spreadsheet would run as a
 * formula (leading = + - @) get a leading apostrophe: trainee rationales are free text.
 */
export function csvCell(value: string | number | boolean | null): string {
  if (value === null) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const OUTCOME = { 1: 'correct', 0: 'wrong' } as const;

/** One row per decision: action, confidence, correctness, latency, rationale. */
export function decisionsCsv(summary: AarSummary): string {
  const names = new Map(summary.meta.players.map((p) => [p.id, p]));
  const teams = new Map(summary.meta.teams.map((t) => [t.id, t.name]));
  const header = [
    'session_code',
    'tick',
    'time',
    'trainee',
    'role',
    'team',
    'action',
    'confidence_pct',
    'outcome',
    'latency_s',
    'target_contact',
    'based_on_order',
    'spoof_acted',
    'rationale',
  ];
  const rows = summary.decisions.map((d) => {
    const p = names.get(d.playerId);
    return [
      summary.meta.code,
      d.tick,
      formatClock(d.tick),
      p?.name ?? d.playerId,
      p?.role ?? '',
      p ? (teams.get(p.teamId) ?? '') : '',
      d.actionType,
      d.confidence,
      d.outcome === null ? 'not scored' : OUTCOME[d.outcome],
      d.latencyTicks,
      d.targetContactId,
      d.basedOnMessageId,
      d.spoofActed,
      d.rationale,
    ]
      .map(csvCell)
      .join(',');
  });
  return `${[header.join(','), ...rows].join('\r\n')}\r\n`;
}

/**
 * One row per trainee per situation-awareness probe. It follows the decisions in the same file, after
 * a blank line and its own header, so one download carries both tables.
 */
export function probesCsv(summary: AarSummary): string {
  const names = new Map(summary.meta.players.map((p) => [p.id, p]));
  const header = [
    'session_code',
    'probe_tick',
    'probe_time',
    'trainee',
    'role',
    'answered',
    'sa_score',
    'contacts_found',
    'contacts_missed',
    'ghost_markers',
    'avg_contact_error_m',
    'avg_teammate_error_m',
    'jammed_channel_answer',
    'jammed_channel_truth',
    'channel_correct',
  ];
  const rows = summary.analysis.probes.flatMap((probe) =>
    probe.results.map((r) => {
      const p = names.get(r.playerId);
      return [
        summary.meta.code,
        probe.tick,
        formatClock(probe.tick),
        p?.name ?? r.playerId,
        p?.role ?? '',
        r.answered,
        r.score,
        r.matched.length,
        r.missedUnitIds.length,
        r.ghostCount,
        r.avgContactErrorM,
        r.avgTeammateErrorM,
        r.answer?.jammedChannel ?? null,
        r.truth.jammedChannel,
        r.channelCorrect,
      ]
        .map(csvCell)
        .join(',');
    }),
  );
  return `${[header.join(','), ...rows].join('\r\n')}\r\n`;
}

/** The decisions table and, when probes were run, the situation-awareness table under it. */
export function aarCsv(summary: AarSummary): string {
  const decisions = decisionsCsv(summary);
  return summary.analysis.probes.length === 0 ? decisions : `${decisions}\r\n${probesCsv(summary)}`;
}

/** The complete record of the exercise: metadata, roster, every event, and the decisions. */
export function fullLogJson(summary: AarSummary, events: readonly EventRow[]): unknown {
  return {
    format: 'vyuha-aar/1',
    meta: summary.meta,
    decisions: summary.decisions,
    situationAwareness: {
      probes: summary.analysis.probes,
      scores: summary.analysis.players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        probeCount: p.probeCount,
        saScore: p.saScore,
      })),
    },
    eventCount: events.length,
    events: events.map((e) => ({
      tick: e.tick,
      type: e.type,
      visibleTo: e.visibleTo,
      payload: e.payload,
    })),
  };
}
