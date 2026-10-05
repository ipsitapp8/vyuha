import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  assignPlayerBodySchema,
  createSessionBodySchema,
  createTeamBodySchema,
  joinSessionBodySchema,
  setSpeedBodySchema,
  updatePaceBodySchema,
  updateTeamBodySchema,
  type JoinSessionResponse,
  type LobbyView,
  type PublicUser,
  type SessionListResponse,
} from '@vyuha/shared';
import type { AuthGuards } from '../auth';
import { HttpError, sendError } from '../errors';
import type { LobbyService } from './lobby';
import type { SessionManager } from './manager';
import type { SessionRow, SessionStore } from './store';

export function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    throw new HttpError(400, 'VALIDATION_ERROR', detail);
  }
  return result.data;
}

type Typed<P> = FastifyRequest<{ Params: P }>;

/**
 * Wraps a handler so every failure becomes a typed error response (never an unhandled rejection).
 * Route params are typed per handler; Fastify validates the path shape itself.
 */
export function guarded<P>(
  fn: (request: Typed<P>, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await fn(request as unknown as Typed<P>, reply);
    } catch (err) {
      if (err instanceof HttpError) return sendError(reply, err.status, err.code, err.message);
      request.log.error({ err }, 'session route failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Unexpected server error');
    }
  };
}

