import { Prisma, PrismaClient } from '@prisma/client';
import { areaBoundsSchema, type ScenarioSummary } from '@vyuha/shared';
import { z } from 'zod';
import {
  EmailTakenError,
  type DbProbe,
  type Deps,
  type ScenarioRepo,
  type UserRepo,
} from './repos';

export const prisma = new PrismaClient();

const db: DbProbe = {
  async ping(): Promise<boolean> {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  },
};

const users: UserRepo = {
  findByEmail: (email) => prisma.user.findUnique({ where: { email } }),
  findById: (id) => prisma.user.findUnique({ where: { id } }),
  async create(input) {
    try {
      return await prisma.user.create({ data: input });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new EmailTakenError();
      }
      throw err;
    }
  },
};

const jsonArrayLength = (v: unknown): number => z.array(z.unknown()).parse(v).length;

const scenarios: ScenarioRepo = {
  async listSummaries(): Promise<ScenarioSummary[]> {
    const rows = await prisma.scenario.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      areaBounds: areaBoundsSchema.parse(r.areaBounds),
      seed: r.seed,
      injectCount: jsonArrayLength(r.msel),
      unitCount: jsonArrayLength(r.initialUnits),
    }));
  },
};

export const deps: Deps = { db, users, scenarios };
