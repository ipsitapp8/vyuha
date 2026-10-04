import type { Prisma } from '@prisma/client';
import { hashPassword } from '../src/auth';
import { geoRepo, prisma } from '../src/db';
import { loadConfig } from '../src/config';
import { bundledGeo } from '../src/geo/bundled';
import { ingestScenarioGeo } from '../src/geo/ingest';
import { createOpenMeteoNetwork } from '../src/geo/openMeteo';
import { SILENT_RIDGE_ID, silentRidge } from '../src/seed/silentRidge';

/** Demo accounts share one password. A public deployment sets SEED_PASSWORD so it is never the published one. */
const DEMO_PASSWORD = process.env['SEED_PASSWORD'] ?? 'Vyuha@123';

const INSTRUCTOR = {
  name: 'Col. Instructor',
  email: 'instructor@vyuha.local',
  password: DEMO_PASSWORD,
};
const TRAINEE_NAMES = [
  'Aarav Singh',
  'Meera Nair',
  'Rohan Das',
  'Kavya Iyer',
  'Imran Khan',
  'Tenzin Dorje',
];

async function main(): Promise<void> {
  const instructor = await prisma.user.upsert({
    where: { email: INSTRUCTOR.email },
    update: {},
    create: {
      name: INSTRUCTOR.name,
      email: INSTRUCTOR.email,
      passwordHash: await hashPassword(INSTRUCTOR.password),
      role: 'INSTRUCTOR',
    },
  });

  for (const [i, name] of TRAINEE_NAMES.entries()) {
    const email = `trainee${i + 1}@vyuha.local`;
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: { name, email, passwordHash: await hashPassword(DEMO_PASSWORD), role: 'TRAINEE' },
    });
  }

  const data = {
    title: silentRidge.title,
    description: silentRidge.description,
    areaBounds: silentRidge.areaBounds,
    seed: silentRidge.seed,
    msel: silentRidge.msel,
    initialUnits: silentRidge.initialUnits,
    paceDefaults: silentRidge.paceDefaults,
  } satisfies Prisma.ScenarioUpdateInput;
  await prisma.scenario.upsert({
    where: { id: SILENT_RIDGE_ID },
    update: data,
    create: { id: SILENT_RIDGE_ID, createdById: instructor.id, ...data },
  });

  // Real terrain + weather: try Open-Meteo once (fail fast), else use the bundled real-data copy.
  const config = loadConfig();
  const geo = await ingestScenarioGeo(
    SILENT_RIDGE_ID,
    geoRepo,
    createOpenMeteoNetwork({
      elevationUrl: config.OPEN_METEO_ELEVATION_URL,
      forecastUrl: config.OPEN_METEO_FORECAST_URL,
      maxAttempts: 2,
      rateLimitWaitMs: 5_000,
    }),
    bundledGeo(SILENT_RIDGE_ID),
  );
  console.log(`Terrain source: ${geo.terrainSource}, weather source: ${geo.weatherSource}`);
  for (const w of geo.warnings) console.log(`  note: ${w}`);

  console.log(
    `Seeded 1 instructor, ${TRAINEE_NAMES.length} trainees and scenario "${silentRidge.title}".`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
