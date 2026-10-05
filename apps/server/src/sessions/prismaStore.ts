import { Prisma, type PrismaClient } from '@prisma/client';
import { paceDefaultsSchema, speedSchema } from '@vyuha/shared';
import { z } from 'zod';
import {
  CodeTakenError,
  type PlayerRow,
  type SessionRow,
  type SessionStore,
  type StoredDecision,
  type TeamRow,
} from './store';

const payloadSchema = z.record(z.string(), z.unknown());
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

type SessionWithScenario = Prisma.SessionGetPayload<{
  include: { scenario: { select: { title: true } } };
}>;
type PlayerWithUser = Prisma.PlayerGetPayload<{
  include: { user: { select: { name: true; isDemoBot: true } } };
}>;

/** Stored in Session.degradationProfile; sessions created before baselines existed hold `{}`. */
const profileSchema = z
  .object({
    clean: z.boolean().catch(false).default(false),
    baselineOfId: z.string().nullable().catch(null).default(null),
  })
  .catch({ clean: false, baselineOfId: null });

const sessionRow = (s: SessionWithScenario): SessionRow => ({
  id: s.id,
  code: s.code,
  scenarioId: s.scenarioId,
  scenarioTitle: s.scenario.title,
  status: s.status,
  speed: speedSchema.catch(1).parse(s.speed),
  currentTick: s.currentTick,
  startedAt: s.startedAt,
  endedAt: s.endedAt,
  createdAt: s.createdAt,
  ...profileSchema.parse(s.degradationProfile),
});

const teamRow = (t: {
  id: string;
  sessionId: string;
  name: string;
  pacePlan: unknown;
}): TeamRow => ({
  id: t.id,
  sessionId: t.sessionId,
  name: t.name,
  pace: paceDefaultsSchema.parse(t.pacePlan),
});

const playerRow = (p: PlayerWithUser): PlayerRow => ({
  id: p.id,
  sessionId: p.sessionId,
  userId: p.userId,
  userName: p.user.name,
  userIsDemoBot: p.user.isDemoBot,
  teamId: p.teamId,
  role: p.role,
  unitId: p.unitId,
});

const withScenario = { scenario: { select: { title: true } } } as const;
const withUser = { user: { select: { name: true, isDemoBot: true } } } as const;

const isCode = (err: unknown, code: string): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;

