import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  channelSchema,
  decisionActionSchema,
  type Channel,
  type LobbyView,
  type PerceivedStateDto,
  type PlayerAction,
} from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { PaceEditor } from '@/components/PaceEditor';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api';
import { useSessionSocket, type SessionLive } from '@/lib/useSessionSocket';

const CHANNELS = channelSchema.options;
const ACTIONS = decisionActionSchema.options;
const RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const CREDIBILITY = [1, 2, 3, 4, 5, 6] as const;
const clock = (tick: number): string =>
  `${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick % 60).padStart(2, '0')}`;

export function TraineeSessionPage() {
  const { code = '' } = useParams();
  const live = useSessionSocket(code.toUpperCase());
  const status = live.status?.status ?? live.lobby?.session.status ?? null;

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link to="/trainee" className="text-sm text-primary underline">
          ← Trainee home
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {live.lobby?.session.scenarioTitle ?? 'Exercise'}
        </h1>
        <p className="text-sm text-muted-foreground">
          Code <span className="font-mono">{code.toUpperCase()}</span> ·{' '}
          {live.connection === 'connected' ? 'Connected' : `Connection: ${live.connection}`}
          {status ? ` · ${status}` : ''}
        </p>
        {live.error ? (
          <p role="alert" className="mt-3 text-red-400">
            {live.error}
          </p>
        ) : null}
        {live.connection === 'connecting' ? (
          <p role="status" className="mt-4">
            Connecting to the exercise…
          </p>
        ) : null}

        {live.lobby && status === 'LOBBY' ? <LobbyPanel live={live} lobby={live.lobby} /> : null}
        {(status === 'RUNNING' || status === 'PAUSED') && live.lobby ? (
          live.perceived ? (
            <Running
              live={live}
              perceived={live.perceived}
              lobby={live.lobby}
              paused={status === 'PAUSED'}
            />
          ) : (
            <p role="status" className="mt-4">
              Waiting for your first update…
            </p>
          )
        ) : null}
        {status === 'ENDED' ? (
          <p className="mt-4 rounded-lg border border-border bg-secondary p-4">
            This exercise has ended. Your instructor will share the after action review.
          </p>
        ) : null}
      </main>
    </>
  );
}

function LobbyPanel({ live, lobby }: { live: SessionLive; lobby: LobbyView }) {
  const me = lobby.players.find((p) => p.id === live.playerId);
  const team = lobby.teams.find((t) => t.id === me?.teamId);
  const unit = lobby.units.find((u) => u.id === me?.unitId);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-2 font-semibold">Your assignment</h2>
        {team && me?.role && unit ? (
          <p>
            Team <strong>{team.name}</strong> · Role <strong>{me.role}</strong> · Unit{' '}
            <strong>{unit.name}</strong>
          </p>
        ) : (
          <p className="text-muted-foreground">
            Waiting for the instructor to give you a team, a role and a unit.
          </p>
        )}
      </section>

      {team ? (
        <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
          <h2 className="mb-1 font-semibold">Your team's PACE comms plan</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Primary, Alternate, Contingency, Emergency: the order you fall back through when a
            channel fails.
          </p>
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
                const msg =
                  e instanceof ApiRequestError ? e.message : 'Could not save the PACE plan.';
                setError(msg);
                throw new Error(msg);
              }
            }}
          />
        </section>
      ) : null}

      <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
        <h2 className="mb-2 font-semibold">Who is here ({lobby.players.length})</h2>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {lobby.players.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.id === live.playerId ? ' (you)' : ''}
              <span className="text-muted-foreground">
                {' '}
                · {lobby.teams.find((t) => t.id === p.teamId)?.name ?? 'no team'} ·{' '}
                {p.role ?? 'no role'}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          The exercise begins when your instructor starts it.
        </p>
      </section>
    </>
  );
}

