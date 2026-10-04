import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AarSummary } from '@vyuha/shared';
import { AarCharts } from '@/aar/AarCharts';
import { FlowGraph } from '@/aar/FlowGraph';
import { GhostReplay } from '@/aar/GhostReplay';
import { KeyEvents, LearningList } from '@/aar/LearningPoints';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { DemoBotBadge } from '@/lib/demoBot';
import { clock } from '@/lib/format';
import { apiErrorText } from '@/lib/messages';

const pct = (v: number | null, digits = 0): string => (v === null ? '–' : `${v.toFixed(digits)}%`);

/** /aar/:sessionId: the after action review, built only from the recorded events and decisions. */
export function AarPage() {
  const { sessionId = '' } = useParams();
  const { t } = useTranslation();
  const [summary, setSummary] = useState<AarSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getAar(sessionId)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(t, e, t('aar.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt, t]);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          {t('aar.back')}
        </Link>

        {!summary && !error ? (
          <p role="status" className="mt-4">
            {t('aar.loading')}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="mt-4 flex items-center gap-3 text-red-700">
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

        {summary ? <Review summary={summary} /> : null}
      </main>
    </>
  );
}

function Review({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const { meta, analysis } = summary;
  const bots = new Set(meta.players.filter((p) => p.isDemoBot).map((p) => p.id));
  return (
    <div className="mt-2 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('aar.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('aar.meta', {
              scenario: meta.scenarioTitle,
              code: meta.code,
              duration: clock(meta.durationTicks),
              count: meta.players.length,
            })}
          </p>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label={t('aar.export.title')}>
          {(['pdf', 'csv', 'json'] as const).map((kind) => (
            <Button key={kind} asChild variant={kind === 'pdf' ? 'default' : 'outline'}>
              <a href={api.aarExportUrl(meta.sessionId, kind)} download>
                <Download className="mr-1 h-4 w-4" aria-hidden="true" />
                {t(`aar.export.${kind}`)}
              </a>
            </Button>
          ))}
        </nav>
      </header>

      <section
        className="rounded-lg border border-border bg-secondary p-4"
        aria-label={t('aar.summary.title')}
      >
        <h2 className="mb-2 font-semibold">{t('aar.summary.title')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="p-1">{t('aar.summary.trainee')}</th>
                <th className="p-1">{t('aar.summary.role')}</th>
                <th className="p-1 text-right">{t('aar.summary.decisions')}</th>
                <th className="p-1 text-right">{t('aar.summary.correct')}</th>
                <th className="p-1 text-right">{t('aar.summary.confidence')}</th>
                <th className="p-1 text-right">{t('aar.summary.brier')}</th>
                <th className="p-1 text-right">{t('aar.summary.latency')}</th>
                <th className="p-1 text-right">{t('aar.summary.grading')}</th>
                <th className="p-1 text-right">{t('aar.summary.spoofs')}</th>
                <th className="p-1 text-right">{t('aar.summary.challenged')}</th>
                <th className="p-1 text-right">{t('aar.summary.drift')}</th>
              </tr>
            </thead>
            <tbody>
              {analysis.players.map((p) => (
                <tr key={p.playerId} className="border-t border-border">
                  <td className="p-1 font-medium">
                    {p.name}
                    {bots.has(p.playerId) ? <DemoBotBadge /> : null}
                  </td>
                  <td className="p-1">
                    {t(`roles.${p.role}` as 'roles.PL_CDR', { defaultValue: p.role })}
                  </td>
                  <td className="p-1 text-right">{p.decisionCount}</td>
                  <td className="p-1 text-right">{pct(p.accuracy)}</td>
                  <td className="p-1 text-right">{pct(p.meanConfidence)}</td>
                  <td className="p-1 text-right">
                    {p.brierScore === null ? '–' : p.brierScore.toFixed(2)}
                  </td>
                  <td className="p-1 text-right">
                    {p.avgLatencyTicks === null
                      ? '–'
                      : t('god.cards.seconds', { n: Math.round(p.avgLatencyTicks) })}
                  </td>
                  <td className="p-1 text-right">
                    {p.gradingAccuracy === null ? '–' : pct(p.gradingAccuracy * 100)}
                  </td>
                  <td
                    className={`p-1 text-right ${p.spoofActedCount > 0 ? 'font-semibold text-red-700' : ''}`}
                  >
                    {p.spoofActedCount}
                  </td>
                  <td className="p-1 text-right">
                    {p.spoofsChallengedPct === null
                      ? '–'
                      : `${pct(p.spoofsChallengedPct)} (${p.spoofsChallenged}/${p.spoofsReceived})`}
                  </td>
                  <td className="p-1 text-right">
                    {p.drift ? Math.round(p.drift.meanPositionErrorM) : '–'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('aar.summary.help')}</p>
      </section>

      <LearningList summary={summary} />
      <GhostReplay summary={summary} />
      <AarCharts summary={summary} />
      <FlowGraph summary={summary} />
      <KeyEvents summary={summary} />
    </div>
  );
}
