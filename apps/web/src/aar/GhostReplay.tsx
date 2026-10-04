import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AarDecisionDetail, AarSnapshot, AarSummary } from '@vyuha/shared';
import { CockpitMap } from '@/cockpit/CockpitMap';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { TruthMap } from '@/instructor/TruthMap';
import { api } from '@/lib/api';
import { clock, formatAge, latLonText } from '@/lib/format';
import { apiErrorText } from '@/lib/messages';
import { colorOfPlayer } from './chartData';

const STEP_TICKS = 5;
const FRAME_MS = 500;
const FETCH_DEBOUNCE_MS = 150;

type OutcomeKey = 'correct' | 'wrong' | 'unscored';
const outcomeKey = (o: 0 | 1 | null): OutcomeKey =>
  o === null ? 'unscored' : o === 1 ? 'correct' : 'wrong';
const OUTCOME_COLOR: Record<OutcomeKey, string> = {
  correct: '#22c55e',
  wrong: '#ef4444',
  unscored: '#94a3b8',
};

/**
 * Ghost replay: scrub the finished exercise and see, at any moment, the ground truth beside what the
 * chosen trainee believed. Decision markers open the rationale and the snapshots recorded at that moment.
 */
export function GhostReplay({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const { sessionId, scenarioId, durationTicks, players, areaBounds } = summary.meta;
  const [tick, setTick] = useState(0);
  const [playerId, setPlayerId] = useState(players[0]?.id ?? '');
  const [playing, setPlaying] = useState(false);
  const [snapshot, setSnapshot] = useState<AarSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<
    { id: string; data: AarDecisionDetail } | { id: string; error: string } | null
  >(null);
  const [, setTilesOffline] = useState(false);

  const isPlaying = playing && tick < durationTicks;
  const nameOf = (id: string): string => players.find((p) => p.id === id)?.name ?? id;

  useEffect(() => {
    if (!isPlaying) return;
    const h = setInterval(() => setTick((v) => Math.min(durationTicks, v + STEP_TICKS)), FRAME_MS);
    return () => clearInterval(h);
  }, [isPlaying, durationTicks]);

  // Fetch the replayed moment (debounced while scrubbing).
  useEffect(() => {
    let cancelled = false;
    const h = setTimeout(() => {
      setLoading(true);
      api
        .getAarSnapshot(sessionId, tick, playerId || null)
        .then((s) => {
          if (cancelled) return;
          setSnapshot(s);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(apiErrorText(t, e, t('aar.replay.snapshotFailed')));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [sessionId, tick, playerId, t]);

  // Load the recorded decision (rationale + the two snapshots taken at that moment).
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api
      .getAarDecision(sessionId, selected)
      .then((data) => {
        if (!cancelled) setDetail({ id: selected, data });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setDetail({ id: selected, error: apiErrorText(t, e, t('aar.decision.failed')) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, selected, t]);

  const selectDecision = (id: string): void => {
    const d = summary.decisions.find((x) => x.id === id);
    if (!d) return;
    setPlaying(false);
    setSelected(id);
    setTick(d.tick);
    setPlayerId(d.playerId);
  };

  const watched = snapshot?.perceived ?? null;
  const jam = snapshot
    ? (['VHF', 'HF', 'SATCOM', 'DATALINK'] as const)
        .filter((c) => snapshot.truth.jamming[c] > 0.05)
        .map((c) => `${c} ${Math.round(snapshot.truth.jamming[c] * 100)}%`)
    : [];
  const current = detail && detail.id === selected ? detail : null;

  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('aar.replay.title')}
    >
      <h2 className="font-semibold">{t('aar.replay.title')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('aar.replay.intro')}</p>

      <div className="mb-2 flex flex-wrap items-end gap-3">
        <Select
          label={t('aar.replay.trainee')}
          value={playerId}
          options={players.map((p) => ({ value: p.id, label: p.name }))}
          onChange={setPlayerId}
        />
        <Button
          variant="outline"
          aria-pressed={isPlaying}
          onClick={() => {
            if (!isPlaying && tick >= durationTicks) setTick(0);
            setPlaying(!isPlaying);
          }}
        >
          {isPlaying ? (
            <Pause className="mr-1 h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="mr-1 h-4 w-4" aria-hidden="true" />
          )}
          {isPlaying ? t('aar.replay.pause') : t('aar.replay.play')}
        </Button>
        <p
          className="font-mono text-xl"
          role="timer"
          aria-label={t('aar.replay.time', { time: clock(tick) })}
        >
          {clock(tick)} / {clock(durationTicks)}
        </p>
        {loading ? (
          <span role="status" className="text-sm text-muted-foreground">
            {t('aar.replay.loadingSnapshot')}
          </span>
        ) : null}
      </div>

      <input
        type="range"
        min={0}
        max={durationTicks}
        step={1}
        value={tick}
        aria-label={t('aar.replay.scrubber')}
        aria-valuetext={clock(tick)}
        className="w-full"
        onChange={(e) => {
          setPlaying(false);
          setTick(Number(e.target.value));
        }}
      />

      <div className="relative mb-1 mt-1 h-7" role="group" aria-label={t('aar.replay.markers')}>
        {summary.decisions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('aar.replay.noDecisions')}</p>
        ) : (
          summary.decisions.map((d) => {
            const k = outcomeKey(d.outcome);
            const label = t('aar.replay.marker', {
              time: clock(d.tick),
              name: nameOf(d.playerId),
              action: t(`actions.${d.actionType}` as 'actions.HOLD', {
                defaultValue: d.actionType,
              }),
              outcome: t(`aar.decision.outcomes.${k}`),
            });
            return (
              <button
                key={d.id}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={selected === d.id}
                onClick={() => selectDecision(d.id)}
                className="absolute top-1 h-5 w-3 -translate-x-1/2 rounded-sm border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                style={{
                  left: `${durationTicks === 0 ? 0 : Math.min(100, (d.tick / durationTicks) * 100)}%`,
                  background: OUTCOME_COLOR[k],
                  borderColor: colorOfPlayer(summary, d.playerId),
                  boxShadow: selected === d.id ? '0 0 0 3px #fff' : undefined,
                }}
              />
            );
          })
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('aar.replay.markers')}</p>

      {error ? (
        <p role="alert" className="mb-2 text-red-400">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="flex flex-col gap-1">
          <figcaption className="font-semibold">{t('aar.replay.truthTitle')}</figcaption>
          <div className="h-[40dvh] min-h-64 overflow-hidden rounded-lg border border-border">
            {snapshot ? (
              <TruthMap
                bounds={areaBounds}
                scenarioId={scenarioId}
                truth={snapshot.truth}
                watched={watched}
                onTilesOffline={() => setTilesOffline(true)}
              />
            ) : (
              <p className="flex h-full items-center justify-center text-muted-foreground">
                {t('aar.replay.loadingSnapshot')}
              </p>
            )}
          </div>
        </figure>
        <figure className="flex flex-col gap-1">
          <figcaption className="font-semibold">
            {t('aar.replay.perceivedTitle', { name: nameOf(playerId) })}
          </figcaption>
          <div className="relative h-[40dvh] min-h-64 overflow-hidden rounded-lg border border-border">
            {watched ? (
              <CockpitMap
                bounds={areaBounds}
                scenarioId={scenarioId}
                perceived={watched}
                picture={watched}
                selectedContactId={null}
                onSelectContact={() => undefined}
                pickMode={false}
                onPick={() => undefined}
                onTilesOffline={() => setTilesOffline(true)}
              />
            ) : (
              <p className="flex h-full items-center justify-center text-muted-foreground">
                {t('aar.replay.loadingSnapshot')}
              </p>
            )}
          </div>
        </figure>
      </div>
      {snapshot ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {jam.length > 0 ? t('aar.replay.jamming', { levels: jam.join(', ') }) : null}
          {!snapshot.truth.satcomUp ? ` ${t('aar.replay.satcomDown')}` : ''}
        </p>
      ) : null}

      {selected ? (
        <DecisionPanel
          summary={summary}
          decisionId={selected}
          detail={current}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

function DecisionPanel({
  summary,
  decisionId,
  detail,
  onClose,
}: {
  summary: AarSummary;
  decisionId: string;
  detail: { id: string; data: AarDecisionDetail } | { id: string; error: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const d = summary.decisions.find((x) => x.id === decisionId);
  if (!d) return null;
  const player = summary.meta.players.find((p) => p.id === d.playerId);
  const outcome = outcomeKey(d.outcome);

  return (
    <div
      className="mt-4 rounded-md border border-border bg-background p-3"
      role="region"
      aria-label={t('aar.decision.title')}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold">
          {player?.name} · {clock(d.tick)} ·{' '}
          {t(`actions.${d.actionType}` as 'actions.HOLD', { defaultValue: d.actionType })}
        </h3>
        <Button variant="outline" onClick={onClose}>
          {t('aar.decision.close')}
        </Button>
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t('aar.decision.rationale')}</dt>
        <dd>“{d.rationale}”</dd>
        <dt className="text-muted-foreground">{t('aar.decision.confidence')}</dt>
        <dd>{d.confidence}%</dd>
        <dt className="text-muted-foreground">{t('aar.decision.outcome')}</dt>
        <dd style={{ color: OUTCOME_COLOR[outcome] }}>{t(`aar.decision.outcomes.${outcome}`)}</dd>
        <dt className="text-muted-foreground">{t('aar.decision.latency')}</dt>
        <dd>
          {d.latencyTicks === null
            ? '–'
            : t('god.cards.seconds', { n: Math.round(d.latencyTicks) })}
        </dd>
      </dl>
      {d.spoofActed ? (
        <p className="mt-1 text-sm font-semibold text-red-400">{t('aar.decision.spoof')}</p>
      ) : null}

      {detail === null ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t('aar.decision.loading')}
        </p>
      ) : 'error' in detail ? (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {detail.error}
        </p>
      ) : (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="font-medium">{t('aar.decision.saw')}</h4>
            <p className="text-sm text-muted-foreground">
              {detail.data.perceived.contacts.length === 0
                ? t('aar.decision.noContacts')
                : t('aar.decision.contactsLine', { count: detail.data.perceived.contacts.length })}
            </p>
            <ul className="mt-1 max-h-40 overflow-y-auto text-sm">
              {detail.data.perceived.contacts.map((c) => (
                <li key={c.id}>
                  {t('aar.decision.contactLine', {
                    type: t(`unitTypes.${c.type}` as 'unitTypes.RECCE', { defaultValue: c.type }),
                    age: formatAge(t, c.ageTicks),
                  })}{' '}
                  <span className="text-muted-foreground">({latLonText(c.position)})</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-medium">{t('aar.decision.was')}</h4>
            <p className="text-sm text-muted-foreground">{t('aar.decision.hostiles')}</p>
            <ul className="mt-1 max-h-40 overflow-y-auto text-sm">
              {detail.data.truth.units
                .filter((u) => u.side !== 'BLUE')
                .map((u) => (
                  <li key={u.id}>
                    {t('aar.decision.unitLine', {
                      type: t(`unitTypes.${u.type}` as 'unitTypes.RECCE', { defaultValue: u.type }),
                      lat: u.position.lat.toFixed(4),
                      lon: u.position.lon.toFixed(4),
                      status: u.status,
                    })}
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
