import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthGuards } from '../auth';
import { HttpError } from '../errors';
import type { SessionAccess } from '../sessions/access';
import { guarded, parse, userOf } from '../sessions/routes';
import type { AarService } from './service';

const snapshotQuery = z.object({
  tick: z.coerce.number().int().min(0),
  playerId: z.string().min(1).optional(),
});

/** UTF-8 byte order mark so Excel opens the CSV as UTF-8 (Devanagari stays readable). */
const BOM = String.fromCharCode(0xfeff);

type Id = { sessionId: string };

/**
 * After action review endpoints. Only ENDED sessions can be reviewed, and only by the session's owner or
 * co-instructors; a trainee gets their own probe scores and nothing else.
 */
export function registerAarRoutes(
  app: FastifyInstance,
  guards: AuthGuards,
  aar: AarService,
  access: SessionAccess,
): void {
  const instructor = { preHandler: guards.requireRole('INSTRUCTOR') };
  /** Every instructor route checks the session before the review is built. */
  const allowed = (request: FastifyRequest<{ Params: Id }>): Promise<unknown> =>
    access.requireInstructor(userOf(request), request.params.sessionId);

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
    guarded<Id>(async (request) => {
      await allowed(request);
      const summary = await aar.summary(request.params.sessionId);
      const twin = summary.meta.twin;
      // The twin's id and code are only shown to instructors who may open that run too.
      if (twin && !(await access.canInstruct(userOf(request), twin.sessionId))) {
        return { ...summary, meta: { ...summary.meta, twin: null } };
      }
      return summary;
    }),
  );

  /** The degraded run beside its clean baseline twin (either session of the pair). */
  app.get(
    '/aar/:sessionId/compare',
    instructor,
    guarded<Id>(async (request) => {
      await allowed(request);
      // The comparison also reveals the twin run, so the caller must be entitled to that one as well.
      const twinId = await aar.twinSessionId(request.params.sessionId);
      if (twinId) await access.requireInstructor(userOf(request), twinId);
      return aar.compare(request.params.sessionId);
    }),
  );

  /** Ground truth and a trainee's perception at any tick, rebuilt by deterministic replay. */
  app.get(
    '/aar/:sessionId/snapshot',
    instructor,
    guarded<Id>(async (request) => {
      await allowed(request);
      const q = parse(snapshotQuery, request.query);
      return aar.snapshot(request.params.sessionId, q.tick, q.playerId ?? null);
    }),
  );

  app.get(
    '/aar/:sessionId/decisions/:decisionId',
    instructor,
    guarded<Id & { decisionId: string }>(async (request) => {
      await allowed(request);
      return aar.decisionDetail(request.params.sessionId, request.params.decisionId);
    }),
  );

  app.get(
    '/aar/:sessionId/export.json',
    instructor,
    guarded<Id>(async (request, reply) => {
      await allowed(request);
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
      await allowed(request);
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
      await allowed(request);
      const f = await aar.pdf(
        request.params.sessionId,
        await access.instructableSessionIds(userOf(request)),
      );
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${f.filename}"`)
        .send(f.body);
    }),
  );
}
