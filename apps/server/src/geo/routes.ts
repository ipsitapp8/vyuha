import type { FastifyInstance } from 'fastify';
import type { IngestJob, ScenarioGeoResponse } from '@vyuha/shared';
import type { AuthGuards } from '../auth';
import { sendError } from '../errors';
import type { Deps } from '../repos';
import { createIngestJobRunner } from './jobs';

interface IdParams {
  id: string;
}

export function registerGeoRoutes(app: FastifyInstance, deps: Deps, guards: AuthGuards): void {
  const runner = createIngestJobRunner(deps.geo, deps.geoNetwork, deps.bundledGeo, (msg, err) =>
    app.log.error({ err }, msg),
  );
  const instructorOnly = { preHandler: guards.requireRole('INSTRUCTOR') };

  /** Starts (or joins) background ingestion of elevation + weather for the scenario. */
  app.post<{ Params: IdParams }>(
    '/scenarios/:id/ingest-geo',
    instructorOnly,
    async (request, reply) => {
      try {
        if (!(await deps.geo.getScenarioBounds(request.params.id))) {
          return sendError(reply, 404, 'NOT_FOUND', 'Scenario not found');
        }
        const job: IngestJob = runner.start(request.params.id);
        return reply.status(202).send(job);
      } catch (err) {
        request.log.error({ err }, 'start geo ingest failed');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not start geodata ingestion');
      }
    },
  );

  /** Progress / result of the latest ingestion job for the scenario. */
  app.get<{ Params: IdParams }>(
    '/scenarios/:id/ingest-geo',
    instructorOnly,
    async (request, reply) => {
      const job = runner.get(request.params.id);
      if (!job) return sendError(reply, 404, 'NOT_FOUND', 'No ingestion has been started');
      return job;
    },
  );

  /** Stored terrain grid + weather for the scenario (either may be null before ingestion). */
  app.get<{ Params: IdParams }>('/scenarios/:id/geo', instructorOnly, async (request, reply) => {
    try {
      if (!(await deps.geo.getScenarioBounds(request.params.id))) {
        return sendError(reply, 404, 'NOT_FOUND', 'Scenario not found');
      }
      const body: ScenarioGeoResponse = {
        terrain: await deps.geo.getTerrain(request.params.id),
        weather: await deps.geo.getWeather(request.params.id),
      };
      return body;
    } catch (err) {
      request.log.error({ err }, 'load geo failed');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Could not load terrain and weather');
    }
  });
}
