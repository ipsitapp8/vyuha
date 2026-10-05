import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import type { AarCompare, AarCompareSide } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { clock } from '@/lib/format';
import { apiErrorText } from '@/lib/messages';
import { compareMetrics, decisionMarks, driftRows, latencyRows } from './compareData';

const GRID = '#d3dae6';
const AXIS = '#475569';
const DEGRADED = '#b91c1c';
const BASELINE = '#15803d';
const TOOLTIP = { background: '#ffffff', border: '1px solid #94a3b8', color: '#0f172a' };

const fixed = (v: number | null, digits: number): string => (v === null ? '–' : v.toFixed(digits));

function Track({
  side,
  playerId,
  label,
  colour,
}: {
  side: AarCompareSide;
  playerId: string;
  label: string;
  colour: string;
}) {
  const { t } = useTranslation();
  const marks = decisionMarks(side, playerId);
  const outcome = (o: 0 | 1 | null): string =>
    t(`aar.decision.outcomes.${o === null ? 'unscored' : o === 1 ? 'correct' : 'wrong'}`);
  return (
    <div>
      <p className="mb-1 text-sm font-medium">
        {label}{' '}
        <span className="font-normal text-muted-foreground">
          {t('aar.compare.runMeta', { code: side.code, duration: clock(side.durationTicks) })}
        </span>
      </p>
      <div
        className="relative h-6 rounded bg-background"
        role="img"
        aria-label={t('aar.compare.trackLabel', { run: label, count: marks.length })}
      >
        {marks.map((m) => (
          <span
            key={m.id}
            title={`${clock(m.tick)} ${m.actionType}`}
            className="absolute top-1 h-4 w-1.5 -translate-x-1/2 rounded-sm"
            style={{
              left: `${m.percent}%`,
              background: colour,
              opacity: m.outcome === 0 ? 0.45 : 1,
            }}
          />
        ))}
      </div>
      {marks.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{t('aar.compare.noDecisions')}</p>
      ) : (
        <ol className="mt-1 flex flex-col gap-0.5 text-sm">
          {marks.map((m) => (
            <li key={m.id}>
              <span className="font-mono">{clock(m.tick)}</span>{' '}
              {t(`actions.${m.actionType}` as 'actions.HOLD', { defaultValue: m.actionType })} ·{' '}
              {m.confidence}% · {outcome(m.outcome)}
              {m.latencyTicks === null
                ? ''
                : ` · ${t('aar.compare.latencyOf', { seconds: m.latencyTicks })}`}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The degraded exercise beside its clean baseline (same scenario, same seed, no degradation), for a
 * trainee who played both: decision timeline, decision latency and picture drift.
 */
export function BaselineCompare({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [cmp, setCmp] = useState<AarCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [userId, setUserId] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .getAarCompare(sessionId)
      .then((c) => {
        if (!cancelled) setCmp(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(t, e, t('aar.compare.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt, t]);

  const trainee = cmp?.trainees.find((x) => x.userId === userId) ?? cmp?.trainees[0];
  const latency = cmp && trainee ? latencyRows(cmp, trainee) : [];
  const drift = cmp && trainee ? driftRows(cmp, trainee) : [];
  const degradedLabel = t('aar.compare.degraded');
  const baselineLabel = t('aar.compare.baseline');

  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('aar.compare.title')}
    >
      <h2 className="mb-1 font-semibold">{t('aar.compare.title')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('aar.compare.intro')}</p>
      {!cmp && !error ? <p role="status">{t('common.loading')}</p> : null}
      {error ? (
        <div role="alert" className="flex items-center gap-3 text-red-700">
          <span>{error}</span>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : null}
      {cmp && !trainee ? (
        <p className="text-sm text-muted-foreground">{t('aar.compare.nobodyInBoth')}</p>
      ) : null}
      {cmp && trainee ? (
        <div className="flex flex-col gap-4">
          <Select
            label={t('aar.replay.trainee')}
            value={trainee.userId}
            options={cmp.trainees.map((x) => ({ value: x.userId, label: x.name }))}
            onChange={setUserId}
          />

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-1">{t('aar.compare.metric')}</th>
                  <th className="p-1 text-right">{degradedLabel}</th>
                  <th className="p-1 text-right">{baselineLabel}</th>
                  <th className="p-1 text-right">{t('aar.compare.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {compareMetrics(cmp, trainee).map((m) => {
                  const worse =
                    m.delta !== null && m.delta !== 0 && m.delta > 0 === m.lowerIsBetter;
                  return (
                    <tr key={m.key} className="border-t border-border">
                      <th scope="row" className="p-1 text-left font-medium">
                        {t(`aar.compare.metrics.${m.key}`)}
                      </th>
                      <td className="p-1 text-right">{fixed(m.degraded, m.digits)}</td>
                      <td className="p-1 text-right">{fixed(m.baseline, m.digits)}</td>
                      <td className={`p-1 text-right ${worse ? 'font-semibold text-red-700' : ''}`}>
                        {m.delta === null
                          ? '–'
                          : `${m.delta > 0 ? '+' : ''}${m.delta.toFixed(m.digits)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">{t('aar.compare.timeline')}</h3>
            <div className="grid gap-4 lg:grid-cols-2">
              <Track
                side={cmp.degraded}
                playerId={trainee.degradedPlayerId}
                label={degradedLabel}
                colour={DEGRADED}
              />
              <Track
                side={cmp.baseline}
                playerId={trainee.baselinePlayerId}
                label={baselineLabel}
                colour={BASELINE}
              />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-sm font-semibold">{t('aar.compare.latency')}</h3>
              {latency.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('aar.charts.noData')}
                </p>
              ) : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={latency} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
                      <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="n"
                        stroke={AXIS}
                        tickFormatter={(n: number) => t('aar.charts.decisionNo', { n })}
                      />
                      <YAxis stroke={AXIS} width={40} />
                      <Tooltip contentStyle={TOOLTIP} />
                      <Legend verticalAlign="top" height={24} />
                      <Bar dataKey="degraded" name={degradedLabel} fill={DEGRADED} />
                      <Bar dataKey="baseline" name={baselineLabel} fill={BASELINE} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">{t('aar.compare.drift')}</h3>
              {drift.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('aar.charts.noData')}
                </p>
              ) : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={drift} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
                      <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                      <XAxis
                        dataKey="tick"
                        type="number"
                        domain={[0, 'dataMax']}
                        stroke={AXIS}
                        tickFormatter={(v: number) => clock(v)}
                      />
                      <YAxis stroke={AXIS} width={48} />
                      <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => clock(Number(v))} />
                      <Legend verticalAlign="top" height={24} />
                      <Line
                        type="linear"
                        dataKey="degraded"
                        name={degradedLabel}
                        stroke={DEGRADED}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      <Line
                        type="linear"
                        dataKey="baseline"
                        name={baselineLabel}
                        stroke={BASELINE}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
