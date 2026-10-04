import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { AarSummary } from '@vyuha/shared';
import { clock } from '@/lib/format';
import {
  CHANNEL_COLORS,
  MAIN_CHANNELS,
  calibrationChart,
  channelChart,
  driftChart,
  latencyChart,
} from './chartData';

const GRID = '#334155';
const AXIS = '#94a3b8';
const TOOLTIP = { background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' };

function Card({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty: string | null;
}) {
  return (
    <section className="rounded-lg border border-border bg-secondary p-4" aria-label={title}>
      <h3 className="mb-2 font-semibold">{title}</h3>
      {empty ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="h-64">{children}</div>
      )}
    </section>
  );
}

/** The four review charts: picture drift, decision latency, confidence calibration, channel usage vs jamming. */
export function AarCharts({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const drift = driftChart(summary);
  const latency = latencyChart(summary);
  const calibration = calibrationChart(summary);
  const channels = channelChart(summary);
  const noData = t('aar.charts.noData');
  const hasMessages = channels.some((r) => r.VHF + r.HF + r.SATCOM + r.DATALINK > 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t('aar.charts.drift')} empty={drift.rows.length === 0 ? noData : null}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={drift.rows} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis
              dataKey="tick"
              type="number"
              domain={[0, 'dataMax']}
              stroke={AXIS}
              tickFormatter={(v: number) => clock(v)}
              label={{
                value: t('aar.charts.time'),
                position: 'insideBottom',
                offset: -8,
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <YAxis
              stroke={AXIS}
              label={{
                value: t('aar.charts.driftY'),
                angle: -90,
                position: 'insideLeft',
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => clock(Number(v))} />
            <Legend />
            {drift.series.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={`p:${s.id}`}
                name={s.name}
                stroke={s.color}
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card title={t('aar.charts.latency')} empty={latency.length === 0 ? noData : null}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={latency} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis
              dataKey="n"
              stroke={AXIS}
              label={{
                value: t('aar.charts.decisionNo', { n: '#' }),
                position: 'insideBottom',
                offset: -8,
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <YAxis
              stroke={AXIS}
              label={{
                value: t('aar.charts.latencyY'),
                angle: -90,
                position: 'insideLeft',
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <Tooltip
              contentStyle={TOOLTIP}
              formatter={(v, _n, item) => [
                `${String(v)} s`,
                (item.payload as { name: string }).name,
              ]}
              labelFormatter={(n) => t('aar.charts.decisionNo', { n: String(n) })}
            />
            <Bar dataKey="seconds" name={t('aar.charts.latencyY')}>
              {latency.map((b) => (
                <Cell key={b.n} fill={b.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card title={t('aar.charts.calibration')} empty={calibration.length === 0 ? noData : null}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={calibration} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis
              dataKey="confidence"
              type="number"
              domain={[0, 100]}
              stroke={AXIS}
              label={{
                value: t('aar.charts.calibrationX'),
                position: 'insideBottom',
                offset: -8,
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              domain={[0, 100]}
              stroke={AXIS}
              label={{
                value: t('aar.charts.calibrationY'),
                angle: -90,
                position: 'insideLeft',
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <Tooltip
              contentStyle={TOOLTIP}
              formatter={(v, _n, item) => [
                `${String(v)}% (${t('aar.charts.samples', { count: (item.payload as { count: number }).count })})`,
                t('aar.charts.overall'),
              ]}
              labelFormatter={(v) => `${String(v)}%`}
            />
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: 100, y: 100 },
              ]}
              stroke="#a3a3a3"
              strokeDasharray="5 4"
              label={{
                value: t('aar.charts.ideal'),
                fill: '#a3a3a3',
                fontSize: 10,
                position: 'insideBottomRight',
              }}
            />
            <Line
              type="monotone"
              dataKey="accuracy"
              name={t('aar.charts.overall')}
              stroke="#38bdf8"
              strokeWidth={2}
              dot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card
        title={t('aar.charts.channels')}
        empty={channels.length === 0 || !hasMessages ? noData : null}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={channels} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis
              dataKey="tick"
              type="number"
              domain={['dataMin', 'dataMax']}
              stroke={AXIS}
              tickFormatter={(v: number) => clock(v)}
              label={{
                value: t('aar.charts.time'),
                position: 'insideBottom',
                offset: -8,
                fill: AXIS,
                fontSize: 11,
              }}
            />
            <YAxis yAxisId="msgs" stroke={AXIS} allowDecimals={false} />
            <YAxis yAxisId="jam" orientation="right" domain={[0, 100]} stroke={AXIS} unit="%" />
            <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => clock(Number(v))} />
            <Legend />
            {MAIN_CHANNELS.map((c) => (
              <Bar
                key={c}
                yAxisId="msgs"
                stackId="usage"
                dataKey={c}
                name={t('aar.charts.usage', { channel: c })}
                fill={CHANNEL_COLORS[c]}
                fillOpacity={0.55}
              />
            ))}
            {MAIN_CHANNELS.map((c) => (
              <Line
                key={`j${c}`}
                yAxisId="jam"
                type="stepAfter"
                dataKey={`jam${c}`}
                name={t('aar.charts.jamming', { channel: c })}
                stroke={CHANNEL_COLORS[c]}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}
