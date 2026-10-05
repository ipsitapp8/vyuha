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
  page.on('response', (res) => {
    if (res.status() >= 400) seen.failed.push(`${res.url()} -> ${res.status()}`);
  });
  return seen;
}

/**
 * A running session with one trainee. Logging in through page.request also signs the browser in
 * (shared cookie jar), so the page can open the God View directly.
 */
async function startedSession(
  page: Page,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<string> {
  const login = await page.request.post(`${API}/auth/login`, {
    data: { email: 'instructor@vyuha.local', password: PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const created = await page.request.post(`${API}/sessions`, {
    data: { scenarioId: 'scenario-op-silent-ridge' },
  });
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
  const assigned = await page.request.put(`${API}/sessions/${session.id}/players/${playerId}`, {
    data: { teamId, role: 'PL_CDR', unitId: 'b-pl' },
  });
  expect(assigned.ok()).toBe(true);
  expect((await page.request.post(`${API}/sessions/${session.id}/start`)).ok()).toBe(true);
  return session.id;
}

/** A map that drew real content compresses far worse than the flat dark placeholder it starts as. */
async function expectDrawn(page: Page, label: string | RegExp): Promise<void> {
  const map = page.getByRole('application', { name: label });
  await expect(map).toBeVisible();
  await expect
    .poll(async () => (await map.screenshot()).length, { timeout: 30_000 })
    .toBeGreaterThan(30_000);
}

test.describe('base map with the network unplugged', () => {
  test('renders vector tiles from the bundled PMTiles file and makes no external request', async ({
    page,
    playwright,
  }) => {
    const seen = await blockExternal(page);
    const ranges: number[] = [];
    page.on('response', (res) => {
      if (res.url().endsWith('/tiles/area.pmtiles') && res.status() === 206)
        ranges.push(res.status());
    });
    const sessionId = await startedSession(page, playwright);
    await page.goto(`/instructor/sessions/${sessionId}`);

    await expectDrawn(page, /Ground truth map/);
    // The style's attribution is only shown once its PMTiles source has loaded.
    await expect(page.getByText(/OpenStreetMap contributors/).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/offline-map.png' });

    expect(ranges.length, 'tiles are read with HTTP Range requests').toBeGreaterThan(0);
    expect(seen.blocked, 'nothing tried to reach the internet').toEqual([]);
    expect(seen.failed, 'no failed requests').toEqual([]);
    // the tile source did not fall back to hillshade
    await expect(page.getByText(/Street map unavailable/)).toHaveCount(0);
  });

  test('3D terrain is built from the stored elevation grid and needs no external request', async ({
    page,
    playwright,
  }) => {
    const seen = await blockExternal(page);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const sessionId = await startedSession(page, playwright);
    await page.goto(`/instructor/sessions/${sessionId}`);
    await expectDrawn(page, /Ground truth map/);
    const map = page.getByRole('application', { name: /Ground truth map/ });
    const flat = await map.screenshot();

    // the elevation tiles are painted in the browser from the grid the VYUHA server already holds
    const grid = page.waitForResponse((r) => /\/scenarios\/[^/]+\/terrain$/.test(r.url()));
    const toggle = page.getByRole('button', { name: '3D terrain' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(map).toHaveAttribute('data-terrain3d', 'on');
    expect((await grid).status()).toBe(200);
    await expect
      .poll(async () => Buffer.compare(await map.screenshot(), flat) !== 0, { timeout: 20_000 })
      .toBe(true);
    await page.waitForTimeout(1500); // let the elevation tiles load and the camera settle
    await page.screenshot({ path: 'test-results/offline-map-3d.png' });

    // the choice is remembered, and it switches back off cleanly
    await page.reload();
    await expect(page.getByRole('application', { name: /Ground truth map/ })).toHaveAttribute(
      'data-terrain3d',
      'on',
    );
    await page.getByRole('button', { name: '3D terrain' }).click();
    await expect(page.getByRole('application', { name: /Ground truth map/ })).toHaveAttribute(
      'data-terrain3d',
      'off',
    );

    expect(seen.blocked, 'nothing tried to reach the internet').toEqual([]);
    expect(seen.failed, 'no failed requests').toEqual([]);
    expect(errors, 'no page errors').toEqual([]);
  });

  test('falls back to a hillshade from the stored terrain when the tile file is missing', async ({
    page,
    playwright,
  }) => {
    const seen = await blockExternal(page);
    await page.route('**/tiles/area.pmtiles', (route) => route.fulfill({ status: 404, body: '' }));
    const sessionId = await startedSession(page, playwright);
    const terrain = page.waitForResponse((r) => /\/scenarios\/[^/]+\/terrain$/.test(r.url()));
    await page.goto(`/instructor/sessions/${sessionId}`);
    expect((await terrain).status()).toBe(200);

    await expectDrawn(page, /Ground truth map/);
    await expect(page.getByText(/Street map unavailable/)).toBeVisible();
    await page.screenshot({ path: 'test-results/offline-map-fallback.png' });
    expect(seen.blocked).toEqual([]);
    // the only failure is the tile file we removed on purpose
    expect(seen.failed.filter((f) => !f.includes('area.pmtiles'))).toEqual([]);
  });
});
