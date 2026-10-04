import type { FastifyInstance } from 'fastify';
import type { AuthGuards } from '../auth';
import { sendError } from '../errors';
import { guarded } from '../sessions/routes';
import type { ProgressService } from './service';

/**
 * Progress across sessions. Instructors may read any trainee; a trainee only their own history.
 * (Registered before the `:userId` route so `trainees` is not read as an id.)
 */
export function registerProgressRoutes(
  app: FastifyInstance,
  guards: AuthGuards,
  progress: ProgressService,
): void {
  app.get(
    '/progress/trainees',
    { preHandler: guards.requireRole('INSTRUCTOR') },
    guarded<Record<string, never>>(async () => progress.trainees()),
  );

  app.get(
    '/progress/:userId',
    { preHandler: guards.requireAuth },
    guarded<{ userId: string }>(async (request, reply) => {
      const user = request.user;
      if (!user || (user.role !== 'INSTRUCTOR' && user.id !== request.params.userId)) {
        return sendError(reply, 403, 'FORBIDDEN', 'You can only view your own progress');
      }
      return progress.forUser(request.params.userId);
    }),
  );
}
