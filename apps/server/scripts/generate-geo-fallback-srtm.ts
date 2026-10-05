/**
 * Second source for a scenario's bundled terrain, for when Open-Meteo's daily quota is used up:
 * SRTM 90 m elevation from the public OpenTopoData API, on the same 64 x 64 grid, plus the weather
 * values given on the command line (taken from a live observation).
 *
 * Run: pnpm --filter @vyuha/server exec tsx scripts/generate-geo-fallback-srtm.ts \
 *        <scenario id> <visibility m> <precipitation mm> <wind km/h>
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sampleGridPoints } from '@vyuha/engine';
import { GRID_COLS, GRID_ROWS } from '@vyuha/shared';
import { z } from 'zod';
import { SEED_SCENARIOS } from '../src/seed/scenarios';

const URL_BASE = 'https://api.opentopodata.org/v1/srtm90m';
const BATCH = 100; // the API's limit per request
const PAUSE_MS = 1100; // and it asks for at most one request a second
const body = z.object({
  status: z.literal('OK'),
  results: z.array(z.object({ elevation: z.number().nullable() })),
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const [id, vis, precip, wind] = process.argv.slice(2).filter((a) => a !== '--');
  const scenario = SEED_SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);
  const weather = z
    .object({
      visibilityM: z.coerce.number().min(0),
      precipitationMm: z.coerce.number().min(0),
      windKph: z.coerce.number().min(0),
    })
    .parse({ visibilityM: vis, precipitationMm: precip, windKph: wind });

  const bbox = scenario.definition.areaBounds;
  const points = sampleGridPoints(bbox, GRID_ROWS, GRID_COLS);
  const elevations: number[] = [];
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    const locations = batch.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|');
    let parsed: z.infer<typeof body> | null = null;
    for (let attempt = 1; attempt <= 4 && !parsed; attempt++) {
      const res = await fetch(`${URL_BASE}?locations=${locations}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) parsed = body.parse(await res.json());
      else await sleep(PAUSE_MS * attempt * 2);
    }
    if (!parsed || parsed.results.length !== batch.length) {
      throw new Error(`OpenTopoData did not answer for points ${i}..${i + batch.length}`);
    }
    for (const r of parsed.results) {
      if (r.elevation === null) throw new Error('OpenTopoData has no elevation for a grid point');
      elevations.push(r.elevation);
    }
    console.log(`${elevations.length} / ${points.length}`);
    await sleep(PAUSE_MS);
  }

  const out = {
    source: 'SRTM 90 m (OpenTopoData); weather from a live observation',
    terrain: { rows: GRID_ROWS, cols: GRID_COLS, bbox, elevations },
    weather: { ...weather, fetchedAt: new Date().toISOString() },
  };
  const path = fileURLToPath(new URL(`../src/seed/${scenario.geoFile}`, import.meta.url));
  writeFileSync(path, JSON.stringify(out) + '\n');
  console.log(`Wrote ${path} (${elevations.length} elevation samples)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
