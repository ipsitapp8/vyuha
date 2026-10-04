import { defineConfig } from '@playwright/test';

/**
 * One end-to-end multiplayer test. Needs PostgreSQL with the seed data:
 *   docker compose up -d db && pnpm db:migrate && pnpm db:seed
 * Servers already running on 4000/5173 are reused; otherwise they are started here.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 5 * 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env['PW_CHANNEL'] ?? 'chrome',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @vyuha/server dev',
      url: 'http://localhost:4000/health',
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @vyuha/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
