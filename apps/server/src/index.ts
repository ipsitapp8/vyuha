import { buildApp } from './app';
import { loadConfig } from './config';
import { buildDeps, prisma } from './db';

async function main(): Promise<void> {
  const config = loadConfig();
  const { fastify, io, manager } = await buildApp(config, buildDeps(config));
  if (config.NODE_ENV === 'production' && config.JWT_SECRET.startsWith('change-me')) {
    fastify.log.warn('JWT_SECRET is the published placeholder: set JWT_SECRET before real use');
  }

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
