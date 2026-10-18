import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  CORS_ORIGIN: 'http://localhost:5173',
};

describe('loadConfig', () => {
  it('parses valid env and applies defaults', () => {
    const cfg = loadConfig(valid);
    expect(cfg.PORT).toBe(4000);
    expect(cfg.NODE_ENV).toBe('development');
  });
  it('fails fast with a clear message when vars are missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('production refuses to start without a JWT secret or with the published placeholder', () => {
    const placeholder = 'change-me-to-a-long-random-string-of-32-chars-or-more';
    const prod = { ...valid, NODE_ENV: 'production' };
    expect(() => loadConfig({ ...prod, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...prod, JWT_SECRET: '' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...prod, JWT_SECRET: placeholder })).toThrow(/placeholder/);
    expect(loadConfig(prod).NODE_ENV).toBe('production');
    // the placeholder stays usable for local development
    expect(loadConfig({ ...valid, JWT_SECRET: placeholder }).NODE_ENV).toBe('development');
  });
  it('production refuses an empty or published database password, without echoing it', () => {
    const prod = { ...valid, NODE_ENV: 'production' };
    const published = 'postgresql://vyuha:vyuha_dev_password@db:5432/vyuha';
    expect(() => loadConfig({ ...prod, DATABASE_URL: published })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: published })).not.toThrow(
      /vyuha_dev_password/,
    );
    expect(() =>
      loadConfig({ ...prod, DATABASE_URL: 'postgresql://vyuha:@db:5432/vyuha' }),
    ).toThrow(/DATABASE_URL/);
    // A random password, or a URL with no password part (socket or platform auth), is accepted.
    expect(
      loadConfig({ ...prod, DATABASE_URL: 'postgresql://vyuha:3f9c1a7e5b@db:5432/vyuha' }).NODE_ENV,
    ).toBe('production');
    expect(loadConfig({ ...prod, DATABASE_URL: 'postgresql://vyuha@db:5432/vyuha' }).NODE_ENV).toBe(
      'production',
    );
    // Local development keeps working with the old example password.
    expect(loadConfig({ ...valid, DATABASE_URL: published }).NODE_ENV).toBe('development');
  });
  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
