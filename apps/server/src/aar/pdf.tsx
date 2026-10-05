import { createRequire } from 'node:module';
import path from 'node:path';
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { ReactNode } from 'react';
import { brierTrend, compareToFirst } from '@vyuha/engine';
import {
  APP_NAME,
  APP_TAGLINE,
  formatClock,
  learningTextEn,
  type AarSummary,
  type LearningPointDto,
  type ProgressSession,
  type TimelineItemDto,
} from '@vyuha/shared';
import { BarChartPdf, LineChartPdf, type Series } from './pdfCharts';

const require = createRequire(import.meta.url);
const fontFile = (pkg: string, file: string): string =>
  path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'files', file);

let fontsReady = false;
function registerFonts(): void {
  if (fontsReady) return;
  Font.register({
    family: 'Noto Sans',
    fonts: [
      {
        src: fontFile('@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff'),
        fontWeight: 400,
      },
      {
        src: fontFile('@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff'),
        fontWeight: 700,
      },
    ],
  });
  Font.register({
    family: 'Noto Sans Devanagari',
    fonts: [
      {
        src: fontFile(
          '@fontsource/noto-sans-devanagari',
          'noto-sans-devanagari-devanagari-400-normal.woff',
        ),
        fontWeight: 400,
      },
      {
        src: fontFile(
          '@fontsource/noto-sans-devanagari',
          'noto-sans-devanagari-devanagari-700-normal.woff',
        ),
        fontWeight: 700,
      },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
  fontsReady = true;
}

const GREEN = '#15803d';
const PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4b5563',
];

const s = StyleSheet.create({
  page: { padding: 36, paddingBottom: 48, fontFamily: 'Noto Sans', fontSize: 9, color: '#18181b' },
  h1: { fontSize: 18, fontWeight: 700, color: GREEN, marginBottom: 6 },
  h2: { fontSize: 12, fontWeight: 700, marginTop: 10, marginBottom: 4 },
  muted: { color: '#52525b' },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: '#d4d4d8',
    paddingVertical: 3,
  },
  th: { fontWeight: 700, fontSize: 8 },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7,
    color: '#71717a',
  },
});

/** Hindi text needs its own font: render Devanagari runs with Noto Sans Devanagari, the rest with Noto Sans. */
type PdfStyle = Parameters<typeof StyleSheet.create>[0][string];

