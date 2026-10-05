import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MySaScoresResponse } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { clock } from '@/lib/format';
import { apiErrorText } from '@/lib/messages';

/** After the exercise: the trainee's own situation-awareness scores. Shown only once it has ended. */
export function MySaScores({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<MySaScoresResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .getMySaScores(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(apiErrorText(t, e, t('cockpit.sa.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt, t]);

  return (
    <section
      aria-label={t('cockpit.sa.title')}
      className="mt-4 rounded-lg border border-border bg-secondary p-4"
    >
      <h2 className="font-semibold">{t('cockpit.sa.title')}</h2>
      {!data && !error ? (
        <p role="status" className="mt-2 text-sm">
          {t('common.loading')}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-2 flex items-center gap-3 text-sm text-red-700">
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
      {data && data.probes.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t('cockpit.sa.none')}</p>
      ) : null}
      {data && data.probes.length > 0 ? (
        <>
          <p className="mt-1 text-sm">
            {t('cockpit.sa.mean', { score: Math.round(data.saScore ?? 0) })}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-1">{t('cockpit.sa.time')}</th>
                  <th className="p-1 text-right">{t('cockpit.sa.score')}</th>
                  <th className="p-1 text-right">{t('cockpit.sa.found')}</th>
                  <th className="p-1 text-right">{t('cockpit.sa.missed')}</th>
                  <th className="p-1 text-right">{t('cockpit.sa.ghosts')}</th>
                  <th className="p-1 text-right">{t('cockpit.sa.channel')}</th>
                </tr>
              </thead>
              <tbody>
                {data.probes.map((p) => (
                  <tr key={p.probeId} className="border-t border-border">
                    <td className="p-1">{clock(p.tick)}</td>
                    <td className="p-1 text-right font-semibold">
                      {p.answered ? Math.round(p.score) : t('cockpit.sa.notAnswered')}
                    </td>
                    <td className="p-1 text-right">{p.contactsFound}</td>
                    <td className="p-1 text-right">{p.contactsMissed}</td>
                    <td className="p-1 text-right">{p.ghostCount}</td>
                    <td className="p-1 text-right">
                      {p.channelCorrect ? t('cockpit.sa.right') : t('cockpit.sa.wrong')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('cockpit.sa.help')}</p>
        </>
      ) : null}
    </section>
  );
}
