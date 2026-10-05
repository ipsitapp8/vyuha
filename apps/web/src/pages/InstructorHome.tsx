import { useCallback, useEffect, useState } from 'react';
import { scenarioDescription, scenarioTitle } from '@/lib/scenarioText';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ScenarioSummary, SessionListResponse } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { apiErrorText } from '@/lib/messages';

/** Sessions shown before "Show all": the newest ones are what an instructor is looking for. */
const VISIBLE_SESSIONS = 8;

const STATUS_STYLE: Record<SessionListResponse['sessions'][number]['status'], string> = {
  RUNNING: 'border-green-700 bg-emerald-50 text-green-700',
  LOBBY: 'border-amber-700 bg-amber-50 text-amber-800',
  PAUSED: 'border-amber-700 bg-amber-50 text-amber-800',
  ENDED: 'border-border bg-secondary text-muted-foreground',
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; scenarios: ScenarioSummary[] };

export function InstructorHome() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sessions, setSessions] = useState<SessionListResponse['sessions'] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigate();

  const createSession = async (scenarioId: string): Promise<void> => {
    setCreatingFor(scenarioId);
    setCreateError(null);
    try {
      const lobby = await api.createSession(scenarioId);
      navigate(`/instructor/sessions/${lobby.session.id}`);
    } catch (e) {
      setCreateError(apiErrorText(t, e, t('instructor.scenario.createFailed')));
      setCreatingFor(null);
    }
  };

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
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-semibold">{t('instructor.home.title')}</h1>
        <p className="mb-6 text-muted-foreground">{t('instructor.home.intro')}</p>
        {createError ? (
          <p role="alert" className="mb-4 text-red-700">
            {createError}
          </p>
        ) : null}

        {state.kind === 'loading' ? (
          <p role="status">{t('instructor.home.loadingScenarios')}</p>
        ) : null}
        {state.kind === 'error' ? (
          <div role="alert" className="flex items-center gap-3 text-red-700">
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
                <h2 className="text-lg font-semibold">{scenarioTitle(t, s.title)}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {scenarioDescription(t, s.title, s.description)}
                </p>
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
                <div className="mt-4">
                  <Button onClick={() => void createSession(s.id)} disabled={creatingFor !== null}>
                    {creatingFor === s.id
                      ? t('instructor.scenario.creating')
                      : t('instructor.scenario.createSession')}
                  </Button>
                </div>
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
          <p role="alert" className="text-red-700">
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
          <>
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-navy text-white">
                  <tr>
                    <th scope="col" className="p-2">
                      {t('instructor.home.table.scenario')}
                    </th>
                    <th scope="col" className="p-2">
                      {t('instructor.home.table.code')}
                    </th>
                    <th scope="col" className="p-2">
                      {t('instructor.home.table.status')}
                    </th>
                    <th scope="col" className="p-2">
                      {t('instructor.home.table.trainees')}
                    </th>
                    <th scope="col" className="p-2">
                      <span className="sr-only">{t('instructor.home.table.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? sessions : sessions.slice(0, VISIBLE_SESSIONS)).map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-border odd:bg-background even:bg-secondary"
                    >
                      <td className="p-2 font-semibold">
                        {scenarioTitle(t, row.scenarioTitle)}
                        {row.clean ? (
                          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-semibold text-emerald-900">
                            {t('instructor.home.baselineTag')}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 font-mono text-primary">{row.code}</td>
                      <td className="p-2">
                        <span
                          className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[row.status]}`}
                        >
                          {t(`cockpit.status.${row.status}`)}
                        </span>
                      </td>
                      <td className="p-2">
                        {t('instructor.home.traineeCount', { count: row.playerCount })}
                      </td>
                      <td className="p-2">
                        <span className="flex justify-end gap-4">
                          <Link
                            className="text-primary underline"
                            to={`/instructor/sessions/${row.id}`}
                          >
                            {t('instructor.home.open')}
                          </Link>
                          {row.status === 'ENDED' ? (
                            <Link className="text-primary underline" to={`/aar/${row.id}`}>
                              {t('aar.review')}
                            </Link>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sessions.length > VISIBLE_SESSIONS ? (
              <Button
                variant="outline"
                className="mt-3"
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll
                  ? t('instructor.home.showFewer', { count: VISIBLE_SESSIONS })
                  : t('instructor.home.showAll', { count: sessions.length })}
              </Button>
            ) : null}
          </>
        ) : null}
      </main>
    </>
  );
}
