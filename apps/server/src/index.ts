import { buildApp } from './app';
import { loadConfig } from './config';
import { buildDeps, prisma } from './db';
import { assertNoPublishedDemoPasswords } from './seed/demoAccounts';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
    // Allowed (the air-gapped Compose stack is plain http on one machine), but never silent.
    console.warn(
      'COOKIE_SECURE is false: the sign-in cookie can travel over plain http. Set COOKIE_SECURE=true ' +
        'whenever the site is served over https.',
    );
  }
  if (config.NODE_ENV === 'production') {
    await assertNoPublishedDemoPasswords(
      async (email) =>
        (await prisma.user.findUnique({ where: { email }, select: { passwordHash: true } }))
          ?.passwordHash ?? null,
    );
  }
  const { fastify, io, manager } = await buildApp(config, buildDeps(config));

  const shutdown = async (): Promise<void> => {
    manager.shutdown();
    io.close();
    await fastify.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
  await manager.resumeAll();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
