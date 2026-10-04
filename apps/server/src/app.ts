import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { Server as SocketServer } from 'socket.io';
import type { HealthResponse, ScenarioListResponse } from '@vyuha/shared';
import type { Config } from './config';
import { registerAarRoutes } from './aar/routes';
import { AarService } from './aar/service';
import { registerAuth } from './auth';
import { registerProgressRoutes } from './progress/routes';
import { ProgressService } from './progress/service';
import { registerScenarioRoutes } from './scenarioRoutes';
import { sendError } from './errors';
import { registerGeoRoutes } from './geo/routes';
import type { Deps } from './repos';
import { LobbyService } from './sessions/lobby';
import { SessionManager, type Scheduler } from './sessions/manager';
import { registerSessionRoutes } from './sessions/routes';
import { RateLimiter, attachSocketHandlers } from './sessions/socket';

export type { Deps, DbProbe } from './repos';

export interface App {
  fastify: FastifyInstance;
  io: SocketServer;
  manager: SessionManager;
}

export interface AppOptions {
  scheduler?: Scheduler;
  limiter?: RateLimiter;
  /** Throttles /auth/login and /auth/register per client address. */
  authLimiter?: RateLimiter;
}

/** Largest accepted JSON body (MSEL imports are the biggest legitimate payload). */
export const BODY_LIMIT_BYTES = 1024 * 1024;
/** Largest accepted socket message; actions and joins are a few hundred bytes. */
export const SOCKET_MAX_BYTES = 64 * 1024;

/** Header values that must never reach the logs. */
export const LOG_REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  '*.headers.cookie',
  '*.headers.authorization',
  'res.headers["set-cookie"]',
];

export async function buildApp(config: Config, deps: Deps, options: AppOptions = {}): Promise<App> {
  const fastify = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : { level: config.LOG_LEVEL, redact: { paths: LOG_REDACT, censor: '[redacted]' } },
    bodyLimit: BODY_LIMIT_BYTES,
  });
  const origins = config.CORS_ORIGIN;
  await fastify.register(helmet, {
    // The API serves JSON, CSV and PDF downloads to a separate web origin.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await fastify.register(cors, { origin: origins, credentials: true });
  await fastify.register(cookie);

  fastify.setErrorHandler((err: { statusCode?: number }, request, reply) => {
    request.log.error({ err }, 'unhandled error');
    if (err.statusCode === 400) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Malformed request');
    }
    if (err.statusCode === 413) {
      return sendError(reply, 413, 'VALIDATION_ERROR', 'Request body is too large');
    }
    return sendError(reply, 500, 'INTERNAL_ERROR', 'Unexpected server error');
  });

  const authLimiter = options.authLimiter ?? new RateLimiter(30, 0.5);
  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (request.method === 'POST' && (path === '/auth/login' || path === '/auth/register')) {
      if (!authLimiter.allow(request.ip)) {
        return sendError(reply, 429, 'RATE_LIMITED', 'Too many attempts, try again shortly');
      }
    }
    return undefined;
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
  const io = new SocketServer(fastify.server, {
    cors: { origin: origins, credentials: true },
    maxHttpBufferSize: SOCKET_MAX_BYTES,
  });
  const lobby = new LobbyService(deps.sessions, deps.scenarios);
  const progress = new ProgressService(deps.sessions, fastify.log);
  const manager = new SessionManager(
    deps.sessions,
    deps.scenarios,
    deps.geo,
    lobby,
    io,
    fastify.log,
    options.scheduler,
    (sessionId) => progress.recordSession(sessionId),
  );
  registerSessionRoutes(fastify, guards, deps.sessions, lobby, manager);
  registerAarRoutes(fastify, guards, new AarService(deps.sessions));
  registerProgressRoutes(fastify, guards, progress);
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
