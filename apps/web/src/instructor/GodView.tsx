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
} from '@vyuha/shared';
import { CockpitMap } from '@/cockpit/CockpitMap';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { clock } from '@/lib/format';
import { ackErrorText } from '@/lib/messages';
import type { SessionLive } from '@/lib/useSessionSocket';
import { DegradationPanel } from './DegradationPanel';
import { InjectEditor, type UnitRef } from './InjectEditor';
import { MselTimeline } from './MselTimeline';
import { TraineeCards } from './TraineeCards';
import { TruthMap } from './TruthMap';

const SPEEDS = speedSchema.options.map((o) => o.value);
const QUICK: { type: InjectType; label: 'jam' | 'satcom' | 'spoof' | 'conflict' | 'weather' }[] = [
  { type: 'JAM_CHANNEL', label: 'jam' },
  { type: 'SATCOM_OUTAGE', label: 'satcom' },
  { type: 'SPOOF_ORDER', label: 'spoof' },
  { type: 'CONFLICTING_REPORTS', label: 'conflict' },
  { type: 'WEATHER_CHANGE', label: 'weather' },
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

  const units: UnitRef[] = truth.units.map((u) => ({ id: u.id, name: u.name, side: u.side }));
  const b = lobby.session.areaBounds;
  const anchor = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
  const watched = live.perceived && live.perceived.playerId === watchedId ? live.perceived : null;
  const watchedName = lobby.players.find((p) => p.id === watchedId)?.name ?? '';

  return (
    <div className="mt-6 flex flex-col gap-6">
      <RunControls lobby={lobby} status={status} speed={speed} busy={busy} run={run} />

      {notice ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={notice.kind === 'error' ? 'text-red-400' : 'text-primary'}
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
              truth={truth}
              watched={watched}
              onTilesOffline={() => setTilesOffline(true)}
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
                perceived={watched}
                picture={watched}
                selectedContactId={null}
                onSelectContact={() => undefined}
                pickMode={false}
                onPick={() => undefined}
                onTilesOffline={() => setTilesOffline(true)}
              />
            ) : (
              <p className="flex h-full items-center justify-center p-4 text-center text-muted-foreground">
                {t('god.maps.pick')}
              </p>
            )}
          </div>
        </figure>
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
          <div className="flex flex-wrap gap-2">
            {QUICK.map((q) => (
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

function RunControls({ lobby, status, speed, busy, run }: Omit<Props, 'live'>) {
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
        <p>{t('god.controls.ended')}</p>
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
