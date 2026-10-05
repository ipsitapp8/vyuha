import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = 'http://localhost:4000';
const PASSWORD = 'Vyuha@123';
const ASSIGNMENTS = [
  { email: 'trainee1@vyuha.local', role: 'PL_CDR', unitId: 'b-pl' },
  { email: 'trainee2@vyuha.local', role: 'SECTION_CDR', unitId: 'b-sec1' },
  { email: 'trainee3@vyuha.local', role: 'ISR_OPERATOR', unitId: 'b-uav' },
] as const;
/** Assigned through the lobby selects in the browser rather than over REST (seed name of trainee3). */
const UI_ASSIGNED = { ...ASSIGNMENTS[2], name: 'Rohan Das' } as const;

async function apiLogin(request: APIRequestContext, email: string): Promise<void> {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `login ${email}`).toBe(true);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(email.startsWith('instructor') ? '/login/instructor' : '/login/trainee');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // exact paths: "/login/instructor" also ends in "/instructor", so a loose pattern would match too early
  await page.waitForURL((u) => ['/trainee', '/instructor'].includes(u.pathname));
}

test('instructor and trainees run a degraded-comms exercise and export the AAR', async ({
  browser,
  playwright,
}) => {
  // ---- set up the lobby through the REST API (each actor has its own cookie jar) ----
  const instructorApi = await playwright.request.newContext();
  await apiLogin(instructorApi, 'instructor@vyuha.local');
  const created = await instructorApi.post(`${API}/sessions`, {
    data: { scenarioId: 'scenario-op-silent-ridge' },
  });
  expect(created.ok()).toBe(true);
  const { session } = (await created.json()) as { session: { id: string; code: string } };
  const team = await instructorApi.post(`${API}/sessions/${session.id}/teams`, {
    data: { name: 'Alpha' },
  });
  const teamId = ((await team.json()) as { teams: { id: string }[] }).teams[0]?.id ?? '';
  for (const a of ASSIGNMENTS) {
    const ctx = await playwright.request.newContext();
    await apiLogin(ctx, a.email);
    const joined = await ctx.post(`${API}/sessions/join`, { data: { code: session.code } });
    const { playerId } = (await joined.json()) as { playerId: string };
    // The drone operator is assigned in the browser below, so a cross-origin PUT is exercised.
    if (a.email !== UI_ASSIGNED.email) {
      const put = await instructorApi.put(`${API}/sessions/${session.id}/players/${playerId}`, {
        data: { teamId, role: a.role, unitId: a.unitId },
      });
      expect(put.ok(), `assign ${a.email}`).toBe(true);
    }
    await ctx.dispose();
  }

  // ---- three browsers: instructor God View, section commander, drone operator ----
  const instructorPage = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await signIn(instructorPage, 'instructor@vyuha.local');
  await instructorPage.goto(`/instructor/sessions/${session.id}`);
  await expect(instructorPage.getByText('Trainees (3)')).toBeVisible();

  // ---- assign the last trainee through the lobby selects (browser PUT, needs its CORS preflight) ----
  const blocked: string[] = [];
  instructorPage.on('console', (m) => {
    if (m.type() === 'error' && /CORS|blocked/i.test(m.text())) blocked.push(m.text());
  });
  const who = UI_ASSIGNED.name;
  await instructorPage.getByLabel(`Team for ${who}`).selectOption({ label: 'Alpha' });
  await expect(instructorPage.getByLabel(`Team for ${who}`)).toHaveValue(teamId);
  await instructorPage.getByLabel(`Role for ${who}`).selectOption(UI_ASSIGNED.role);
  await expect(instructorPage.getByLabel(`Role for ${who}`)).toHaveValue(UI_ASSIGNED.role);
  await instructorPage.getByLabel(`Unit for ${who}`).selectOption(UI_ASSIGNED.unitId);
  await expect(instructorPage.getByLabel(`Unit for ${who}`)).toHaveValue(UI_ASSIGNED.unitId);
  const lobbyNow = (await (
    await instructorApi.get(`${API}/sessions/${session.id}/lobby`)
  ).json()) as {
    players: { name: string; teamId: string | null; role: string | null; unitId: string | null }[];
  };
  expect(lobbyNow.players.find((p) => p.name === who)).toMatchObject({
    teamId,
    role: UI_ASSIGNED.role,
    unitId: UI_ASSIGNED.unitId,
  });
  expect(blocked, 'no request blocked by CORS').toEqual([]);

  const section = await (await browser.newContext()).newPage();
  const drone = await (await browser.newContext()).newPage();
  for (const [page, email] of [
    [section, 'trainee2@vyuha.local'],
    [drone, 'trainee3@vyuha.local'],
  ] as const) {
    await signIn(page, email);
    await page.goto(`/session/${session.code}`);
    await expect(page.getByText('Your assignment')).toBeVisible();
  }

  // ---- instructor starts the exercise at 4x ----
  await instructorPage.getByRole('button', { name: 'Start exercise' }).click();
  await expect(instructorPage.getByRole('region', { name: 'Exercise controls' })).toBeVisible();
  await instructorPage.getByRole('button', { name: '4x' }).click();
  await expect(section.getByRole('timer', { name: 'Exercise time' })).toBeVisible();
  await expect(drone.getByRole('timer', { name: 'Exercise time' })).toBeVisible();

  // Information asymmetry: trainees never see the hostile force's scenario ids or truth.
  for (const page of [section, drone]) {
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/r-recce|r-mech|trueReliability/);
  }

  // The instructor sees truth, including hostile units, and can inject live.
  await expect(
    instructorPage.getByRole('region', { name: /ground truth|truth/i }).first(),
  ).toBeVisible();

  // ---- the scripted spoofed order reaches the section commander at 04:00 exercise time ----
  await expect(section.getByRole('region', { name: 'Order alerts' })).toBeVisible({
    timeout: 120_000,
  });
  await section.getByRole('button', { name: 'Record a decision' }).click();
  await section.getByLabel('Action').selectOption('COMPLY_ORDER');
  await section.getByLabel('Based on order (optional)').selectOption({ index: 1 });
  await section.getByLabel(/Rationale/).fill('Order looked like it came from HQ');
  await section.getByRole('button', { name: 'Submit decision' }).click();
  // The server confirms it has queued the decision. Ending straight away is safe: the session manager
  // applies whatever is still queued in a final tick before it closes the exercise.
  await expect(section.getByText('Decision recorded.')).toBeVisible();

  // ---- end the exercise, open the review, export the PDF ----
  await instructorPage.getByRole('button', { name: 'End exercise' }).click();
  await instructorPage.getByRole('link', { name: 'Open after action review' }).click();
  await expect(instructorPage.getByRole('heading', { name: 'After Action Review' })).toBeVisible();
  await expect(
    instructorPage.getByText(/Acted on an order that had not been authenticated/),
  ).toBeVisible();

  const [download] = await Promise.all([
    instructorPage.waitForEvent('download'),
    instructorPage.getByRole('link', { name: 'Download PDF report' }).click(),
  ]);
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  const pdf = await readFile(path);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(10_000);
  expect(download.suggestedFilename()).toBe(`vyuha-aar-${session.code}.pdf`);
});
