import { analyzeExercise, createTruthState, type AarDecision, type Roster } from '@vyuha/engine';
import {
  aarCompareSchema,
  aarDecisionDetailSchema,
  aarSummarySchema,
  type AarCompare,
  perceivedStateSchema,
  type AarDecisionDetail,
  type AarSnapshot,
  type AarSummary,
  type MySaScoresResponse,
} from '@vyuha/shared';
import { z } from 'zod';
import { HttpError } from '../errors';
import { inputsFromLog, startedPayloadSchema } from '../sessions/manager';
import type { EventRow, SessionRow, SessionStore, StoredDecision } from '../sessions/store';
import { aarCsv, fullLogJson } from './exports';
import { renderAarPdf, type ProgressByPlayer } from './pdf';
import { Replayer } from './replayer';

const decisionPayloadSchema = z.object({
  targetContactId: z.string().nullable().catch(null),
  basedOnMessageId: z.string().nullable().catch(null),
  outcome: z
    .union([z.literal(0), z.literal(1)])
    .nullable()
    .catch(null),
  latencyTicks: z.number().nullable().catch(null),
  spoofActed: z.boolean().catch(false),
});

interface AarData {
  /** Account of each player, to match the same trainee across a degraded run and its baseline. */
  userOf: Map<string, string>;
  summary: AarSummary;
  events: EventRow[];
  stored: StoredDecision[];
  replayer: Replayer;
}

const CACHE_SIZE = 3;

/**
 * Builds the after action review of an ENDED session purely from its recorded SessionEvent and
 * Decision rows: analysis, replayable snapshots at any tick, and the PDF / JSON / CSV exports.
 */
export class AarService {
  /** Finished exercises never change, so their analysis is kept (a few at a time). */
  private readonly cache = new Map<string, Promise<AarData>>();

  constructor(private readonly store: SessionStore) {}

  private data(sessionId: string): Promise<AarData> {
    const hit = this.cache.get(sessionId);
    if (hit) {
      this.cache.delete(sessionId);
      this.cache.set(sessionId, hit); // most recently used last
      return hit;
    }
    const pending = this.build(sessionId);
    this.cache.set(sessionId, pending);
    pending.catch(() => this.cache.delete(sessionId));
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return pending;
  }

  /** Each trainee's sessions so far (up to and including this one), for the "Progress so far" section. */
  private async progressByPlayer(sessionId: string): Promise<ProgressByPlayer> {
    const [playerRows, session] = await Promise.all([
      this.store.listPlayers(sessionId),
      this.store.getSession(sessionId),
    ]);
    const until = session?.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const out: ProgressByPlayer = {};
    for (const p of playerRows) {
      const rows = (await this.store.listUserProgress(p.userId)).filter(
        (r) => r.endedAt.getTime() <= until,
      );
      out[p.id] = rows.map((r) => ({
        sessionId: r.sessionId,
        code: r.code,
        scenarioTitle: r.scenarioTitle,
        endedAt: r.endedAt.toISOString(),
        metrics: {
          avgDecisionLatencyMs: r.avgDecisionLatencyMs,
          latencyUnderJammingMs: r.latencyUnderJammingMs,
          brierScore: r.brierScore,
          spoofsChallengedPct: r.spoofsChallengedPct,
          reportGradingAccuracy: r.reportGradingAccuracy,
          saScore: r.saScore,
        },
      }));
    }
    return out;
  }

  private async build(sessionId: string): Promise<AarData> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    if (session.status !== 'ENDED') {
      throw new HttpError(
        409,
        'SESSION_STATE',
        'The review is available once the exercise has ended',
      );
    }
    const [events, stored, playerRows] = await Promise.all([
      this.store.loadAllEvents(sessionId),
      this.store.listDecisions(sessionId),
      this.store.listPlayers(sessionId),
    ]);
    const started = events.find((e) => e.type === 'SESSION_STARTED');
    if (!started) throw new HttpError(409, 'SESSION_STATE', 'This session was never started');
    const p = startedPayloadSchema.parse(started.payload);

