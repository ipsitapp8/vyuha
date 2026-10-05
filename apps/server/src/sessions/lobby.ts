import { randomInt } from 'node:crypto';
import {
  SESSION_CODE_ALPHABET,
  type AssignPlayerBody,
  type CreateTeamBody,
  type LobbyView,
  type PaceDefaults,
  type PublicUser,
  type ScenarioDefinition,
  type UpdateTeamBody,
} from '@vyuha/shared';
import type { Roster } from '@vyuha/engine';
import { HttpError } from '../errors';
import type { ScenarioRepo } from '../repos';
import {
  CodeTakenError,
  type PlayerRow,
  type SessionRow,
  type SessionStore,
  type TeamRow,
  type SessionProfile,
} from './store';

export function generateSessionCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++)
    code += SESSION_CODE_ALPHABET[randomInt(SESSION_CODE_ALPHABET.length)];
  return code;
}

const MAX_TEAMS = 8;

export class LobbyService {
  constructor(
    private readonly store: SessionStore,
    private readonly scenarios: ScenarioRepo,
    private readonly newCode: () => string = generateSessionCode,
  ) {}

  async requireSession(id: string): Promise<SessionRow> {
    const s = await this.store.getSession(id);
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    return s;
  }

  async requireDefinition(scenarioId: string): Promise<ScenarioDefinition> {
    const def = await this.scenarios.getDefinition(scenarioId);
    if (!def) throw new HttpError(404, 'NOT_FOUND', 'Scenario not found');
    return def;
  }

  private requireLobby(session: SessionRow): void {
    if (session.status !== 'LOBBY') {
      throw new HttpError(409, 'SESSION_STATE', 'The exercise has already started');
    }
  }

