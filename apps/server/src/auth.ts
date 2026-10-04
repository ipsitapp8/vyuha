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

const tokenPayloadSchema = z.object({ sub: z.string(), role: roleSchema });

export function toPublicUser(u: UserRecord): PublicUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function setAuthCookie(reply: FastifyReply, config: Config, user: PublicUser): void {
  const token = jwt.sign({ role: user.role }, config.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: TOKEN_TTL_SECONDS,
  });
  reply.setCookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    path: '/',
    maxAge: TOKEN_TTL_SECONDS,
  });
}

/** Verifies a JWT and loads its user (null when missing, invalid, expired or the user is gone). */
export async function authenticateToken(
  token: string | undefined,
  config: Config,
  users: UserRepo,
): Promise<PublicUser | null> {
  if (!token) return null;
  try {
    const decoded = tokenPayloadSchema.safeParse(
      jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }),
    );
    if (!decoded.success) return null;
    const record = await users.findById(decoded.data.sub);
    return record ? toPublicUser(record) : null;
  } catch {
    return null;
  }
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

export function registerAuth(app: FastifyInstance, config: Config, users: UserRepo): AuthGuards {
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
      const user = toPublicUser(created);
      setAuthCookie(reply, config, user);
      const body: AuthResponse = { user };
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
      const user = toPublicUser(record);
      setAuthCookie(reply, config, user);
      const body: AuthResponse = { user };
      return reply.send(body);
    } catch (err) {
      request.log.error({ err }, 'login failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not sign in');
    }
  });

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
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