function Mixed({ text, style }: { text: string; style?: PdfStyle }) {
  const parts = text.split(/([ऀ-ॿ][ऀ-ॿ\s.,!?]*)/).filter((p) => p !== '');
  return (
    <Text style={style}>
      {parts.map((p, i) =>
        /[ऀ-ॿ]/.test(p) ? (
          <Text key={i} style={{ fontFamily: 'Noto Sans Devanagari' }}>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

const fmt = (v: number | null, digits = 0, suffix = ''): string =>
  v === null ? '–' : `${v.toFixed(digits)}${suffix}`;

/** Progress per player id: their sessions so far, oldest first (the current one included). */
export type ProgressByPlayer = Record<string, ProgressSession[]>;

/** Name as shown in the report: scripted demo trainees are always marked. */
export const displayName = (p: { name: string; isDemoBot: boolean }): string =>
  p.isDemoBot ? `${p.name} (Demo bot)` : p.name;

/** "100% (1 of 1)" or a dash when no spoofed order reached the trainee. */
export function challengedText(p: {
  spoofsReceived: number;
  spoofsChallenged: number;
  spoofsChallengedPct: number | null;
}): string {
  return p.spoofsChallengedPct === null
    ? '–'
    : `${Math.round(p.spoofsChallengedPct)}% (${p.spoofsChallenged} of ${p.spoofsReceived})`;
}

const seconds = (ms: number | null): string => (ms === null ? '–' : `${(ms / 1000).toFixed(0)} s`);

/** The rows and the two trend sentences of the "Progress so far" section. */
export function describeProgress(sessions: readonly ProgressSession[]): {
  rows: string[][];
  delay: string;
  brier: string;
} {
  const rows = sessions.map((x, i) => [
    String(i + 1),
    x.endedAt.slice(0, 10),
    seconds(x.metrics.avgDecisionLatencyMs),
    seconds(x.metrics.latencyUnderJammingMs),
    fmt(x.metrics.brierScore, 2),
    x.metrics.spoofsChallengedPct === null ? '–' : `${Math.round(x.metrics.spoofsChallengedPct)}%`,
    x.metrics.reportGradingAccuracy === null
      ? '–'
      : `${Math.round(x.metrics.reportGradingAccuracy * 100)}%`,
    fmt(x.metrics.saScore, 0),
  ]);
  const cmp = compareToFirst(sessions.map((x) => x.metrics.latencyUnderJammingMs));
  const delay =
    cmp?.changePct == null
      ? 'Decision delay under jamming: not measurable in both sessions compared.'
      : `Decision delay under jamming, session ${cmp.toSession} vs session ${cmp.fromSession}: ${cmp.changePct > 0 ? '+' : ''}${cmp.changePct.toFixed(0)}% (lower is better).`;
  const trend = brierTrend(sessions.map((x) => x.metrics.brierScore));
  const brier =
    trend === null
      ? 'Brier score trend: not enough scored sessions.'
      : `Brier score trend: ${trend} (lower is better).`;
  return { rows, delay, brier };
}

function ProgressSection({ sessions }: { sessions: readonly ProgressSession[] }) {
  const { rows, delay, brier } = describeProgress(sessions);
  return (
    <View wrap={false}>
      <Text style={s.h2}>{`Progress so far (${sessions.length} sessions)`}</Text>
      <Table
        cols={[
          { label: '#', w: 6 },
          { label: 'Date', w: 16 },
          { label: 'Avg latency', w: 14, align: 'right' },
          { label: 'Under jamming', w: 16, align: 'right' },
          { label: 'Brier', w: 9, align: 'right' },
          { label: 'Spoofs challenged', w: 19, align: 'right' },
          { label: 'Grading', w: 11, align: 'right' },
          { label: 'SA score', w: 9, align: 'right' },
        ]}
        rows={rows}
      />
      <Text style={[s.muted, { marginTop: 3 }]}>{delay}</Text>
      <Text style={s.muted}>{brier}</Text>
    </View>
  );
}

/** One trainee's situation-awareness probes as table rows: time, score and what the score is made of. */
export function probeRows(probes: AarSummary['analysis']['probes'], playerId: string): string[][] {
  return probes.flatMap((probe) =>
    probe.results
      .filter((r) => r.playerId === playerId)
      .map((r) => [
        formatClock(probe.tick),
        r.answered ? String(Math.round(r.score)) : '0 (no answer)',
        `${r.matched.length} of ${r.truth.hostiles.length}`,
        String(r.ghostCount),
        fmt(r.avgContactErrorM, 0, ' m'),
        fmt(r.avgTeammateErrorM, 0, ' m'),
        `${r.answer?.jammedChannel ?? '–'} / ${r.truth.jammedChannel}`,
      ]),
  );
}

function ProbeSection({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <View wrap={false}>
      <Text style={s.h2}>{`Situation awareness probes (${rows.length})`}</Text>
      <Table
        cols={[
          { label: 'Time', w: 9 },
          { label: 'SA score', w: 16, align: 'right' },
          { label: 'Hostiles found', w: 16, align: 'right' },
          { label: 'Ghost markers', w: 14, align: 'right' },
          { label: 'Contact error', w: 14, align: 'right' },
          { label: 'Teammate error', w: 15, align: 'right' },
          { label: 'Jammed: said / true', w: 16, align: 'right' },
        ]}
        rows={rows}
      />
    </View>
  );
}

export function describeTimeline(
  item: TimelineItemDto,
  nameOf: (id: string | null) => string,
): string {
  const p = item.params;
  switch (item.kind) {
    case 'INJECT':
      return `Inject fired${p['source'] === 'LIVE' ? ' (live)' : ''}: ${String(p['title'])}`;
    case 'SPOOF':
      return `Spoofed order delivered to ${nameOf(item.playerId)}: "${String(p['text'])}"`;
    case 'AUTH':
      return `${nameOf(item.playerId)} authentication result: ${String(p['result'])}`;
    case 'CHANNEL_SWITCH':
      return `${nameOf(item.playerId)} switched the team channel ${String(p['from'])} -> ${String(p['to'])}`;
    case 'DECISION':
      return `${nameOf(item.playerId)} decided ${String(p['action'])} at ${String(p['confidence'])}% (${String(p['outcome'])})`;
    case 'JAMMING':
      return `Jamming changed: heaviest on ${String(p['channel'])} at ${String(p['level'])}%`;
    case 'C2_DETECTED':
      return `${nameOf(item.playerId)} detected the C2 compromise after ${String(p['seconds'])} s, over ${String(p['via'])}`;
    case 'UAV_SPOOF_ACTED':
      return `${nameOf(item.playerId)} acted on spoofed UAV data (contact ${String(p['contact'])})`;
  }
}

function Footer({ summary }: { summary: AarSummary }) {
  return (
    <View style={s.footer} fixed>
      <Text>
        {APP_NAME} · After Action Review · {summary.meta.scenarioTitle} · {summary.meta.code}
      </Text>
      <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
    </View>
  );
}

const SEVERITY_MARK: Record<LearningPointDto['severity'], { mark: string; color: string }> = {
  warn: { mark: '!', color: '#b91c1c' },
  info: { mark: 'i', color: '#1d4ed8' },
  good: { mark: '+', color: GREEN },
};

function LearningList({
  points,
  nameOf,
}: {
  points: readonly LearningPointDto[];
  nameOf: (id: string | null) => string;
}) {
  if (points.length === 0) return <Text style={s.muted}>No notable observations.</Text>;
  return (
    <View>
      {points.map((p, i) => {
        const m = SEVERITY_MARK[p.severity];
        return (
          <View
            key={`${p.rule}-${i}`}
            style={{ flexDirection: 'row', gap: 6, marginBottom: 3 }}
            wrap={false}
          >
            <Text style={{ width: 10, fontWeight: 700, color: m.color }}>{m.mark}</Text>
            <Mixed
              text={`${p.playerId ? `${nameOf(p.playerId)}: ` : ''}${learningTextEn(p)}`}
              style={{ flex: 1 }}
            />
          </View>
        );
      })}
    </View>
  );
}

function Table({
  cols,
  rows,
}: {
  cols: { label: string; w: number; align?: 'right' }[];
  rows: ReactNode[][];
}) {
  return (
    <View>
      <View style={[s.row, { borderBottomColor: '#52525b' }]} fixed>
        {cols.map((c) => (
          <Text
            key={c.label}
            style={[s.th, { width: `${c.w}%`, textAlign: c.align, paddingRight: 5 }]}
          >
            {c.label}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={i} style={s.row} wrap={false}>
          {r.map((cell, j) => (
            <View key={j} style={{ width: `${cols[j]?.w ?? 10}%`, paddingRight: 5 }}>
              {typeof cell === 'string' ? (
                <Mixed text={cell} style={{ textAlign: cols[j]?.align }} />
              ) : (
                cell
              )}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function AarDocument({ summary, progress }: { summary: AarSummary; progress: ProgressByPlayer }) {
  const { meta, analysis, decisions } = summary;
  const nameMap = new Map(meta.players.map((p) => [p.id, displayName(p)]));
  const nameOf = (id: string | null): string => (id ? (nameMap.get(id) ?? id) : 'Exercise control');
  const colorOf = new Map(
    meta.players.map((p, i) => [p.id, PALETTE[i % PALETTE.length] ?? '#4b5563']),
  );
  const teamName = new Map(meta.teams.map((t) => [t.id, t.name]));
  const learningFor = (id: string): LearningPointDto[] =>
    analysis.learning.filter((l) => l.playerId === id);
  const teamLearning = analysis.learning.filter((l) => l.playerId === null);

  const driftSeries: Series[] = meta.players.map((p) => ({
    label: p.name,
    color: colorOf.get(p.id) ?? '#000',
    points: (analysis.drift[p.id] ?? []).map((d) => ({ x: d.tick, y: d.avgPositionErrorM })),
  }));
  const latencyBars = decisions
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.latencyTicks !== null)
    .map(({ d, i }) => ({
      x: i + 1,
      value: d.latencyTicks ?? 0,
      color: colorOf.get(d.playerId) ?? '#000',
    }));
  const calibration: Series[] = [
    {
      label: 'Perfectly calibrated',
      color: '#a1a1aa',
      dashed: true,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    },
    {
      label: 'Overall',
      color: '#2563eb',
      dots: true,
      points: analysis.calibration.overall.map((b) => ({ x: b.meanConfidence, y: b.accuracy })),
    },
  ];
  const stride = Math.max(1, Math.ceil(analysis.channels.length / 36));
  const sampled = analysis.channels.filter((_, i) => i % stride === 0);
  const CHANNEL_COLORS: Record<string, string> = {
    VHF: '#2563eb',
    HF: '#16a34a',
    SATCOM: '#d97706',
    DATALINK: '#7c3aed',
  };
  const jamSeries: Series[] = (['VHF', 'HF', 'SATCOM', 'DATALINK'] as const).map((c) => ({
    label: `${c} jamming %`,
    color: CHANNEL_COLORS[c] ?? '#000',
    points: sampled.map((b) => ({ x: b.tick, y: b.jamming[c] * 100 })),
  }));
  const usageSeries: Series[] = (['VHF', 'HF', 'SATCOM', 'DATALINK'] as const).map((c) => ({
    label: `${c} messages`,
    color: CHANNEL_COLORS[c] ?? '#000',
    points: sampled.map((b) => ({
      x: b.tick,
      y: analysis.channels
        .filter((x) => x.tick >= b.tick && x.tick < b.tick + stride * 10)
        .reduce((a, x) => a + x.usage[c], 0),
    })),
  }));

  const flowRows = analysis.flow
    .filter((e) => e.kind === 'TEXT')
    .slice(0, 30)
    .map((e) => {
      const lost = e.outcomes.DROPPED + e.outcomes.CORRUPTED;
      return [
        nameOf(e.from),
        nameOf(e.to),
        e.channel,
        String(e.total),
        String(e.outcomes.DELIVERED),
        String(e.outcomes.DELAYED),
        String(e.outcomes.CORRUPTED),
        String(e.outcomes.DROPPED),
        `${Math.round((lost / Math.max(1, e.total)) * 100)}%`,
      ];
    });

  return (
    <Document
      title={`VYUHA After Action Review ${meta.code}`}
      author={APP_NAME}
      subject={meta.scenarioTitle}
    >
      <Page size="A4" style={s.page}>
        <View style={{ marginTop: 120 }}>
          <Text style={{ fontSize: 44, fontWeight: 700, color: GREEN, letterSpacing: 6 }}>
            {APP_NAME}
          </Text>
          <Text style={[s.muted, { fontSize: 11, marginBottom: 40 }]}>{APP_TAGLINE}</Text>
          <Text style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
            After Action Review
          </Text>
          <Mixed text={meta.scenarioTitle} style={{ fontSize: 14, marginBottom: 24 }} />
          {[
            ['Session code', meta.code],
            ['Ended', meta.endedAt ? meta.endedAt.replace('T', ' ').slice(0, 19) + ' UTC' : '–'],
            ['Exercise length', formatClock(meta.durationTicks)],
            ['Trainees', String(meta.players.length)],
            ['Teams', meta.teams.map((t) => t.name).join(', ') || '–'],
          ].map(([k, v]) => (
            <View key={k} style={{ flexDirection: 'row', marginBottom: 4 }}>
              <Text style={[s.muted, { width: 110 }]}>{k}</Text>
              <Mixed text={v ?? ''} />
            </View>
          ))}
        </View>
        <Text
          style={[s.muted, { position: 'absolute', bottom: 60, left: 36, right: 36, fontSize: 8 }]}
        >
          Built from the recorded event log and decision records only. Terrain, elevation and
          weather are real open data; scenario events are synthetic.
        </Text>
        <Footer summary={summary} />
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Summary</Text>
        <Table
          cols={[
            { label: 'Trainee', w: 14 },
            { label: 'Role', w: 12 },
            { label: 'Dec.', w: 5, align: 'right' },
            { label: 'Correct', w: 8, align: 'right' },
            { label: 'Avg conf.', w: 9, align: 'right' },
            { label: 'Brier', w: 6, align: 'right' },
            { label: 'Latency', w: 8, align: 'right' },
            { label: 'Grading', w: 8, align: 'right' },
            { label: 'Spoofs acted', w: 8, align: 'right' },
            { label: 'Challenged', w: 10, align: 'right' },
            { label: 'Drift m', w: 7, align: 'right' },
            { label: 'SA', w: 5, align: 'right' },
          ]}
          rows={analysis.players.map((p) => [
            p.name,
            p.role,
            String(p.decisionCount),
            fmt(p.accuracy, 0, '%'),
            fmt(p.meanConfidence, 0, '%'),
            fmt(p.brierScore, 2),
            fmt(p.avgLatencyTicks, 0, ' s'),
            p.gradingAccuracy === null ? '–' : `${Math.round(p.gradingAccuracy * 100)}%`,
            String(p.spoofActedCount),
            challengedText(p),
            fmt(p.drift?.meanPositionErrorM ?? null, 0),
            fmt(p.saScore, 0),
          ])}
        />
        <Text style={[s.muted, { fontSize: 7, marginTop: 3 }]}>
          Dec. = decisions · Correct = share of scored decisions that were right · Brier =
          calibration score (lower is better) · Latency = seconds from the relevant information
          arriving to the decision · Grading = Admiralty grading accuracy · Spoofs acted = spoofed
          orders acted on · Challenged = spoofed orders received that the trainee challenged with
          Authenticate (received in brackets) · Drift = average position error of the picture · SA =
          mean situation-awareness score (0 to 100) over the freeze probes.
        </Text>
        <Text style={s.h2}>Key learning points</Text>
        <LearningList points={analysis.learning} nameOf={nameOf} />
        <Footer summary={summary} />
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Charts</Text>
        <LineChartPdf
          title="Picture drift over time"
          xLabel="Exercise time (s)"
          yLabel="Position error (m)"
          series={driftSeries}
          empty="No drift samples"
        />
        <BarChartPdf
          title="Decision latency per decision"
          xLabel="Decision number"
          yLabel="Seconds"
          bars={latencyBars}
          legend={meta.players.map((p) => ({ label: p.name, color: colorOf.get(p.id) ?? '#000' }))}
          empty="No decisions with latency"
        />
        <LineChartPdf
          title="Confidence calibration"
          xLabel="Stated confidence (%)"
          yLabel="Correct (%)"
          xMax={100}
          yMax={100}
          series={calibration}
          empty="No scored decisions"
        />
        <LineChartPdf
          title="Channel usage (messages) over time"
          xLabel="Exercise time (s)"
          yLabel="Messages"
          series={usageSeries}
          empty="No messages"
        />
        <LineChartPdf
          title="Jamming level by channel"
          xLabel="Exercise time (s)"
          yLabel="Jamming (%)"
          yMax={100}
          series={jamSeries}
          empty="No jamming"
        />
        <Footer summary={summary} />
      </Page>

      {meta.players.map((p) => {
        const sum = analysis.players.find((x) => x.playerId === p.id);
        const mine = decisions.filter((d) => d.playerId === p.id);
        return (
          <Page key={p.id} size="A4" style={s.page}>
            <Mixed text={displayName(p)} style={s.h1} />
            <Text style={[s.muted, { marginBottom: 6 }]}>
              {p.role} · Team {teamName.get(p.teamId) ?? p.teamId} · Unit {p.unitId}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {[
                ['Decisions', String(sum?.decisionCount ?? 0)],
                ['Correct', fmt(sum?.accuracy ?? null, 0, '%')],
                ['Average confidence', fmt(sum?.meanConfidence ?? null, 0, '%')],
                ['Brier score', fmt(sum?.brierScore ?? null, 2)],
                ['Average latency', fmt(sum?.avgLatencyTicks ?? null, 0, ' s')],
                ['Reports graded', String(sum?.gradeCount ?? 0)],
                [
                  'Grading accuracy',
                  sum?.gradingAccuracy == null ? '–' : `${Math.round(sum.gradingAccuracy * 100)}%`,
                ],
                ['Channel switches', String(sum?.channelSwitchCount ?? 0)],
                ['Spoofs acted on', String(sum?.spoofActedCount ?? 0)],
                ['Spoofs challenged', sum ? challengedText(sum) : '–'],
                ['Avg position error', fmt(sum?.drift?.meanPositionErrorM ?? null, 0, ' m')],
                ['Avg missed hostiles', fmt(sum?.drift?.meanMissed ?? null, 1)],
                ['Avg ghost contacts', fmt(sum?.drift?.meanGhost ?? null, 1)],
                [
                  'Situation awareness',
                  sum?.saScore == null ? '–' : `${Math.round(sum.saScore)} / 100`,
                ],
              ].map(([k, v]) => (
                <View key={k} style={{ width: '33%', marginBottom: 5 }}>
                  <Text style={[s.muted, { fontSize: 7 }]}>{k}</Text>
                  <Text style={{ fontSize: 11, fontWeight: 700 }}>{v}</Text>
                </View>
              ))}
            </View>
            {(progress[p.id]?.length ?? 0) >= 2 ? (
              <ProgressSection sessions={progress[p.id] ?? []} />
            ) : null}
            <ProbeSection rows={probeRows(analysis.probes, p.id)} />
            <Text style={s.h2}>Learning points</Text>
            <LearningList points={learningFor(p.id)} nameOf={nameOf} />
            <Text style={s.h2}>Decisions</Text>
            {mine.length === 0 ? (
              <Text style={s.muted}>No decisions recorded.</Text>
            ) : (
              <Table
                cols={[
                  { label: 'Time', w: 8 },
                  { label: 'Action', w: 15 },
                  { label: 'Conf.', w: 8, align: 'right' },
                  { label: 'Result', w: 10 },
                  { label: 'Latency', w: 9, align: 'right' },
                  { label: 'Rationale', w: 50 },
                ]}
                rows={mine.map((d) => [
                  formatClock(d.tick),
                  d.actionType,
                  `${d.confidence}%`,
                  d.outcome === null ? 'not scored' : d.outcome === 1 ? 'correct' : 'wrong',
                  d.latencyTicks === null ? '–' : `${Math.round(d.latencyTicks)} s`,
                  d.rationale,
                ])}
              />
            )}
            <Footer summary={summary} />
          </Page>
        );
      })}

      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Team timeline</Text>
        {teamLearning.length > 0 ? (
          <>
            <Text style={s.h2}>Communications</Text>
            <LearningList points={teamLearning} nameOf={nameOf} />
          </>
        ) : null}
        <Text style={s.h2}>Key events</Text>
        {analysis.timeline.length === 0 ? (
          <Text style={s.muted}>No events.</Text>
        ) : (
          analysis.timeline.map((it, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 6, marginBottom: 2 }} wrap={false}>
              <Text style={[s.muted, { width: 32 }]}>{formatClock(it.tick)}</Text>
              <Mixed text={describeTimeline(it, nameOf)} style={{ flex: 1 }} />
            </View>
          ))
        )}
        <Text style={s.h2}>Message flow (player messages)</Text>
        {flowRows.length === 0 ? (
          <Text style={s.muted}>No player messages were sent.</Text>
        ) : (
          <Table
            cols={[
              { label: 'From', w: 17 },
              { label: 'To', w: 17 },
              { label: 'Channel', w: 12 },
              { label: 'Sent', w: 8, align: 'right' },
              { label: 'Delivered', w: 11, align: 'right' },
              { label: 'Delayed', w: 9, align: 'right' },
              { label: 'Garbled', w: 9, align: 'right' },
              { label: 'Dropped', w: 9, align: 'right' },
              { label: 'Lost', w: 8, align: 'right' },
            ]}
            rows={flowRows}
          />
        )}
        <Footer summary={summary} />
      </Page>
    </Document>
  );
}

/** Renders the report to a PDF (A4, embedded Noto Sans fonts so it also works fully offline). */
export async function renderAarPdf(
  summary: AarSummary,
  progress: ProgressByPlayer = {},
): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<AarDocument summary={summary} progress={progress} />);
}
