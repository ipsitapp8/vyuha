import { GRID_COLS, GRID_ROWS, type IngestJob } from '@vyuha/shared';
import { GeoUnavailableError, ingestScenarioGeo, ScenarioNotFoundError } from './ingest';
import type { BundledGeo, GeoRepo } from './ingest';
import type { GeoNetwork } from './openMeteo';

export interface IngestJobRunner {
  /** Starts ingestion for a scenario, or returns the one already running. */
  start(scenarioId: string): IngestJob;
  get(scenarioId: string): IngestJob | null;
}

/** In-memory job tracker: ingestion can take minutes under Open-Meteo rate limits, so it runs in the background. */
export function createIngestJobRunner(
  repo: GeoRepo,
  network: GeoNetwork,
  bundledFor: (scenarioId: string) => BundledGeo | null,
  log: (message: string, err?: unknown) => void,
): IngestJobRunner {
  const jobs = new Map<string, IngestJob>();

  return {
    get: (id) => jobs.get(id) ?? null,
    start(id) {
      const existing = jobs.get(id);
      if (existing?.status === 'RUNNING') return existing;

      const job: IngestJob = {
        scenarioId: id,
        status: 'RUNNING',
        done: 0,
        total: GRID_ROWS * GRID_COLS,
        result: null,
        error: null,
      };
      jobs.set(id, job);

      ingestScenarioGeo(id, repo, network, bundledFor(id), {
        onProgress: (done, total) => {
          job.done = done;
          job.total = total;
        },
      })
        .then((result) => {
          job.status = 'DONE';
          job.result = result;
          job.done = job.total = result.terrain.elevations.length;
        })
        .catch((err: unknown) => {
          job.status = 'FAILED';
          if (err instanceof ScenarioNotFoundError) {
            job.error = { code: 'NOT_FOUND', message: err.message };
          } else if (err instanceof GeoUnavailableError) {
            job.error = { code: 'GEO_UNAVAILABLE', message: err.message };
          } else {
            log('geo ingest failed', err);
            job.error = {
              code: 'INTERNAL_ERROR',
              message: 'Geodata ingestion failed unexpectedly',
            };
          }
        });
      return job;
    },
  };
}
