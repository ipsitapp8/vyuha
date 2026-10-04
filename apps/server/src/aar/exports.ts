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

/** The complete record of the exercise: metadata, roster, every event, and the decisions. */
export function fullLogJson(summary: AarSummary, events: readonly EventRow[]): unknown {
  return {
    format: 'vyuha-aar/1',
    meta: summary.meta,
    decisions: summary.decisions,
    eventCount: events.length,
    events: events.map((e) => ({
      tick: e.tick,
      type: e.type,
      visibleTo: e.visibleTo,
      payload: e.payload,
    })),
  };
}
