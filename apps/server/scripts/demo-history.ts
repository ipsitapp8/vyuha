/**
 * Builds a real progress history for the "Progress" page without inventing any number.
 *
 * It plays three complete exercises of Op Silent Ridge through the same lobby, session manager, event log
 * and metric recording that live sessions use, with three scripted bot trainees at the controls
 * (apps/server/src/demo). The bots get better each session; the engine scores what they did. Runs are
 * deterministic. The bots are flagged "Demo bot" in the database and everywhere in the UI.
 *
 * Run: pnpm demo:history            (adds the history once)
 *      pnpm demo:history -- --reset (removes the bots' sessions first, then plays them again)
 * Needs the database to be migrated and seeded (pnpm db:migrate && pnpm db:seed).
 */
import { randomUUID } from 'node:crypto';
import type { PublicUser } from '@vyuha/shared';
import { hashPassword } from '../src/auth';
import { loadConfig } from '../src/config';
import { buildDeps, prisma } from '../src/db';
import { DEMO_TEAM, runDemoHistory } from '../src/demo/history';
import { SILENT_RIDGE_ID } from '../src/seed/silentRidge';

const BOT_NAMES = ['Demo Bot Alpha', 'Demo Bot Bravo', 'Demo Bot Charlie'] as const;
const SESSIONS = 3;

const emailFor = (name: string): string => `${name.toLowerCase().replace(/\s+/g, '-')}@vyuha.demo`;

async function ensureBots(): Promise<PublicUser[]> {
  const bots: PublicUser[] = [];
  for (const name of BOT_NAMES) {
    const email = emailFor(name);
    // Nobody knows this password, so a bot account can never be signed into.
    const passwordHash = await hashPassword(randomUUID());
    const u = await prisma.user.upsert({
      where: { email },
      update: { name, isDemoBot: true, role: 'TRAINEE' },
      create: { name, email, passwordHash, role: 'TRAINEE', isDemoBot: true },
    });
    bots.push({ id: u.id, name: u.name, email: u.email, role: 'TRAINEE' });
  }
  return bots;
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const config = loadConfig();
  const deps = buildDeps(config);

  if (
    !(await deps.scenarios.getDefinition(SILENT_RIDGE_ID)) ||
    !(await deps.geo.getTerrain(SILENT_RIDGE_ID))
  ) {
    throw new Error(
      'Op Silent Ridge or its terrain is missing. Run: pnpm db:migrate && pnpm db:seed',
    );
  }
  if (DEMO_TEAM.length !== BOT_NAMES.length) throw new Error('bot names and demo team differ');

  const bots = await ensureBots();
  const botIds = bots.map((b) => b.id);

  if (reset) {
    const removed = await prisma.session.deleteMany({
      where: { players: { some: { userId: { in: botIds } } } },
    });
    console.log(`Removed ${removed.count} earlier demo session(s).`);
  } else {
    const have = await prisma.sessionMetric.count({ where: { userId: { in: botIds } } });
    if (have >= SESSIONS * bots.length) {
      console.log(
        'Demo history is already there. Use "pnpm demo:history -- --reset" to play it again.',
      );
      return;
    }
  }

  const results = await runDemoHistory({
    store: deps.sessions,
    scenarios: deps.scenarios,
    geo: deps.geo,
    scenarioId: SILENT_RIDGE_ID,
    bots,
    sessions: SESSIONS,
    log: {
      error: (obj, msg) => console.error(msg, obj),
      warn: (obj, msg) => console.warn(msg, obj),
    },
    onProgress: (m) => console.log(m),
  });

  console.log(`\nPlayed ${results.length} sessions. Stored metrics (computed by the engine):`);
  for (const bot of bots) {
    console.log(`\n${bot.name}`);
    for (const [i, r] of (await deps.sessions.listUserProgress(bot.id)).entries()) {
      const s = (ms: number | null): string =>
        ms === null ? '   -' : `${(ms / 1000).toFixed(1)} s`;
      const pct = (v: number | null, k = 1): string =>
        v === null ? '-' : `${(v * k).toFixed(0)}%`;
      console.log(
        `  session ${i + 1}: latency ${s(r.avgDecisionLatencyMs)}, under jamming ${s(r.latencyUnderJammingMs)}, ` +
          `Brier ${r.brierScore === null ? '-' : r.brierScore.toFixed(2)}, ` +
          `spoofs challenged ${pct(r.spoofsChallengedPct)}, grading ${pct(r.reportGradingAccuracy, 100)}`,
      );
    }
  }
  console.log(`\nOpen http://localhost:5173/progress as an instructor to see the charts.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
