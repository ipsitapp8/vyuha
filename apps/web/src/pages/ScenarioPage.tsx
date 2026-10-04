import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { elevationRange } from '@vyuha/engine';
import type { IngestJob, ScenarioGeoResponse, ScenarioSummary } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { TerrainMap } from '@/components/TerrainMap';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { apiErrorText } from '@/lib/messages';
import { RAMP_CSS_GRADIENT } from '@/lib/terrainColor';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; scenario: ScenarioSummary; geo: ScenarioGeoResponse };

const POLL_MS = 1500;

export function ScenarioPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
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
      if (!scenario) return { kind: 'error', message: t('instructor.scenario.notFound') };
      return { kind: 'ready', scenario, geo };
    } catch (e) {
      return { kind: 'error', message: apiErrorText(t, e, t('instructor.scenario.loadFailed')) };
    }
  }, [id, t]);

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
      setActionError(apiErrorText(t, e, t('instructor.scenario.lostContact')));
      setJob(null);
    }
  }, [id, fetchAll, stopPolling, t]);

  const startIngest = async (): Promise<void> => {
    setActionError(null);
    try {
      setJob(await api.startGeoIngest(id));
      stopPolling();
      pollRef.current = window.setInterval(() => void poll(), POLL_MS);
    } catch (e) {
      setActionError(apiErrorText(t, e, t('instructor.scenario.startFailed')));
    }
  };

  const createSession = async (): Promise<void> => {
    setCreating(true);
    setActionError(null);
    try {
      const lobby = await api.createSession(id);
      navigate(`/instructor/sessions/${lobby.session.id}`);
    } catch (e) {
      setActionError(apiErrorText(t, e, t('instructor.scenario.createFailed')));
      setCreating(false);
    }
  };

  const onMapError = useCallback(() => setMapError(t('instructor.scenario.mapDrawFailed')), [t]);
  const running = job?.status === 'RUNNING';

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          {t('instructor.scenario.back')}
        </Link>

        {load.kind === 'loading' ? (
          <p role="status" className="mt-4">
            {t('instructor.scenario.loading')}
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <div role="alert" className="mt-4 flex items-center gap-3 text-red-700">
            <span>{load.message}</span>
            <Button variant="outline" onClick={retryLoad}>
              {t('common.retry')}
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
                  ? t('instructor.scenario.ingesting')
                  : load.geo.terrain
                    ? t('instructor.scenario.refresh')
                    : t('instructor.scenario.ingest')}
              </Button>
              <Button variant="outline" onClick={() => void createSession()} disabled={creating}>
                {creating
                  ? t('instructor.scenario.creating')
                  : t('instructor.scenario.createSession')}
              </Button>
              <Button asChild variant="outline">
                <Link to={`/instructor/scenarios/${id}/msel`}>
                  {t('instructor.scenario.editMsel')}
                </Link>
              </Button>
              {running && job ? (
                <div className="flex min-w-60 flex-1 flex-col gap-1" role="status">
                  <progress className="h-2 w-full" value={job.done} max={job.total} />
                  <span className="text-xs text-muted-foreground">
                    {t('instructor.scenario.progress', { done: job.done, total: job.total })}
                  </span>
                </div>
              ) : null}
            </div>

            {actionError ? (
              <p role="alert" className="mb-4 text-red-700">
                {actionError}
              </p>
            ) : null}
            {job?.status === 'FAILED' && job.error ? (
              <p role="alert" className="mb-4 text-red-700">
                {job.error.message}
              </p>
            ) : null}
            {job?.status === 'DONE' && job.result && job.result.warnings.length > 0 ? (
              <ul className="mb-4 list-disc pl-5 text-sm text-amber-700" role="status">
                {job.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
            {mapError ? (
              <p role="alert" className="mb-4 text-red-700">
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
                {t('instructor.scenario.noTerrain')}
              </p>
            )}

            <section className="mt-6 rounded-lg border border-border bg-secondary p-4">
              <h2 className="mb-2 font-semibold">{t('instructor.scenario.weatherTitle')}</h2>
              {load.geo.weather ? (
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat
                    label={t('instructor.scenario.visibility')}
                    value={`${(load.geo.weather.visibilityM / 1000).toFixed(1)} km`}
                  />
                  <Stat
                    label={t('instructor.scenario.precipitation')}
                    value={`${load.geo.weather.precipitationMm.toFixed(1)} mm`}
                  />
                  <Stat
                    label={t('instructor.scenario.wind')}
                    value={`${load.geo.weather.windKph.toFixed(1)} km/h`}
                  />
                  <Stat
                    label={t('instructor.scenario.fetched')}
                    value={new Date(load.geo.weather.fetchedAt).toLocaleString()}
                  />
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('instructor.scenario.noWeather')}
                </p>
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
  const { t } = useTranslation();
  const { min, max } = elevationRange(grid);
  return (
    <div className="mt-3 max-w-md text-xs text-muted-foreground">
      <div className="h-3 rounded" style={{ background: RAMP_CSS_GRADIENT }} aria-hidden="true" />
      <div className="mt-1 flex justify-between">
        <span>{Math.round(min)} m</span>
        <span>{t('instructor.scenario.elevation', { rows: grid.rows, cols: grid.cols })}</span>
        <span>{Math.round(max)} m</span>
      </div>
    </div>
  );
}
