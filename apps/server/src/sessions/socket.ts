import type { Server as SocketServer, Socket } from 'socket.io';
import {
  AUTH_COOKIE_NAME,
  SOCKET_EVENTS,
  joinPayloadSchema,
  playerActionSchema,
  type Ack,
  type ApiErrorCode,
  type JoinAck,
  type PublicUser,
} from '@vyuha/shared';
import { authenticateToken } from '../auth';
import type { Config } from '../config';
import { HttpError } from '../errors';
import type { UserRepo } from '../repos';
import type { LobbyService } from './lobby';
import { room, type ManagerLogger, type SessionManager } from './manager';
import type { SessionStore } from './store';

/** Token bucket: `capacity` burst, refilled at `refillPerSec`. Time is injected for testability. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }
}

interface SocketData {
  user: PublicUser;
  sessionId?: string;
  playerId?: string;
}

const data = (socket: Socket): SocketData => socket.data as SocketData;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function toError(err: unknown, log: ManagerLogger): { code: ApiErrorCode; message: string } {
  if (err instanceof HttpError) return { code: err.code, message: err.message };
  log.error({ err }, 'socket handler failed');
  return { code: 'INTERNAL_ERROR', message: 'Unexpected server error' };
}

const reply = (ack: unknown, body: Ack | JoinAck): void => {
  if (typeof ack === 'function') ack(body);
};

export function attachSocketHandlers(
  io: SocketServer,
  config: Config,
  users: UserRepo,
  store: SessionStore,
  lobby: LobbyService,
  manager: SessionManager,
  log: ManagerLogger,
  limiter: RateLimiter = new RateLimiter(20, 5),
): void {
  // Every socket must carry the same httpOnly auth cookie the REST API uses.
  io.use((socket, next) => {
    authenticateToken(readCookie(socket.handshake.headers.cookie, AUTH_COOKIE_NAME), config, users)
      .then((user) => {
        if (!user) return next(new Error('UNAUTHENTICATED'));
        socket.data = { user } satisfies SocketData;
        next();
      })
      .catch(() => next(new Error('INTERNAL_ERROR')));
  });

  io.on('connection', (socket) => {
    const fail = (ack: unknown, err: unknown): void => {
      const error = toError(err, log);
      reply(ack, { ok: false, error });
      socket.emit(SOCKET_EVENTS.error, error);
    };

    /** Joins the session's rooms and immediately sends the current lobby, status and picture. */
    socket.on(SOCKET_EVENTS.join, async (raw: unknown, ack: unknown) => {
      try {
        const user = data(socket).user;
        if (!limiter.allow(`join:${user.id}`))
          throw new HttpError(429, 'RATE_LIMITED', 'Slow down');
        const parsed = joinPayloadSchema.safeParse(raw);
        if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid session code');
        const session = await store.getSessionByCode(parsed.data.code);
        if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'No session with that code');

        let playerId: string | null = null;
        if (user.role === 'TRAINEE') {
          const player = await store.findPlayerByUser(session.id, user.id);
          if (!player)
            throw new HttpError(403, 'NOT_IN_SESSION', 'You have not joined this session');
          playerId = player.id;
        }

        for (const r of socket.rooms) if (r.startsWith('session:')) await socket.leave(r);
        await socket.join(room.session(session.id));
        data(socket).sessionId = session.id;
        if (playerId) {
          await socket.join(room.player(session.id, playerId));
          data(socket).playerId = playerId;
        } else {
          await socket.join(room.instructor(session.id));
        }
        reply(ack, { ok: true, role: user.role, playerId });

        socket.emit(SOCKET_EVENTS.lobbyUpdate, await lobby.view(session));
        socket.emit(SOCKET_EVENTS.status, {
          status: session.status,
          tick: session.currentTick,
          speed: session.speed,
        });
        if (playerId) {
          const perceived = await manager.perceivedFor(session.id, playerId);
          if (perceived) socket.emit(SOCKET_EVENTS.perceived, perceived);
        } else {
          const truth = await manager.truthFor(session.id);
          if (truth) socket.emit(SOCKET_EVENTS.truth, truth);
        }
      } catch (err) {
        fail(ack, err);
      }
    });

    /** A trainee action: validated with Zod, rate-limited, queued for the next tick. */
    socket.on(SOCKET_EVENTS.action, async (raw: unknown, ack: unknown) => {
      try {
        const { user, sessionId, playerId } = data(socket);
        if (!limiter.allow(`action:${user.id}`))
          throw new HttpError(429, 'RATE_LIMITED', 'Too many actions, slow down');
        if (user.role !== 'TRAINEE') throw new HttpError(403, 'FORBIDDEN', 'Only trainees can act');
        if (!sessionId || !playerId)
          throw new HttpError(403, 'NOT_IN_SESSION', 'Join a session first');
        const parsed = playerActionSchema.safeParse(raw);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join('.') || 'action'}: ${i.message}`)
            .join('; ');
          throw new HttpError(400, 'VALIDATION_ERROR', detail);
        }
        await manager.enqueue(sessionId, playerId, parsed.data);
        reply(ack, { ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });
  });
}
