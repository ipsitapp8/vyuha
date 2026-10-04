import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { ProgressResponse } from '@vyuha/shared';
import { DemoBotBadge } from '@/lib/demoBot';
import {
  METRIC_VIEW,
  MIN_SESSIONS_FOR_TREND,
  PROGRESS_METRIC_KEYS,
  brierSummary,
  chartRows,
  delayComparison,
  measuredCount,
  type ProgressMetricKey,
} from './progressData';

const GRID = '#334155';
const AXIS = '#94a3b8';
const LINE = '#4ade80';
const TOOLTIP = { background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' };

const fixed = (v: number | null, digits: number): string => (v === null ? '–' : v.toFixed(digits));

function MetricChart({
  metric,
  sessions,
}: {
  metric: ProgressMetricKey;
  sessions: ProgressResponse['sessions'];
}) {
  const { t } = useTranslation();
  const rows = chartRows(sessions, metric);
  const title = t(`progress.metric.${metric}`);
  const none = measuredCount(rows) === 0;
  return (
    <section className="rounded-lg border border-border bg-secondary p-4" aria-label={title}>
      <h3 className="mb-2 font-semibold">{title}</h3>
      {none ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('progress.noData')}</p>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis
                dataKey="session"
                stroke={AXIS}
                tickLine={false}
                allowDecimals={false}
                label={{ value: t('progress.axisSession'), position: 'insideBottom', offset: -2 }}
              />
              <YAxis stroke={AXIS} tickLine={false} width={44} />
              <Tooltip
                contentStyle={TOOLTIP}
                formatter={(v) => [
                  typeof v === 'number' ? v.toFixed(METRIC_VIEW[metric].digits) : '–',
                  title,
                ]}
                labelFormatter={(n) => t('progress.sessionLabel', { n })}
              />
              <Line
                type="linear"
                dataKey="value"
                stroke={LINE}
                strokeWidth={2}
                dot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

const ARROW = { improving: '↓', worsening: '↑', flat: '→' } as const;
const ARROW_TONE = {
  improving: 'text-green-400',
  worsening: 'text-red-400',
  flat: 'text-muted-foreground',
} as const;

/** A trainee's metrics across sessions: trend cards, one chart per metric and a table of the numbers. */
export function ProgressView({ data }: { data: ProgressResponse }) {
  const { t } = useTranslation();
  const { sessions } = data;

  if (sessions.length < MIN_SESSIONS_FOR_TREND) {
    return (
      <p
        role="status"
        className="rounded-lg border border-border bg-secondary p-6 text-center text-muted-foreground"
      >
        {t('progress.needTwo')}
        <span className="mt-1 block text-sm">
          {t('progress.sessionCount', { count: sessions.length })}
        </span>
      </p>
    );
  }

  const delay = delayComparison(sessions);
  const brier = brierSummary(sessions);
  const delayTitle = t('progress.delayCard.title', {
    to: delay?.toSession ?? 0,
    from: delay?.fromSession ?? 1,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <section
          className="rounded-lg border border-border bg-secondary p-4"
          aria-label={delayTitle}
        >
          <h3 className="font-semibold">{delayTitle}</h3>
          {delay?.changePct == null ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('progress.delayCard.unmeasurable')}
            </p>
          ) : (
            <>
              <p
                className={`mt-2 text-4xl font-bold ${delay.changePct <= 0 ? 'text-green-400' : 'text-red-400'}`}
              >
                {delay.changePct > 0 ? '+' : ''}
                {delay.changePct.toFixed(0)}%
              </p>
              <p className="text-sm text-muted-foreground">
                {t('progress.delayCard.detail', {
                  from: fixed(delay.from, 0),
                  to: fixed(delay.to, 0),
                })}
              </p>
            </>
          )}
        </section>

        <section
          className="rounded-lg border border-border bg-secondary p-4"
          aria-label={t('progress.brierCard.title')}
        >
          <h3 className="font-semibold">{t('progress.brierCard.title')}</h3>
          {brier.trend === null ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('progress.brierCard.unmeasurable')}
            </p>
          ) : (
            <>
              <p className={`mt-2 text-4xl font-bold ${ARROW_TONE[brier.trend]}`}>
                <span aria-hidden="true">{ARROW[brier.trend]}</span>{' '}
                <span className="text-lg">{t(`progress.brierCard.${brier.trend}`)}</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t('progress.brierCard.detail', {
                  latest: fixed(brier.latest, 2),
                  average: fixed(brier.average, 2),
                })}
              </p>
            </>
          )}
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {PROGRESS_METRIC_KEYS.map((key) => (
          <MetricChart key={key} metric={key} sessions={sessions} />
        ))}
      </div>

      <section className="overflow-x-auto rounded-lg border border-border bg-secondary p-4">
        <h3 className="mb-2 font-semibold">{t('progress.table.title')}</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="p-1">#</th>
              <th className="p-1">{t('progress.table.date')}</th>
              {PROGRESS_METRIC_KEYS.map((k) => (
                <th key={k} className="p-1 text-right">
                  {t(`progress.metric.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sessions.map((s, i) => (
              <tr key={s.sessionId} className="border-t border-border">
                <td className="p-1">{i + 1}</td>
                <td className="whitespace-nowrap p-1">{s.endedAt.slice(0, 10)}</td>
                {PROGRESS_METRIC_KEYS.map((k) => (
                  <td key={k} className="p-1 text-right">
                    {fixed(chartRows(sessions, k)[i]?.value ?? null, METRIC_VIEW[k].digits)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function ProgressHeading({ data }: { data: ProgressResponse }) {
  const { t } = useTranslation();
  return (
    <h1 className="text-2xl font-semibold">
      {t('progress.titleFor', { name: data.user.name })}
      {data.user.isDemoBot ? <DemoBotBadge /> : null}
    </h1>
  );
}
