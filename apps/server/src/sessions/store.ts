import type { PaceDefaults, PlayerRole, SessionStatus, Speed } from '@vyuha/shared';

export interface SessionRow {
  id: string;
  code: string;
  scenarioId: string;
  scenarioTitle: string;
  status: SessionStatus;
  speed: Speed;
  currentTick: number;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

export interface TeamRow {
  id: string;
  sessionId: string;
  name: string;
  pace: PaceDefaults;
}

export interface PlayerRow {
  id: string;
  sessionId: string;
  userId: string;
  userName: string;
  teamId: string | null;
  role: PlayerRole | null;
  unitId: string | null;
}

export interface EventRow {
  tick: number;
  type: string;
  payload: Record<string, unknown>;
  visibleTo: string[];
}

export interface DecisionRow {
  playerId: string;
  tick: number;
  actionType: string;
  payload: Record<string, unknown>;
  confidence: number;
  rationale: string;
  perceivedSnapshot: unknown;
  truthSnapshot: unknown;
  latencyMs: number;
}

export interface GradeRow {
  playerId: string;
  reportId: string;
  gradedReliability: string;
  gradedCredibility: number;
  trueReliability: string;
  trueCredibility: number;
}

export interface BatchCommit {
  sessionId: string;
  currentTick: number;
  events: EventRow[];
  decisions: DecisionRow[];
  grades: GradeRow[];
}

export class CodeTakenError extends Error {
  constructor() {
    super('Session code already in use');
    this.name = 'CodeTakenError';
  }
}

export type SessionPatch = Partial<
  Pick<SessionRow, 'status' | 'speed' | 'currentTick' | 'startedAt' | 'endedAt'>
>;
export type PlayerPatch = Partial<Pick<PlayerRow, 'teamId' | 'role' | 'unitId'>>;

/** Persistence for sessions. Prisma in production, in-memory in unit tests. */
export interface SessionStore {
  createSession(scenarioId: string, code: string): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  getSessionByCode(code: string): Promise<SessionRow | null>;
  listSessions(): Promise<(SessionRow & { playerCount: number })[]>;
  /** Sessions that were RUNNING or PAUSED (used to resume after a restart). */
  listRunnable(): Promise<SessionRow[]>;
  updateSession(id: string, patch: SessionPatch): Promise<SessionRow>;

  listTeams(sessionId: string): Promise<TeamRow[]>;
  createTeam(sessionId: string, name: string, pace: PaceDefaults): Promise<TeamRow>;
  updateTeam(
    teamId: string,
    patch: { name?: string | undefined; pace?: PaceDefaults | undefined },
  ): Promise<TeamRow | null>;
  deleteTeam(teamId: string): Promise<void>;

  listPlayers(sessionId: string): Promise<PlayerRow[]>;
  addPlayer(sessionId: string, userId: string): Promise<PlayerRow>;
  findPlayerByUser(sessionId: string, userId: string): Promise<PlayerRow | null>;
  updatePlayer(playerId: string, patch: PlayerPatch): Promise<PlayerRow | null>;

  /** Atomically persists one batch of ticks: events, decisions, report grades and the session tick. */
  commitBatch(batch: BatchCommit): Promise<void>;
  loadEvents(sessionId: string, types: string[]): Promise<EventRow[]>;
}
