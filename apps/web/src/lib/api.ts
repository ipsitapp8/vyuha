import type { z } from 'zod';
import {
  aarDecisionDetailSchema,
  aarSnapshotSchema,
  aarSummarySchema,
  apiErrorSchema,
  authResponseSchema,
  ingestJobSchema,
  joinSessionResponseSchema,
  lobbyViewSchema,
  scenarioGeoResponseSchema,
  scenarioDetailSchema,
  scenarioListResponseSchema,
  sessionResponseSchema,
  progressResponseSchema,
  progressTraineesResponseSchema,
  sessionListResponseSchema,
  terrainGridSchema,
  type AarDecisionDetail,
  type AarSnapshot,
  type AarSummary,
  type AssignPlayerBody,
  type IngestJob,
  type Inject,
  type JoinSessionResponse,
  type LobbyView,
  type PaceDefaults,
  type ProgressResponse,
  type ProgressTraineesResponse,
  type LoginBody,
  type PublicUser,
  type RegisterBody,
  type ScenarioGeoResponse,
  type ScenarioDetail,
  type ScenarioSummary,
  type SessionListResponse,
  type TerrainGridDto,
  type Speed,
  mySaScoresResponseSchema,
  type MySaScoresResponse,
  aarCompareSchema,
  type AarCompare,
} from '@vyuha/shared';

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown },
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiRequestError(
      'Cannot reach the VYUHA server. Check that it is running.',
      0,
      'NETWORK',
    );
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) {
      throw new ApiRequestError(parsed.data.error.message, res.status, parsed.data.error.code);
    }
    throw new ApiRequestError(`Request failed (${res.status})`, res.status, 'UNKNOWN');
  }
  return schema.parse(json);
}

