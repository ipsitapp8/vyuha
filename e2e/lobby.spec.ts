import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'Vyuha@123';

async function signInAsInstructor(page: Page): Promise<void> {
  await page.goto('/login/instructor');
  await page.getByLabel('Email').fill('instructor@vyuha.local');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname === '/instructor');
}

/**
 * The lobby is driven through the browser, so every call crosses origins: PUT, PATCH and DELETE need
 * their CORS preflight to succeed. API-only tests cannot see that, which is how "Delete team" broke.
 */
test('instructor creates a session, adds and deletes teams and saves a PACE plan in the browser', async ({
  page,
}) => {
  const failures: string[] = [];
  page.on('requestfailed', (r) =>
    failures.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`),
  );
  page.on('console', (m) => {
    if (m.type() === 'error' && /CORS|blocked/i.test(m.text())) failures.push(m.text());
  });

  await signInAsInstructor(page);
  await page.getByRole('button', { name: 'Create exercise session' }).click();
  await page.waitForURL(/\/instructor\/sessions\//);
  await expect(page.getByText('Teams and PACE plans')).toBeVisible();

  const name = page.getByLabel('New team name');
  const add = page.getByRole('button', { name: 'Add team' });
  await name.fill('Alpha');
  await add.click();
  await expect(
    page.getByRole('heading', { name: /Alpha/ }).or(page.getByText('Alpha').first()),
  ).toBeVisible();
  await name.fill('Bravo');
  await add.click();
  const deleteButtons = page.getByRole('button', { name: 'Delete team' });
  await expect(deleteButtons).toHaveCount(2);

  // PATCH: save a different PACE plan for the first team
  // (the plan must use four different channels, so swap the first two)
  await page.getByLabel('Primary').first().selectOption('HF');
  await page.getByLabel('Alternate').first().selectOption('VHF');
  await page.getByRole('button', { name: 'Save PACE plan' }).first().click();
  await expect(page.getByLabel('Primary').first()).toHaveValue('HF');

  // DELETE: remove the second team; it must really go, and stay gone after a reload
  await deleteButtons.last().click();
  await expect(deleteButtons).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Delete team' })).toHaveCount(1);
  await expect(page.getByLabel('Primary').first()).toHaveValue('HF');

  // and the last one too
  await page.getByRole('button', { name: 'Delete team' }).click();
  await expect(page.getByRole('button', { name: 'Delete team' })).toHaveCount(0);

  expect(failures, 'no blocked or failed requests').toEqual([]);
});
