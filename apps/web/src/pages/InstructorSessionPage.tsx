import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LobbyView } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { GodView } from '@/instructor/GodView';
import { LobbyEditor } from '@/instructor/LobbyEditor';
import { api } from '@/lib/api';
import { apiErrorText } from '@/lib/messages';
import { useSessionSocket } from '@/lib/useSessionSocket';

/** /instructor/sessions/:id: lobby management before the start, the God View while the exercise runs. */
export function InstructorSessionPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const [initial, setInitial] = useState<LobbyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getLobby(id)
      .then((v) => {
        if (!cancelled) setInitial(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(apiErrorText(t, e, t('god.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt, t]);

  const live = useSessionSocket(initial?.session.code ?? null);
  // A REST result is shown until the next socket broadcast replaces the lobby it was based on.
  const [override, setOverride] = useState<{ view: LobbyView; base: LobbyView | null } | null>(
    null,
  );
  const lobby = override && override.base === live.lobby ? override.view : (live.lobby ?? initial);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const base = live.lobby;
  const run = useCallback(
    async (fn: () => Promise<LobbyView>): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        setOverride({ view: await fn(), base });
      } catch (e) {
        setActionError(apiErrorText(t, e, t('god.actionFailed')));
      } finally {
        setBusy(false);
      }
    },
    [base, t],
  );

  const [teamName, setTeamName] = useState('');
  const status = live.status?.status ?? lobby?.session.status ?? 'LOBBY';

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          {t('god.back')}
        </Link>

        {!lobby && !loadError ? (
          <p role="status" className="mt-4">
            {t('god.loading')}
          </p>
        ) : null}
        {loadError ? (
          <div role="alert" className="mt-4 flex items-center gap-3 text-red-700">
            <span>{loadError}</span>
            <Button
              variant="outline"
              onClick={() => {
                setLoadError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        {lobby ? (
          <>
            <header className="mt-2 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold">{lobby.session.scenarioTitle}</h1>
                <p className="text-sm text-muted-foreground">
                  {t('god.statusLine', {
                    status: t(`cockpit.status.${status}`),
                    tick: live.status?.tick ?? lobby.session.tick,
                    connection: t(`cockpit.connection.${live.connection}`),
                  })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">
                  {t('god.code')}
                </p>
                <p
                  className="font-mono text-4xl font-bold tracking-[0.3em] text-primary"
                  aria-label={t('god.code')}
                >
                  {lobby.session.code}
                </p>
              </div>
            </header>

            {live.error ? (
              <p role="alert" className="mt-3 text-red-700">
                {live.error}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" className="mt-3 text-red-700">
                {actionError}
              </p>
            ) : null}

            {status === 'LOBBY' ? (
              <LobbyEditor
                lobby={lobby}
                busy={busy}
                teamName={teamName}
                setTeamName={setTeamName}
                run={run}
              />
            ) : (
              <GodView
                lobby={lobby}
                live={live}
                status={status}
                speed={live.status?.speed ?? lobby.session.speed}
                busy={busy}
                run={run}
              />
            )}
          </>
        ) : null}
      </main>
    </>
  );
}
