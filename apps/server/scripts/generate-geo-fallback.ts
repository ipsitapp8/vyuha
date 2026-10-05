/**
 * Regenerates the bundled terrain and weather of the seeded scenarios from live Open-Meteo data
 * (needs internet). The files under src/seed are what makes every scenario work with no network.
 *
 * Run: pnpm --filter @vyuha/server geo:fallback            (every scenario)
 *      pnpm --filter @vyuha/server geo:fallback -- <id>    (one scenario, e.g. scenario-op-thar-kavach)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sampleGridPoints } from '@vyuha/engine';
import { GRID_COLS, GRID_ROWS } from '@vyuha/shared';
import { loadConfig } from '../src/config';
import { createOpenMeteoNetwork } from '../src/geo/openMeteo';
import { SEED_SCENARIOS } from '../src/seed/scenarios';

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => a !== '--');
  const wanted = SEED_SCENARIOS.filter((s) => only.length === 0 || only.includes(s.id));
  if (wanted.length === 0) throw new Error(`No seeded scenario matches: ${only.join(', ')}`);
  const config = loadConfig();
  const net = createOpenMeteoNetwork({
    elevationUrl: config.OPEN_METEO_ELEVATION_URL,
    forecastUrl: config.OPEN_METEO_FORECAST_URL,
  });
  for (const scenario of wanted) {
    const bbox = scenario.definition.areaBounds;
    const elevations = await net.fetchElevations(sampleGridPoints(bbox, GRID_ROWS, GRID_COLS));
    const weather = await net.fetchWeather({
      lat: (bbox.south + bbox.north) / 2,
      lon: (bbox.west + bbox.east) / 2,
    });
    const out = {
      terrain: { rows: GRID_ROWS, cols: GRID_COLS, bbox, elevations },
      weather: { ...weather, fetchedAt: new Date().toISOString() },
    };
    const path = fileURLToPath(new URL(`../src/seed/${scenario.geoFile}`, import.meta.url));
    writeFileSync(path, JSON.stringify(out) + '\n');
    console.log(`Wrote ${path} (${elevations.length} elevation samples)`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
