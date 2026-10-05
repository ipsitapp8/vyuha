import { useState } from 'react';
import { Clock, ShieldAlert, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  channelSchema,
  type Channel,
  type LobbyView,
  type PerceivedStateDto,
  type PlayerAction,
} from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { clock } from '@/lib/format';
import { ChannelIcon, SignalBars } from './ChannelIcon';
import { computeDegradation, deliveryFlags } from './logic';
import { RadioAudioControls } from './RadioAudioControls';
import type { RadioAudioControls as AudioControls } from './useRadioAudio';

const CHANNELS = channelSchema.options;
type Send = (a: PlayerAction) => Promise<boolean>;
type Message = PerceivedStateDto['inbox'][number];

interface Props {
  perceived: PerceivedStateDto;
  lobby: LobbyView;
  selfId: string | null;
  pending: boolean;
  send: Send;
  /** Radio audio mute and volume; absent where the panel is shown without sound. */
  audio?: AudioControls;
}

export function CommsPanel({ perceived, lobby, selfId, pending, send, audio }: Props) {
  return (
    <div className="flex flex-col gap-6">
      {audio ? <RadioAudioControls {...audio} /> : null}
      <Radio perceived={perceived} pending={pending} send={send} />
      <Compose perceived={perceived} lobby={lobby} selfId={selfId} pending={pending} send={send} />
      <Inbox perceived={perceived} pending={pending} send={send} />
    </div>
  );
}

