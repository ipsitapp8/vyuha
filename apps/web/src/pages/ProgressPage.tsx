import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ProgressResponse, ProgressTraineesResponse } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { AppHeader } from '@/components/AppHeader';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { botName, DemoBotBadge } from '@/lib/demoBot';
import { apiErrorText } from '@/lib/messages';
import { ProgressHeading, ProgressView } from '@/progress/ProgressView';

/** /progress: instructors pick a trainee; a trainee goes straight to their own page. */
export function ProgressIndexPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [list, setList] = useState<ProgressTraineesResponse['trainees'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const isInstructor = user?.role === 'INSTRUCTOR';

  useEffect(() => {
    if (!isInstructor) return;
    let cancelled = false;
    api
      .getProgressTrainees()
      .then((r) => {
        if (!cancelled) setList(r.trainees);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(t, e, t('progress.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [isInstructor, attempt, t]);

  if (user && !isInstructor) return <Navigate to={`/progress/${user.id}`} replace />;

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          {t('progress.back')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{t('progress.allTitle')}</h1>
        {!list && !error ? (
          <p role="status" className="mt-4">
            {t('progress.loading')}
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
        {list && list.length === 0 ? (
          <p className="mt-4 text-muted-foreground">{t('progress.noTrainees')}</p>
        ) : null}
        {list && list.length > 0 ? (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-secondary">
            {list.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 p-3">
                <span>
                  {u.name}
                  {u.isDemoBot ? <DemoBotBadge /> : null}
                </span>
                <span className="flex items-center gap-4 text-sm text-muted-foreground">
                  {t('progress.sessionCount', { count: u.sessionCount })}
                  <Link className="text-primary underline" to={`/progress/${u.id}`}>
                    {t('progress.open')}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </>
  );
}

/** /progress/:userId: charts and trends across a trainee's sessions. */
export function ProgressPage() {
  const { userId = '' } = useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [trainees, setTrainees] = useState<ProgressTraineesResponse['trainees']>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const isInstructor = user?.role === 'INSTRUCTOR';

  useEffect(() => {
    let cancelled = false;
    api
      .getProgress(userId)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(t, e, t('progress.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt, t]);

  useEffect(() => {
    if (!isInstructor) return;
    let cancelled = false;
    api
      .getProgressTrainees()
      .then((r) => {
        if (!cancelled) setTrainees(r.trainees);
      })
      .catch(() => undefined); // the switcher is a convenience; the page itself still works
    return () => {
      cancelled = true;
    };
  }, [isInstructor]);

  // while another trainee is loading, the previous one must not stay on screen
  const shown = data && data.user.id === userId ? data : null;
  const home = user ? homePathFor(user.role) : '/';

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link to={home} className="text-sm text-primary underline">
            {t('progress.back')}
          </Link>
          {isInstructor && trainees.length > 0 ? (
            <div className="w-64">
              <Select
                label={t('progress.pickTrainee')}
                value={userId}
                onChange={(id) => {
                  setError(null);
                  navigate(`/progress/${id}`);
                }}
                options={trainees.map((u) => ({ value: u.id, label: botName(t, u) }))}
              />
            </div>
          ) : null}
        </div>

        {!shown && !error ? (
          <p role="status" className="mt-4">
            {t('progress.loading')}
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

        {shown ? (
          <div className="mt-2 flex flex-col gap-6">
            <header>
              <ProgressHeading data={shown} />
              <p className="text-sm text-muted-foreground">{t('progress.help')}</p>
            </header>
            <ProgressView data={shown} />
          </div>
        ) : null}
      </main>
    </>
  );
}
