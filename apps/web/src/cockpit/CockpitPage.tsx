import { useCallback, useState } from 'react';
import { scenarioTitle } from '@/lib/scenarioText';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { EventDto, LobbyView, PerceivedStateDto, PlayerAction } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { clock } from '@/lib/format';
import { ackErrorText, reasonText } from '@/lib/messages';
import { useSessionSocket, type SessionLive } from '@/lib/useSessionSocket';
import { AlertStack } from './AlertStack';
import { CommsPanel } from './CommsPanel';
import { DecisionDialog } from './DecisionDialog';
import { LobbyPanel } from './LobbyPanel';
import { computeDegradation, orderAlerts } from './logic';
import { MapStage } from './MapStage';
import { MySaScores } from './MySaScores';
import {
  blankPicture,
  draftMarkers,
  emptyDraft,
  placePoint,
  toAnswer,
  type ProbeDraft,
} from './probe';
import { ProbePanel } from './ProbePanel';
import { ReportsPanel } from './ReportsPanel';
import { useRadioAudio } from './useRadioAudio';

const NOTICE_TYPES = [
  'INPUT_REJECTED',
  'AUTH_RESOLVED',
  'CHANNEL_SWITCHED',
  'UNIT_ARRIVED',
  'ISR_REQUESTED',
  'UNIT_MOVE_ORDERED',
  'C2_COMPROMISE_DETECTED',
] as const;

function noticeText(t: TFunction, e: EventDto): string {
  const p = e.payload;
  switch (e.type) {
    case 'INPUT_REJECTED':
      return t('cockpit.notices.rejected', { reason: reasonText(t, String(p['reason'])) });
    case 'AUTH_RESOLVED':
      return t('cockpit.notices.authResolved', {
        result:
          p['result'] === 'VERIFIED' ? t('cockpit.orders.verified') : t('cockpit.orders.failed'),
      });
    case 'CHANNEL_SWITCHED': {
      const to = String(p['to']);
      return t('cockpit.notices.channelSwitched', {
        channel: t(`channels.${to}` as 'channels.VHF', { defaultValue: to }),
      });
    }
    case 'UNIT_ARRIVED':
      return t('cockpit.notices.arrived');
    case 'ISR_REQUESTED':
      return t('cockpit.notices.isr');
    case 'C2_COMPROMISE_DETECTED':
      return t('cockpit.notices.c2Detected');
    default:
      return t('cockpit.notices.moveOrdered');
  }
}

