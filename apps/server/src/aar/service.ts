import { analyzeExercise, createTruthState, type AarDecision, type Roster } from '@vyuha/engine';
import {
  aarDecisionDetailSchema,
  aarSummarySchema,
  perceivedStateSchema,
  type AarDecisionDetail,
  type AarSnapshot,
  type AarSummary,
} from '@vyuha/shared';
import { z } from 'zod';
import { HttpError } from '../errors';
import { inputsFromLog, startedPayloadSchema } from '../sessions/manager';
import type { EventRow, SessionStore, StoredDecision } from '../sessions/store';
import { decisionsCsv, fullLogJson } from './exports';
import { renderAarPdf } from './pdf';
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
    const players = p.roster.players.map((r) => ({
      id: r.id,
      name: names.get(r.id) ?? r.id,
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
        areaBounds: p.scenario.areaBounds,
      },
      decisions,
      analysis,
    });

    const initial = createTruthState(p.scenario, p.terrain, p.weather, p.seed, p.roster as Roster);
    return {
      summary,
      events,
      stored,
      replayer: new Replayer(initial, inputsFromLog(events), session.currentTick),
    };
  }

  async summary(sessionId: string): Promise<AarSummary> {
    return (await this.data(sessionId)).summary;
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

  async csv(sessionId: string): Promise<{ filename: string; body: string }> {
    const { summary } = await this.data(sessionId);
    return { filename: `vyuha-decisions-${summary.meta.code}.csv`, body: decisionsCsv(summary) };
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
    return { filename: `vyuha-aar-${summary.meta.code}.pdf`, body: await renderAarPdf(summary) };
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
