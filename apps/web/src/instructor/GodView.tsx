import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  speedSchema,
  type InjectType,
  type InstructorInput,
  type LobbyView,
  type Speed,
  type TruthEventDto,
  type TruthViewDto,
} from '@vyuha/shared';
import { CockpitMap } from '@/cockpit/CockpitMap';
import { Link } from 'react-router-dom';
import { Mountain, Snowflake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { clock } from '@/lib/format';
import { readTerrain3dPref, saveTerrain3dPref } from '@/lib/terrain3d';
import { ackErrorText } from '@/lib/messages';
import type { SessionLive } from '@/lib/useSessionSocket';
import { DegradationPanel } from './DegradationPanel';
import { InjectEditor, type UnitRef } from './InjectEditor';
import { MselTimeline } from './MselTimeline';
import { TraineeCards } from './TraineeCards';
import { TruthMap } from './TruthMap';

const SPEEDS = speedSchema.options.map((o) => o.value);
const QUICK: {
  type: InjectType;
  label: 'jam' | 'satcom' | 'spoof' | 'conflict' | 'weather' | 'gps' | 'c2';
}[] = [
  { type: 'JAM_CHANNEL', label: 'jam' },
  { type: 'SATCOM_OUTAGE', label: 'satcom' },
  { type: 'SPOOF_ORDER', label: 'spoof' },
  { type: 'CONFLICTING_REPORTS', label: 'conflict' },
  { type: 'WEATHER_CHANGE', label: 'weather' },
  { type: 'GPS_SPOOF', label: 'gps' },
  { type: 'C2_COMPROMISE', label: 'c2' },
];

type RunFn = (fn: () => Promise<LobbyView>) => Promise<void>;

interface Props {
  lobby: LobbyView;
  live: SessionLive;
  status: 'RUNNING' | 'PAUSED' | 'ENDED';
  speed: Speed;
  busy: boolean;
  run: RunFn;
}

/** The instructor's God View: truth beside a trainee's perception, live injects, MSEL and metrics. */
export function GodView({ lobby, live, status, speed, busy, run }: Props) {
  const { t } = useTranslation();
  const { truth, instruct, watch } = live;
  const [watchedId, setWatchedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [quick, setQuick] = useState<InjectType | null>(null);
  const [tilesOffline, setTilesOffline] = useState(false);
  const [terrain3d, setTerrain3d] = useState(readTerrain3dPref);

  // Rooms are lost on reconnect: ask for the watched trainee's picture again.
  useEffect(() => {
    if (live.connection === 'connected' && watchedId) void watch(watchedId);
  }, [live.connection, watchedId, watch]);

  const send = async (input: InstructorInput): Promise<void> => {
    const ack = await instruct(input);
    if (!ack.ok) throw new Error(ackErrorText(t, ack.error));
  };
  const toggleWatch = async (id: string): Promise<void> => {
    const next = id === watchedId ? null : id;
    const ack = await watch(next);
    if (ack.ok) setWatchedId(next);
    else setNotice({ kind: 'error', text: ackErrorText(t, ack.error) });
  };

  if (!truth) {
    return (
      <p role="status" className="mt-6 text-muted-foreground">
        {t('god.waiting')}
      </p>
    );
  }

  const units: UnitRef[] = truth.units.map((u) => ({
    id: u.id,
    name: u.name,
    side: u.side,
    domain: u.domain,
  }));
  const b = lobby.session.areaBounds;
  const anchor = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
  const watched = live.perceived && live.perceived.playerId === watchedId ? live.perceived : null;
  const watchedName = lobby.players.find((p) => p.id === watchedId)?.name ?? '';
  const { clean } = lobby.session;

  return (
    <div className="mt-6 flex flex-col gap-6">
      <RunControls
        lobby={lobby}
        status={status}
        speed={speed}
        busy={busy}
        run={run}
        probe={truth.probe}
      />

      {notice ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={notice.kind === 'error' ? 'text-red-700' : 'text-primary'}
        >
          {notice.text}
        </p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2" aria-label={t('god.maps.truth')}>
        <figure className="flex flex-col gap-1">
          <figcaption className="font-semibold">{t('god.maps.truth')}</figcaption>
          <div className="h-[46dvh] min-h-72 overflow-hidden rounded-lg border border-border">
            <TruthMap
              bounds={b}
              scenarioId={lobby.session.scenarioId}
              truth={truth}
              watched={watched}
              onTilesOffline={() => setTilesOffline(true)}
              terrain3d={terrain3d}
            />
          </div>
        </figure>
        <figure className="flex flex-col gap-1">
          <figcaption className="font-semibold">
            {watched ? t('god.maps.perceived', { name: watchedName }) : t('god.cards.watch')}
          </figcaption>
          <div className="relative h-[46dvh] min-h-72 overflow-hidden rounded-lg border border-border">
            {watched ? (
              <CockpitMap
                bounds={b}
                scenarioId={lobby.session.scenarioId}
                perceived={watched}
                picture={watched}
                selectedContactId={null}
                onSelectContact={() => undefined}
                pickMode={false}
                onPick={() => undefined}
                terrain3d={terrain3d}
                onTilesOffline={() => setTilesOffline(true)}
              />
            ) : (
              <p className="flex h-full items-center justify-center p-4 text-center text-muted-foreground">
                {t('god.maps.pick')}
              </p>
            )}
          </div>
        </figure>
        <div className="lg:col-span-2">
          <Button
            variant="outline"
            aria-pressed={terrain3d}
            onClick={() => {
              saveTerrain3dPref(!terrain3d);
              setTerrain3d(!terrain3d);
            }}
          >
            <Mountain className="mr-1 h-4 w-4" aria-hidden="true" />
            {t('map.terrain3d')}
          </Button>
        </div>
        {truth.effects.gpsSpoofs.length + truth.effects.c2Compromises.length > 0 ? (
          <ul
            aria-label={t('god.effects.title')}
            className="flex flex-wrap gap-2 text-sm lg:col-span-2"
          >
            {truth.effects.gpsSpoofs.map((g) => (
              <li
                key={`gps-${g.unitId}`}
                className="rounded-md bg-amber-100 px-2 py-1 text-amber-900"
              >
                {t('god.effects.gps', {
                  unit: truth.units.find((u) => u.id === g.unitId)?.name ?? g.unitId,
                  offset: g.offsetM,
                  until: clock(g.untilTick),
                })}
              </li>
            ))}
            {truth.effects.c2Compromises.map((c) => (
              <li
                key={`c2-${c.playerId}`}
                className="rounded-md bg-amber-100 px-2 py-1 text-amber-900"
              >
                {t('god.effects.c2', {
                  name: lobby.players.find((p) => p.id === c.playerId)?.name ?? c.playerId,
                  drift: c.driftM,
                  channel: t(`channels.${c.channel}`),
                })}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground lg:col-span-2">
          {watched ? t('god.maps.legend', { name: watchedName }) : null}{' '}
          {tilesOffline ? t('god.maps.tilesOffline') : null}
        </p>
      </section>

      <TraineeCards
        lobby={lobby}
        truth={truth}
        watchedId={watchedId}
        onWatch={(id) => void toggleWatch(id)}
      />

      <section className="grid gap-4 lg:grid-cols-2">
        <div
          className="rounded-lg border border-border bg-secondary p-4"
          aria-label={t('god.inject.title')}
        >
          <h2 className="mb-2 font-semibold">{t('god.inject.title')}</h2>
          {clean ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('god.inject.baselineOff')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {(clean ? [] : QUICK).map((q) => (
              <Button
                key={q.type}
                variant={quick === q.type ? 'default' : 'outline'}
                aria-pressed={quick === q.type}
                disabled={status !== 'RUNNING'}
                onClick={() => {
                  setNotice(null);
                  setQuick(quick === q.type ? null : q.type);
                }}
              >
                {t(`god.inject.${q.label}`)}
              </Button>
            ))}
          </div>
          {quick ? (
            <div className="mt-3">
              <InjectEditor
                key={quick}
                fixedType={quick}
                withTick={false}
                units={units}
                anchor={anchor}
                submitLabel={t('god.inject.fire')}
                onCancel={() => setQuick(null)}
                onSubmit={async (inject) => {
                  await send({ type: 'INJECT_NOW', inject });
                  setNotice({ kind: 'ok', text: t('god.inject.sent') });
                  setQuick(null);
                }}
              />
            </div>
          ) : null}
        </div>
        {clean ? null : (
          <DegradationPanel
            truth={truth}
            onSet={async (channel, intensity) => {
              try {
                await send({ type: 'SET_JAMMING', channel, intensity });
                return true;
              } catch (e) {
                setNotice({
                  kind: 'error',
                  text: e instanceof Error ? e.message : t('god.actionFailed'),
                });
                return false;
              }
            }}
          />
        )}
      </section>

      <MselTimeline
        entries={truth.msel}
        tick={truth.tick}
        units={units}
        anchor={anchor}
        onAdd={(inject) => send({ type: 'MSEL_ADD', inject })}
        onUpdate={(inject) => send({ type: 'MSEL_UPDATE', inject })}
        onRemove={(injectId) => send({ type: 'MSEL_REMOVE', injectId })}
      />

      <EventFeed events={live.truthEvents} />
    </div>
  );
}

function RunControls({
  lobby,
  status,
  speed,
  busy,
  run,
  probe,
}: Omit<Props, 'live'> & { probe: TruthViewDto['probe'] }) {
  const { t } = useTranslation();
  const sid = lobby.session.id;
  const ended = status === 'ENDED';
  return (
    <section
      aria-label={t('god.controls.label')}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary p-4"
    >
      {status === 'RUNNING' ? (
        <Button disabled={busy} onClick={() => void run(() => api.sessionControl(sid, 'pause'))}>
          {t('god.controls.pause')}
        </Button>
      ) : null}
      {status === 'PAUSED' ? (
        <Button disabled={busy} onClick={() => void run(() => api.sessionControl(sid, 'resume'))}>
          {t('god.controls.resume')}
        </Button>
      ) : null}
      {status === 'RUNNING' ? (
        <Button
          variant="outline"
          disabled={busy || lobby.players.length === 0}
          title={t('god.controls.probeHelp')}
          onClick={() => void run(() => api.sessionControl(sid, 'probe'))}
        >
          <Snowflake className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('god.controls.probe')}
        </Button>
      ) : null}
      {lobby.session.clean ? (
        <p className="rounded-md bg-emerald-100 px-2 py-1 text-sm font-semibold text-emerald-900">
          {t('god.controls.baseline')}
        </p>
      ) : null}
      {probe && !ended ? (
        <p role="status" className="rounded-md bg-amber-100 px-2 py-1 text-sm text-amber-900">
          {t('god.controls.probeOpen', {
            answered: lobby.players.length - probe.pending.length,
            total: lobby.players.length,
          })}
        </p>
      ) : null}
      {!ended ? (
        <>
          <div
            role="group"
            aria-label={t('god.controls.speed')}
            className="flex items-center gap-1"
          >
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
            {t('god.controls.end')}
          </Button>
        </>
      ) : (
        <>
          <p>{t('god.controls.ended')}</p>
          <Button asChild>
            <Link to={`/aar/${sid}`}>{t('aar.openReview')}</Link>
          </Button>
        </>
      )}
    </section>
  );
}

const FEED_TYPES = [
  'MESSAGE_OUTCOME',
  'INJECT_FIRED',
  'SPOOF_INJECTED',
  'JAMMING_CHANGED',
  'DECISION_MADE',
  'INPUT_REJECTED',
  'MSEL_CHANGED',
  'GPS_SPOOF_STARTED',
  'GPS_SPOOF_ENDED',
  'C2_COMPROMISED',
  'C2_COMPROMISE_DETECTED',
  'C2_COMPROMISE_ENDED',
  'SPOOFED_UAV_ACTED',
  'PROBE_STARTED',
  'PROBE_SCORED',
];

function summarise(t: TFunction, e: TruthEventDto): string {
  const p = e.payload;
  switch (e.type) {
    case 'MESSAGE_OUTCOME':
      return t('god.events.message', {
        kind: String(p['kind']),
        channel: String(p['channel']),
        outcome: t(`god.outcome.${String(p['outcome'])}` as 'god.outcome.DELIVERED', {
          defaultValue: String(p['outcome']),
        }),
        quality: Number(p['quality']).toFixed(2),
        los: p['los'] ? t('god.events.yes') : t('god.events.no'),
      });
    case 'INJECT_FIRED':
      return String(p['title']);
    case 'SPOOF_INJECTED':
      return t('god.events.spoof', { text: String(p['text']) });
    case 'JAMMING_CHANGED':
      return t('god.events.jamming');
    case 'DECISION_MADE':
      return t('god.events.decision', {
        action: String(p['actionType']),
        confidence: Number(p['confidence']),
      });
    case 'INPUT_REJECTED':
      return t('god.events.rejected', { reason: String(p['reason']) });
    case 'GPS_SPOOF_STARTED':
      return t('god.events.gpsStarted', {
        unit: String(p['unitId']),
        offset: Math.round(Number(p['offsetM'])),
      });
    case 'GPS_SPOOF_ENDED':
      return t('god.events.gpsEnded', { unit: String(p['unitId']) });
    case 'C2_COMPROMISED':
      return t('god.events.c2Started', { unit: String(p['unitId']) });
    case 'C2_COMPROMISE_DETECTED':
      return t('god.events.c2Detected', {
        seconds: Number(p['afterTicks']),
        channel: String(p['via']),
      });
    case 'C2_COMPROMISE_ENDED':
      return t('god.events.c2Ended', { seconds: Number(p['afterTicks']) });
    case 'SPOOFED_UAV_ACTED':
      return t('god.events.uavActed', { contact: String(p['reportId']) });
    case 'PROBE_STARTED':
      return t('god.events.probeStarted');
    case 'PROBE_SCORED':
      return t('god.events.probeScored', { score: Math.round(Number(p['score'])) });
    default:
      return t('god.events.msel', { change: String(p['change']) });
  }
}

function EventFeed({ events }: { events: readonly TruthEventDto[] }) {
  const { t } = useTranslation();
  const recent = events
    .filter((e) => FEED_TYPES.includes(e.type))
    .slice(-14)
    .reverse();
  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('god.events.title')}
    >
      <h2 className="mb-2 font-semibold">{t('god.events.title')}</h2>
      {recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('god.events.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1 font-mono text-xs">
          {recent.map((e, i) => (
            <li key={`${e.tick}-${e.type}-${i}`}>
              {clock(e.tick)} {summarise(t, e)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