    const names = new Map(playerRows.map((r) => [r.id, r.userName]));
    const bots = new Map(playerRows.map((r) => [r.id, r.userIsDemoBot]));
    const players = p.roster.players.map((r) => ({
      id: r.id,
      name: names.get(r.id) ?? r.id,
      isDemoBot: bots.get(r.id) ?? false,
      role: r.role,
      teamId: r.teamId,
      unitId: r.unitId,
    }));
    const teams = p.roster.teams.map((t) => ({ id: t.id, name: t.name, primary: t.pace.primary }));
    const decisions: AarDecision[] = stored.map((d) => {
      const extra = decisionPayloadSchema.parse(d.payload);
      return {
        id: d.id,
        playerId: d.playerId,
        tick: d.tick,
        actionType: d.actionType,
        confidence: d.confidence,
        rationale: d.rationale,
        targetContactId: extra.targetContactId,
        basedOnMessageId: extra.basedOnMessageId,
        outcome: extra.outcome,
        latencyTicks: extra.latencyTicks,
        spoofActed: extra.spoofActed,
      };
    });

    const analysis = analyzeExercise({
      durationTicks: session.currentTick,
      players,
      teams,
      events,
      decisions,
    });
    const summary = aarSummarySchema.parse({
      meta: {
        sessionId,
        code: session.code,
        scenarioTitle: session.scenarioTitle,
        status: session.status,
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        durationTicks: session.currentTick,
        teams,
        players,
        scenarioId: session.scenarioId,
        clean: session.clean,
        baselineOfId: session.baselineOfId,
        // filled in per request: a baseline can be created after this analysis was cached
        twin: null,
        areaBounds: p.scenario.areaBounds,
      },
      decisions,
      analysis,
    });

