import type { Server as SocketServer, Socket } from 'socket.io';
import {
  AUTH_COOKIE_NAME,
  SOCKET_EVENTS,
  instructorInputSchema,
  joinPayloadSchema,
  playerActionSchema,
  watchPayloadSchema,
  type Ack,
  type ApiErrorCode,
  type JoinAck,
  type PublicUser,
} from '@vyuha/shared';
import { tokenStillValid, toPublicUser, verifyToken } from '../auth';
import type { Config } from '../config';
import { HttpError } from '../errors';
import type { UserRepo } from '../repos';
import type { SessionAccess } from './access';
import type { LobbyService } from './lobby';
import { room, type ManagerLogger, type SessionManager } from './manager';
import type { SessionStore } from './store';

/**
 * Token bucket: `capacity` burst, refilled at `refillPerSec`. Time is injected for testability.
 *
 * Buckets live in this process's memory, which matches the deployment: one server process holds the
 * live sessions too (see docs/ARCHITECTURE.md, "Single instance"). Memory stays bounded: a bucket that
 * has refilled completely is dropped (it would be recreated full anyway), and past `maxKeys` the least
 * recently used bucket is evicted, so a flood of distinct addresses cannot grow the map without limit.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private calls = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 10_000,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    // Re-inserted so the map's order is least recently used first.
    this.buckets.delete(key);
    this.buckets.set(key, b);
    if (++this.calls % 256 === 0) this.prune(t);
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return ok;
  }

  /** Number of buckets held (for tests and metrics). */
  get size(): number {
    return this.buckets.size;
  }

  /** Drops buckets that have refilled to capacity: forgetting them changes no decision. */
  prune(t: number = this.now()): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity)
        this.buckets.delete(key);
    }
  }
}

interface SocketData {
  user: PublicUser;
  /** Version of the token the socket connected with; a sign-out since then revokes the socket too. */
  tokenVersion: number;
  /** Epoch ms when that token expires; the socket is dropped then. */
  expiresAt: number;
  sessionId?: string;
  playerId?: string;
  /** The role the user had when this socket joined its session (its rooms were chosen by it). */
  joinedAs?: PublicUser['role'];
  /** Trainee whose picture this instructor socket is currently watching. */
  watching?: string;
}

const data = (socket: Socket): SocketData => socket.data as SocketData;

/** How often an idle socket's account is re-read, so a deleted or re-roled user stops receiving pictures. */
export const SOCKET_REVALIDATE_MS = 30_000;

/**
 * The account behind a socket no longer matches what the socket was let in as (deleted, its role
 * changed, signed out, or the token expired). The socket is disconnected after the error is sent; a
 * reconnect must pass the handshake again.
 */
class StaleIdentityError extends HttpError {}

