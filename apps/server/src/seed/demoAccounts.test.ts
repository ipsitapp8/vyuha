import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  DEMO_ACCOUNT_EMAILS,
  PUBLISHED_DEMO_PASSWORD,
  accountsWithPublishedPassword,
  assertNoPublishedDemoPasswords,
  resolveSeedPassword,
} from './demoAccounts';

const STRONG = 'a1b2c3d4e5f6a7b8';

describe('resolveSeedPassword', () => {
  it('keeps the published demo password for local development', () => {
    expect(resolveSeedPassword({})).toBe(PUBLISHED_DEMO_PASSWORD);
    expect(resolveSeedPassword({ NODE_ENV: 'development', SEED_PASSWORD: '' })).toBe(
      PUBLISHED_DEMO_PASSWORD,
    );
    expect(resolveSeedPassword({ NODE_ENV: 'test', SEED_PASSWORD: STRONG })).toBe(STRONG);
  });

  it('demands a strong, explicit SEED_PASSWORD in production and never echoes it', () => {
    const prod = { NODE_ENV: 'production' };
    expect(() => resolveSeedPassword(prod)).toThrow(/SEED_PASSWORD is required/);
    expect(() => resolveSeedPassword({ ...prod, SEED_PASSWORD: '' })).toThrow(/required/);
    expect(() => resolveSeedPassword({ ...prod, SEED_PASSWORD: PUBLISHED_DEMO_PASSWORD })).toThrow(
      /published/,
    );
    expect(() => resolveSeedPassword({ ...prod, SEED_PASSWORD: 'short-pw-11' })).toThrow(/12/);
    expect(() => resolveSeedPassword({ ...prod, SEED_PASSWORD: 'short-pw-11' })).not.toThrow(
      /short-pw-11/,
    );
    expect(resolveSeedPassword({ ...prod, SEED_PASSWORD: STRONG })).toBe(STRONG);
  });
});

describe('DEMO_MODE (deliberate public demo)', () => {
  it('lets production seed the published password only with the explicit opt-in', () => {
    const prod = { NODE_ENV: 'production' };
    expect(() => resolveSeedPassword({ ...prod, SEED_PASSWORD: PUBLISHED_DEMO_PASSWORD })).toThrow(
      /published/,
    );
    expect(
      resolveSeedPassword({ ...prod, DEMO_MODE: 'true', SEED_PASSWORD: PUBLISHED_DEMO_PASSWORD }),
    ).toBe(PUBLISHED_DEMO_PASSWORD);
    expect(resolveSeedPassword({ ...prod, DEMO_MODE: 'true' })).toBe(PUBLISHED_DEMO_PASSWORD);
    // any other value is not the opt-in
    expect(() => resolveSeedPassword({ ...prod, DEMO_MODE: 'yes' })).toThrow(/SEED_PASSWORD/);
  });

  it('turns the start-up refusal into a warning on every start, never silence', async () => {
    const published = bcrypt.hashSync(PUBLISHED_DEMO_PASSWORD, 4);
    const lookup = async () => published;
    const warnings: string[] = [];
    await expect(
      assertNoPublishedDemoPasswords(lookup, { demoMode: true, warn: (m) => warnings.push(m) }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/DEMO_MODE is on: 7 demo account\(s\)/);
    expect(warnings[0]).not.toContain(PUBLISHED_DEMO_PASSWORD);
    await expect(assertNoPublishedDemoPasswords(lookup, { demoMode: false })).rejects.toThrow(
      /Refusing to start/,
    );
  });
});

describe('published demo password detection', () => {
  const published = bcrypt.hashSync(PUBLISHED_DEMO_PASSWORD, 4);
  const other = bcrypt.hashSync(STRONG, 4);

  it('finds only demo accounts that still accept the published password', async () => {
    const hashes = new Map<string, string>([
      ['instructor@vyuha.local', published],
      ['trainee1@vyuha.local', other],
      ['trainee3@vyuha.local', published],
      ['someone@else.org', published], // not a demo account: never inspected
    ]);
    const lookup = async (email: string) => hashes.get(email) ?? null;
    expect(await accountsWithPublishedPassword(lookup)).toEqual([
      'instructor@vyuha.local',
      'trainee3@vyuha.local',
    ]);
    await expect(assertNoPublishedDemoPasswords(lookup)).rejects.toThrow(
      /Refusing to start: 2 demo account\(s\)/,
    );
  });

  it('lets the server start when no demo account uses it (or none exist)', async () => {
    await expect(assertNoPublishedDemoPasswords(async () => other)).resolves.toBeUndefined();
    await expect(assertNoPublishedDemoPasswords(async () => null)).resolves.toBeUndefined();
    expect(DEMO_ACCOUNT_EMAILS).toHaveLength(7);
  });
});
