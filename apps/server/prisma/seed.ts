import type { Prisma } from '@prisma/client';
import { hashPassword } from '../src/auth';
import { geoRepo, prisma } from '../src/db';
import { loadConfig } from '../src/config';
import { bundledGeo } from '../src/geo/bundled';
import { ingestScenarioGeo } from '../src/geo/ingest';
import { createOpenMeteoNetwork } from '../src/geo/openMeteo';
import { SEED_SCENARIOS } from '../src/seed/scenarios';

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

  // Real terrain + weather: try Open-Meteo once (fail fast), else use the bundled real-data copy.
  const config = loadConfig();
  const network = createOpenMeteoNetwork({
    elevationUrl: config.OPEN_METEO_ELEVATION_URL,
    forecastUrl: config.OPEN_METEO_FORECAST_URL,
    maxAttempts: 2,
    rateLimitWaitMs: 5_000,
  });
  for (const { id, definition } of SEED_SCENARIOS) {
    const data = {
      title: definition.title,
      description: definition.description,
      areaBounds: definition.areaBounds,
      seed: definition.seed,
      msel: definition.msel,
      initialUnits: definition.initialUnits,
      paceDefaults: definition.paceDefaults,
    } satisfies Prisma.ScenarioUpdateInput;
    await prisma.scenario.upsert({
      where: { id },
      update: data,
      create: { id, createdById: instructor.id, ...data },
    });
    const geo = await ingestScenarioGeo(id, geoRepo, network, bundledGeo(id));
    console.log(`${definition.title}: terrain ${geo.terrainSource}, weather ${geo.weatherSource}`);
    for (const w of geo.warnings) console.log(`  note: ${w}`);
  }

  console.log(
    `Seeded 1 instructor, ${TRAINEE_NAMES.length} trainees and ${SEED_SCENARIOS.length} scenarios.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
