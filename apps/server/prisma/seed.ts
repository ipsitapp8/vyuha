import type { Prisma } from '@prisma/client';
import { hashPassword } from '../src/auth';
import { geoRepo, prisma } from '../src/db';
import { loadConfig } from '../src/config';
import { bundledGeo } from '../src/geo/bundled';
import { ingestScenarioGeo } from '../src/geo/ingest';
import { createOpenMeteoNetwork } from '../src/geo/openMeteo';
import {
  DEMO_INSTRUCTOR,
  DEMO_TRAINEE_NAMES,
  accountsWithPublishedPassword,
  demoTraineeEmail,
  resolveSeedPassword,
} from '../src/seed/demoAccounts';
import { SEED_SCENARIOS } from '../src/seed/scenarios';

async function main(): Promise<void> {
  // Validates the whole environment first (JWT secret, database password rules in production).
  const config = loadConfig();
  // Demo accounts share one password: the published one in development, SEED_PASSWORD in production
  // (which may be the published one only with DEMO_MODE=true, a deliberate public demo).
  const demoPassword = resolveSeedPassword(process.env);
  /**
   * SEED_RESET_PASSWORDS=true sets the demo accounts back to that password on every start, so the demo login
   * shown on the sign-in pages keeps working. Leave it off for a real deployment: accounts then keep their own.
   */
  const resetPasswords = process.env['SEED_RESET_PASSWORDS'] === 'true';

  const instructor = await prisma.user.upsert({
    where: { email: DEMO_INSTRUCTOR.email },
    update: resetPasswords ? { passwordHash: await hashPassword(demoPassword) } : {},
    create: {
      name: DEMO_INSTRUCTOR.name,
      email: DEMO_INSTRUCTOR.email,
      passwordHash: await hashPassword(demoPassword),
      role: 'INSTRUCTOR',
    },
  });

  for (const [i, name] of DEMO_TRAINEE_NAMES.entries()) {
    const email = demoTraineeEmail(i);
    await prisma.user.upsert({
      where: { email },
      update: resetPasswords ? { passwordHash: await hashPassword(demoPassword) } : {},
      create: { name, email, passwordHash: await hashPassword(demoPassword), role: 'TRAINEE' },
    });
  }

  // Production never keeps the published password: demo accounts created by an older seed get
  // SEED_PASSWORD instead. Other passwords (changed by their users) are left alone.
  if (config.NODE_ENV === 'production' && !config.DEMO_MODE) {
    const exposed = await accountsWithPublishedPassword(
      async (email) =>
        (await prisma.user.findUnique({ where: { email }, select: { passwordHash: true } }))
          ?.passwordHash ?? null,
    );
    for (const email of exposed) {
      await prisma.user.update({
        where: { email },
        data: { passwordHash: await hashPassword(demoPassword) },
      });
    }
    if (exposed.length > 0) {
      console.log(`Replaced the published demo password on ${exposed.length} account(s).`);
    }
  }

  // Real terrain + weather: try Open-Meteo once (fail fast), else use the bundled real-data copy.
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
    `Seeded 1 instructor, ${DEMO_TRAINEE_NAMES.length} trainees and ${SEED_SCENARIOS.length} scenarios.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
