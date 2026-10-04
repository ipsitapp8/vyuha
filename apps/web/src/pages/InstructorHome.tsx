import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ScenarioSummary, SessionListResponse } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { apiErrorText } from '@/lib/messages';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; scenarios: ScenarioSummary[] };

export function InstructorHome() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sessions, setSessions] = useState<SessionListResponse['sessions'] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const fetchScenarios = useCallback(() => {
    api
      .listScenarios()
      .then((scenarios) => setState({ kind: 'ready', scenarios }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: apiErrorText(t, err, t('instructor.home.loadFailed')) }),
      );
  }, [t]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    fetchScenarios();
  }, [fetchScenarios]);

  useEffect(fetchScenarios, [fetchScenarios]);

  useEffect(() => {
    let cancelled = false;
    api
      .listSessions()
      .then((s) => {
        if (!cancelled) setSessions(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setSessionsError(apiErrorText(t, e, t('instructor.home.sessionsFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-semibold">{t('instructor.home.title')}</h1>
        <p className="mb-6 text-muted-foreground">{t('instructor.home.intro')}</p>

        {state.kind === 'loading' ? (
          <p role="status">{t('instructor.home.loadingScenarios')}</p>
        ) : null}
        {state.kind === 'error' ? (
          <div role="alert" className="flex items-center gap-3 text-red-400">
            <span>{state.message}</span>
            <Button variant="outline" onClick={retry}>
              {t('common.retry')}
            </Button>
          </div>
        ) : null}
        {state.kind === 'ready' && state.scenarios.length === 0 ? (
          <p className="text-muted-foreground">{t('instructor.home.noScenarios')}</p>
        ) : null}
        {state.kind === 'ready' ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {state.scenarios.map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-secondary p-4">
                <h2 className="text-lg font-semibold">{s.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{s.description}</p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{t('instructor.home.units')}</dt>
                    <dd>{s.unitCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('instructor.home.injects')}</dt>
                    <dd>{s.injectCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('instructor.home.seed')}</dt>
                    <dd>{s.seed}</dd>
                  </div>
                </dl>
                <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <Link className="text-primary underline" to={`/instructor/scenarios/${s.id}`}>
                    {t('instructor.home.openGeo')}
                  </Link>
                  <Link
                    className="text-primary underline"
                    to={`/instructor/scenarios/${s.id}/msel`}
                  >
                    {t('instructor.home.editMsel')}
                  </Link>
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t('instructor.home.area', {
                    south: s.areaBounds.south.toFixed(2),
                    north: s.areaBounds.north.toFixed(2),
                    west: s.areaBounds.west.toFixed(2),
                    east: s.areaBounds.east.toFixed(2),
                  })}
                </p>
              </li>
            ))}
          </ul>
        ) : null}

        <h2 className="mb-2 mt-10 text-xl font-semibold">{t('instructor.home.sessionsTitle')}</h2>
        {sessionsError ? (
          <p role="alert" className="text-red-400">
            {sessionsError}
          </p>
        ) : null}
        {!sessions && !sessionsError ? (
          <p role="status">{t('instructor.home.loadingSessions')}</p>
        ) : null}
        {sessions && sessions.length === 0 ? (
          <p className="text-muted-foreground">{t('instructor.home.noSessions')}</p>
        ) : null}
        {sessions && sessions.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary p-3"
              >
                <span>
                  <strong>{s.scenarioTitle}</strong>{' '}
                  <span className="font-mono text-primary">{s.code}</span>
                  <span className="text-sm text-muted-foreground">
                    {' '}
                    ·{' '}
                    {t('instructor.home.sessionRow', {
                      status: t(`cockpit.status.${s.status}`),
                      count: s.playerCount,
                    })}
                  </span>
                </span>
                <span className="flex gap-4">
                  <Link className="text-primary underline" to={`/instructor/sessions/${s.id}`}>
                    {t('instructor.home.open')}
                  </Link>
                  {s.status === 'ENDED' ? (
                    <Link className="text-primary underline" to={`/aar/${s.id}`}>
                      {t('aar.review')}
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </>
  );
}
