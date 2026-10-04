import type { AarSummary, Channel } from '@vyuha/shared';

export const PLAYER_COLORS = [
  '#0369a1',
  '#b91c1c',
  '#15803d',
  '#b45309',
  '#7e22ce',
  '#0e7490',
  '#be185d',
  '#525252',
];
export const CHANNEL_COLORS: Record<'VHF' | 'HF' | 'SATCOM' | 'DATALINK', string> = {
  VHF: '#0369a1',
  HF: '#15803d',
  SATCOM: '#b45309',
  DATALINK: '#7e22ce',
};
export const MAIN_CHANNELS = ['VHF', 'HF', 'SATCOM', 'DATALINK'] as const;

export const colorOfPlayer = (summary: AarSummary, playerId: string): string => {
  const i = summary.meta.players.findIndex((p) => p.id === playerId);
  return PLAYER_COLORS[(i < 0 ? 0 : i) % PLAYER_COLORS.length] ?? '#a3a3a3';
};

export interface DriftChart {
  series: { id: string; name: string; color: string }[];
  /** One row per sample tick; each player's error is stored under `p:<id>`. */
  rows: Record<string, number>[];
}

export function driftChart(summary: AarSummary): DriftChart {
  const series = summary.meta.players.map((p) => ({
    id: p.id,
    name: p.name,
    color: colorOfPlayer(summary, p.id),
  }));
  const byTick = new Map<number, Record<string, number>>();
  for (const p of summary.meta.players) {
    for (const d of summary.analysis.drift[p.id] ?? []) {
      const row = byTick.get(d.tick) ?? { tick: d.tick };
      row[`p:${p.id}`] = Math.round(d.avgPositionErrorM);
      byTick.set(d.tick, row);
    }
  }
  return { series, rows: [...byTick.values()].sort((a, b) => (a['tick'] ?? 0) - (b['tick'] ?? 0)) };
}

export interface LatencyBar {
  n: number;
  playerId: string;
  name: string;
  seconds: number;
  color: string;
}

/** One bar per decision that had a measurable latency, in the order the decisions were made. */
export function latencyChart(summary: AarSummary): LatencyBar[] {
  const names = new Map(summary.meta.players.map((p) => [p.id, p.name]));
  return summary.decisions
    .map((d, i) => ({ d, n: i + 1 }))
    .filter(({ d }) => d.latencyTicks !== null)
    .map(({ d, n }) => ({
      n,
      playerId: d.playerId,
      name: names.get(d.playerId) ?? d.playerId,
      seconds: Math.round(d.latencyTicks ?? 0),
      color: colorOfPlayer(summary, d.playerId),
    }));
}

export interface CalibrationPoint {
  confidence: number;
  accuracy: number;
  count: number;
}

export const calibrationChart = (summary: AarSummary): CalibrationPoint[] =>
  summary.analysis.calibration.overall.map((b) => ({
    confidence: Math.round(b.meanConfidence),
    accuracy: Math.round(b.accuracy),
    count: b.count,
  }));

export interface ChannelRow {
  tick: number;
  VHF: number;
  HF: number;
  SATCOM: number;
  DATALINK: number;
  jamVHF: number;
  jamHF: number;
  jamSATCOM: number;
  jamDATALINK: number;
}

/** Messages per channel (summed) and jamming (percent, at the end of the span), at most `maxRows` rows. */
export function channelChart(summary: AarSummary, maxRows = 60): ChannelRow[] {
  const buckets = summary.analysis.channels;
  const stride = Math.max(1, Math.ceil(buckets.length / maxRows));
  const rows: ChannelRow[] = [];
  for (let i = 0; i < buckets.length; i += stride) {
    const span = buckets.slice(i, i + stride);
    const last = span[span.length - 1];
    if (!last) continue;
    const sum = (c: Channel): number => span.reduce((a, b) => a + b.usage[c], 0);
    rows.push({
      tick: span[0]?.tick ?? 0,
      VHF: sum('VHF'),
      HF: sum('HF'),
      SATCOM: sum('SATCOM'),
      DATALINK: sum('DATALINK'),
      jamVHF: Math.round(last.jamming.VHF * 100),
      jamHF: Math.round(last.jamming.HF * 100),
      jamSATCOM: Math.round(last.jamming.SATCOM * 100),
      jamDATALINK: Math.round(last.jamming.DATALINK * 100),
    });
  }
  return rows;
}

// ---- message flow graph --------------------------------------------------------------------

export interface FlowNode {
  id: string;
  label: string;
  x: number;
  y: number;
  unmanned: boolean;
}

export interface FlowLink {
  key: string;
  from: string;
  to: string;
  channel: Channel;
  total: number;
  lost: number;
  lostShare: number;
}

export interface FlowGraph {
  nodes: FlowNode[];
  links: FlowLink[];
}

/** Players (and unmanned senders) on a circle; one link per sender -> recipient -> channel. */
export function flowGraph(
  summary: AarSummary,
  kind: 'TEXT' | 'ALL',
  size = 360,
  unmannedLabel: (id: string) => string = (id) => id,
): FlowGraph {
  const edges = summary.analysis.flow.filter((e) => kind === 'ALL' || e.kind === 'TEXT');
  const names = new Map(summary.meta.players.map((p) => [p.id, p.name]));
  const ids = [
    ...summary.meta.players.map((p) => p.id),
    ...[...new Set(edges.flatMap((e) => [e.from, e.to]))].filter((id) => !names.has(id)).sort(),
  ];
  const cx = size / 2;
  const r = size / 2 - 52;
  const nodes = ids.map((id, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, ids.length) - Math.PI / 2;
    return {
      id,
      label: names.get(id) ?? unmannedLabel(id),
      x: Math.round(cx + r * Math.cos(angle)),
      y: Math.round(cx + r * Math.sin(angle)),
      unmanned: !names.has(id),
    };
  });
  const merged = new Map<string, FlowLink>();
  for (const e of edges) {
    const key = `${e.from}>${e.to}>${e.channel}`;
    const link = merged.get(key) ?? {
      key,
      from: e.from,
      to: e.to,
      channel: e.channel,
      total: 0,
      lost: 0,
      lostShare: 0,
    };
    link.total += e.total;
    link.lost += e.outcomes.DROPPED + e.outcomes.CORRUPTED;
    merged.set(key, link);
  }
  const links = [...merged.values()].map((l) => ({
    ...l,
    lostShare: l.total === 0 ? 0 : l.lost / l.total,
  }));
  return { nodes, links };
}

/** Green (nothing lost) to red (everything lost). */
export function lossColor(share: number): string {
  const s = Math.min(1, Math.max(0, share));
  return `rgb(${Math.round(74 + s * (239 - 74))},${Math.round(222 - s * (222 - 68))},${Math.round(128 - s * (128 - 68))})`;
}