export const api = {
  async me(): Promise<PublicUser | null> {
    return (await request('/auth/session', sessionResponseSchema)).user;
  },
  async login(body: LoginBody): Promise<PublicUser> {
    return (await request('/auth/login', authResponseSchema, { method: 'POST', body })).user;
  },
  async register(body: RegisterBody): Promise<PublicUser> {
    return (await request('/auth/register', authResponseSchema, { method: 'POST', body })).user;
  },
  async logout(): Promise<void> {
    const res = await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => null);
    if (!res || !res.ok)
      throw new ApiRequestError('Could not sign out', res?.status ?? 0, 'LOGOUT_FAILED');
  },
  async listScenarios(): Promise<ScenarioSummary[]> {
    return (await request('/scenarios', scenarioListResponseSchema)).scenarios;
  },
  getScenarioGeo(id: string): Promise<ScenarioGeoResponse> {
    return request(`/scenarios/${encodeURIComponent(id)}/geo`, scenarioGeoResponseSchema);
  },
  getProgress(userId: string): Promise<ProgressResponse> {
    return request(`/progress/${encodeURIComponent(userId)}`, progressResponseSchema);
  },
  getProgressTrainees(): Promise<ProgressTraineesResponse> {
    return request('/progress/trainees', progressTraineesResponseSchema);
  },
  getScenarioTerrain(id: string): Promise<TerrainGridDto> {
    return request(`/scenarios/${encodeURIComponent(id)}/terrain`, terrainGridSchema);
  },
  startGeoIngest(id: string): Promise<IngestJob> {
    return request(`/scenarios/${encodeURIComponent(id)}/ingest-geo`, ingestJobSchema, {
      method: 'POST',
    });
  },
  getGeoIngestJob(id: string): Promise<IngestJob> {
    return request(`/scenarios/${encodeURIComponent(id)}/ingest-geo`, ingestJobSchema);
  },

  // ---- sessions ----
  createSession(scenarioId: string): Promise<LobbyView> {
    return request('/sessions', lobbyViewSchema, { method: 'POST', body: { scenarioId } });
  },
  listSessions(): Promise<SessionListResponse['sessions']> {
    return request('/sessions', sessionListResponseSchema).then((r) => r.sessions);
  },
  getLobby(sessionId: string): Promise<LobbyView> {
    return request(`/sessions/${encodeURIComponent(sessionId)}/lobby`, lobbyViewSchema);
  },
  getLobbyByCode(code: string): Promise<LobbyView> {
    return request(`/sessions/code/${encodeURIComponent(code)}/lobby`, lobbyViewSchema);
  },
  joinSession(code: string): Promise<JoinSessionResponse> {
    return request('/sessions/join', joinSessionResponseSchema, { method: 'POST', body: { code } });
  },
  createTeam(sessionId: string, name: string): Promise<LobbyView> {
    return request(`/sessions/${sessionId}/teams`, lobbyViewSchema, {
      method: 'POST',
      body: { name },
    });
  },
  deleteTeam(sessionId: string, teamId: string): Promise<LobbyView> {
    return request(`/sessions/${sessionId}/teams/${teamId}`, lobbyViewSchema, { method: 'DELETE' });
  },
  setPace(sessionId: string, teamId: string, pace: PaceDefaults): Promise<LobbyView> {
    return request(`/sessions/${sessionId}/teams/${teamId}/pace`, lobbyViewSchema, {
      method: 'PATCH',
      body: { pace },
    });
  },
  assignPlayer(sessionId: string, playerId: string, body: AssignPlayerBody): Promise<LobbyView> {
    return request(`/sessions/${sessionId}/players/${playerId}`, lobbyViewSchema, {
      method: 'PUT',
      body,
    });
  },
  sessionControl(
    sessionId: string,
    action: 'start' | 'pause' | 'resume' | 'end' | 'probe',
  ): Promise<LobbyView> {
    return request(`/sessions/${sessionId}/${action}`, lobbyViewSchema, { method: 'POST' });
  },
  setSpeed(sessionId: string, speed: Speed): Promise<LobbyView> {
    return request(`/sessions/${sessionId}/speed`, lobbyViewSchema, {
      method: 'POST',
      body: { speed },
    });
  },
  getScenario(id: string): Promise<ScenarioDetail> {
    return request(`/scenarios/${encodeURIComponent(id)}`, scenarioDetailSchema);
  },
  saveMsel(id: string, msel: Inject[]): Promise<ScenarioDetail> {
    return request(`/scenarios/${encodeURIComponent(id)}/msel`, scenarioDetailSchema, {
      method: 'PUT',
      body: { msel },
    });
  },

  // ---- after action review ----
  getAar(sessionId: string): Promise<AarSummary> {
    return request(`/aar/${encodeURIComponent(sessionId)}`, aarSummarySchema);
  },
  getAarSnapshot(sessionId: string, tick: number, playerId: string | null): Promise<AarSnapshot> {
    const q = new URLSearchParams({ tick: String(Math.max(0, Math.floor(tick))) });
    if (playerId) q.set('playerId', playerId);
    return request(
      `/aar/${encodeURIComponent(sessionId)}/snapshot?${q.toString()}`,
      aarSnapshotSchema,
    );
  },
  getAarDecision(sessionId: string, decisionId: string): Promise<AarDecisionDetail> {
    return request(
      `/aar/${encodeURIComponent(sessionId)}/decisions/${encodeURIComponent(decisionId)}`,
      aarDecisionDetailSchema,
    );
  },
  /** Creates the baseline twin of a finished session: same scenario and seed, no degradation. */
  createBaseline(sessionId: string): Promise<LobbyView> {
    return request(`/sessions/${encodeURIComponent(sessionId)}/baseline`, lobbyViewSchema, {
      method: 'POST',
    });
  },
  getAarCompare(sessionId: string): Promise<AarCompare> {
    return request(`/aar/${encodeURIComponent(sessionId)}/compare`, aarCompareSchema);
  },
  /** A trainee's own situation-awareness scores, available once the exercise has ended. */
  getMySaScores(sessionId: string): Promise<MySaScoresResponse> {
    return request(`/aar/${encodeURIComponent(sessionId)}/my-sa`, mySaScoresResponseSchema);
  },
  /** Plain download link: the auth cookie goes with the navigation, the server answers with an attachment. */
  aarExportUrl(sessionId: string, kind: 'pdf' | 'csv' | 'json'): string {
    return `${API_URL}/aar/${encodeURIComponent(sessionId)}/export.${kind}`;
  },
};