  async createSession(scenarioId: string, profile?: SessionProfile): Promise<SessionRow> {
    await this.requireDefinition(scenarioId);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.store.createSession(scenarioId, this.newCode(), profile);
      } catch (err) {
        if (!(err instanceof CodeTakenError)) throw err;
      }
    }
    throw new HttpError(500, 'INTERNAL_ERROR', 'Could not allocate a session code');
  }

  /**
   * A baseline twin of a finished exercise: the same scenario (so the same seed and MSEL) with every
   * degradation switched off, and the same teams and PACE plans waiting in its lobby. The trainees
   * join it with its own code, so the review can compare the same person in both runs.
   */
  async createBaseline(source: SessionRow): Promise<SessionRow> {
    if (source.status !== 'ENDED' || !source.startedAt) {
      throw new HttpError(
        409,
        'SESSION_STATE',
        'A baseline can be made once the exercise has been played and ended',
      );
    }
    if (source.clean) {
      throw new HttpError(409, 'CONFLICT', 'This session is already a baseline run');
    }
    const twin = await this.createSession(source.scenarioId, {
      clean: true,
      baselineOfId: source.id,
    });
    for (const team of await this.store.listTeams(source.id)) {
      await this.store.createTeam(twin.id, team.name, team.pace);
    }
    return twin;
  }

  /** Trainee joins by code. Existing players may always re-enter; new ones only during the lobby. */
  async join(code: string, user: PublicUser): Promise<{ session: SessionRow; player: PlayerRow }> {
    const session = await this.store.getSessionByCode(code);
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'No session with that code');
    const existing = await this.store.findPlayerByUser(session.id, user.id);
    if (existing) return { session, player: existing };
    if (session.status !== 'LOBBY') {
      throw new HttpError(409, 'SESSION_STATE', 'That exercise has already started');
    }
    return { session, player: await this.store.addPlayer(session.id, user.id) };
  }

  async view(session: SessionRow): Promise<LobbyView> {
    const [teams, players, def] = await Promise.all([
      this.store.listTeams(session.id),
      this.store.listPlayers(session.id),
      this.requireDefinition(session.scenarioId),
    ]);
    return {
      session: {
        id: session.id,
        code: session.code,
        status: session.status,
        speed: session.speed,
        tick: session.currentTick,
        scenarioId: session.scenarioId,
        scenarioTitle: session.scenarioTitle,
        areaBounds: def.areaBounds,
        createdAt: session.createdAt.toISOString(),
        clean: session.clean,
        baselineOfId: session.baselineOfId,
      },
      teams: teams.map((t) => ({ id: t.id, name: t.name, pace: t.pace })),
      players: players.map((p) => ({
        id: p.id,
        userId: p.userId,
        name: p.userName,
        isDemoBot: p.userIsDemoBot,
        teamId: p.teamId,
        role: p.role,
        unitId: p.unitId,
      })),
      units: def.initialUnits
        .filter((u) => u.side === 'BLUE')
        .map((u) => ({ id: u.id, name: u.name, type: u.type, domain: u.domain })),
    };
  }

  async createTeam(session: SessionRow, body: CreateTeamBody): Promise<TeamRow> {
    this.requireLobby(session);
    const teams = await this.store.listTeams(session.id);
    if (teams.length >= MAX_TEAMS)
      throw new HttpError(409, 'CONFLICT', `At most ${MAX_TEAMS} teams`);
    const def = await this.requireDefinition(session.scenarioId);
    return this.store.createTeam(session.id, body.name, body.pace ?? def.paceDefaults);
  }

  async updateTeam(session: SessionRow, teamId: string, body: UpdateTeamBody): Promise<TeamRow> {
    this.requireLobby(session);
    await this.requireTeam(session, teamId);
    const updated = await this.store.updateTeam(teamId, body);
    if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Team not found');
    return updated;
  }

  async setPace(session: SessionRow, teamId: string, pace: PaceDefaults): Promise<TeamRow> {
    return this.updateTeam(session, teamId, { pace });
  }

  async deleteTeam(session: SessionRow, teamId: string): Promise<void> {
    this.requireLobby(session);
    await this.requireTeam(session, teamId);
    await this.store.deleteTeam(teamId);
  }

  private async requireTeam(session: SessionRow, teamId: string): Promise<TeamRow> {
    const team = (await this.store.listTeams(session.id)).find((t) => t.id === teamId);
    if (!team) throw new HttpError(404, 'NOT_FOUND', 'Team not found');
    return team;
  }

  async assignPlayer(
    session: SessionRow,
    playerId: string,
    body: AssignPlayerBody,
  ): Promise<PlayerRow> {
    this.requireLobby(session);
    const [players, teams, def] = await Promise.all([
      this.store.listPlayers(session.id),
      this.store.listTeams(session.id),
      this.requireDefinition(session.scenarioId),
    ]);
    const player = players.find((p) => p.id === playerId);
    if (!player) throw new HttpError(404, 'NOT_FOUND', 'Player not found');

    const next = {
      teamId: body.teamId === undefined ? player.teamId : body.teamId,
      role: body.role === undefined ? player.role : body.role,
      unitId: body.unitId === undefined ? player.unitId : body.unitId,
    };
    if (next.teamId !== null && !teams.some((t) => t.id === next.teamId)) {
      throw new HttpError(404, 'NOT_FOUND', 'Team not found');
    }
    if (next.unitId !== null) {
      const unit = def.initialUnits.find((u) => u.id === next.unitId);
      if (!unit || unit.side !== 'BLUE') {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'Unit must be a friendly (BLUE) unit of the scenario',
        );
      }
      if (players.some((p) => p.id !== playerId && p.unitId === next.unitId)) {
        throw new HttpError(409, 'CONFLICT', 'That unit is already assigned to another player');
      }
    }
    if (
      next.teamId !== null &&
      next.role !== null &&
      players.some((p) => p.id !== playerId && p.teamId === next.teamId && p.role === next.role)
    ) {
      throw new HttpError(409, 'CONFLICT', 'That role is already taken in this team');
    }
    const updated = await this.store.updatePlayer(playerId, next);
    if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Player not found');
    return updated;
  }

  /** Checks the lobby is playable and builds the engine roster; every problem is listed in the error. */
  async buildRoster(session: SessionRow): Promise<Roster> {
    const [players, teams] = await Promise.all([
      this.store.listPlayers(session.id),
      this.store.listTeams(session.id),
    ]);
    const problems: string[] = [];
    if (players.length === 0) problems.push('No trainees have joined yet.');
    for (const p of players) {
      if (!p.teamId || !p.role || !p.unitId) {
        problems.push(`${p.userName} needs a team, a role and a unit.`);
      }
    }
    const used = teams.filter((t) => players.some((p) => p.teamId === t.id));
    for (const t of used) {
      if (!players.some((p) => p.teamId === t.id && p.role === 'PL_CDR')) {
        problems.push(`Team "${t.name}" needs a platoon commander (PL_CDR).`);
      }
    }
    if (problems.length > 0) throw new HttpError(409, 'CONFLICT', problems.join(' '));

    return {
      teams: used.map((t) => ({ id: t.id, name: t.name, pace: t.pace })),
      players: players.flatMap((p) =>
        p.teamId && p.role && p.unitId
          ? [{ id: p.id, teamId: p.teamId, unitId: p.unitId, role: p.role }]
          : [],
      ),
    };
  }
}