/** Largest delay setTimeout accepts (about 24.8 days); longer timers fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Drops every socket of a user, on this server (used after a sign-out revoked their tokens). */
export async function disconnectUserSockets(io: SocketServer, userId: string): Promise<void> {
  for (const socket of await io.fetchSockets()) {
    if ((socket.data as Partial<SocketData>).user?.id === userId) socket.disconnect(true);
  }
}

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
  access: SessionAccess,
  log: ManagerLogger,
  limiter: RateLimiter = new RateLimiter(20, 5),
  revalidateMs: number = SOCKET_REVALIDATE_MS,
): void {
  /**
   * The socket's user as the database has it now. The handshake user can be stale (role changed,
   * account deleted), and rights must be judged on the server's current record. Called on joins and on
   * every trainee action or instructor command, and on a slow timer for idle sockets; never per tick.
   */
  const currentUser = async (socket: Socket): Promise<PublicUser> => {
    const d = data(socket);
    if (Date.now() >= d.expiresAt) {
      throw new StaleIdentityError(401, 'UNAUTHENTICATED', 'Your sign-in has expired');
    }
    const record = await users.findById(d.user.id);
    if (!record) throw new StaleIdentityError(401, 'UNAUTHENTICATED', 'Sign in required');
    if (!tokenStillValid(record, d.tokenVersion)) {
      throw new StaleIdentityError(401, 'UNAUTHENTICATED', 'You have signed out; sign in again');
    }
    const user = toPublicUser(record);
    if (d.joinedAs && user.role !== d.joinedAs) {
      throw new StaleIdentityError(403, 'FORBIDDEN', 'Your account has changed; sign in again');
    }
    d.user = user;
    return user;
  };

  /** The player this trainee socket acts for, re-checked against the database before each action. */
  const actingPlayer = async (socket: Socket): Promise<{ sessionId: string; playerId: string }> => {
    const user = await currentUser(socket);
    if (user.role !== 'TRAINEE') throw new HttpError(403, 'FORBIDDEN', 'Only trainees can act');
    const { sessionId, playerId } = data(socket);
    if (!sessionId || !playerId) throw new HttpError(403, 'NOT_IN_SESSION', 'Join a session first');
    const player = await store.findPlayerByUser(sessionId, user.id);
    if (!player || player.id !== playerId) {
      throw new StaleIdentityError(403, 'NOT_IN_SESSION', 'You are no longer in this exercise');
    }
    return { sessionId, playerId };
  };

  /** Leaves the session's rooms (no more truth, pictures or lobby updates); the socket stays open. */
  const leaveSession = async (socket: Socket): Promise<void> => {
    for (const r of socket.rooms) if (r.startsWith('session:')) await socket.leave(r);
    const d = data(socket);
    d.sessionId = undefined;
    d.playerId = undefined;
    d.watching = undefined;
    d.joinedAs = undefined;
  };

  /**
   * The session this instructor socket joined, re-checked against the access rules on every call. Access
   * lost by any route (co-instructor withdrawn, owner account deleted, ownerless session) also takes the
   * socket out of the instructor room, so it stops receiving the truth view.
   */
  const instructedSession = async (socket: Socket): Promise<string> => {
    const user = await currentUser(socket);
    if (user.role !== 'INSTRUCTOR') {
      throw new HttpError(403, 'FORBIDDEN', 'Only instructors can do that');
    }
    const { sessionId } = data(socket);
    if (!sessionId) throw new HttpError(403, 'NOT_IN_SESSION', 'Join a session first');
    if (!(await access.canInstruct(user, sessionId))) {
      await leaveSession(socket);
      throw new HttpError(403, 'FORBIDDEN', 'You are not an instructor of this exercise');
    }
    return sessionId;
  };

  /** The slow timer's check: the account, and the right to stay in the session's rooms. */
  const revalidateSocket = async (socket: Socket): Promise<void> => {
    const user = await currentUser(socket);
    const { sessionId, playerId, joinedAs } = data(socket);
    if (!sessionId) return;
    const stillIn =
      joinedAs === 'INSTRUCTOR'
        ? await access.canInstruct(user, sessionId)
        : playerId !== undefined &&
          (await store.findPlayerByUser(sessionId, user.id))?.id === playerId;
    if (!stillIn) {
      await leaveSession(socket);
      socket.emit(SOCKET_EVENTS.error, {
        code: 'FORBIDDEN',
        message: 'You no longer have access to this exercise',
      });
    }
  };

  // Every socket must carry the same httpOnly auth cookie the REST API uses.
  io.use((socket, next) => {
    verifyToken(readCookie(socket.handshake.headers.cookie, AUTH_COOKIE_NAME), config, users)
      .then((verified) => {
        if (!verified) return next(new Error('UNAUTHENTICATED'));
        const { user, tokenVersion, expiresAt } = verified;
        socket.data = { user, tokenVersion, expiresAt } satisfies SocketData;
        next();
      })
      .catch(() => next(new Error('INTERNAL_ERROR')));
  });

  io.on('connection', (socket) => {
    const fail = (ack: unknown, err: unknown): void => {
      const error = toError(err, log);
      reply(ack, { ok: false, error });
      socket.emit(SOCKET_EVENTS.error, error);
      if (err instanceof StaleIdentityError) socket.disconnect(true);
    };

    // Idle sockets still receive a picture every tick, so their account is re-read now and then.
    const revalidate = setInterval(() => {
      revalidateSocket(socket).catch((err: unknown) => {
        if (err instanceof StaleIdentityError) {
          socket.emit(SOCKET_EVENTS.error, { code: err.code, message: err.message });
          socket.disconnect(true);
        } else {
          log.warn({ err }, 'socket revalidation failed');
        }
      });
    }, revalidateMs);
    revalidate.unref();
    // The token's expiry ends the socket too, with no database read.
    const expiry = setTimeout(
      () => {
        socket.emit(SOCKET_EVENTS.error, {
          code: 'UNAUTHENTICATED',
          message: 'Your sign-in has expired',
        });
        socket.disconnect(true);
      },
      Math.min(Math.max(data(socket).expiresAt - Date.now(), 0), MAX_TIMER_MS),
    );
    expiry.unref();
    socket.on('disconnect', () => {
      clearInterval(revalidate);
      clearTimeout(expiry);
    });

    /** Joins the session's rooms and immediately sends the current lobby, status and picture. */
    socket.on(SOCKET_EVENTS.join, async (raw: unknown, ack: unknown) => {
      try {
        const user = await currentUser(socket);
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
        } else {
          // Same rule as the REST API: only the owner or an explicitly added co-instructor.
          await access.assertInstructor(user, session);
        }

        for (const r of socket.rooms) if (r.startsWith('session:')) await socket.leave(r);
        data(socket).sessionId = undefined;
        data(socket).playerId = undefined;
        data(socket).watching = undefined;
        await socket.join(room.session(session.id));
        data(socket).sessionId = session.id;
        data(socket).joinedAs = user.role;
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

    /** Instructor controls: live injects, jamming levels and live MSEL edits. */
    socket.on(SOCKET_EVENTS.instructorInput, async (raw: unknown, ack: unknown) => {
      try {
        if (!limiter.allow(`action:${data(socket).user.id}`))
          throw new HttpError(429, 'RATE_LIMITED', 'Too many actions, slow down');
        const sessionId = await instructedSession(socket);
        const parsed = instructorInputSchema.safeParse(raw);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
            .join('; ');
          throw new HttpError(400, 'VALIDATION_ERROR', detail);
        }
        await manager.enqueueInstructor(sessionId, parsed.data);
        reply(ack, { ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    /** God View: look through one trainee's eyes (their perceived state is streamed to this socket). */
    socket.on(SOCKET_EVENTS.watch, async (raw: unknown, ack: unknown) => {
      try {
        const sessionId = await instructedSession(socket);
        const d = data(socket);
        const parsed = watchPayloadSchema.safeParse(raw);
        if (!parsed.success) throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid player');
        const target = parsed.data.playerId;
        let perceived = null;
        if (target) {
          // Only a player of this very session: the id is the client's, so it is checked here.
          perceived = await manager.perceivedFor(sessionId, target);
          if (!perceived) throw new HttpError(404, 'NOT_FOUND', 'No such player in this exercise');
        }
        if (d.watching) await socket.leave(room.player(sessionId, d.watching));
        d.watching = target ?? undefined;
        if (target) {
          await socket.join(room.player(sessionId, target));
          if (perceived) socket.emit(SOCKET_EVENTS.perceived, perceived);
        }
        reply(ack, { ok: true });
      } catch (err) {
        fail(ack, err);
      }
    });

    /** A trainee action: validated with Zod, rate-limited, queued for the next tick. */
    socket.on(SOCKET_EVENTS.action, async (raw: unknown, ack: unknown) => {
      try {
        if (!limiter.allow(`action:${data(socket).user.id}`))
          throw new HttpError(429, 'RATE_LIMITED', 'Too many actions, slow down');
        const { sessionId, playerId } = await actingPlayer(socket);
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