/** /session/:code: the lobby before the exercise, the trainee cockpit while it runs. */
export function CockpitPage() {
  const { code = '' } = useParams();
  const { t } = useTranslation();
  const live = useSessionSocket(code.toUpperCase());
  const status = live.status?.status ?? live.lobby?.session.status ?? null;
  const running = (status === 'RUNNING' || status === 'PAUSED') && live.lobby && live.perceived;

  if (running && live.lobby && live.perceived) {
    return (
      <Cockpit
        live={live}
        lobby={live.lobby}
        perceived={live.perceived}
        paused={status === 'PAUSED'}
      />
    );
  }

  return (
    <>
      <AppHeader compact />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link to="/trainee" className="text-sm text-primary underline">
          {t('cockpit.backHome')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {live.lobby ? scenarioTitle(t, live.lobby.session.scenarioTitle) : t('cockpit.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('cockpit.code')} <span className="font-mono">{code.toUpperCase()}</span> ·{' '}
          {t(`cockpit.connection.${live.connection}`)}
          {status ? ` · ${t(`cockpit.status.${status}`)}` : ''}
        </p>
        {live.error ? (
          <p role="alert" className="mt-3 text-red-700">
            {live.error}
          </p>
        ) : null}
        {live.connection === 'connecting' ? (
          <p role="status" className="mt-4">
            {t('cockpit.connecting')}
          </p>
        ) : null}
        {live.lobby && status === 'LOBBY' ? (
          <LobbyPanel lobby={live.lobby} playerId={live.playerId} />
        ) : null}
        {(status === 'RUNNING' || status === 'PAUSED') &&
        !live.perceived &&
        live.connection === 'connected' ? (
          <p role="status" className="mt-4">
            {t('cockpit.waitingFirst')}
          </p>
        ) : null}
        {status === 'ENDED' ? (
          <>
            <p className="mt-4 rounded-lg border border-border bg-secondary p-4">
              {t('cockpit.ended')}
            </p>
            {live.lobby && live.playerId ? <MySaScores sessionId={live.lobby.session.id} /> : null}
          </>
        ) : null}
      </main>
    </>
  );
}

type TabId = 'comms' | 'reports';

function Cockpit({
  live,
  lobby,
  perceived,
  paused,
}: {
  live: SessionLive;
  lobby: LobbyView;
  perceived: PerceivedStateDto;
  paused: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { act } = live;
  const audio = useRadioAudio(perceived, i18n.language);
  const [tab, setTab] = useState<TabId>('comms');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ contactId: string | null; nonce: number } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [recordedAt, setRecordedAt] = useState<number | null>(null);

  const send = useCallback(
    async (action: PlayerAction): Promise<boolean> => {
      setPendingCount((n) => n + 1);
      setFeedback(null);
      const ack = await act(action);
      setPendingCount((n) => n - 1);
      if (!ack.ok) setFeedback(ackErrorText(t, ack.error));
      else if (action.type === 'DECISION') setRecordedAt(Date.now());
      return ack.ok;
    },
    [act, t],
  );

  // ---- situation-awareness probe (SAGAT): answered from memory while the exercise is frozen ----
  const probe = perceived.probe;
  const [draftState, setDraftState] = useState<{ id: string; draft: ProbeDraft } | null>(null);
  const [submittedProbes, setSubmittedProbes] = useState<string[]>([]);
  const [sendingProbe, setSendingProbe] = useState(false);
  const draft = probe && draftState?.id === probe.id ? draftState.draft : emptyDraft();
  const probeSubmitted = probe !== null && submittedProbes.includes(probe.id);
  const answering = probe !== null && !probeSubmitted;
  const setDraft = (next: ProbeDraft): void => {
    if (probe) setDraftState({ id: probe.id, draft: next });
  };
  const submitProbe = async (): Promise<void> => {
    if (!probe) return;
    setSendingProbe(true);
    const ok = await send(toAnswer(probe.id, draft));
    setSendingProbe(false);
    if (ok) setSubmittedProbes((list) => [...list, probe.id]);
  };
  const mateNames = Object.fromEntries(perceived.friendlies.map((f) => [f.unitId, f.name]));
  const probeHint = !answering
    ? ''
    : draft.target.kind === 'contact'
      ? t('cockpit.probe.hintContact')
      : t('cockpit.probe.hintTeammate', { name: mateNames[draft.target.unitId] ?? '' });

  const degradation = computeDegradation(perceived);
  // When the data-link is lost, the shared picture (teammates + contacts) freezes at the last good state.
  const [lastGood, setLastGood] = useState<PerceivedStateDto | null>(null);
  if (!degradation.datalinkLost && lastGood !== perceived) setLastGood(perceived);
  const picture = degradation.datalinkLost ? (lastGood ?? perceived) : perceived;

  const blocked = paused || pendingCount > 0;
  const notices = live.playerEvents
    .filter((e) => (NOTICE_TYPES as readonly string[]).includes(e.type))
    .slice(-4)
    .reverse();

  const openDecision = (contactId: string | null): void =>
    setDialog({ contactId, nonce: (dialog?.nonce ?? 0) + 1 });

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader compact />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-sm">
        <p className="font-semibold">
          {perceived.self.name} · {t(`roles.${perceived.role}`)}
          <span className="font-normal text-muted-foreground">
            {' '}
            · {t('cockpit.strength')} {perceived.self.strength}%
          </span>
        </p>
        <p className="text-muted-foreground">
          {scenarioTitle(t, lobby.session.scenarioTitle)} · {t('cockpit.code')}{' '}
          <span className="font-mono">{lobby.session.code}</span> ·{' '}
          {t(`cockpit.connection.${live.connection}`)}
        </p>
        <p className="font-mono text-lg" role="timer" aria-label={t('cockpit.exerciseTime')}>
          {clock(perceived.tick)}
        </p>
      </div>
      {paused || answering ? (
        <p
          role="status"
          className="bg-amber-500 px-4 py-1 text-center text-sm font-bold text-black"
        >
          {probe ? t('cockpit.probe.banner') : t('cockpit.paused')}
        </p>
      ) : null}
      {live.error ? (
        <p role="alert" className="bg-red-50 px-4 py-1 text-sm text-red-800">
          {live.error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative h-[46dvh] shrink-0 lg:h-auto lg:flex-1">
          <MapStage
            bounds={lobby.session.areaBounds}
            scenarioId={lobby.session.scenarioId}
            perceived={perceived}
            picture={probe && (answering || paused) ? blankPicture(picture) : picture}
            degradation={degradation}
            frozen={degradation.datalinkLost && !probe}
            paused={paused}
            probe={
              answering
                ? {
                    markers: draftMarkers(draft, mateNames, (n) =>
                      t('cockpit.probe.contactN', { n }),
                    ),
                    hint: probeHint,
                    onPick: (point) => setDraft(placePoint(draft, point)),
                  }
                : null
            }
            selectedContactId={selectedId}
            onSelectContact={(id) => {
              setSelectedId(id);
              setTab('reports');
            }}
            send={send}
          >
            <AlertStack alerts={orderAlerts(perceived)} pending={blocked} send={send} />
          </MapStage>
        </section>

        <aside className="flex min-h-0 flex-1 flex-col border-t border-border lg:w-[26rem] lg:flex-none lg:border-l lg:border-t-0">
          {probe && (answering || paused) ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {feedback ? (
                <p role="alert" className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-800">
                  {feedback}
                </p>
              ) : null}
              <ProbePanel
                perceived={perceived}
                draft={draft}
                onChange={setDraft}
                submitted={probeSubmitted}
                sending={sendingProbe}
                onSubmit={() => void submitProbe()}
              />
            </div>
          ) : (
            <>
              <div
                role="tablist"
                aria-label={t('cockpit.tabs.label')}
                className="flex border-b border-border"
              >
                {(['comms', 'reports'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`tab-${id}`}
                    aria-selected={tab === id}
                    aria-controls={`panel-${id}`}
                    onClick={() => setTab(id)}
                    className={
                      tab === id
                        ? 'flex-1 border-b-2 border-primary px-3 py-2 text-sm font-semibold'
                        : 'flex-1 px-3 py-2 text-sm text-muted-foreground hover:bg-secondary'
                    }
                  >
                    {t(`cockpit.tabs.${id}`)}
                    {id === 'reports' ? ` (${perceived.contacts.length})` : ''}
                  </button>
                ))}
              </div>

              <div
                role="tabpanel"
                id={`panel-${tab}`}
                aria-labelledby={`tab-${tab}`}
                className="min-h-0 flex-1 overflow-y-auto p-4"
              >
                {feedback ? (
                  <p role="alert" className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-800">
                    {feedback}
                  </p>
                ) : null}
                {notices.length > 0 ? (
                  <ul
                    aria-label={t('cockpit.notices.region')}
                    aria-live="polite"
                    className="mb-3 text-sm text-amber-800"
                  >
                    {notices.map((e, i) => (
                      <li key={`${e.tick}-${e.type}-${i}`}>
                        {clock(e.tick)} {noticeText(t, e)}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {tab === 'comms' ? (
                  <CommsPanel
                    perceived={perceived}
                    lobby={lobby}
                    selfId={live.playerId}
                    pending={blocked}
                    send={send}
                    audio={audio}
                  />
                ) : (
                  <ReportsPanel
                    perceived={perceived}
                    selectedId={selectedId}
                    pending={blocked}
                    send={send}
                    onDecide={(id) => openDecision(id)}
                  />
                )}
              </div>

              <div className="border-t border-border p-3">
                <Button
                  className="w-full"
                  disabled={paused}
                  onClick={() => openDecision(selectedId)}
                >
                  {t('cockpit.decision.open')}
                </Button>
                {recordedAt !== null ? (
                  <p role="status" className="mt-1 text-center text-xs text-primary">
                    {t('cockpit.decision.recorded')}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </aside>
      </div>

      {dialog ? (
        <DecisionDialog
          key={dialog.nonce}
          perceived={perceived}
          initialContactId={dialog.contactId}
          onClose={() => setDialog(null)}
          send={send}
        />
      ) : null}
    </div>
  );
}
