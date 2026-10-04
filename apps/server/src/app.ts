import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { Server as SocketServer } from 'socket.io';
import type { HealthResponse, ScenarioListResponse } from '@vyuha/shared';
import type { Config } from './config';
import { registerAuth } from './auth';
import { sendError } from './errors';
import type { Deps } from './repos';

export type { Deps, DbProbe } from './repos';

export interface App {
  fastify: FastifyInstance;
  io: SocketServer;
}

export async function buildApp(config: Config, deps: Deps): Promise<App> {
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

  const { requireRole } = registerAuth(fastify, config, deps.users);

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

  await fastify.ready();
  const io = new SocketServer(fastify.server, { cors: { origin: origins, credentials: true } });

  return { fastify, io };
}