function Running({
  live,
  perceived,
  lobby,
  paused,
}: {
  live: SessionLive;
  perceived: PerceivedStateDto;
  lobby: LobbyView;
  paused: boolean;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const send = async (action: PlayerAction): Promise<boolean> => {
    setPending(true);
    setFeedback(null);
    const ack = await live.act(action);
    setPending(false);
    if (!ack.ok) setFeedback(ack.error.message);
    return ack.ok;
  };

  const recent = live.playerEvents
    .filter((e) =>
      [
        'INPUT_REJECTED',
        'AUTH_RESOLVED',
        'CHANNEL_SWITCHED',
        'UNIT_ARRIVED',
        'ISR_REQUESTED',
      ].includes(e.type),
    )
    .slice(-6)
    .reverse();

  return (
    <>
      <section className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary p-4">
        <div>
          <p className="font-semibold">
            {perceived.self.name} · {perceived.role}
          </p>
          <p className="text-sm text-muted-foreground">
            {perceived.self.position.lat.toFixed(4)}, {perceived.self.position.lon.toFixed(4)} ·
            strength {perceived.self.strength}%
          </p>
        </div>
        <p className="font-mono text-2xl" aria-label="Exercise time">
          {clock(perceived.tick)}
        </p>
        {paused ? (
          <p role="status" className="font-semibold text-amber-400">
            PAUSED
          </p>
        ) : null}
      </section>

      {feedback ? (
        <p role="alert" className="mt-3 text-red-400">
          {feedback}
        </p>
      ) : null}
      {recent.length > 0 ? (
        <ul className="mt-3 text-sm text-amber-300" aria-label="Recent notices">
          {recent.map((e, i) => (
            <li key={`${e.tick}-${e.type}-${i}`}>
              {clock(e.tick)} {notice(e.type, e.payload)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Comms perceived={perceived} send={send} pending={pending || paused} />
        <Compose
          perceived={perceived}
          lobby={lobby}
          selfId={live.playerId}
          send={send}
          pending={pending || paused}
        />
      </div>

      <Contacts perceived={perceived} send={send} pending={pending || paused} />
      <Inbox perceived={perceived} send={send} pending={pending || paused} />
      <Decision perceived={perceived} send={send} pending={pending || paused} />
    </>
  );
}

type Send = (a: PlayerAction) => Promise<boolean>;

function notice(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case 'INPUT_REJECTED':
      return `Refused: ${String(p['reason'])}`;
    case 'AUTH_RESOLVED':
      return `Authentication result: ${String(p['result'])}`;
    case 'CHANNEL_SWITCHED':
      return `Team switched to ${String(p['to'])}`;
    case 'UNIT_ARRIVED':
      return 'A unit reached its destination';
    case 'ISR_REQUESTED':
      return 'ISR tasked';
    default:
      return type;
  }
}

function Comms({
  perceived,
  send,
  pending,
}: {
  perceived: PerceivedStateDto;
  send: Send;
  pending: boolean;
}) {
  const active = perceived.comms.activeChannel;
  const [selected, setSelected] = useState<Channel | null>(null);
  const channel = selected ?? active;
  return (
    <section className="rounded-lg border border-border bg-secondary p-4">
      <h2 className="mb-2 font-semibold">Radio</h2>
      <ul className="mb-3 flex flex-col gap-1 text-sm">
        {CHANNELS.map((c) => {
          const v = perceived.comms.signal[c];
          return (
            <li key={c} className="flex items-center gap-2">
              <span className="w-20">{c}</span>
              {v === null ? (
                <span className="text-muted-foreground">n/a</span>
              ) : (
                <>
                  <progress className="h-2 flex-1" value={v} max={1} aria-label={`${c} signal`} />
                  <span className="w-10 text-right">{Math.round(v * 100)}%</span>
                </>
              )}
              {c === active ? <span className="text-primary">active</span> : null}
            </li>
          );
        })}
      </ul>
      <p className="mb-2 text-sm text-muted-foreground">
        PACE: {perceived.comms.pace.primary} / {perceived.comms.pace.alternate} /{' '}
        {perceived.comms.pace.contingency} / {perceived.comms.pace.emergency}
      </p>
      {perceived.comms.switchPenaltyActive ? (
        <p className="mb-2 text-sm text-amber-400">
          Recently switched: messages are slower for a few seconds.
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <Select
          label="Team channel"
          value={channel}
          options={CHANNELS.map((c) => ({ value: c, label: c }))}
          onChange={(v) => setSelected(v as Channel)}
        />
        <Button
          variant="outline"
          disabled={pending || channel === active}
          onClick={() =>
            void send({ type: 'SWITCH_CHANNEL', channel }).then(() => setSelected(null))
          }
        >
          Switch channel
        </Button>
      </div>
    </section>
  );
}

function Compose({
  perceived,
  lobby,
  selfId,
  send,
  pending,
}: {
  perceived: PerceivedStateDto;
  lobby: LobbyView;
  selfId: string | null;
  send: Send;
  pending: boolean;
}) {
  const mates = lobby.players.filter((p) => p.id !== selfId && p.teamId !== null);
  const [to, setTo] = useState(mates[0]?.id ?? '');
  const [channel, setChannel] = useState<Channel>(perceived.comms.activeChannel);
  const [text, setText] = useState('');
  const recipient = to || mates[0]?.id || '';

  return (
    <section className="rounded-lg border border-border bg-secondary p-4">
      <h2 className="mb-2 font-semibold">Send a message</h2>
      {mates.length === 0 ? (
        <p className="text-sm text-muted-foreground">There is nobody else to message.</p>
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
              label="To"
              value={recipient}
              options={mates.map((m) => ({ value: m.id, label: `${m.name} (${m.role ?? '?'})` }))}
              onChange={setTo}
            />
            <Select
              label="Channel"
              value={channel}
              options={CHANNELS.map((c) => ({ value: c, label: c }))}
              onChange={(v) => setChannel(v as Channel)}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Message
            <textarea
              value={text}
              maxLength={500}
              rows={3}
              onChange={(e) => setText(e.target.value)}
              className="rounded-md border border-border bg-background p-2 text-sm font-normal"
            />
          </label>
          <Button type="submit" disabled={pending || text.trim().length === 0}>
            Send
          </Button>
          <p className="text-xs text-muted-foreground">
            Messages can arrive late, corrupted or not at all. RUNNER is slow but cannot be jammed.
          </p>
        </form>
      )}
    </section>
  );
}

function Contacts({
  perceived,
  send,
  pending,
}: {
  perceived: PerceivedStateDto;
  send: Send;
  pending: boolean;
}) {
  return (
    <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
      <h2 className="mb-2 font-semibold">Contacts ({perceived.contacts.length})</h2>
      {perceived.contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No contacts reported yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th>Type</th>
                <th>Position</th>
                <th>Seen</th>
                <th>Source</th>
                <th>Your grade</th>
              </tr>
            </thead>
            <tbody>
              {perceived.contacts.map((c) => (
                <ContactRow key={c.id} contact={c} send={send} pending={pending} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ContactRow({
  contact,
  send,
  pending,
}: {
  contact: PerceivedStateDto['contacts'][number];
  send: Send;
  pending: boolean;
}) {
  const [rel, setRel] = useState<(typeof RELIABILITY)[number]>(contact.grade?.reliability ?? 'C');
  const [cred, setCred] = useState<(typeof CREDIBILITY)[number]>(contact.grade?.credibility ?? 3);
  return (
    <tr>
      <td>{contact.type}</td>
      <td>
        {contact.position.lat.toFixed(4)}, {contact.position.lon.toFixed(4)}
      </td>
      <td>{contact.ageTicks}s ago</td>
      <td>
        {contact.source}
        {contact.via === 'DIRECT' ? '' : ` via ${contact.via}`}
      </td>
      <td>
        <span className="flex items-center gap-1">
          <Select
            label={`Reliability for ${contact.id}`}
            hideLabel
            value={rel}
            options={RELIABILITY.map((r) => ({ value: r, label: r }))}
            onChange={(v) => setRel(v as (typeof RELIABILITY)[number])}
          />
          <Select
            label={`Credibility for ${contact.id}`}
            hideLabel
            value={String(cred)}
            options={CREDIBILITY.map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => setCred(Number(v) as (typeof CREDIBILITY)[number])}
          />
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              void send({
                type: 'GRADE_REPORT',
                reportId: contact.id,
                reliability: rel,
                credibility: cred,
              })
            }
          >
            {contact.grade
              ? `Regrade (${contact.grade.reliability}${contact.grade.credibility})`
              : 'Grade'}
          </Button>
        </span>
      </td>
    </tr>
  );
}

function Inbox({
  perceived,
  send,
  pending,
}: {
  perceived: PerceivedStateDto;
  send: Send;
  pending: boolean;
}) {
  const messages = [...perceived.inbox].reverse();
  return (
    <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
      <h2 className="mb-2 font-semibold">Inbox ({messages.length})</h2>
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {messages.map((m) => (
            <li key={m.id} className="rounded-md border border-border p-3 text-sm">
              <p className="text-muted-foreground">
                {m.from} via {m.channel} · sent {clock(m.sentTick)} · received{' '}
                {clock(m.receivedTick)} ({m.receivedTick - m.sentTick}s transit)
              </p>
              <p className="mt-1">{m.text}</p>
              {m.requiresAuth ? (
                <div className="mt-2 flex items-center gap-3">
                  {m.authState === 'NONE' ? (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void send({ type: 'AUTHENTICATE', messageId: m.id })}
                    >
                      Authenticate
                    </Button>
                  ) : null}
                  <span
                    className={
                      m.authState === 'FAILED'
                        ? 'font-semibold text-red-400'
                        : m.authState === 'VERIFIED'
                          ? 'font-semibold text-primary'
                          : 'text-amber-400'
                    }
                  >
                    {m.authState === 'NONE' && 'Unverified order'}
                    {m.authState === 'PENDING' && 'Authenticating… (takes about 15 s)'}
                    {m.authState === 'VERIFIED' && 'Verified genuine'}
                    {m.authState === 'FAILED' && 'FAILED: this order is not genuine'}
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Decision({
  perceived,
  send,
  pending,
}: {
  perceived: PerceivedStateDto;
  send: Send;
  pending: boolean;
}) {
  const orders = perceived.inbox.filter((m) => m.requiresAuth);
  const [action, setAction] = useState<(typeof ACTIONS)[number]>('HOLD');
  const [confidence, setConfidence] = useState(60);
  const [rationale, setRationale] = useState('');
  const [contactId, setContactId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [done, setDone] = useState(false);
  const valid = rationale.trim().length >= 10;

  return (
    <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
      <h2 className="mb-2 font-semibold">Record a decision</h2>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void send({
            type: 'DECISION',
            actionType: action,
            confidence,
            rationale: rationale.trim(),
            ...(contactId ? { targetContactId: contactId } : {}),
            ...(messageId ? { basedOnMessageId: messageId } : {}),
          }).then((ok) => {
            setDone(ok);
            if (ok) setRationale('');
          });
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Select
            label="Action"
            value={action}
            options={ACTIONS.map((a) => ({ value: a, label: a.replace('_', ' ') }))}
            onChange={(v) => setAction(v as (typeof ACTIONS)[number])}
          />
          <Select
            label="About contact (optional)"
            value={contactId}
            options={[
              { value: '', label: '— none —' },
              ...perceived.contacts.map((c) => ({
                value: c.id,
                label: `${c.type} (${c.ageTicks}s ago)`,
              })),
            ]}
            onChange={setContactId}
          />
          <Select
            label="Based on order (optional)"
            value={messageId}
            options={[
              { value: '', label: '— none —' },
              ...orders.map((m) => ({
                value: m.id,
                label: `${m.from} @ ${clock(m.receivedTick)}`,
              })),
            ]}
            onChange={setMessageId}
          />
        </div>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Confidence: {confidence}%
          <input
            type="range"
            min={0}
            max={100}
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Rationale (at least 10 characters)
          <textarea
            value={rationale}
            rows={2}
            maxLength={1000}
            onChange={(e) => setRationale(e.target.value)}
            className="rounded-md border border-border bg-background p-2 text-sm font-normal"
          />
        </label>
        <Button type="submit" disabled={pending || !valid}>
          Submit decision
        </Button>
        {done ? (
          <p role="status" className="text-sm text-primary">
            Decision recorded.
          </p>
        ) : null}
      </form>
    </section>
  );
}
