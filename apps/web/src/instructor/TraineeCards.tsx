import { useTranslation } from 'react-i18next';
import { DemoBotBadge } from '@/lib/demoBot';
import type { LobbyView, TruthViewDto } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import { clock } from '@/lib/format';

interface Props {
  lobby: LobbyView;
  truth: TruthViewDto;
  watchedId: string | null;
  onWatch: (playerId: string) => void;
}

const DRIFT_FULL_SCALE_M = 2000;
const pct = (n: number | null): string => (n === null ? '–' : String(Math.round(n)));

/** One card per trainee: how wrong their picture is, and how well they judge under uncertainty. */
export function TraineeCards({ lobby, truth, watchedId, onWatch }: Props) {
  const { t } = useTranslation();
  const players = lobby.players.filter((p) => truth.players[p.id] !== undefined);

  return (
    <section aria-label={t('god.cards.title')}>
      <h2 className="mb-2 font-semibold">{t('god.cards.title')}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {players.map((p) => {
          const m = truth.players[p.id];
          const d = truth.drift[p.id];
          if (!m || !d) return null;
          const watching = p.id === watchedId;
          const last = m.lastDecision;
          return (
            <li
              key={p.id}
              data-testid={`card-${p.id}`}
              className={`rounded-lg border bg-secondary p-3 text-sm ${watching ? 'border-primary' : 'border-border'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {p.name}
                    {p.isDemoBot ? <DemoBotBadge /> : null}
                  </p>
                  <p className="text-muted-foreground">
                    {p.role ? t(`roles.${p.role}`) : ''} ·{' '}
                    {lobby.teams.find((x) => x.id === p.teamId)?.name ?? ''}
                  </p>
                </div>
                <Button
                  variant={watching ? 'default' : 'outline'}
                  aria-pressed={watching}
                  aria-label={`${watching ? t('god.cards.watching') : t('god.cards.watch')}: ${p.name}`}
                  onClick={() => onWatch(p.id)}
                >
                  {watching ? t('god.cards.watching') : t('god.cards.watch')}
                </Button>
              </div>

              <div className="mt-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('god.cards.drift')}
                </p>
                <progress
                  className="h-2 w-full"
                  max={DRIFT_FULL_SCALE_M}
                  value={Math.min(DRIFT_FULL_SCALE_M, d.avgPositionErrorM)}
                  aria-label={t('god.cards.error')}
                />
                <p className="mt-1">
                  {t('god.cards.missed')} <strong>{d.missed}</strong> · {t('god.cards.ghosts')}{' '}
                  <strong>{d.ghost}</strong> · {t('god.cards.error')}{' '}
                  <strong>{t('god.cards.meters', { n: Math.round(d.avgPositionErrorM) })}</strong>
                </p>
                <p className="text-muted-foreground">
                  {t('god.cards.friendlyError')}:{' '}
                  {t('god.cards.meters', { n: Math.round(d.friendlyAvgErrorM) })}
                </p>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t('god.cards.decisions')}</dt>
                <dd>{m.decisionCount}</dd>
                <dt className="text-muted-foreground">{t('god.cards.latency')}</dt>
                <dd>
                  {m.avgLatencyTicks === null
                    ? '–'
                    : t('god.cards.seconds', { n: Math.round(m.avgLatencyTicks) })}
                </dd>
                <dt className="text-muted-foreground">{t('god.cards.calibration')}</dt>
                <dd>
                  {m.meanConfidence === null
                    ? '–'
                    : t('god.cards.calibrationLine', {
                        conf: pct(m.meanConfidence),
                        acc: pct(m.accuracy),
                      })}
                </dd>
                <dt className="text-muted-foreground">{t('god.cards.brierLabel')}</dt>
                <dd>
                  {m.brierScore === null
                    ? '–'
                    : t('god.cards.brier', { value: m.brierScore.toFixed(2) })}
                </dd>
                <dt className="text-muted-foreground">{t('god.cards.spoofs')}</dt>
                <dd className={m.spoofActedCount > 0 ? 'font-semibold text-red-700' : ''}>
                  {m.spoofActedCount}
                </dd>
                <dt className="text-muted-foreground">{t('god.cards.switches')}</dt>
                <dd>{m.channelSwitchCount}</dd>
                <dt className="text-muted-foreground">{t('god.cards.grading')}</dt>
                <dd>
                  {m.gradingAccuracy === null ? '–' : `${Math.round(m.gradingAccuracy * 100)}%`}
                </dd>
                <dt className="text-muted-foreground">{t('god.cards.sa')}</dt>
                <dd>
                  {m.lastSaScore === null
                    ? '–'
                    : t('god.cards.saLine', {
                        last: Math.round(m.lastSaScore),
                        mean: Math.round(m.saScore ?? m.lastSaScore),
                        count: m.probeCount,
                      })}
                </dd>
              </dl>

              <p className="mt-3 text-xs uppercase tracking-wide text-muted-foreground">
                {t('god.cards.lastDecision')}
              </p>
              {last ? (
                <>
                  <p>
                    {t('god.cards.decisionLine', {
                      action: t(`actions.${last.actionType}` as 'actions.HOLD', {
                        defaultValue: last.actionType,
                      }),
                      confidence: last.confidence,
                      outcome:
                        last.outcome === null
                          ? t('god.cards.unscored')
                          : last.outcome === 1
                            ? t('god.cards.correct')
                            : t('god.cards.wrong'),
                      time: clock(last.tick),
                    })}
                  </p>
                  <p className="text-muted-foreground">“{last.rationale}”</p>
                </>
              ) : (
                <p className="text-muted-foreground">{t('god.cards.none')}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
