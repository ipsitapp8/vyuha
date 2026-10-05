import { randomUUID } from 'node:crypto';
import {
  CodeTakenError,
  type BatchCommit,
  type DecisionRow,
  type EventRow,
  type GradeRow,
  type PlayerRow,
  type SessionMetricRow,
  type SessionRow,
  type SessionStore,
  type StoredDecision,
  type TeamRow,
  type TraineeBrief,
  type UserProgressRow,
} from './store';

/** The user accounts a memory store can see (tests keep them in a Map). */
export type MemoryUsers = ReadonlyMap<
  string,
  { id: string; name: string; role: string; isDemoBot?: boolean }
>;

/** In-memory SessionStore with the same semantics as the Prisma one (used by unit tests). */
export function createMemorySessionStore(
  names: (userId: string) => string = (id) => id,
  titles: (scenarioId: string) => string = (id) => id,
  users: () => MemoryUsers = () => new Map(),
): SessionStore & {
  events: Map<string, EventRow[]>;
  decisions: (StoredDecision & { sessionId: string })[];
  grades: GradeRow[];
  metrics: SessionMetricRow[];
  failNextCommit(): void;
} {
  const sessions = new Map<string, SessionRow>();
  const teams = new Map<string, TeamRow>();
  const players = new Map<string, PlayerRow>();
  const events = new Map<string, EventRow[]>();
  const decisions: (StoredDecision & { sessionId: string })[] = [];
  const grades: GradeRow[] = [];
  const metrics: SessionMetricRow[] = [];
  let failCommit = false;

  return {
    events,
    decisions,
    grades,
    metrics,
    failNextCommit: () => {
      failCommit = true;
    },

    async createSession(scenarioId, code, profile) {
      if ([...sessions.values()].some((s) => s.code === code)) throw new CodeTakenError();
      const row: SessionRow = {
        id: randomUUID(),
        code,
        scenarioId,
        scenarioTitle: titles(scenarioId),
        status: 'LOBBY',
        speed: 1,
        currentTick: 0,
        startedAt: null,
        endedAt: null,
        createdAt: new Date(),
        clean: profile?.clean ?? false,
        baselineOfId: profile?.baselineOfId ?? null,
      };
      sessions.set(row.id, row);
      return { ...row };
    },
    async getSession(id) {
      const s = sessions.get(id);
      return s ? { ...s } : null;
    },
    async getSessionByCode(code) {
      const s = [...sessions.values()].find((x) => x.code === code);
      return s ? { ...s } : null;
    },
    async listSessions() {
      return [...sessions.values()].map((s) => ({
        ...s,
        playerCount: [...players.values()].filter((p) => p.sessionId === s.id).length,
      }));
    },
    async listRunnable() {
      return [...sessions.values()]
        .filter((s) => s.status === 'RUNNING' || s.status === 'PAUSED')
        .map((s) => ({ ...s }));
    },
    async updateSession(id, patch) {
      const s = sessions.get(id);
      if (!s) throw new Error('no such session');
      const next = { ...s, ...patch };
      sessions.set(id, next);
      return { ...next };
    },

    async listTeams(sessionId) {
      return [...teams.values()].filter((t) => t.sessionId === sessionId);
    },
    async createTeam(sessionId, name, pace) {
      const t: TeamRow = { id: randomUUID(), sessionId, name, pace };
      teams.set(t.id, t);
      return t;
    },
    async updateTeam(teamId, patch) {
      const t = teams.get(teamId);
      if (!t) return null;
      const next = {
        ...t,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.pace ? { pace: patch.pace } : {}),
      };
      teams.set(teamId, next);
      return next;
    },
    async deleteTeam(teamId) {
      teams.delete(teamId);
      for (const [id, p] of players)
        if (p.teamId === teamId) players.set(id, { ...p, teamId: null });
    },

    async listPlayers(sessionId) {
      return [...players.values()].filter((p) => p.sessionId === sessionId);
    },
    async addPlayer(sessionId, userId) {
      const existing = [...players.values()].find(
        (p) => p.sessionId === sessionId && p.userId === userId,
      );
      if (existing) return existing;
      const p: PlayerRow = {
        id: randomUUID(),
        sessionId,
        userId,
        userName: names(userId),
        userIsDemoBot: users().get(userId)?.isDemoBot ?? false,
        teamId: null,
        role: null,
        unitId: null,
      };
      players.set(p.id, p);
      return p;
    },
    async findPlayerByUser(sessionId, userId) {
      return (
        [...players.values()].find((p) => p.sessionId === sessionId && p.userId === userId) ?? null
      );
    },
    async updatePlayer(playerId, patch) {
      const p = players.get(playerId);
      if (!p) return null;
      const next = { ...p, ...patch };
      players.set(playerId, next);
      return next;
    },

    async commitBatch(b: BatchCommit) {
      if (failCommit) {
        failCommit = false;
        throw new Error('simulated database failure');
      }
      const list = events.get(b.sessionId) ?? [];
      list.push(...b.events);
      events.set(b.sessionId, list);
      decisions.push(
        ...b.decisions.map((d: DecisionRow) => ({
          ...d,
          id: randomUUID(),
          sessionId: b.sessionId,
        })),
      );
      grades.push(...b.grades);
      const s = sessions.get(b.sessionId);
      if (s) sessions.set(b.sessionId, { ...s, currentTick: b.currentTick });
    },
    async loadAllEvents(sessionId) {
      return [...(events.get(sessionId) ?? [])];
    },
    async listDecisions(sessionId) {
      return decisions.filter((d) => d.sessionId === sessionId);
    },
    async saveSessionMetrics(rows) {
      for (const r of rows) {
        const at = metrics.findIndex((m) => m.sessionId === r.sessionId && m.userId === r.userId);
        if (at >= 0) metrics[at] = { ...r };
        else metrics.push({ ...r });
      }
    },
    async listUserProgress(userId): Promise<UserProgressRow[]> {
      return metrics
        .filter((m) => m.userId === userId)
        .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())
        .map((m) => {
          const s = sessions.get(m.sessionId);
          return { ...m, code: s?.code ?? '', scenarioTitle: s?.scenarioTitle ?? '' };
        });
    },
    async getUserBrief(userId): Promise<TraineeBrief | null> {
      const u = users().get(userId);
      return u ? { id: u.id, name: u.name, isDemoBot: u.isDemoBot ?? false } : null;
    },
    async listTrainees() {
      return [...users().values()]
        .filter((u) => u.role === 'TRAINEE')
        .map((u) => ({
          id: u.id,
          name: u.name,
          isDemoBot: u.isDemoBot ?? false,
          sessionCount: metrics.filter((m) => m.userId === u.id).length,
        }));
    },
    async loadEvents(sessionId, types) {
      return (events.get(sessionId) ?? []).filter((e) => types.includes(e.type));
    },
  };
}
