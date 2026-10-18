import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { z } from 'zod';
import {
  AUTH_COOKIE_NAME,
  loginBodySchema,
  registerBodySchema,
  roleSchema,
  type AuthResponse,
  type PublicUser,
  type Role,
  type SessionResponse,
} from '@vyuha/shared';
import type { Config } from './config';
import { sendError, sendValidationError } from './errors';
import { EmailTakenError, type UserRecord, type UserRepo } from './repos';

declare module 'fastify' {
  interface FastifyRequest {
    user: PublicUser | null;
  }
}

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const BCRYPT_ROUNDS = 10;
// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('vyuha-timing-equaliser', BCRYPT_ROUNDS);

/**
 * What a sign-in token carries. `ver` is the user's `tokenVersion` at issue time: signing out increments
 * it, which revokes the token. Tokens issued before versions existed have none and count as version 0.
 * `role` is informational only; rights always come from the user's current database record.
 */
const tokenPayloadSchema = z.object({
  sub: z.string().min(1),
  role: roleSchema,
  ver: z.number().int().nonnegative().default(0),
  exp: z.number().int(),
});

export function toPublicUser(u: UserRecord): PublicUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function cookieOptions(config: Config) {
  return { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/' } as const;
}

function setAuthCookie(reply: FastifyReply, config: Config, user: UserRecord): void {
  const token = jwt.sign({ role: user.role, ver: user.tokenVersion ?? 0 }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: TOKEN_TTL_SECONDS,
  });
  reply.setCookie(AUTH_COOKIE_NAME, token, { ...cookieOptions(config), maxAge: TOKEN_TTL_SECONDS });
}

/** A verified sign-in: the user as the database has it now, and the token's version and expiry. */
export interface VerifiedToken {
  user: PublicUser;
  tokenVersion: number;
  /** Epoch milliseconds after which the token is no longer accepted. */
  expiresAt: number;
}

/** True while the user's current record still accepts a token of this version. */
export const tokenStillValid = (record: UserRecord, tokenVersion: number): boolean =>
  (record.tokenVersion ?? 0) === tokenVersion;

/**
 * Verifies a JWT (signature, HS256 only, expiry, payload shape) and that it was not revoked, then loads
 * its user. Null when the token is missing, malformed, expired, revoked or the user is gone. The token
 * itself is never logged or echoed.
 */
export async function verifyToken(
  token: string | undefined,
  config: Config,
  users: UserRepo,
): Promise<VerifiedToken | null> {
  if (!token) return null;
  try {
    const decoded = tokenPayloadSchema.safeParse(
      jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }),
    );
    if (!decoded.success) return null;
    const record = await users.findById(decoded.data.sub);
    if (!record || !tokenStillValid(record, decoded.data.ver)) return null;
    return {
      user: toPublicUser(record),
      tokenVersion: decoded.data.ver,
      expiresAt: decoded.data.exp * 1000,
    };
  } catch {
    return null;
  }
}

/** Verifies a JWT and loads its user (null when missing, invalid, expired, revoked or the user is gone). */
export async function authenticateToken(
  token: string | undefined,
  config: Config,
  users: UserRepo,
): Promise<PublicUser | null> {
  return (await verifyToken(token, config, users))?.user ?? null;
}

async function resolveUser(
  request: FastifyRequest,
  config: Config,
  users: UserRepo,
): Promise<PublicUser | null> {
  return authenticateToken(request.cookies[AUTH_COOKIE_NAME], config, users);
}

export interface AuthGuards {
  requireAuth: preHandlerAsyncHookHandler;
  requireRole: (...roles: Role[]) => preHandlerAsyncHookHandler;
}

export interface AuthHooks {
  /** Runs after a user's tokens were revoked (sign-out), e.g. to drop their open sockets. */
  onTokensRevoked?: (userId: string) => Promise<void>;
  /**
   * Asked for each well-formed registration before the password is hashed; false = refuse with 429.
   * (Malformed requests are refused first and cost nothing, so they cannot drain the budget.)
   */
  allowRegistration?: () => boolean;
}