    const initial = createTruthState(p.scenario, p.terrain, p.weather, p.seed, p.roster as Roster, {
      clean: p.clean,
    });
    return {
      userOf: new Map(playerRows.map((r) => [r.id, r.userId])),
      summary,
      events,
      stored,
      replayer: new Replayer(initial, inputsFromLog(events), session.currentTick),
    };
  }

  /** A baseline's source; or, for a degraded run, its newest baseline (an ended one if there is one). */
  private async twinOf(
    session: SessionRow,
  ): Promise<{ sessionId: string; code: string; status: SessionRow['status'] } | null> {
    let twin: SessionRow | null = null;
    if (session.baselineOfId) {
      twin = await this.store.getSession(session.baselineOfId);
    } else {
      const baselines = (await this.store.listSessions())
        .filter((s) => s.baselineOfId === session.id)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      twin = baselines.find((s) => s.status === 'ENDED') ?? baselines[0] ?? null;
    }
    return twin ? { sessionId: twin.id, code: twin.code, status: twin.status } : null;
  }

  /**
   * The degraded exercise beside its clean baseline: decisions, latency and picture drift for both, and
   * the trainees who played both. Works from either session of the pair.
   */
  async compare(sessionId: string): Promise<AarCompare> {
    const here = await this.data(sessionId);
    const twin = (await this.summary(sessionId)).meta.twin;
    if (!twin) {
      throw new HttpError(404, 'NOT_FOUND', 'This exercise has no baseline run to compare with');
    }
    if (twin.status !== 'ENDED') {
      throw new HttpError(409, 'SESSION_STATE', 'The other run of this pair has not ended yet');
    }
    const there = await this.data(twin.sessionId);
    const [degraded, baseline] = here.summary.meta.clean ? [there, here] : [here, there];
    const side = (d: AarData): AarCompare['degraded'] => ({
      sessionId: d.summary.meta.sessionId,
      code: d.summary.meta.code,
      durationTicks: d.summary.meta.durationTicks,
      decisions: d.summary.decisions,
      drift: d.summary.analysis.drift,
      players: d.summary.analysis.players.map((p) => ({
        playerId: p.playerId,
        userId: d.userOf.get(p.playerId) ?? '',
        name: p.name,
        decisionCount: p.decisionCount,
        avgLatencyTicks: p.avgLatencyTicks,
        accuracy: p.accuracy,
        brierScore: p.brierScore,
        meanPositionErrorM: p.drift?.meanPositionErrorM ?? null,
        meanMissed: p.drift?.meanMissed ?? null,
      })),
    });
    const a = side(degraded);
    const b = side(baseline);
    return aarCompareSchema.parse({
      scenarioTitle: degraded.summary.meta.scenarioTitle,
      degraded: a,
      baseline: b,
      trainees: a.players.flatMap((p) => {
        const same = b.players.find((q) => q.userId !== '' && q.userId === p.userId);
        return same
          ? [
              {
                userId: p.userId,
                name: p.name,
                degradedPlayerId: p.playerId,
                baselinePlayerId: same.playerId,
              },
            ]
          : [];
      }),
    });
  }

  async summary(sessionId: string): Promise<AarSummary> {
    const { summary } = await this.data(sessionId);
    const session = await this.store.getSession(sessionId);
    return {
      ...summary,
      meta: { ...summary.meta, twin: session ? await this.twinOf(session) : null },
    };
  }

  /** Ground truth and (optionally) one trainee's perception at any tick, rebuilt by deterministic replay. */
  async snapshot(sessionId: string, tick: number, playerId: string | null): Promise<AarSnapshot> {
    const d = await this.data(sessionId);
    if (playerId && !d.summary.meta.players.some((x) => x.id === playerId)) {
      throw new HttpError(404, 'NOT_FOUND', 'No such trainee in this exercise');
    }
    return d.replayer.snapshot(tick, playerId);
  }

  /** A decision with the snapshots recorded at that moment: what the trainee saw vs what was true. */
  async decisionDetail(sessionId: string, decisionId: string): Promise<AarDecisionDetail> {
    const d = await this.data(sessionId);
    const decision = d.summary.decisions.find((x) => x.id === decisionId);
    const row = d.stored.find((x) => x.id === decisionId);
    if (!decision || !row) throw new HttpError(404, 'NOT_FOUND', 'Decision not found');
    const parsed = aarDecisionDetailSchema.safeParse({
      decision,
      perceived: withDefaults(row.perceivedSnapshot),
      truth: row.truthSnapshot,
    });
    if (!parsed.success)
      throw new HttpError(500, 'INTERNAL_ERROR', 'The recorded snapshots could not be read');
    return parsed.data;
  }

  /**
   * A trainee's own situation-awareness scores, once the exercise has ended. Scores and counts only:
   * the frozen truth (where units really were) stays with the instructor.
   */
  async saScoresForUser(sessionId: string, userId: string): Promise<MySaScoresResponse> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    const player = await this.store.findPlayerByUser(sessionId, userId);
    if (!player) throw new HttpError(403, 'NOT_IN_SESSION', 'You have not joined this session');
    const { summary } = await this.data(sessionId);
    const probes = summary.analysis.probes.flatMap((probe) =>
      probe.results
        .filter((r) => r.playerId === player.id)
        .map((r) => ({
          probeId: probe.probeId,
          tick: probe.tick,
          answered: r.answered,
          score: r.score,
          channelCorrect: r.channelCorrect,
          contactsFound: r.matched.length,
          contactsMissed: r.missedUnitIds.length,
          ghostCount: r.ghostCount,
          avgContactErrorM: r.avgContactErrorM,
          avgTeammateErrorM: r.avgTeammateErrorM,
        })),
    );
    const saScore = summary.analysis.players.find((p) => p.playerId === player.id)?.saScore ?? null;
    return { probes, saScore };
  }

  async csv(sessionId: string): Promise<{ filename: string; body: string }> {
    const { summary } = await this.data(sessionId);
    return { filename: `vyuha-decisions-${summary.meta.code}.csv`, body: aarCsv(summary) };
  }

  async json(sessionId: string): Promise<{ filename: string; body: string }> {
    const { summary, events } = await this.data(sessionId);
    return {
      filename: `vyuha-event-log-${summary.meta.code}.json`,
      body: JSON.stringify(fullLogJson(summary, events)),
    };
  }

  async pdf(sessionId: string): Promise<{ filename: string; body: Buffer }> {
    const { summary } = await this.data(sessionId);
    return {
      filename: `vyuha-aar-${summary.meta.code}.pdf`,
      body: await renderAarPdf(summary, await this.progressByPlayer(sessionId)),
    };
  }
}

/** Snapshots recorded by older builds lack a few fields the current schema requires. */
function withDefaults(raw: unknown): unknown {
  const parsed = perceivedStateSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (raw !== null && typeof raw === 'object' && 'inbox' in raw && Array.isArray(raw.inbox)) {
    return {
      ...raw,
      inbox: raw.inbox.map((m: unknown) =>
        m !== null && typeof m === 'object' && !('authResolvesAtTick' in m)
          ? { ...m, authResolvesAtTick: null }
          : m,
      ),
    };
  }
  return raw;
}
