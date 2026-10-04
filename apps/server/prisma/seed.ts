import type { Prisma } from '@prisma/client';
import { hashPassword } from '../src/auth';
import { prisma } from '../src/db';
import { SILENT_RIDGE_ID, silentRidge } from '../src/seed/silentRidge';

const INSTRUCTOR = {
  name: 'Col. Instructor',
  email: 'instructor@vyuha.local',
  password: 'Vyuha@123',
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
      create: { name, email, passwordHash: await hashPassword('Vyuha@123'), role: 'TRAINEE' },
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