export function createPrismaSessionStore(prisma: PrismaClient): SessionStore {
  return {
    async createSession(scenarioId, code, profile) {
      try {
        const s = await prisma.session.create({
          data: {
            scenarioId,
            code,
            degradationProfile: profile
              ? { clean: profile.clean, baselineOfId: profile.baselineOfId }
              : {},
          },
          include: withScenario,
        });
        return sessionRow(s);
      } catch (err) {
        if (isCode(err, 'P2002')) throw new CodeTakenError();
        throw err;
      }
    },
    async getSession(id) {
      const s = await prisma.session.findUnique({ where: { id }, include: withScenario });
      return s ? sessionRow(s) : null;
    },
    async getSessionByCode(code) {
      const s = await prisma.session.findUnique({ where: { code }, include: withScenario });
      return s ? sessionRow(s) : null;
    },
    async listSessions() {
      const rows = await prisma.session.findMany({
        orderBy: { createdAt: 'desc' },
        include: { ...withScenario, _count: { select: { players: true } } },
      });
      return rows.map((s) => ({ ...sessionRow(s), playerCount: s._count.players }));
    },
    async listRunnable() {
      const rows = await prisma.session.findMany({
        where: { status: { in: ['RUNNING', 'PAUSED'] } },
        include: withScenario,
      });
      return rows.map(sessionRow);
    },
    async updateSession(id, patch) {
      const s = await prisma.session.update({ where: { id }, data: patch, include: withScenario });
      return sessionRow(s);
    },

    async listTeams(sessionId) {
      const rows = await prisma.team.findMany({ where: { sessionId }, orderBy: { id: 'asc' } });
      return rows.map(teamRow);
    },
    async createTeam(sessionId, name, pace) {
      return teamRow(await prisma.team.create({ data: { sessionId, name, pacePlan: json(pace) } }));
    },
    async updateTeam(teamId, patch) {
      const data: Prisma.TeamUpdateInput = {};
      if (patch.name !== undefined) data.name = patch.name;
      if (patch.pace !== undefined) data.pacePlan = json(patch.pace);
      try {
        return teamRow(await prisma.team.update({ where: { id: teamId }, data }));
      } catch (err) {
        if (isCode(err, 'P2025')) return null;
        throw err;
      }
    },
    async deleteTeam(teamId) {
      await prisma.$transaction([
        prisma.player.updateMany({ where: { teamId }, data: { teamId: null } }),
        prisma.team.deleteMany({ where: { id: teamId } }),
      ]);
    },

    async listPlayers(sessionId) {
      const rows = await prisma.player.findMany({
        where: { sessionId },
        orderBy: { id: 'asc' },
        include: withUser,
      });
      return rows.map(playerRow);
    },
    async addPlayer(sessionId, userId) {
      const p = await prisma.player.upsert({
        where: { sessionId_userId: { sessionId, userId } },
        update: {},
        create: { sessionId, userId },
        include: withUser,
      });
      return playerRow(p);
    },
    async findPlayerByUser(sessionId, userId) {
      const p = await prisma.player.findUnique({
        where: { sessionId_userId: { sessionId, userId } },
        include: withUser,
      });
      return p ? playerRow(p) : null;
    },
    async updatePlayer(playerId, patch) {
      try {
        return playerRow(
          await prisma.player.update({ where: { id: playerId }, data: patch, include: withUser }),
        );
      } catch (err) {
        if (isCode(err, 'P2025')) return null;
        throw err;
      }
    },

    async commitBatch(b) {
      await prisma.$transaction([
        prisma.sessionEvent.createMany({
          data: b.events.map((e) => ({
            sessionId: b.sessionId,
            tick: e.tick,
            type: e.type,
            payload: json(e.payload),
            visibleTo: e.visibleTo,
          })),
        }),
        prisma.decision.createMany({
          data: b.decisions.map((d) => ({
            sessionId: b.sessionId,
            playerId: d.playerId,
            tick: d.tick,
            actionType: d.actionType,
            payload: json(d.payload),
            confidence: d.confidence,
            rationale: d.rationale,
            perceivedSnapshot: json(d.perceivedSnapshot),
            truthSnapshot: json(d.truthSnapshot),
            latencyMs: d.latencyMs,
          })),
        }),
        prisma.reportGrade.createMany({ data: b.grades }),
        prisma.session.update({ where: { id: b.sessionId }, data: { currentTick: b.currentTick } }),
      ]);
    },
    async loadAllEvents(sessionId) {
      const rows = await prisma.sessionEvent.findMany({
        where: { sessionId },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => ({
        tick: r.tick,
        type: r.type,
        payload: payloadSchema.parse(r.payload),
        visibleTo: r.visibleTo,
      }));
    },
    async listDecisions(sessionId): Promise<StoredDecision[]> {
      const rows = await prisma.decision.findMany({
        where: { sessionId },
        orderBy: [{ tick: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => ({
        id: r.id,
        playerId: r.playerId,
        tick: r.tick,
        actionType: r.actionType,
        payload: payloadSchema.parse(r.payload),
        confidence: r.confidence,
        rationale: r.rationale,
        perceivedSnapshot: r.perceivedSnapshot,
        truthSnapshot: r.truthSnapshot,
        latencyMs: r.latencyMs,
      }));
    },
    async saveSessionMetrics(rows) {
      await prisma.$transaction(
        rows.map((r) =>
          prisma.sessionMetric.upsert({
            where: { sessionId_userId: { sessionId: r.sessionId, userId: r.userId } },
            create: r,
            update: r,
          }),
        ),
      );
    },
    async listUserProgress(userId) {
      const rows = await prisma.sessionMetric.findMany({
        where: { userId },
        orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
        include: { session: { select: { code: true, scenario: { select: { title: true } } } } },
      });
      return rows.map((r) => ({
        userId: r.userId,
        sessionId: r.sessionId,
        endedAt: r.endedAt,
        avgDecisionLatencyMs: r.avgDecisionLatencyMs,
        latencyUnderJammingMs: r.latencyUnderJammingMs,
        brierScore: r.brierScore,
        spoofsChallengedPct: r.spoofsChallengedPct,
        reportGradingAccuracy: r.reportGradingAccuracy,
        saScore: r.saScore,
        code: r.session.code,
        scenarioTitle: r.session.scenario.title,
      }));
    },
    async getUserBrief(userId) {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, isDemoBot: true },
      });
      return u;
    },
    async listTrainees() {
      const users = await prisma.user.findMany({
        where: { role: 'TRAINEE' },
        orderBy: [{ isDemoBot: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, isDemoBot: true, _count: { select: { metrics: true } } },
      });
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        isDemoBot: u.isDemoBot,
        sessionCount: u._count.metrics,
      }));
    },
    async loadEvents(sessionId, types) {
      const rows = await prisma.sessionEvent.findMany({
        where: { sessionId, type: { in: types } },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => ({
        tick: r.tick,
        type: r.type,
        payload: payloadSchema.parse(r.payload),
        visibleTo: r.visibleTo,
      }));
    },
  };
}
