import { useTranslation } from 'react-i18next';
import { DemoBotBadge } from '@/lib/demoBot';
import {
  playerRoleSchema,
  type LobbyView,
  type PaceDefaults,
  type PlayerRole,
} from '@vyuha/shared';
import { PaceEditor } from '@/components/PaceEditor';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

const ROLES = playerRoleSchema.options;
const NONE = '';

interface Props {
  lobby: LobbyView;
  busy: boolean;
  teamName: string;
  setTeamName: (v: string) => void;
  run: (fn: () => Promise<LobbyView>) => Promise<void>;
}

/** Lobby management: assign each trainee a team, role and unit; edit PACE plans; start the exercise. */
export function LobbyEditor({ lobby, busy, teamName, setTeamName, run }: Props) {
  const { t } = useTranslation();
  const sid = lobby.session.id;
  const teamOptions = [
    { value: NONE, label: t('god.lobby.noTeam') },
    ...lobby.teams.map((x) => ({ value: x.id, label: x.name })),
  ];
  const roleOptions = [
    { value: NONE, label: t('god.lobby.noRole') },
    ...ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) })),
  ];
  const unitOptions = [
    { value: NONE, label: t('god.lobby.noUnit') },
    ...lobby.units.map((u) => ({
      value: u.id,
      label: `${u.name} (${t(`unitTypes.${u.type}` as 'unitTypes.HQ', { defaultValue: u.type })})`,
    })),
  ];

  return (
    <>
      {lobby.session.clean ? (
        <p
          role="status"
          className="mt-6 rounded-md bg-emerald-100 p-3 text-sm font-semibold text-emerald-900"
        >
          {t('god.lobby.baseline')}
        </p>
      ) : null}
      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-1 font-semibold">
          {t('god.lobby.trainees', { count: lobby.players.length })}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t('god.lobby.intro')}</p>
        {lobby.players.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('god.lobby.nobody')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {lobby.players.map((p) => {
              const ready = p.teamId && p.role && p.unitId;
              return (
                <li
                  key={p.id}
                  className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_1.4fr_auto]"
                >
                  <span className="font-medium">
                    {p.name}
                    {p.isDemoBot ? <DemoBotBadge /> : null}
                  </span>
                  <Select
                    label={t('god.lobby.teamFor', { name: p.name })}
                    hideLabel
                    value={p.teamId ?? NONE}
                    options={teamOptions}
                    disabled={busy}
                    onChange={(v) =>
                      void run(() => api.assignPlayer(sid, p.id, { teamId: v === NONE ? null : v }))
                    }
                  />
                  <Select
                    label={t('god.lobby.roleFor', { name: p.name })}
                    hideLabel
                    value={p.role ?? NONE}
                    options={roleOptions}
                    disabled={busy}
                    onChange={(v) =>
                      void run(() =>
                        api.assignPlayer(sid, p.id, {
                          role: v === NONE ? null : (v as PlayerRole),
                        }),
                      )
                    }
                  />
                  <Select
                    label={t('god.lobby.unitFor', { name: p.name })}
                    hideLabel
                    value={p.unitId ?? NONE}
                    options={unitOptions}
                    disabled={busy}
                    onChange={(v) =>
                      void run(() => api.assignPlayer(sid, p.id, { unitId: v === NONE ? null : v }))
                    }
                  />
                  <span className={ready ? 'text-sm text-primary' : 'text-sm text-amber-700'}>
                    {ready ? t('god.lobby.ready') : t('god.lobby.incomplete')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-3 font-semibold">{t('god.lobby.teamsTitle')}</h2>
        <form
          className="mb-4 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const name = teamName.trim();
            if (!name) return;
            void run(() => api.createTeam(sid, name)).then(() => setTeamName(''));
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="team-name" className="text-sm font-medium">
              {t('god.lobby.newTeam')}
            </label>
            <input
              id="team-name"
              value={teamName}
              maxLength={40}
              onChange={(e) => setTeamName(e.target.value)}
              className="h-10 rounded-md border border-border bg-background px-3 text-sm"
            />
          </div>
          <Button type="submit" disabled={busy || teamName.trim().length === 0}>
            {t('god.lobby.addTeam')}
          </Button>
        </form>
        {lobby.teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('god.lobby.noTeams')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {lobby.teams.map((team) => (
              <li key={team.id} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-medium">
                    {team.name}{' '}
                    <span className="text-sm text-muted-foreground">
                      (
                      {t('god.lobby.players', {
                        count: lobby.players.filter((p) => p.teamId === team.id).length,
                      })}
                      )
                    </span>
                  </h3>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => api.deleteTeam(sid, team.id))}
                  >
                    {t('god.lobby.deleteTeam')}
                  </Button>
                </div>
                <PaceEditor
                  key={JSON.stringify(team.pace)}
                  pace={team.pace}
                  disabled={busy}
                  onSave={async (pace: PaceDefaults) => {
                    await run(() => api.setPace(sid, team.id, pace));
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={busy}
          onClick={() => void run(() => api.sessionControl(sid, 'start'))}
        >
          {t('god.lobby.start')}
        </Button>
        <p className="text-sm text-muted-foreground">{t('god.lobby.startHelp')}</p>
      </div>
    </>
  );
}
