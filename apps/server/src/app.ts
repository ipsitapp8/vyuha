import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as SocketServer } from 'socket.io';
import type { HealthResponse } from '@vyuha/shared';
import type { Config } from './config';

export interface DbProbe {
  ping(): Promise<boolean>;
}

export interface App {
  fastify: FastifyInstance;
  io: SocketServer;
}

export async function buildApp(config: Config, db: DbProbe): Promise<App> {
  const fastify = Fastify({ logger: config.NODE_ENV !== 'test' });
  const origins = config.CORS_ORIGIN.split(',');
  await fastify.register(cors, { origin: origins, credentials: true });

  fastify.get('/health', async (): Promise<HealthResponse> => {
    let dbOk = false;
    try {
      dbOk = await db.ping();
    } catch (err) {
      fastify.log.warn({ err }, 'database health check failed');
    }
    return { ok: true, db: dbOk };
  });

  await fastify.ready();
  const io = new SocketServer(fastify.server, { cors: { origin: origins, credentials: true } });

  return { fastify, io };
}
