import { createHash, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import type { Server as SocketServer } from 'socket.io';
import type { Config } from './config';
import { sendError } from './errors';
import type { DbProbe } from './repos';
import type { SessionManager } from './sessions/manager';

/** sha256 both sides so the comparison is constant-time whatever the lengths. */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const gauge = (name: string, help: string, value: number, type = 'gauge'): string =>
  `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${Number.isFinite(value) ? value : 0}\n`;

/**
 * GET /metrics in Prometheus text format, for an operator's scraper. Off unless METRICS_TOKEN is set,
 * and then only with `Authorization: Bearer <METRICS_TOKEN>`. Exposes counts and timings only: no
 * session ids or codes, no user data, no configuration values.
 */
export function registerMetrics(
  app: FastifyInstance,
  config: Config,
  sources: { manager: () => SessionManager; io: SocketServer; db: DbProbe },
): void {
  const token = config.METRICS_TOKEN;
  if (token === undefined) return;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  app.addHook('onClose', async () => loop.disable());

  app.get('/metrics', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!tokenMatches(given, token)) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Metrics need the metrics token');
    }
    let dbUp = 0;
    try {
      dbUp = (await sources.db.ping()) ? 1 : 0;
    } catch {
      dbUp = 0;
    }
    const stats = sources.manager().stats();
    const mem = process.memoryUsage();
    const body =
      gauge('vyuha_up', 'The server process is serving requests.', 1) +
      gauge('vyuha_db_up', 'The database answered a ping (1) or not (0).', dbUp) +
      gauge(
        'vyuha_process_uptime_seconds',
        'Seconds since the process started.',
        process.uptime(),
      ) +
      gauge('vyuha_process_resident_memory_bytes', 'Resident set size.', mem.rss) +
      gauge('vyuha_process_heap_used_bytes', 'V8 heap in use.', mem.heapUsed) +
      gauge(
        'vyuha_event_loop_delay_p99_seconds',
        'Event loop delay, 99th percentile since the process started.',
        loop.percentile(99) / 1e9,
      ) +
      gauge('vyuha_sessions_running', 'Exercises currently ticking.', stats.runningSessions) +
      gauge('vyuha_sessions_paused', 'Exercises loaded but paused.', stats.pausedSessions) +
      gauge(
        'vyuha_tick_lag_max_seconds',
        'How late the latest tick timer fired, worst running exercise.',
        stats.maxTickLagMs / 1000,
      ) +
      gauge(
        'vyuha_ticks_processed_total',
        'Simulation ticks persisted since the process started.',
        stats.ticksProcessed,
        'counter',
      ) +
      gauge(
        'vyuha_socket_connections',
        'Open Socket.IO connections.',
        sources.io.engine.clientsCount,
      );
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(body);
  });
}
