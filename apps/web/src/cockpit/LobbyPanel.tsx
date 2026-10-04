import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PaceEditor } from '@/components/PaceEditor';
import type { LobbyView } from '@vyuha/shared';
import { api } from '@/lib/api';
import { apiErrorText } from '@/lib/messages';

/** What a trainee sees before the exercise starts: assignment, team PACE plan and who else is here. */
export function LobbyPanel({ lobby, playerId }: { lobby: LobbyView; playerId: string | null }) {
  const { t } = useTranslation();
  const me = lobby.players.find((p) => p.id === playerId);
  const team = lobby.teams.find((x) => x.id === me?.teamId);
  const unit = lobby.units.find((u) => u.id === me?.unitId);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-2 font-semibold">{t('cockpit.lobby.assignment')}</h2>
        {team && me?.role && unit ? (
          <p>
            {t('cockpit.lobby.assignmentValue', {
              team: team.name,
              role: t(`roles.${me.role}`),
              unit: unit.name,
            })}
          </p>
        ) : (
          <p className="text-muted-foreground">{t('cockpit.lobby.waiting')}</p>
        )}
      </section>

      {team ? (
        <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
          <h2 className="mb-1 font-semibold">{t('cockpit.lobby.pacePlan')}</h2>
          <p className="mb-3 text-sm text-muted-foreground">{t('cockpit.lobby.paceHelp')}</p>
          {error ? (
            <p role="alert" className="mb-2 text-red-400">
              {error}
            </p>
          ) : null}
          <PaceEditor
            key={JSON.stringify(team.pace)}
            pace={team.pace}
            onSave={async (pace) => {
              setError(null);
              try {
                await api.setPace(lobby.session.id, team.id, pace);
              } catch (e) {
                const msg = apiErrorText(t, e, t('cockpit.lobby.paceSaveFailed'));
                setError(msg);
                throw new Error(msg);
              }
            }}
          />
        </section>
      ) : null}

      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-2 font-semibold">
          {t('cockpit.lobby.here', { count: lobby.players.length })}
        </h2>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {lobby.players.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.id === playerId ? ` ${t('cockpit.lobby.you')}` : ''}
              <span className="text-muted-foreground">
                {' '}
                · {lobby.teams.find((x) => x.id === p.teamId)?.name ??
                  t('cockpit.lobby.noTeam')} ·{' '}
                {p.role ? t(`roles.${p.role}`) : t('cockpit.lobby.noRole')}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">{t('cockpit.lobby.startsWhen')}</p>
      </section>
    </>
  );
}