function userOf(request: FastifyRequest): PublicUser {
  if (!request.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return request.user;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  guards: AuthGuards,
  store: SessionStore,
  lobby: LobbyService,
  manager: SessionManager,
): void {
  const instructor = { preHandler: guards.requireRole('INSTRUCTOR') };
  const trainee = { preHandler: guards.requireRole('TRAINEE') };
  const anyUser = { preHandler: guards.requireAuth };

  /** Instructors may see any session; trainees only the sessions they joined. */
  async function assertCanView(user: PublicUser, session: SessionRow): Promise<void> {
    if (user.role === 'INSTRUCTOR') return;
    if (!(await store.findPlayerByUser(session.id, user.id))) {
      throw new HttpError(403, 'NOT_IN_SESSION', 'You have not joined this session');
    }
  }

  /** Responds with the fresh lobby and pushes it to everyone connected to the session. */
  async function respondWithLobby(
    session: SessionRow,
    reply: FastifyReply,
    status = 200,
  ): Promise<LobbyView> {
    const fresh = await lobby.requireSession(session.id);
    const view = await lobby.view(fresh);
    void manager.broadcastLobby(session.id);
    reply.status(status);
    return view;
  }

  type Id = { id: string };
  type TeamParams = { id: string; teamId: string };

  app.post(
    '/sessions',
    instructor,
    guarded<Record<string, never>>(async (request, reply) => {
      const body = parse(createSessionBodySchema, request.body);
      const session = await lobby.createSession(body.scenarioId);
      reply.status(201);
      return lobby.view(session);
    }),
  );

  /** Creates the baseline twin of a finished exercise: same scenario and seed, no degradation. */
  app.post(
    '/sessions/:id/baseline',
    instructor,
    guarded<Id>(async (request, reply) => {
      const source = await lobby.requireSession(request.params.id);
      const twin = await lobby.createBaseline(source);
      reply.status(201);
      return lobby.view(twin);
    }),
  );

  app.get(
    '/sessions',
    instructor,
    guarded<Record<string, never>>(async () => {
      const rows = await store.listSessions();
      const body: SessionListResponse = {
        sessions: rows.map((s) => ({
          id: s.id,
          code: s.code,
          status: s.status,
          scenarioTitle: s.scenarioTitle,
          playerCount: s.playerCount,
          createdAt: s.createdAt.toISOString(),
          clean: s.clean,
          baselineOfId: s.baselineOfId,
        })),
      };
      return body;
    }),
  );

  app.post(
    '/sessions/join',
    trainee,
    guarded<Record<string, never>>(async (request, reply) => {
      const body = parse(joinSessionBodySchema, request.body);
      const { session, player } = await lobby.join(body.code, userOf(request));
      void manager.broadcastLobby(session.id);
      const res: JoinSessionResponse = {
        sessionId: session.id,
        code: session.code,
        playerId: player.id,
      };
      reply.status(200);
      return res;
    }),
  );

  app.get(
    '/sessions/:id/lobby',
    anyUser,
    guarded<Id>(async (request) => {
      const session = await lobby.requireSession(request.params.id);
      await assertCanView(userOf(request), session);
      return lobby.view(session);
    }),
  );

  app.get(
    '/sessions/code/:code/lobby',
    anyUser,
    guarded<{ code: string }>(async (request) => {
      const code = parse(joinSessionBodySchema, { code: request.params.code }).code;
      const session = await store.getSessionByCode(code);
      if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'No session with that code');
      await assertCanView(userOf(request), session);
      return lobby.view(session);
    }),
  );

  app.post(
    '/sessions/:id/teams',
    instructor,
    guarded<Id>(async (request, reply) => {
      const session = await lobby.requireSession(request.params.id);
      await lobby.createTeam(session, parse(createTeamBodySchema, request.body));
      return respondWithLobby(session, reply, 201);
    }),
  );

  app.patch(
    '/sessions/:id/teams/:teamId',
    instructor,
    guarded<TeamParams>(async (request, reply) => {
      const session = await lobby.requireSession(request.params.id);
      await lobby.updateTeam(
        session,
        request.params.teamId,
        parse(updateTeamBodySchema, request.body),
      );
      return respondWithLobby(session, reply);
    }),
  );

  app.delete(
    '/sessions/:id/teams/:teamId',
    instructor,
    guarded<TeamParams>(async (request, reply) => {
      const session = await lobby.requireSession(request.params.id);
      await lobby.deleteTeam(session, request.params.teamId);
      return respondWithLobby(session, reply);
    }),
  );

  /** The team's own members (or the instructor) set its PACE plan in the lobby. */
  app.patch(
    '/sessions/:id/teams/:teamId/pace',
    anyUser,
    guarded<TeamParams>(async (request, reply) => {
      const user = userOf(request);
      const session = await lobby.requireSession(request.params.id);
      if (user.role === 'TRAINEE') {
        const me = await store.findPlayerByUser(session.id, user.id);
        if (!me || me.teamId !== request.params.teamId) {
          throw new HttpError(403, 'FORBIDDEN', "You can only set your own team's PACE plan");
        }
      }
      const { pace } = parse(updatePaceBodySchema, request.body);
      await lobby.setPace(session, request.params.teamId, pace);
      return respondWithLobby(session, reply);
    }),
  );

  app.put(
    '/sessions/:id/players/:playerId',
    instructor,
    guarded<{ id: string; playerId: string }>(async (request, reply) => {
      const session = await lobby.requireSession(request.params.id);
      await lobby.assignPlayer(
        session,
        request.params.playerId,
        parse(assignPlayerBodySchema, request.body),
      );
      return respondWithLobby(session, reply);
    }),
  );

  const control = (name: 'start' | 'pause' | 'resume' | 'end' | 'probe'): void => {
    app.post(
      `/sessions/:id/${name}`,
      instructor,
      guarded<Id>(async (request, reply) => {
        const session = await lobby.requireSession(request.params.id);
        await manager[name](session.id);
        return respondWithLobby(session, reply);
      }),
    );
  };
  control('start');
  control('pause');
  control('resume');
  control('end');
  // Freeze and probe: opens a situation-awareness probe and pauses the exercise.
  control('probe');

  app.post(
    '/sessions/:id/speed',
    instructor,
    guarded<Id>(async (request, reply) => {
      const session = await lobby.requireSession(request.params.id);
      await manager.setSpeed(session.id, parse(setSpeedBodySchema, request.body).speed);
      return respondWithLobby(session, reply);
    }),
  );
}
