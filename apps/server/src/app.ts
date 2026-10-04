import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { Server as SocketServer } from 'socket.io';
import type { HealthResponse, ScenarioListResponse } from '@vyuha/shared';
import type { Config } from './config';
import { registerAuth } from './auth';
import { registerScenarioRoutes } from './scenarioRoutes';
import { sendError } from './errors';
import { registerGeoRoutes } from './geo/routes';
import type { Deps } from './repos';
import { LobbyService } from './sessions/lobby';
import { SessionManager, type Scheduler } from './sessions/manager';
import { registerSessionRoutes } from './sessions/routes';
import type { RateLimiter } from './sessions/socket';
import { attachSocketHandlers } from './sessions/socket';

export type { Deps, DbProbe } from './repos';

export interface App {
  fastify: FastifyInstance;
  io: SocketServer;
  manager: SessionManager;
}

export interface AppOptions {
  scheduler?: Scheduler;
  limiter?: RateLimiter;
}

export async function buildApp(config: Config, deps: Deps, options: AppOptions = {}): Promise<App> {
  const fastify = Fastify({ logger: config.NODE_ENV !== 'test' });
  const origins = config.CORS_ORIGIN.split(',');
  await fastify.register(cors, { origin: origins, credentials: true });
  await fastify.register(cookie);

  fastify.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    request.log.error({ err }, 'unhandled error');
    if (err.statusCode === 400) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Malformed request');
    }
    return sendError(reply, 500, 'INTERNAL_ERROR', 'Unexpected server error');
  });

  const guards = registerAuth(fastify, config, deps.users);
  const { requireRole } = guards;

  fastify.get('/health', async (): Promise<HealthResponse> => {
    let dbOk = false;
    try {
      dbOk = await deps.db.ping();
    } catch (err) {
      fastify.log.warn({ err }, 'database health check failed');
    }
    return { ok: true, db: dbOk };
  });

  fastify.get('/scenarios', { preHandler: requireRole('INSTRUCTOR') }, async (request, reply) => {
    try {
      const body: ScenarioListResponse = { scenarios: await deps.scenarios.listSummaries() };
      return body;
    } catch (err) {
      request.log.error({ err }, 'list scenarios failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not load scenarios');
    }
  });

  registerGeoRoutes(fastify, deps, guards);
  registerScenarioRoutes(fastify, deps, guards);

  // Socket.IO shares the Fastify HTTP server; sessions fan out through it.
  const io = new SocketServer(fastify.server, { cors: { origin: origins, credentials: true } });
  const lobby = new LobbyService(deps.sessions, deps.scenarios);
  const manager = new SessionManager(
    deps.sessions,
    deps.scenarios,
    deps.geo,
    lobby,
    io,
    fastify.log,
    options.scheduler,
  );
  registerSessionRoutes(fastify, guards, deps.sessions, lobby, manager);
  attachSocketHandlers(
    io,
    config,
    deps.users,
    deps.sessions,
    lobby,
    manager,
    fastify.log,
    options.limiter,
  );
  fastify.addHook('onClose', async () => manager.shutdown());

  await fastify.ready();
  return { fastify, io, manager };
}
