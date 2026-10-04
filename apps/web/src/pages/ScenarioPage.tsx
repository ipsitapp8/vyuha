import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { elevationRange } from '@vyuha/engine';
import type { IngestJob, ScenarioGeoResponse, ScenarioSummary } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { TerrainMap } from '@/components/TerrainMap';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api';
import { RAMP_CSS_GRADIENT } from '@/lib/terrainColor';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; scenario: ScenarioSummary; geo: ScenarioGeoResponse };

const POLL_MS = 1500;
const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiRequestError ? e.message : fallback;

export function ScenarioPage() {
  const { id = '' } = useParams();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [job, setJob] = useState<IngestJob | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const fetchAll = useCallback(async (): Promise<Load> => {
    try {
      const [scenarios, geo] = await Promise.all([api.listScenarios(), api.getScenarioGeo(id)]);
      const scenario = scenarios.find((s) => s.id === id);
      if (!scenario) return { kind: 'error', message: 'Scenario not found.' };
      return { kind: 'ready', scenario, geo };
    } catch (e) {
      return { kind: 'error', message: errMsg(e, 'Could not load this scenario.') };
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void fetchAll().then((result) => {
      if (!cancelled) setLoad(result);
    });
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [fetchAll, stopPolling]);

  const retryLoad = (): void => {
    setLoad({ kind: 'loading' });
    void fetchAll().then(setLoad);
  };

  const poll = useCallback(async () => {
    try {
      const next = await api.getGeoIngestJob(id);
      setJob(next);
      if (next.status !== 'RUNNING') {
        stopPolling();
        if (next.status === 'DONE') setLoad(await fetchAll());
      }
    } catch (e) {
      stopPolling();
      setActionError(errMsg(e, 'Lost contact with the server while ingesting.'));
      setJob(null);
    }
  }, [id, fetchAll, stopPolling]);

  const startIngest = async (): Promise<void> => {
    setActionError(null);
    try {
      setJob(await api.startGeoIngest(id));
      stopPolling();
      pollRef.current = window.setInterval(() => void poll(), POLL_MS);
    } catch (e) {
      setActionError(errMsg(e, 'Could not start ingestion.'));
    }
  };

  const createSession = async (): Promise<void> => {
    setCreating(true);
    setActionError(null);
    try {
      const lobby = await api.createSession(id);
      navigate(`/instructor/sessions/${lobby.session.id}`);
    } catch (e) {
      setActionError(errMsg(e, 'Could not create the session.'));
      setCreating(false);
    }
  };

  const onMapError = useCallback((m: string) => setMapError(m), []);
  const running = job?.status === 'RUNNING';

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          ← All scenarios
        </Link>

        {load.kind === 'loading' ? (
          <p role="status" className="mt-4">
            Loading scenario…
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <div role="alert" className="mt-4 flex items-center gap-3 text-red-400">
            <span>{load.message}</span>
            <Button variant="outline" onClick={retryLoad}>
              Retry
            </Button>
          </div>
        ) : null}

        {load.kind === 'ready' ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold">{load.scenario.title}</h1>
            <p className="mb-4 text-muted-foreground">{load.scenario.description}</p>

            <div className="mb-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => void startIngest()} disabled={running}>
                {running
                  ? 'Ingesting…'
                  : load.geo.terrain
                    ? 'Refresh real terrain and weather'
                    : 'Ingest real terrain and weather'}
              </Button>
              <Button variant="outline" onClick={() => void createSession()} disabled={creating}>
                {creating ? 'Creating…' : 'Create exercise session'}
              </Button>
              {running && job ? (
                <div className="flex min-w-60 flex-1 flex-col gap-1" role="status">
                  <progress className="h-2 w-full" value={job.done} max={job.total} />
                  <span className="text-xs text-muted-foreground">
                    Elevation samples {job.done}/{job.total}. Open-Meteo limits requests per minute,
                    so this can take a few minutes.
                  </span>
                </div>
              ) : null}
            </div>

            {actionError ? (
              <p role="alert" className="mb-4 text-red-400">
                {actionError}
              </p>
            ) : null}
            {job?.status === 'FAILED' && job.error ? (
              <p role="alert" className="mb-4 text-red-400">
                {job.error.message}
              </p>
            ) : null}
            {job?.status === 'DONE' && job.result && job.result.warnings.length > 0 ? (
              <ul className="mb-4 list-disc pl-5 text-sm text-amber-400" role="status">
                {job.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            {mapError ? (
              <p role="alert" className="mb-4 text-red-400">
                {mapError}
              </p>
            ) : null}

            <TerrainMap
              bounds={load.scenario.areaBounds}
              terrain={load.geo.terrain}
              onError={onMapError}
            />

            {load.geo.terrain ? (
              <TerrainLegend grid={load.geo.terrain} />
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                No terrain stored yet. Use the button above to fetch the elevation grid.
              </p>
            )}

            <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
              <h2 className="mb-2 font-semibold">Weather at area centre</h2>
              {load.geo.weather ? (
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat
                    label="Visibility"
                    value={`${(load.geo.weather.visibilityM / 1000).toFixed(1)} km`}
                  />
                  <Stat
                    label="Precipitation"
                    value={`${load.geo.weather.precipitationMm.toFixed(1)} mm`}
                  />
                  <Stat label="Wind" value={`${load.geo.weather.windKph.toFixed(1)} km/h`} />
                  <Stat
                    label="Fetched"
                    value={new Date(load.geo.weather.fetchedAt).toLocaleString()}
                  />
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">No weather stored yet.</p>
              )}
            </section>
          </>
        ) : null}
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TerrainLegend({ grid }: { grid: NonNullable<ScenarioGeoResponse['terrain']> }) {
  const { min, max } = elevationRange(grid);
  return (
    <div className="mt-3 max-w-md text-xs text-muted-foreground">
      <div className="h-3 rounded" style={{ background: RAMP_CSS_GRADIENT }} aria-hidden="true" />
      <div className="mt-1 flex justify-between">
        <span>{Math.round(min)} m</span>
        <span>
          Elevation ({grid.rows}×{grid.cols} grid)
        </span>
        <span>{Math.round(max)} m</span>
      </div>
    </div>
  );
}
