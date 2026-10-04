import { AUTH_COOKIE_NAME, type LobbyView } from '@vyuha/shared';
import { buildApp, type App } from '../app';
import { hashPassword } from '../auth';
import { bundledGeo } from '../geo/bundled';
import { SILENT_RIDGE_ID, silentRidge } from '../seed/silentRidge';
import { createMemoryDeps, memoryGeo, testConfig } from '../testing';
import type { Scheduler } from './manager';
import type { RateLimiter } from './socket';

/** A scheduler that never fires by itself; tests drive time explicitly. */
export function manualScheduler(): Scheduler & {
  time: number;
  timers: { fn: () => void; at: number; id: number }[];
  fireNext(): void;
} {
  let nextId = 1;
  const s = {
    time: 0,
    timers: [] as { fn: () => void; at: number; id: number }[],
    now: () => s.time,
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++;
      s.timers.push({ fn, at: s.time + ms, id });
      return id;
    },
    clearTimeout(handle: unknown): void {
      s.timers = s.timers.filter((t) => t.id !== handle);
    },
    fireNext(): void {
      s.timers.sort((a, b) => a.at - b.at);
      const t = s.timers.shift();
      if (!t) return;
      s.time = Math.max(s.time, t.at);
      t.fn();
    },
  };
  return s;
}

export const TRAINEES = [
  { id: 'u-pl', name: 'Asha PL', email: 'pl@x.io' },
  { id: 'u-sec', name: 'Bilal SEC', email: 'sec@x.io' },
  { id: 'u-isr', name: 'Chen ISR', email: 'isr@x.io' },
  { id: 'u-out', name: 'Dev Outsider', email: 'out@x.io' },
] as const;

export interface Env {
  app: App;
  mem: ReturnType<typeof createMemoryDeps>;
  scheduler: ReturnType<typeof manualScheduler>;
  cookie(email: string): Promise<string>;
  api(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    as: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }>;
}

export async function makeEnv(opts: { limiter?: RateLimiter } = {}): Promise<Env> {
  const geo = memoryGeo({ [SILENT_RIDGE_ID]: silentRidge.areaBounds });
  const bundled = bundledGeo(SILENT_RIDGE_ID);
  if (!bundled) throw new Error('bundled geodata missing');
  geo.terrain.set(SILENT_RIDGE_ID, bundled.terrain);
  geo.weather.set(SILENT_RIDGE_ID, bundled.weather);

  const mem = createMemoryDeps([], { geo }, { [SILENT_RIDGE_ID]: silentRidge });
  const hash = await hashPassword('Vyuha@123');
  mem.users.set('u-inst', {
    id: 'u-inst',
    name: 'Instructor',
    email: 'inst@x.io',
    role: 'INSTRUCTOR',
    passwordHash: hash,
  });
  for (const t of TRAINEES) {
    mem.users.set(t.id, { ...t, role: 'TRAINEE', passwordHash: hash });
  }
  const scheduler = manualScheduler();
  const app = await buildApp(testConfig, mem.deps, {
    scheduler,
    ...(opts.limiter ? { limiter: opts.limiter } : {}),
  });

  const cookies = new Map<string, string>();
  const cookie = async (email: string): Promise<string> => {
    const cached = cookies.get(email);
    if (cached) return cached;
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'Vyuha@123' },
    });
    const c = res.cookies.find((x) => x.name === AUTH_COOKIE_NAME);
    if (!c) throw new Error(`login failed for ${email}`);
    const header = `${AUTH_COOKIE_NAME}=${c.value}`;
    cookies.set(email, header);
    return header;
  };
  const api: Env['api'] = async (method, url, as, payload) => {
    const res = await app.fastify.inject({
      method,
      url,
      headers: { cookie: await cookie(as) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  return { app, mem, scheduler, cookie, api };
}

export async function closeEnv(env: Env | undefined): Promise<void> {
  if (!env) return;
  env.app.io.close();
  await env.app.fastify.close();
}

/** Creates a session, joins the three trainees and assigns them to one team (PL / section / ISR). */
export async function setupLobby(env: Env): Promise<{
  sessionId: string;
  code: string;
  players: Record<'pl' | 'sec' | 'isr', string>;
  teamId: string;
}> {
  const created = await env.api('POST', '/sessions', 'inst@x.io', { scenarioId: SILENT_RIDGE_ID });
  const view = created.body as LobbyView;
  const sessionId = view.session.id;
  const code = view.session.code;
  const joined: Record<string, string> = {};
  for (const [key, email] of [
    ['pl', 'pl@x.io'],
    ['sec', 'sec@x.io'],
    ['isr', 'isr@x.io'],
  ] as const) {
    const j = await env.api('POST', '/sessions/join', email, { code });
    joined[key] = (j.body as { playerId: string }).playerId;
  }
  const team = await env.api('POST', `/sessions/${sessionId}/teams`, 'inst@x.io', {
    name: 'Alpha',
  });
  const teamId = (team.body as LobbyView).teams[0]?.id ?? '';
  const assign = (playerId: string, role: string, unitId: string) =>
    env.api('PUT', `/sessions/${sessionId}/players/${playerId}`, 'inst@x.io', {
      teamId,
      role,
      unitId,
    });
  await assign(joined['pl'] ?? '', 'PL_CDR', 'b-pl');
  await assign(joined['sec'] ?? '', 'SECTION_CDR', 'b-sec1');
  await assign(joined['isr'] ?? '', 'ISR_OPERATOR', 'b-uav');
  return {
    sessionId,
    code,
    teamId,
    players: { pl: joined['pl'] ?? '', sec: joined['sec'] ?? '', isr: joined['isr'] ?? '' },
  };
}