function Radio({ perceived, pending, send }: Omit<Props, 'lobby' | 'selfId' | 'audio'>) {
  const { t } = useTranslation();
  const active = perceived.comms.activeChannel;
  const [selected, setSelected] = useState<Channel | null>(null);
  const channel = selected ?? active;
  const { jammed } = computeDegradation(perceived);
  const pace = perceived.comms.pace;

  return (
    <section aria-label={t('cockpit.radio.title')}>
      <h2 className="mb-2 font-semibold">{t('cockpit.radio.title')}</h2>
      <ul className="mb-3 flex flex-col gap-1.5 text-sm">
        {CHANNELS.map((c) => {
          const v = perceived.comms.signal[c];
          return (
            <li key={c} className="flex items-center gap-2">
              <ChannelIcon channel={c} />
              <span className="w-24">{t(`channels.${c}`)}</span>
              {v === null ? (
                <span className="text-muted-foreground">{t('cockpit.radio.na')}</span>
              ) : (
                <>
                  <SignalBars
                    value={v}
                    label={t('cockpit.radio.signal', { channel: t(`channels.${c}`) })}
                  />
                  <span className="w-10 text-right">{Math.round(v * 100)}%</span>
                </>
              )}
              {c === active ? (
                <span className="rounded bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                  {t('cockpit.radio.active')}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mb-2 text-sm text-muted-foreground">
        {t('cockpit.radio.pace', {
          p: pace.primary,
          a: pace.alternate,
          c: pace.contingency,
          e: pace.emergency,
        })}
      </p>
      {jammed ? (
        <p role="alert" className="mb-2 text-sm text-red-700">
          {t('cockpit.radio.jammed')}
        </p>
      ) : null}
      {perceived.comms.switchPenaltyActive ? (
        <p className="mb-2 text-sm text-amber-700">{t('cockpit.radio.switchPenalty')}</p>
      ) : null}
      <div className="flex items-end gap-2">
        <Select
          label={t('cockpit.radio.teamChannel')}
          value={channel}
          options={CHANNELS.map((c) => ({ value: c, label: t(`channels.${c}`) }))}
          onChange={(v) => setSelected(v as Channel)}
        />
        <Button
          variant="outline"
          disabled={pending || channel === active}
          onClick={() =>
            void send({ type: 'SWITCH_CHANNEL', channel }).then(() => setSelected(null))
          }
        >
          {t('cockpit.radio.switch')}
        </Button>
      </div>
    </section>
  );
}

function Compose({ perceived, lobby, selfId, pending, send }: Omit<Props, 'audio'>) {
  const { t } = useTranslation();
  const mates = lobby.players.filter((p) => p.id !== selfId && p.teamId !== null);
  const [to, setTo] = useState('');
  const [channelSel, setChannelSel] = useState<Channel | null>(null);
  const [text, setText] = useState('');
  const recipient = to || mates[0]?.id || '';
  const channel = channelSel ?? perceived.comms.activeChannel;

  return (
    <section aria-label={t('cockpit.compose.title')}>
      <h2 className="mb-2 font-semibold">{t('cockpit.compose.title')}</h2>
      {mates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cockpit.compose.nobody')}</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const body = text.trim();
            if (!body || !recipient) return;
            void send({ type: 'SEND_MESSAGE', toPlayerId: recipient, channel, text: body }).then(
              (ok) => {
                if (ok) setText('');
              },
            );
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Select
              label={t('cockpit.compose.to')}
              value={recipient}
              options={mates.map((m) => ({
                value: m.id,
                label: `${m.name}${m.role ? ` (${t(`roles.${m.role}`)})` : ''}`,
              }))}
              onChange={setTo}
            />
            <Select
              label={t('cockpit.compose.channel')}
              value={channel}
              options={CHANNELS.map((c) => ({ value: c, label: t(`channels.${c}`) }))}
              onChange={(v) => setChannelSel(v as Channel)}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('cockpit.compose.message')}
            <textarea
              value={text}
              maxLength={500}
              rows={3}
              onChange={(e) => setText(e.target.value)}
              className="rounded-md border border-border bg-background p-2 text-sm font-normal"
            />
          </label>
          <Button type="submit" disabled={pending || text.trim().length === 0}>
            {t('cockpit.compose.send')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('cockpit.compose.hint')}</p>
        </form>
      )}
    </section>
  );
}

function Inbox({ perceived, pending, send }: Omit<Props, 'lobby' | 'selfId' | 'audio'>) {
  const { t } = useTranslation();
  const messages = [...perceived.inbox].reverse();
  return (
    <section aria-label={t('cockpit.inbox.title', { count: messages.length })}>
      <h2 className="mb-2 font-semibold">{t('cockpit.inbox.title', { count: messages.length })}</h2>
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cockpit.inbox.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              tick={perceived.tick}
              pending={pending}
              send={send}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MessageItem({
  message: m,
  tick,
  pending,
  send,
}: {
  message: Message;
  tick: number;
  pending: boolean;
  send: Send;
}) {
  const { t } = useTranslation();
  const flags = deliveryFlags(m);
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <ChannelIcon channel={m.channel} className="h-3.5 w-3.5" />
        {t('cockpit.inbox.meta', {
          from: m.from,
          channel: t(`channels.${m.channel}`),
          sent: clock(m.sentTick),
          received: clock(m.receivedTick),
        })}
        {flags.delayedBy !== null ? (
          <span
            className="inline-flex items-center gap-1 text-amber-700"
            title={t('cockpit.inbox.delayed', { n: flags.delayedBy })}
          >
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{t('cockpit.inbox.delayed', { n: flags.delayedBy })}</span>
          </span>
        ) : null}
        {flags.garbled ? (
          <span
            className="inline-flex items-center gap-1 text-red-700"
            title={t('cockpit.inbox.garbled')}
          >
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">{t('cockpit.inbox.garbled')}</span>
          </span>
        ) : null}
      </p>
      <p className="mt-1">{m.text}</p>
      {m.requiresAuth ? (
        <OrderStatus message={m} tick={tick} pending={pending} send={send} />
      ) : null}
    </li>
  );
}

export function OrderStatus({
  message: m,
  tick,
  pending,
  send,
}: {
  message: Message;
  tick: number;
  pending: boolean;
  send: Send;
}) {
  const { t } = useTranslation();
  const left = m.authResolvesAtTick !== null ? Math.max(0, m.authResolvesAtTick - tick) : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      {m.authState === 'NONE' ? (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void send({ type: 'AUTHENTICATE', messageId: m.id })}
        >
          {t('cockpit.orders.authenticate')}
        </Button>
      ) : null}
      <span
        className={
          m.authState === 'FAILED'
            ? 'inline-flex items-center gap-1 font-semibold text-red-700'
            : m.authState === 'VERIFIED'
              ? 'inline-flex items-center gap-1 font-semibold text-primary'
              : 'inline-flex items-center gap-1 text-amber-700'
        }
      >
        {m.authState === 'FAILED' ? <ShieldX className="h-4 w-4" aria-hidden="true" /> : null}
        {m.authState === 'VERIFIED' ? <ShieldCheck className="h-4 w-4" aria-hidden="true" /> : null}
        {m.authState === 'NONE' || m.authState === 'PENDING' ? (
          <ShieldAlert className="h-4 w-4" aria-hidden="true" />
        ) : null}
        {m.authState === 'NONE' && t('cockpit.orders.unverified')}
        {m.authState === 'PENDING' &&
          (left === null
            ? t('cockpit.orders.pendingUnknown')
            : t('cockpit.orders.pending', { n: left }))}
        {m.authState === 'VERIFIED' && t('cockpit.orders.verified')}
        {m.authState === 'FAILED' && t('cockpit.orders.failed')}
      </span>
    </div>
  );
}
