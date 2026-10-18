import type { FastifyInstance } from 'fastify';
import type { AuthGuards } from '../auth';
import { HttpError } from '../errors';
import type { SessionAccess } from '../sessions/access';
import { guarded, userOf } from '../sessions/routes';
import type { ProgressService } from './service';

/**
 * Progress across sessions. A trainee reads only their own history. An instructor reads metrics only
 * from sessions they may review (owner or co-instructor): the same rule as the session and AAR routes.
 * (Registered before the `:userId` route so `trainees` is not read as an id.)
 */
export function registerProgressRoutes(
  app: FastifyInstance,
  guards: AuthGuards,
  progress: ProgressService,
  access: SessionAccess,
): void {
  app.get(
    '/progress/trainees',
    { preHandler: guards.requireRole('INSTRUCTOR') },
    guarded<Record<string, never>>(async (request) =>
      progress.trainees(await access.instructableSessionIds(userOf(request))),
    ),
  );

  app.get(
    '/progress/:userId',
    { preHandler: guards.requireAuth },
    guarded<{ userId: string }>(async (request) => {
      const user = userOf(request);
      if (user.role === 'INSTRUCTOR') {
        return progress.forUser(request.params.userId, await access.instructableSessionIds(user));
      }
      if (user.id !== request.params.userId) {
        throw new HttpError(403, 'FORBIDDEN', 'You can only view your own progress');
      }
      return progress.forUser(user.id, 'ALL');
    }),
  );
}
