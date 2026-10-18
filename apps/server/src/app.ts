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
import { registerMetrics } from './metrics';
import { registerProgressRoutes } from './progress/routes';
import { ProgressService } from './progress/service';
import { registerScenarioRoutes } from './scenarioRoutes';
import { sendError } from './errors';
import { registerGeoRoutes } from './geo/routes';
import type { Deps } from './repos';
import { SessionAccess } from './sessions/access';
import { LobbyService } from './sessions/lobby';
import { SessionManager, type Scheduler } from './sessions/manager';
import { registerSessionRoutes } from './sessions/routes';
import { RateLimiter, attachSocketHandlers, disconnectUserSockets } from './sessions/socket';

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
  /** Throttles /auth/login per account (email), whatever address the attempts come from. */
  accountLimiter?: RateLimiter;
  /** Server-wide budget for new accounts, independent of addresses (see `registrationBudget`). */
  registrationLimiter?: RateLimiter;
  /** How often idle sockets re-read their account (tests shorten it). */
  socketRevalidateMs?: number;
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

/**
 * Fastify's `trustProxy: true` would take the LEFT-most X-Forwarded-For entry, which the client writes
 * itself, so every request could claim a fresh address and walk past the per-address rate limits. A hop
 * count makes it read only the entry the trusted proxy appended. `true` therefore means one hop.
 */
export function proxyHops(setting: boolean | number): number {
  if (setting === true) return 1;
  return setting === false || setting <= 0 ? 0 : setting;
}

/** Fastify trust function: hop 0 is the socket peer; trust exactly the first `hops` of them. */
function trustFirstHops(hops: number): boolean | ((address: string, hop: number) => boolean) {
  return hops === 0 ? false : (_address, hop) => hop < hops;
}

/**
 * A browser always sends Origin on a WebSocket handshake; it must be one of the allowed origins. A
 * request without Origin is not from a browser page, so no victim's cookie can ride along with it.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

export async function buildApp(config: Config, deps: Deps, options: AppOptions = {}): Promise<App> {
  const fastify = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? false
        : { level: config.LOG_LEVEL, redact: { paths: LOG_REDACT, censor: '[redacted]' } },
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trustFirstHops(proxyHops(config.TRUST_PROXY)),
  });
  const origins = config.CORS_ORIGIN;
  const prefix = config.API_PREFIX;
  await fastify.register(helmet, {
    // The API serves JSON, CSV and PDF downloads; when the web app is served from the same origin the
    // page also needs its own scripts, workers, tiles and the live socket.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // helmet's default HSTS is kept on every response: browsers ignore it over plain http (RFC 6797
    // section 8.1) and honour it once the API is reached over https.
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
    // `cors` only covers HTTP long-polling; a WebSocket upgrade is never subject to CORS, and the browser
    // attaches the SameSite=Lax cookie for any same-site page (another port on localhost, a sibling
    // subdomain). Without this check such a page could open a socket as the signed-in user.
    allowRequest: (req, callback) => {
      callback(null, originAllowed(req.headers.origin, origins));
    },
  });
  let manager: SessionManager | undefined;

  // Everything the API offers lives in one plugin, so it can sit under a prefix such as /api.
  await fastify.register(
    async (api) => {
      const authLimiter = options.authLimiter ?? new RateLimiter(30, 0.5);
      // 20 attempts, then one every 10 s: slows a guessing run spread over many addresses, while a
      // person who mistypes is never held up. (Per account, so it applies to every source address.)
      const accountLimiter = options.accountLimiter ?? new RateLimiter(20, 0.1);
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
      api.addHook('preHandler', async (request, reply) => {
        if (request.method !== 'POST' || request.url.split('?')[0] !== `${prefix}/auth/login`) {
          return undefined;
        }
        const email = (request.body as { email?: unknown } | null)?.email;
        if (typeof email === 'string' && !accountLimiter.allow(email.trim().toLowerCase())) {
          return sendError(reply, 429, 'RATE_LIMITED', 'Too many attempts, try again shortly');
        }
        return undefined;
      });

      // Account creation costs a bcrypt hash and a database row. Besides the per-address limit, a
      // server-wide budget caps it even if addresses are wrongly attributed (proxy misconfigured, many
      // botnet addresses): 50 at once (a class signing up together), then 30 a minute.
      const registrationLimiter = options.registrationLimiter ?? new RateLimiter(50, 0.5);
      // Signing out revokes the user's tokens; their open sockets are dropped at the same moment.
      const guards = registerAuth(api, config, deps.users, {
        onTokensRevoked: (userId) => disconnectUserSockets(io, userId),
        allowRegistration: () => registrationLimiter.allow('registrations'),
      });

      const dbReachable = async (): Promise<boolean> => {
        try {
          return await deps.db.ping();
        } catch (err) {
          api.log.warn({ err }, 'database health check failed');
          return false;
        }
      };

      /** Overview for people: the process answers, and whether the database does. Always 200. */
      api.get('/health', async (): Promise<HealthResponse> => ({
        ok: true,
        db: await dbReachable(),
      }));

      /** Liveness: the process is up and its event loop answers (restart it if this fails). */
      api.get('/health/live', async () => ({ ok: true }));

      /** Readiness: 503 while the database is unreachable, so a load balancer or Compose holds traffic. */
      api.get('/health/ready', async (_request, reply) => {
        const db = await dbReachable();
        const body: HealthResponse = { ok: db, db };
        return reply.status(db ? 200 : 503).send(body);
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
      const access = new SessionAccess(deps.sessions);
      registerSessionRoutes(api, guards, deps.sessions, lobby, created, access, deps.users);
      registerMetrics(api, config, { manager: () => created, io, db: deps.db });
      registerAarRoutes(api, guards, new AarService(deps.sessions), access);
      registerProgressRoutes(api, guards, progress, access);
      attachSocketHandlers(
        io,
        config,
        deps.users,
        deps.sessions,
        lobby,
        created,
        access,
        api.log,
        options.limiter,
        options.socketRevalidateMs,
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
