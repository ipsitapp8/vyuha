import { buildApp } from './app';
import { loadConfig } from './config';
import { dbProbe, prisma } from './db';

async function main(): Promise<void> {
  const config = loadConfig();
  const { fastify, io } = await buildApp(config, dbProbe);

  const shutdown = async (): Promise<void> => {
    io.close();
    await fastify.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
