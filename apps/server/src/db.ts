import { PrismaClient } from '@prisma/client';
import type { DbProbe } from './app';

export const prisma = new PrismaClient();

export const dbProbe: DbProbe = {
  async ping(): Promise<boolean> {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  },
};
