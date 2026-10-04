import { randomUUID } from 'node:crypto';
import type { ScenarioSummary } from '@vyuha/shared';
import { loadConfig } from './config';
import { EmailTakenError, type Deps, type UserRecord } from './repos';

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'http://localhost:5173',
});

export function createMemoryDeps(scenarios: ScenarioSummary[] = []): {
  deps: Deps;
  users: Map<string, UserRecord>;
} {
  const users = new Map<string, UserRecord>();
  const deps: Deps = {
    db: { ping: async () => true },
    users: {
      findByEmail: async (email) => [...users.values()].find((u) => u.email === email) ?? null,
      findById: async (id) => users.get(id) ?? null,
      create: async (input) => {
        if ([...users.values()].some((u) => u.email === input.email)) throw new EmailTakenError();
        const rec: UserRecord = { id: randomUUID(), ...input };
        users.set(rec.id, rec);
        return rec;
      },
    },
    scenarios: { listSummaries: async () => scenarios },
  };
  return { deps, users };
}
