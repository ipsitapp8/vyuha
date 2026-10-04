import { Prisma, PrismaClient } from '@prisma/client';
import { areaBoundsSchema, scenarioDefinitionSchema, type ScenarioSummary } from '@vyuha/shared';
import { z } from 'zod';
import type { Config } from './config';
import { createPrismaSessionStore } from './sessions/prismaStore';
import { bundledGeo } from './geo/bundled';
import type { GeoRepo } from './geo/ingest';
import { createOpenMeteoNetwork } from './geo/openMeteo';
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
  async updateMsel(id, msel) {
    try {
      await prisma.scenario.update({
        where: { id },
        data: { msel: msel as unknown as Prisma.InputJsonValue },
      });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return false;
      throw err;
    }
  },
  async getDefinition(id) {
    const r = await prisma.scenario.findUnique({ where: { id } });
    if (!r) return null;
    return scenarioDefinitionSchema.parse({
      title: r.title,
      description: r.description,
      areaBounds: r.areaBounds,
      seed: r.seed,
      msel: r.msel,
      initialUnits: r.initialUnits,
      paceDefaults: r.paceDefaults,
    });
  },
};

export const geoRepo: GeoRepo = {
  async getScenarioBounds(id) {
    const row = await prisma.scenario.findUnique({ where: { id }, select: { areaBounds: true } });
    return row ? areaBoundsSchema.parse(row.areaBounds) : null;
  },
  async getTerrain(id) {
    const row = await prisma.terrainGrid.findUnique({ where: { scenarioId: id } });
    if (!row) return null;
    return {
      rows: row.rows,
      cols: row.cols,
      bbox: areaBoundsSchema.parse(row.bbox),
      elevations: row.elevations,
    };
  },
  async getWeather(id) {
    const row = await prisma.weatherSnapshot.findUnique({ where: { scenarioId: id } });
    if (!row) return null;
    return {
      visibilityM: row.visibilityM,
      precipitationMm: row.precipitationMm,
      windKph: row.windKph,
      fetchedAt: row.fetchedAt.toISOString(),
    };
  },
  async saveTerrain(id, grid) {
    const data = { rows: grid.rows, cols: grid.cols, bbox: grid.bbox, elevations: grid.elevations };
    await prisma.terrainGrid.upsert({
      where: { scenarioId: id },
      update: data,
      create: { scenarioId: id, ...data },
    });
  },
  async saveWeather(id, w) {
    const data = {
      visibilityM: w.visibilityM,
      precipitationMm: w.precipitationMm,
      windKph: w.windKph,
      fetchedAt: new Date(w.fetchedAt),
    };
    await prisma.weatherSnapshot.upsert({
      where: { scenarioId: id },
      update: data,
      create: { scenarioId: id, ...data },
    });
  },
};

export function buildDeps(config: Config): Deps {
  return {
    db,
    users,
    scenarios,
    geo: geoRepo,
    geoNetwork: createOpenMeteoNetwork({
      elevationUrl: config.OPEN_METEO_ELEVATION_URL,
      forecastUrl: config.OPEN_METEO_FORECAST_URL,
    }),
    bundledGeo,
    sessions: createPrismaSessionStore(prisma),
  };
}