export function registerAuth(
  app: FastifyInstance,
  config: Config,
  users: UserRepo,
  hooks: AuthHooks = {},
): AuthGuards {
  app.decorateRequest('user', null);

  const requireAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    const user = await resolveUser(request, config, users);
    if (!user) {
      return sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
    }
    request.user = user;
  };

  const requireRole =
    (...roles: Role[]): preHandlerAsyncHookHandler =>
    async (request, reply) => {
      const user = await resolveUser(request, config, users);
      if (!user) return sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
      if (!roles.includes(user.role)) {
        return sendError(reply, 403, 'FORBIDDEN', 'You do not have access to this resource');
      }
      request.user = user;
    };

  app.post('/auth/register', async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    if (hooks.allowRegistration && !hooks.allowRegistration()) {
      return sendError(
        reply,
        429,
        'RATE_LIMITED',
        'Too many new accounts right now, try again shortly',
      );
    }
    try {
      if (await users.findByEmail(parsed.data.email)) {
        return sendError(reply, 409, 'EMAIL_TAKEN', 'This email is already registered');
      }
      // Self-registration always yields a TRAINEE; instructor accounts are provisioned by the seed/admin.
      const created = await users.create({
        name: parsed.data.name,
        email: parsed.data.email,
        passwordHash: await hashPassword(parsed.data.password),
        role: 'TRAINEE',
      });
      setAuthCookie(reply, config, created);
      const body: AuthResponse = { user: toPublicUser(created) };
      return reply.status(201).send(body);
    } catch (err) {
      if (err instanceof EmailTakenError) {
        return sendError(reply, 409, 'EMAIL_TAKEN', 'This email is already registered');
      }
      request.log.error({ err }, 'register failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not create the account');
    }
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    try {
      const record = await users.findByEmail(parsed.data.email);
      const ok = await bcrypt.compare(parsed.data.password, record?.passwordHash ?? DUMMY_HASH);
      if (!record || !ok) {
        return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
      }
      // Said only after the password was right, so it does not reveal which emails exist.
      if (parsed.data.portal && record.role !== parsed.data.portal) {
        return sendError(reply, 403, 'FORBIDDEN', 'This account cannot sign in here');
      }
      setAuthCookie(reply, config, record);
      const body: AuthResponse = { user: toPublicUser(record) };
      return reply.send(body);
    } catch (err) {
      request.log.error({ err }, 'login failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not sign in');
    }
  });

  /**
   * Signs out by revoking the user's tokens (every device: tokens are versioned per user, not per
   * device) and dropping their open sockets, then clears the cookie. A missing or already invalid
   * token just clears the cookie.
   */
  app.post('/auth/logout', async (request, reply) => {
    try {
      const signedIn = await verifyToken(request.cookies[AUTH_COOKIE_NAME], config, users);
      if (signedIn) {
        await users.revokeTokens(signedIn.user.id);
        await hooks.onTokensRevoked?.(signedIn.user.id);
      }
    } catch (err) {
      request.log.error({ err }, 'logout failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not sign out');
    }
    reply.clearCookie(AUTH_COOKIE_NAME, cookieOptions(config));
    return reply.status(204).send();
  });

  app.get('/auth/session', async (request, reply) => {
    try {
      const body: SessionResponse = { user: await resolveUser(request, config, users) };
      return reply.send(body);
    } catch (err) {
      request.log.error({ err }, 'session lookup failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not load the session');
    }
  });

  app.get('/auth/me', async (request, reply) => {
    try {
      const user = await resolveUser(request, config, users);
      if (!user) return sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
      const body: AuthResponse = { user };
      return reply.send(body);
    } catch (err) {
      request.log.error({ err }, 'me failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not load the session');
    }
  });

  return { requireAuth, requireRole };
}
