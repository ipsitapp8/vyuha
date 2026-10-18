import type { PublicUser } from '@vyuha/shared';
import { HttpError } from '../errors';
import type { SessionRow, SessionStore } from './store';

/** How an instructor is entitled to a session: its creator, or someone the creator added. */
export type InstructorAccess = 'OWNER' | 'CO_INSTRUCTOR';

/**
 * The one place that decides who may run and review a session. Every instructor-only REST route and
 * socket handler goes through it, so the rule cannot drift between endpoints.
 *
 * - Only accounts whose server-side role is INSTRUCTOR can ever qualify (the caller passes the user the
 *   server loaded from the database, never anything the client claims).
 * - The owner is `Session.ownerId`; co-instructors are rows the owner added explicitly.
 * - A session with no owner (created before ownership existed) is closed to every instructor until an
 *   operator assigns one; it is never handed to an arbitrary instructor.
 */
export class SessionAccess {
  constructor(private readonly store: SessionStore) {}

  async instructorAccess(user: PublicUser, session: SessionRow): Promise<InstructorAccess | null> {
    if (user.role !== 'INSTRUCTOR' || session.ownerId === null) return null;
    if (session.ownerId === user.id) return 'OWNER';
    return (await this.store.isCoInstructor(session.id, user.id)) ? 'CO_INSTRUCTOR' : null;
  }

  /**
   * Every session this user may run and review: the ones they own or were added to. Empty for anyone
   * who is not an instructor. Used to scope data that spans sessions (progress, the PDF's history).
   */
  async instructableSessionIds(user: PublicUser): Promise<Set<string>> {
    if (user.role !== 'INSTRUCTOR') return new Set();
    return new Set((await this.store.listSessionsForInstructor(user.id)).map((s) => s.id));
  }

  /** True when the session exists and the user may instruct it (for redacting, not for gating). */
  async canInstruct(user: PublicUser, sessionId: string): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    return session !== null && (await this.instructorAccess(user, session)) !== null;
  }

  /** Throws 403 unless the user is the owner or a co-instructor of this session. */
  async assertInstructor(user: PublicUser, session: SessionRow): Promise<InstructorAccess> {
    const access = await this.instructorAccess(user, session);
    if (!access) {
      throw new HttpError(403, 'FORBIDDEN', 'You are not an instructor of this exercise');
    }
    return access;
  }

  /** Loads the session (404 when missing) and checks the user may instruct it. */
  async requireInstructor(user: PublicUser, sessionId: string): Promise<SessionRow> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
    await this.assertInstructor(user, session);
    return session;
  }

  /** Loads the session and checks the user is its owner (managing co-instructors is owner-only). */
  async requireOwner(user: PublicUser, sessionId: string): Promise<SessionRow> {
    const session = await this.requireInstructor(user, sessionId);
    if (session.ownerId !== user.id) {
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Only the instructor who created this exercise can do that',
      );
    }
    return session;
  }
}
