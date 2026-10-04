/**
 * Regenerates src/seed/silent-ridge-geo.json from live Open-Meteo data (needs internet).
 * Run: pnpm --filter @vyuha/server geo:fallback
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sampleGridPoints } from '@vyuha/engine';
import { GRID_COLS, GRID_ROWS } from '@vyuha/shared';
import { loadConfig } from '../src/config';
import { createOpenMeteoNetwork } from '../src/geo/openMeteo';
import { silentRidge } from '../src/seed/silentRidge';

async function main(): Promise<void> {
  const config = loadConfig();
  const net = createOpenMeteoNetwork({
    elevationUrl: config.OPEN_METEO_ELEVATION_URL,
    forecastUrl: config.OPEN_METEO_FORECAST_URL,
  });
  const bbox = silentRidge.areaBounds;
  const elevations = await net.fetchElevations(sampleGridPoints(bbox, GRID_ROWS, GRID_COLS));
  const weather = await net.fetchWeather({
    lat: (bbox.south + bbox.north) / 2,
    lon: (bbox.west + bbox.east) / 2,
  });
  const out = {
    terrain: { rows: GRID_ROWS, cols: GRID_COLS, bbox, elevations },
    weather: { ...weather, fetchedAt: new Date().toISOString() },
  };
  const path = fileURLToPath(new URL('../src/seed/silent-ridge-geo.json', import.meta.url));
  writeFileSync(path, JSON.stringify(out) + '\n');
  console.log(`Wrote ${path} (${elevations.length} elevation samples)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
