import type { FastifyInstance } from 'fastify';
import {
  scenarioDetailSchema,
  updateMselBodySchema,
  validateMselReferences,
  type ScenarioDetail,
} from '@vyuha/shared';
import type { AuthGuards } from './auth';
import { sendError, sendValidationError } from './errors';
import type { Deps } from './repos';

export function registerScenarioRoutes(app: FastifyInstance, deps: Deps, guards: AuthGuards): void {
  const instructorOnly = { preHandler: guards.requireRole('INSTRUCTOR') };

  /** Full scenario (units, MSEL, PACE) for the MSEL authoring page. */
  app.get<{ Params: { id: string } }>('/scenarios/:id', instructorOnly, async (request, reply) => {
    try {
      const def = await deps.scenarios.getDefinition(request.params.id);
      if (!def) return sendError(reply, 404, 'NOT_FOUND', 'Scenario not found');
      const body: ScenarioDetail = scenarioDetailSchema.parse({ id: request.params.id, ...def });
      return body;
    } catch (err) {
      request.log.error({ err }, 'load scenario failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not load the scenario');
    }
  });

  /**
   * Replaces the scenario MSEL. Shapes are checked with Zod and references (unit ids, sides, map bounds)
   * against the scenario itself. Sessions already started keep the MSEL they began with.
   */
  app.put<{ Params: { id: string } }>(
    '/scenarios/:id/msel',
    instructorOnly,
    async (request, reply) => {
      const parsed = updateMselBodySchema.safeParse(request.body);
      if (!parsed.success) return sendValidationError(reply, parsed.error);
      try {
        const def = await deps.scenarios.getDefinition(request.params.id);
        if (!def) return sendError(reply, 404, 'NOT_FOUND', 'Scenario not found');
        const problems = validateMselReferences(parsed.data.msel, def.initialUnits, def.areaBounds);
        if (problems.length > 0) {
          return sendError(
            reply,
            400,
            'VALIDATION_ERROR',
            'The MSEL does not fit this scenario',
            problems.map((message) => ({ path: 'msel', message })),
          );
        }
        const sorted = [...parsed.data.msel].sort(
          (a, b) => a.tick - b.tick || a.id.localeCompare(b.id),
        );
        if (!(await deps.scenarios.updateMsel(request.params.id, sorted))) {
          return sendError(reply, 404, 'NOT_FOUND', 'Scenario not found');
        }
        const body: ScenarioDetail = scenarioDetailSchema.parse({
          id: request.params.id,
          ...def,
          msel: sorted,
        });
        return body;
      } catch (err) {
        request.log.error({ err }, 'update msel failed');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not save the MSEL');
      }
    },
  );
}
