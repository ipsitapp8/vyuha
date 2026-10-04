import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
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
    trustProxy: config.TRUST_PROXY,
  });
  const origins = config.CORS_ORIGIN;
  const prefix = config.API_PREFIX;
  await fastify.register(helmet, {
    // The API serves JSON, CSV and PDF downloads; when the web app is served from the same origin the
    // page also needs its own scripts, workers, tiles and the live socket.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'worker-src': ["'self'", 'blob:'],
        // Over plain http (local runs) the default would turn every request into https and break them.
        'upgrade-insecure-requests': config.COOKIE_SECURE ? [] : null,
      },
    },
  });
  await fastify.register(cors, {
    origin: origins,
    credentials: true,
    // @fastify/cors v11 defaults to GET, HEAD and POST only, which makes browsers block the app's
    // PUT, PATCH and DELETE calls (delete team, assign player, save PACE plan, save MSEL).
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
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

  // Socket.IO shares the Fastify HTTP server; sessions fan out through it.
  const io = new SocketServer(fastify.server, {
    cors: { origin: origins, credentials: true },
    maxHttpBufferSize: SOCKET_MAX_BYTES,
  });
  let manager: SessionManager | undefined;

  // Everything the API offers lives in one plugin, so it can sit under a prefix such as /api.
  await fastify.register(
    async (api) => {
      const authLimiter = options.authLimiter ?? new RateLimiter(30, 0.5);
      api.addHook('onRequest', async (request, reply) => {
        const route = request.url.split('?')[0];
        if (
          request.method === 'POST' &&
          (route === `${prefix}/auth/login` || route === `${prefix}/auth/register`)
        ) {
          if (!authLimiter.allow(request.ip)) {
            return sendError(reply, 429, 'RATE_LIMITED', 'Too many attempts, try again shortly');
          }
        }
        return undefined;
      });

      const guards = registerAuth(api, config, deps.users);

      api.get('/health', async (): Promise<HealthResponse> => {
        let dbOk = false;
        try {
          dbOk = await deps.db.ping();
        } catch (err) {
          api.log.warn({ err }, 'database health check failed');
        }
        return { ok: true, db: dbOk };
      });

      api.get(
        '/scenarios',
        { preHandler: guards.requireRole('INSTRUCTOR') },
        async (request, reply) => {
          try {
            const body: ScenarioListResponse = { scenarios: await deps.scenarios.listSummaries() };
            return body;
          } catch (err) {
            request.log.error({ err }, 'list scenarios failed');
            return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not load scenarios');
          }
        },
      );

      registerGeoRoutes(api, deps, guards);
      registerScenarioRoutes(api, deps, guards);

      const lobby = new LobbyService(deps.sessions, deps.scenarios);
      const progress = new ProgressService(deps.sessions, api.log);
      const created = new SessionManager(
        deps.sessions,
        deps.scenarios,
        deps.geo,
        lobby,
        io,
        api.log,
        options.scheduler,
        (sessionId) => progress.recordSession(sessionId),
      );
      manager = created;
      registerSessionRoutes(api, guards, deps.sessions, lobby, created);
      registerAarRoutes(api, guards, new AarService(deps.sessions));
      registerProgressRoutes(api, guards, progress);
      attachSocketHandlers(
        io,
        config,
        deps.users,
        deps.sessions,
        lobby,
        created,
        api.log,
        options.limiter,
      );
    },
    { prefix },
  );
  if (!manager) throw new Error('session manager was not created');
  const sessionManager = manager;
  fastify.addHook('onClose', async () => sessionManager.shutdown());

  if (config.WEB_DIST_DIR !== undefined) await registerWebApp(fastify, config.WEB_DIST_DIR, prefix);

  await fastify.ready();
  return { fastify, io, manager: sessionManager };
}

/**
 * Serves the built web app from the same server, so one address carries the pages, the API and the
 * live socket (no cross-site cookies, no CORS). Unknown page addresses get index.html, because the app
 * does its own routing; unknown API addresses still get a typed 404.
 */
async function registerWebApp(
  fastify: FastifyInstance,
  distDir: string,
  prefix: string,
): Promise<void> {
  const root = path.resolve(distDir);
  if (!existsSync(path.join(root, 'index.html'))) {
    throw new Error(`WEB_DIST_DIR has no index.html: ${root}. Build the web app first.`);
  }
  await fastify.register(fastifyStatic, {
    root,
    // Built files carry a content hash in their name and never change; everything else is checked often.
    setHeaders: (reply, filePath) => {
      reply.header(
        'Cache-Control',
        filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
      );
    },
  });
  fastify.setNotFoundHandler((request, reply) => {
    const url = request.url.split('?')[0] ?? '';
    const isApi = prefix !== '' && (url === prefix || url.startsWith(`${prefix}/`));
    if (request.method === 'GET' && !isApi && !url.startsWith('/socket.io')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return sendError(reply, 404, 'NOT_FOUND', 'Not found');
  });
}
