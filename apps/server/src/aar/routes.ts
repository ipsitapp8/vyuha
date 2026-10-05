import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthGuards } from '../auth';
import { HttpError } from '../errors';
import { guarded, parse } from '../sessions/routes';
import type { AarService } from './service';

const snapshotQuery = z.object({
  tick: z.coerce.number().int().min(0),
  playerId: z.string().min(1).optional(),
});

/** UTF-8 byte order mark so Excel opens the CSV as UTF-8 (Devanagari stays readable). */
const BOM = String.fromCharCode(0xfeff);

type Id = { sessionId: string };

/** After action review endpoints (instructors only). Only ENDED sessions can be reviewed. */
export function registerAarRoutes(app: FastifyInstance, guards: AuthGuards, aar: AarService): void {
  const instructor = { preHandler: guards.requireRole('INSTRUCTOR') };

  /** A trainee's own probe scores after the exercise (no ground truth in the response). */
  app.get(
    '/aar/:sessionId/my-sa',
    { preHandler: guards.requireRole('TRAINEE') },
    guarded<Id>(async (request) => {
      if (!request.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
      return aar.saScoresForUser(request.params.sessionId, request.user.id);
    }),
  );

  app.get(
    '/aar/:sessionId',
    instructor,
    guarded<Id>(async (request) => aar.summary(request.params.sessionId)),
  );

  /** Ground truth and a trainee's perception at any tick, rebuilt by deterministic replay. */
  app.get(
    '/aar/:sessionId/snapshot',
    instructor,
    guarded<Id>(async (request) => {
      const q = parse(snapshotQuery, request.query);
      return aar.snapshot(request.params.sessionId, q.tick, q.playerId ?? null);
    }),
  );

  app.get(
    '/aar/:sessionId/decisions/:decisionId',
    instructor,
    guarded<Id & { decisionId: string }>(async (request) =>
      aar.decisionDetail(request.params.sessionId, request.params.decisionId),
    ),
  );

  app.get(
    '/aar/:sessionId/export.json',
    instructor,
    guarded<Id>(async (request, reply) => {
      const f = await aar.json(request.params.sessionId);
      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${f.filename}"`)
        .send(f.body);
    }),
  );

  app.get(
    '/aar/:sessionId/export.csv',
    instructor,
    guarded<Id>(async (request, reply) => {
      const f = await aar.csv(request.params.sessionId);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${f.filename}"`)
        .send(BOM + f.body);
    }),
  );

  app.get(
    '/aar/:sessionId/export.pdf',
    instructor,
    guarded<Id>(async (request, reply) => {
      const f = await aar.pdf(request.params.sessionId);
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${f.filename}"`)
        .send(f.body);
    }),
  );
}
