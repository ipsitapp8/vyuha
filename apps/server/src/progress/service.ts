import { computeProgressMetrics, type DecisionRecord } from '@vyuha/engine';
import {
  progressResponseSchema,
  progressTraineesResponseSchema,
  type ProgressResponse,
  type ProgressTraineesResponse,
} from '@vyuha/shared';
import { z } from 'zod';
import { HttpError } from '../errors';
import { startedPayloadSchema, type ManagerLogger } from '../sessions/manager';
import type { SessionMetricRow, SessionStore } from '../sessions/store';

const decisionPayloadSchema = z.object({
  outcome: z
    .union([z.literal(0), z.literal(1)])
    .nullable()
    .catch(null),
  latencyTicks: z.number().nullable().catch(null),
});

/** Turns every ended session into one row of progress numbers per trainee, and serves them back. */
export class ProgressService {
  constructor(
    private readonly store: SessionStore,
    private readonly log: ManagerLogger,
  ) {}

  /**
   * Computes and stores the metrics of an ended session from its event log and decisions.
   * Never throws: a failure here must not stop a session from ending, it is logged instead.
   */
  async recordSession(sessionId: string): Promise<void> {
    try {
      await this.compute(sessionId);
    } catch (err) {
      this.log.error({ err, sessionId }, 'recording session metrics failed');
    }
  }

  private async compute(sessionId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    if (session?.status !== 'ENDED') return;
    // A baseline run has no degradation to perform under: it is for comparison, not for the record.
    if (session.clean) return;
    const [events, stored, playerRows] = await Promise.all([
      this.store.loadAllEvents(sessionId),
      this.store.listDecisions(sessionId),
      this.store.listPlayers(sessionId),
    ]);
    const started = events.find((e) => e.type === 'SESSION_STARTED');
    if (!started) return; // ended from the lobby: nothing was played

    const roster = startedPayloadSchema.parse(started.payload).roster.players;
    const userOf = new Map(playerRows.map((r) => [r.id, r.userId]));
    const records: DecisionRecord[] = stored.map((d) => {
      const extra = decisionPayloadSchema.parse(d.payload);
      return {
        playerId: d.playerId,
        tick: d.tick,
        actionType: d.actionType,
        confidence: d.confidence,
        outcome: extra.outcome,
        latencyTicks: extra.latencyTicks,
      };
    });
    const metrics = computeProgressMetrics(
      events,
      records,
      roster.map((p) => p.id),
    );

    const endedAt = session.endedAt ?? new Date();
    const rows: SessionMetricRow[] = [];
    for (const p of roster) {
      const userId = userOf.get(p.id);
      const m = metrics[p.id];
      if (userId && m) rows.push({ userId, sessionId, endedAt, ...m });
    }
    await this.store.saveSessionMetrics(rows);
  }

  async forUser(userId: string): Promise<ProgressResponse> {
    const user = await this.store.getUserBrief(userId);
    if (!user) throw new HttpError(404, 'NOT_FOUND', 'Trainee not found');
    const rows = await this.store.listUserProgress(userId);
    return progressResponseSchema.parse({
      user,
      sessions: rows.map((r) => ({
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
      })),
    });
  }

  async trainees(): Promise<ProgressTraineesResponse> {
    return progressTraineesResponseSchema.parse({ trainees: await this.store.listTrainees() });
  }
}
