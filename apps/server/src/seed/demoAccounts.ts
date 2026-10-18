import bcrypt from 'bcryptjs';

/**
 * The demo accounts the seed creates, and the rules that keep their published password out of
 * production. The password below is printed in the README and demo script, so it is only acceptable
 * for local development and tests.
 */
export const PUBLISHED_DEMO_PASSWORD = 'Vyuha@123';
export const MIN_PRODUCTION_SEED_PASSWORD_LENGTH = 12;

export const DEMO_INSTRUCTOR = {
  name: 'Col. Instructor',
  email: 'instructor@vyuha.local',
} as const;
export const DEMO_TRAINEE_NAMES = [
  'Aarav Singh',
  'Meera Nair',
  'Rohan Das',
  'Kavya Iyer',
  'Imran Khan',
  'Tenzin Dorje',
] as const;
export const demoTraineeEmail = (index: number): string => `trainee${index + 1}@vyuha.local`;
export const DEMO_ACCOUNT_EMAILS: readonly string[] = [
  DEMO_INSTRUCTOR.email,
  ...DEMO_TRAINEE_NAMES.map((_, i) => demoTraineeEmail(i)),
];

/**
 * The password the seed gives new demo accounts. Production must name its own (SEED_PASSWORD, at least
 * 12 characters, never the published one) unless DEMO_MODE=true opts into a public demo; development
 * and a public demo fall back to the published one. Errors never include the value.
 */
export function resolveSeedPassword(env: NodeJS.ProcessEnv): string {
  const given = env['SEED_PASSWORD'];
  if (env['NODE_ENV'] !== 'production' || env['DEMO_MODE'] === 'true')
    return given && given.length > 0 ? given : PUBLISHED_DEMO_PASSWORD;
  if (!given) {
    throw new Error(
      'SEED_PASSWORD is required to seed demo accounts in production. Set it to 12 or more random ' +
        'characters (for example: openssl rand -hex 16), or set SEED_ON_START=false.',
    );
  }
  if (given === PUBLISHED_DEMO_PASSWORD) {
    throw new Error('SEED_PASSWORD is the published demo password. Production refuses it.');
  }
  if (given.length < MIN_PRODUCTION_SEED_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_PASSWORD must be at least ${MIN_PRODUCTION_SEED_PASSWORD_LENGTH} characters in production.`,
    );
  }
  return given;
}

/** Looks up a stored password hash by email (null when there is no such account). */
export type HashLookup = (email: string) => Promise<string | null>;

/** Emails of demo accounts that still accept the published password. */
export async function accountsWithPublishedPassword(lookup: HashLookup): Promise<string[]> {
  const found: string[] = [];
  for (const email of DEMO_ACCOUNT_EMAILS) {
    const hash = await lookup(email);
    if (hash && (await bcrypt.compare(PUBLISHED_DEMO_PASSWORD, hash))) found.push(email);
  }
  return found;
}

/**
 * Production start-up gate: refuses to serve while any demo account still signs in with the published
 * password (for example a database seeded before SEED_PASSWORD was required). With DEMO_MODE=true (a
 * deliberate public demo) it only warns, every start, so the choice is never silent.
 */
export async function assertNoPublishedDemoPasswords(
  lookup: HashLookup,
  options: { demoMode?: boolean; warn?: (message: string) => void } = {},
): Promise<void> {
  const exposed = await accountsWithPublishedPassword(lookup);
  if (exposed.length > 0 && options.demoMode) {
    (options.warn ?? console.warn)(
      `DEMO_MODE is on: ${exposed.length} demo account(s) (${exposed.join(', ')}) accept the published ` +
        'demo password, so anyone can sign in as them. Never use DEMO_MODE for a real exercise deployment.',
    );
    return;
  }
  if (exposed.length > 0) {
    throw new Error(
      `Refusing to start: ${exposed.length} demo account(s) (${exposed.join(', ')}) still use the ` +
        'published demo password. Set SEED_PASSWORD and run the seed (SEED_ON_START=true or ' +
        '`pnpm --filter @vyuha/server db:seed`): in production it replaces that password.',
    );
  }
}
