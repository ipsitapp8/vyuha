import { prisma } from '../src/db';

async function main(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  console.log('Database reachable. Seed data is added together with the Phase 2 schema.');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
