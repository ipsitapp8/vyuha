import type { AarSummary, LatLon, ProbeScoreDto } from '@vyuha/shared';

export type ProbePointKind =
  | 'true-hostile'
  | 'missed-hostile'
  | 'true-teammate'
  | 'said-contact'
  | 'ghost-contact'
  | 'said-teammate';

export interface ProbePoint {
  key: string;
  kind: ProbePointKind;
  label: string;
  position: LatLon;
}

/** A line from what the trainee marked to where the unit really was. */
export interface ProbeLink {
  from: LatLon;
  to: LatLon;
}

export interface ProbeMapLabels {
  hostile: (type: string) => string;
  missed: (type: string) => string;
  teammate: (name: string) => string;
  marked: (n: number) => string;
  ghost: (n: number) => string;
  saidTeammate: (name: string) => string;
}

/** Everything the probe map draws for one trainee's result: the truth, their answers, and the gaps. */
export function probeMapData(
  result: ProbeScoreDto,
  unitNames: Record<string, string>,
  labels: ProbeMapLabels,
): { points: ProbePoint[]; links: ProbeLink[] } {
  const points: ProbePoint[] = [];
  const links: ProbeLink[] = [];
  const missed = new Set(result.missedUnitIds);
  for (const h of result.truth.hostiles) {
    points.push({
      key: `h:${h.unitId}`,
      kind: missed.has(h.unitId) ? 'missed-hostile' : 'true-hostile',
      label: missed.has(h.unitId) ? labels.missed(h.type) : labels.hostile(h.type),
      position: h.position,
    });
  }
  for (const m of result.truth.teammates) {
    points.push({
      key: `m:${m.unitId}`,
      kind: 'true-teammate',
      label: labels.teammate(unitNames[m.unitId] ?? m.unitId),
      position: m.position,
    });
  }
  if (!result.answer) return { points, links };

  const matchedByMarker = new Map(result.matched.map((m) => [m.marker, m.unitId]));
  result.answer.contacts.forEach((position, i) => {
    const unitId = matchedByMarker.get(i);
    points.push({
      key: `a:${i}`,
      kind: unitId ? 'said-contact' : 'ghost-contact',
      label: unitId ? labels.marked(i + 1) : labels.ghost(i + 1),
      position,
    });
    const real = unitId ? result.truth.hostiles.find((h) => h.unitId === unitId) : undefined;
    if (real) links.push({ from: position, to: real.position });
  });
  for (const said of result.answer.teammates) {
    points.push({
      key: `s:${said.unitId}`,
      kind: 'said-teammate',
      label: labels.saidTeammate(unitNames[said.unitId] ?? said.unitId),
      position: said.position,
    });
    const real = result.truth.teammates.find((m) => m.unitId === said.unitId);
    if (real) links.push({ from: said.position, to: real.position });
  }
  return { points, links };
}

export interface SaChartRow {
  tick: number;
  [playerId: string]: number;
}

/** One row per probe, one column per trainee: the SA score over the exercise. */
export function saChart(summary: AarSummary): {
  rows: SaChartRow[];
  players: { id: string; name: string }[];
} {
  const rows = summary.analysis.probes.map((probe) => {
    const row: SaChartRow = { tick: probe.tick };
    for (const r of probe.results) row[r.playerId] = r.score;
    return row;
  });
  const seen = new Set(summary.analysis.probes.flatMap((p) => p.results.map((r) => r.playerId)));
  return {
    rows,
    players: summary.meta.players
      .filter((p) => seen.has(p.id))
      .map((p) => ({ id: p.id, name: p.name })),
  };
}
