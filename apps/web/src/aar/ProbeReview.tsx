import { useState } from 'react';
import {
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
import type { AarSummary } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { clock } from '@/lib/format';
import { ProbeMap } from './ProbeMap';
import { probeMapData, saChart } from './probeData';

const GRID = '#d3dae6';
const AXIS = '#475569';
const TOOLTIP = { background: '#ffffff', border: '1px solid #94a3b8', color: '#0f172a' };
const COLORS = ['#15803d', '#1d4ed8', '#b45309', '#7e22ce', '#be123c', '#0e7490', '#4d7c0f'];

const meters = (v: number | null): string => (v === null ? '–' : `${Math.round(v)} m`);

/**
 * Situation-awareness probes (SAGAT): for each freeze, the trainee's answers drawn over the truth of
 * that moment, the numbers behind the score, and the score over the exercise for every trainee.
 */
export function ProbeReview({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const { probes } = summary.analysis;
  const [probeId, setProbeId] = useState(probes[0]?.probeId ?? '');
  const [playerId, setPlayerId] = useState(probes[0]?.results[0]?.playerId ?? '');

  if (probes.length === 0) {
    return (
      <section
        className="rounded-lg border border-border bg-secondary p-4"
        aria-label={t('aar.probes.title')}
      >
        <h2 className="mb-1 font-semibold">{t('aar.probes.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('aar.probes.none')}</p>
      </section>
    );
  }

  const probe = probes.find((p) => p.probeId === probeId) ?? probes[0];
  const result = probe?.results.find((r) => r.playerId === playerId) ?? probe?.results[0];
  const names = new Map(summary.meta.players.map((p) => [p.id, p.name]));
  const unitNames = Object.fromEntries(
    summary.meta.players.map((p) => [p.unitId, names.get(p.id) ?? p.unitId]),
  );
  const typeName = (type: string): string =>
    t(`unitTypes.${type}` as 'unitTypes.RECCE', { defaultValue: type });
  const channelName = (c: string): string =>
    c === 'NONE' ? t('cockpit.probe.none') : t(`channels.${c}` as 'channels.VHF');
  const map = result
    ? probeMapData(result, unitNames, {
        hostile: (type) => t('aar.probes.map.hostile', { type: typeName(type) }),
        missed: (type) => t('aar.probes.map.missed', { type: typeName(type) }),
        teammate: (name) => t('aar.probes.map.teammate', { name }),
        marked: (n) => t('aar.probes.map.marked', { n }),
        ghost: (n) => t('aar.probes.map.ghost', { n }),
        saidTeammate: (name) => t('aar.probes.map.saidTeammate', { name }),
      })
    : { points: [], links: [] };
  const chart = saChart(summary);

  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('aar.probes.title')}
    >
      <h2 className="mb-1 font-semibold">{t('aar.probes.title')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('aar.probes.intro')}</p>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select
          label={t('aar.probes.probe')}
          value={probe?.probeId ?? ''}
          options={probes.map((p, i) => ({
            value: p.probeId,
            label: t('aar.probes.probeN', { n: i + 1, time: clock(p.tick) }),
          }))}
          onChange={setProbeId}
        />
        <Select
          label={t('aar.replay.trainee')}
          value={result?.playerId ?? ''}
          options={(probe?.results ?? []).map((r) => ({
            value: r.playerId,
            label: names.get(r.playerId) ?? r.playerId,
          }))}
          onChange={setPlayerId}
        />
        {result ? (
          <p className="text-2xl font-semibold" aria-label={t('aar.probes.score')}>
            {result.answered ? Math.round(result.score) : 0}
            <span className="text-base font-normal text-muted-foreground"> / 100</span>
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="h-80 overflow-hidden rounded-md border border-border">
            {probe && result ? (
              <ProbeMap
                bounds={summary.meta.areaBounds}
                scenarioId={summary.meta.scenarioId}
                points={map.points}
                links={map.links}
              />
            ) : null}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {(
              [
                ['true-hostile', 'legendHostile'],
                ['missed-hostile', 'legendMissed'],
                ['said-contact', 'legendMarked'],
                ['ghost-contact', 'legendGhost'],
                ['true-teammate', 'legendTeammate'],
                ['said-teammate', 'legendSaidTeammate'],
              ] as const
            ).map(([kind, key]) => (
              <li key={kind} className="flex items-center gap-1">
                <span className={`vy-marker vy-pr-${kind}`} aria-hidden="true">
                  <span className="vy-dot" />
                </span>
                {t(`aar.probes.${key}`)}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-3">
          {result ? (
            result.answered ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('aar.probes.found')}</dt>
                <dd>
                  {t('aar.probes.foundValue', {
                    found: result.matched.length,
                    total: result.truth.hostiles.length,
                  })}
                </dd>
                <dt className="text-muted-foreground">{t('aar.probes.missed')}</dt>
                <dd>{result.missedUnitIds.length}</dd>
                <dt className="text-muted-foreground">{t('aar.probes.ghosts')}</dt>
                <dd>{result.ghostCount}</dd>
                <dt className="text-muted-foreground">{t('aar.probes.contactError')}</dt>
                <dd>{meters(result.avgContactErrorM)}</dd>
                <dt className="text-muted-foreground">{t('aar.probes.teammateError')}</dt>
                <dd>{meters(result.avgTeammateErrorM)}</dd>
                <dt className="text-muted-foreground">{t('aar.probes.channel')}</dt>
                <dd className={result.channelCorrect ? 'text-primary' : 'text-red-700'}>
                  {t('aar.probes.channelValue', {
                    said: channelName(result.answer?.jammedChannel ?? 'NONE'),
                    truth: channelName(result.truth.jammedChannel),
                  })}
                </dd>
              </dl>
            ) : (
              <p role="status" className="text-sm text-red-700">
                {t('aar.probes.notAnswered')}
              </p>
            )
          ) : null}

          <div>
            <h3 className="mb-1 text-sm font-semibold">{t('aar.probes.chart')}</h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart.rows} margin={{ top: 4, right: 12, bottom: 16, left: 0 }}>
                  <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="tick"
                    type="number"
                    domain={[0, summary.meta.durationTicks]}
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
                  <YAxis domain={[0, 100]} stroke={AXIS} width={36} />
                  <Tooltip contentStyle={TOOLTIP} labelFormatter={(v) => clock(Number(v))} />
                  <Legend verticalAlign="top" height={24} />
                  {chart.players.map((p, i) => (
                    <Line
                      key={p.id}
                      type="linear"
                      dataKey={p.id}
                      name={p.name}
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 4 }}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
