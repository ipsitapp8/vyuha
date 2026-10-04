import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  playerRoleSchema,
  speedSchema,
  type LobbyView,
  type PaceDefaults,
  type PlayerRole,
  type Speed,
} from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { PaceEditor } from '@/components/PaceEditor';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api';
import { useSessionSocket } from '@/lib/useSessionSocket';

const ROLES = playerRoleSchema.options;
const SPEEDS = speedSchema.options.map((o) => o.value);
const NONE = '';

const errText = (e: unknown, fallback: string): string =>
  e instanceof ApiRequestError ? e.message : fallback;

export function InstructorSessionPage() {
  const { id = '' } = useParams();
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
        if (!cancelled) setLoadError(errText(e, 'Could not load the session.'));
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

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
        setActionError(errText(e, 'That did not work. Try again.'));
      } finally {
        setBusy(false);
      }
    },
    [base],
  );

  const [teamName, setTeamName] = useState('');
  const status = live.status?.status ?? lobby?.session.status ?? 'LOBBY';

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          ← Instructor home
        </Link>

        {!lobby && !loadError ? (
          <p role="status" className="mt-4">
            Loading session…
          </p>
        ) : null}
        {loadError ? (
          <div role="alert" className="mt-4 flex items-center gap-3 text-red-400">
            <span>{loadError}</span>
            <Button
              variant="outline"
              onClick={() => {
                setLoadError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {lobby ? (
          <>
            <header className="mt-2 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold">{lobby.session.scenarioTitle}</h1>
                <p className="text-sm text-muted-foreground">
                  Status <strong>{status}</strong> · Tick {live.status?.tick ?? lobby.session.tick}{' '}
                  · {live.connection === 'connected' ? 'Live' : `Connection: ${live.connection}`}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">
                  Session code
                </p>
                <p
                  className="font-mono text-4xl font-bold tracking-[0.3em] text-primary"
                  aria-label="Session code"
                >
                  {lobby.session.code}
                </p>
              </div>
            </header>

            {live.error ? (
              <p role="alert" className="mt-3 text-red-400">
                {live.error}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" className="mt-3 text-red-400">
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
              <RunControls
                lobby={lobby}
                status={status}
                speed={live.status?.speed ?? lobby.session.speed}
                busy={busy}
                run={run}
              />
            )}

            {status !== 'LOBBY' ? <LiveTruth live={live} lobby={lobby} /> : null}
          </>
        ) : null}
      </main>
    </>
  );
}

interface EditorProps {
  lobby: LobbyView;
  busy: boolean;
  teamName: string;
  setTeamName: (v: string) => void;
  run: (fn: () => Promise<LobbyView>) => Promise<void>;
}

function LobbyEditor({ lobby, busy, teamName, setTeamName, run }: EditorProps) {
  const sid = lobby.session.id;
  const teamOptions = [
    { value: NONE, label: '— no team —' },
    ...lobby.teams.map((t) => ({ value: t.id, label: t.name })),
  ];
  const roleOptions = [
    { value: NONE, label: '— role —' },
    ...ROLES.map((r) => ({ value: r, label: r })),
  ];
  const unitOptions = [
    { value: NONE, label: '— unit —' },
    ...lobby.units.map((u) => ({ value: u.id, label: `${u.name} (${u.type})` })),
  ];

  return (
    <>
      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-1 font-semibold">Trainees ({lobby.players.length})</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Share the session code. Trainees appear here as they join; give each one a team, a role
          and a unit.
        </p>
        {lobby.players.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has joined yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {lobby.players.map((p) => {
              const ready = p.teamId && p.role && p.unitId;
              return (
                <li
                  key={p.id}
                  className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_1.4fr_auto]"
                >
                  <span className="font-medium">{p.name}</span>
                  <Select
                    label={`Team for ${p.name}`}
                    hideLabel
                    value={p.teamId ?? NONE}
                    options={teamOptions}
                    disabled={busy}
                    onChange={(v) =>
                      void run(() => api.assignPlayer(sid, p.id, { teamId: v === NONE ? null : v }))
                    }
                  />
                  <Select
                    label={`Role for ${p.name}`}
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
                    label={`Unit for ${p.name}`}
                    hideLabel
                    value={p.unitId ?? NONE}
                    options={unitOptions}
                    disabled={busy}
                    onChange={(v) =>
                      void run(() => api.assignPlayer(sid, p.id, { unitId: v === NONE ? null : v }))
                    }
                  />
                  <span className={ready ? 'text-sm text-primary' : 'text-sm text-amber-400'}>
                    {ready ? 'Ready' : 'Incomplete'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-3 font-semibold">Teams and PACE plans</h2>
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
              New team name
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
            Add team
          </Button>
        </form>
        {lobby.teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No teams yet. Add one to start assigning trainees.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {lobby.teams.map((t) => (
              <li key={t.id} className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-medium">
                    {t.name}{' '}
                    <span className="text-sm text-muted-foreground">
                      ({lobby.players.filter((p) => p.teamId === t.id).length} players)
                    </span>
                  </h3>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => api.deleteTeam(sid, t.id))}
                  >
                    Delete team
                  </Button>
                </div>
                <PaceEditor
                  key={JSON.stringify(t.pace)}
                  pace={t.pace}
                  disabled={busy}
                  onSave={async (pace: PaceDefaults) => {
                    await run(() => api.setPace(sid, t.id, pace));
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
          Start exercise
        </Button>
        <p className="text-sm text-muted-foreground">
          Starting locks teams, roles and units. Every trainee needs a team, role and unit, and
          every team a PL_CDR.
        </p>
      </div>
    </>
  );
}

interface ControlsProps {
  lobby: LobbyView;
  status: string;
  speed: Speed;
  busy: boolean;
  run: (fn: () => Promise<LobbyView>) => Promise<void>;
}

function RunControls({ lobby, status, speed, busy, run }: ControlsProps) {
  const sid = lobby.session.id;
  const ended = status === 'ENDED';
  return (
    <section
      className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary p-4"
      aria-label="Exercise controls"
    >
      {status === 'RUNNING' ? (
        <Button disabled={busy} onClick={() => void run(() => api.sessionControl(sid, 'pause'))}>
          Pause
        </Button>
      ) : null}
      {status === 'PAUSED' ? (
        <Button disabled={busy} onClick={() => void run(() => api.sessionControl(sid, 'resume'))}>
          Resume
        </Button>
      ) : null}
      {!ended ? (
        <>
          <div className="flex items-center gap-1" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <Button
                key={s}
                variant={s === speed ? 'default' : 'outline'}
                disabled={busy}
                aria-pressed={s === speed}
                onClick={() => void run(() => api.setSpeed(sid, s))}
              >
                {s}x
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => api.sessionControl(sid, 'end'))}
          >
            End exercise
          </Button>
        </>
      ) : (
        <p>The exercise has ended.</p>
      )}
    </section>
  );
}

function LiveTruth({
  live,
  lobby,
}: {
  live: ReturnType<typeof useSessionSocket>;
  lobby: LobbyView;
}) {
  const { truth } = live;
  if (!truth) {
    return (
      <p role="status" className="mt-6 text-muted-foreground">
        Waiting for the first tick…
      </p>
    );
  }
  const names = new Map(lobby.players.map((p) => [p.id, p.name]));
  const recent = live.truthEvents
    .filter((e) =>
      [
        'MESSAGE_OUTCOME',
        'INJECT_FIRED',
        'SPOOF_INJECTED',
        'JAMMING_CHANGED',
        'DECISION_MADE',
      ].includes(e.type),
    )
    .slice(-12)
    .reverse();
  return (
    <>
      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-secondary p-4">
          <h2 className="mb-2 font-semibold">Picture drift (how wrong each picture is)</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th>Trainee</th>
                <th>Missed</th>
                <th>Ghosts</th>
                <th>Error (m)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(truth.drift).map(([pid, d]) => (
                <tr key={pid}>
                  <td>{names.get(pid) ?? pid}</td>
                  <td>{d.missed}</td>
                  <td>{d.ghost}</td>
                  <td>{Math.round(d.avgPositionErrorM)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-lg border border-border bg-secondary p-4">
          <h2 className="mb-2 font-semibold">Channel jamming (truth)</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {(['VHF', 'HF', 'SATCOM', 'DATALINK', 'RUNNER'] as const).map((c) => (
              <li key={c} className="flex items-center gap-2">
                <span className="w-20">{c}</span>
                <progress
                  className="h-2 flex-1"
                  value={truth.jamming[c]}
                  max={1}
                  aria-label={`${c} jamming`}
                />
                <span className="w-12 text-right">{Math.round(truth.jamming[c] * 100)}%</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-muted-foreground">
            SATCOM {truth.satcomUp ? 'up' : 'DOWN'}
          </p>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-2 font-semibold">Ground truth units</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th>Unit</th>
                <th>Side</th>
                <th>Type</th>
                <th>Position</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {truth.units.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.side}</td>
                  <td>{u.type}</td>
                  <td>
                    {u.position.lat.toFixed(4)}, {u.position.lon.toFixed(4)}
                  </td>
                  <td>{u.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-2 font-semibold">Recent events (truth)</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {recent.map((e, i) => (
              <li key={`${e.tick}-${e.type}-${i}`}>
                t={e.tick} {e.type} {summarise(e.type, e.payload)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function summarise(type: string, p: Record<string, unknown>): string {
  if (type === 'MESSAGE_OUTCOME') {
    return `${String(p['kind'])} on ${String(p['channel'])}: ${String(p['outcome'])} (quality ${Number(p['quality']).toFixed(2)}, LOS ${String(p['los'])})`;
  }
  if (type === 'INJECT_FIRED') return String(p['title']);
  if (type === 'DECISION_MADE') return `${String(p['actionType'])} @ ${String(p['confidence'])}%`;
  return '';
}
