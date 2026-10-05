import { expect, test, type Page, type PlaywrightWorkerArgs, type Request } from '@playwright/test';

const API = 'http://localhost:4000';
const PASSWORD = 'Vyuha@123';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Aborts every request that leaves this machine and records it, so the test can prove none happened. */
async function blockExternal(page: Page): Promise<{ blocked: string[]; failed: string[] }> {
  const seen = { blocked: [] as string[], failed: [] as string[] };
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || LOCAL_HOSTS.has(url.hostname)) {
      return route.continue();
    }
    seen.blocked.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  page.on('requestfailed', (req: Request) =>
    seen.failed.push(`${req.url()} ${req.failure()?.errorText}`),
  );
  return seen;
}

async function signInInstructor(page: Page): Promise<void> {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { email: 'instructor@vyuha.local', password: PASSWORD },
  });
  expect(login.ok()).toBe(true);
}

/** A running session of the given scenario with one trainee as platoon commander. */
async function startedSession(
  page: Page,
  playwright: PlaywrightWorkerArgs['playwright'],
  scenarioId: string,
): Promise<string> {
  const created = await page.request.post(`${API}/sessions`, { data: { scenarioId } });
  expect(created.ok(), `create a ${scenarioId} session`).toBe(true);
  const { session } = (await created.json()) as { session: { id: string; code: string } };
  const trainee = await playwright.request.newContext();
  await trainee.post(`${API}/auth/login`, {
    data: { email: 'trainee1@vyuha.local', password: PASSWORD },
  });
  const joined = await trainee.post(`${API}/sessions/join`, { data: { code: session.code } });
  const { playerId } = (await joined.json()) as { playerId: string };
  await trainee.dispose();
  const team = await page.request.post(`${API}/sessions/${session.id}/teams`, {
    data: { name: 'Alpha' },
  });
  const teamId = ((await team.json()) as { teams: { id: string }[] }).teams[0]?.id ?? '';
  await page.request.put(`${API}/sessions/${session.id}/players/${playerId}`, {
    data: { teamId, role: 'PL_CDR', unitId: 'b-pl' },
  });
  expect((await page.request.post(`${API}/sessions/${session.id}/start`)).ok()).toBe(true);
  return session.id;
}

async function expectDrawn(page: Page, label: RegExp): Promise<void> {
  const map = page.getByRole('application', { name: label });
  await expect(map).toBeVisible();
  await expect
    .poll(async () => (await map.screenshot()).length, { timeout: 30_000 })
    .toBeGreaterThan(30_000);
}

test.describe('the three seeded scenarios', () => {
  test('are offered to the instructor, in English and in Hindi', async ({ page }) => {
    await signInInstructor(page);
    await page.goto('/instructor');
    for (const title of ['Op Silent Ridge', 'Op Him Prahari', 'Op Thar Kavach']) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }
    await expect(page.getByText(/5,300 m pass/)).toBeVisible();
    await expect(page.getByText(/navigation spoofed/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create exercise session' })).toHaveCount(3);

    await page.getByRole('button', { name: 'हिन्दी' }).click();
    for (const title of ['ऑप साइलेंट रिज', 'ऑप हिम प्रहरी', 'ऑप थार कवच']) {
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Op Thar Kavach' })).toBeVisible();
  });

  test('the high-altitude scenario runs offline on the bundled street map', async ({
    page,
    playwright,
  }) => {
    const seen = await blockExternal(page);
    await signInInstructor(page);
    const id = await startedSession(page, playwright, 'scenario-op-him-prahari');
    await page.goto(`/instructor/sessions/${id}`);
    await expect(page.getByRole('heading', { name: 'Op Him Prahari' })).toBeVisible();
    await expectDrawn(page, /Ground truth map/);
    await expect(page.getByText(/Street map unavailable/)).toHaveCount(0);
    expect(seen.blocked, 'nothing tried to reach the internet').toEqual([]);
    expect(seen.failed, 'no failed requests').toEqual([]);
  });

  test('the desert scenario runs offline on the terrain base map built from its bundled elevation', async ({
    page,
    playwright,
  }) => {
    const seen = await blockExternal(page);
    await signInInstructor(page);
    const id = await startedSession(page, playwright, 'scenario-op-thar-kavach');
    await page.goto(`/instructor/sessions/${id}`);
    await expect(page.getByRole('heading', { name: 'Op Thar Kavach' })).toBeVisible();
    // the offline tile archive covers Ladakh only, so this map is the hillshade, never a blank one
    await expect(page.getByText(/Street map unavailable/)).toBeVisible();
    await expectDrawn(page, /Ground truth map/);
    // the scripted UAV GPS spoof is on this scenario's MSEL timeline
    await expect(page.getByText('MSEL timeline')).toBeVisible();
    await page.screenshot({ path: 'test-results/desert-terrain-map.png' });
    expect(seen.blocked, 'nothing tried to reach the internet').toEqual([]);
    expect(seen.failed, 'no failed requests').toEqual([]);
  });
});
