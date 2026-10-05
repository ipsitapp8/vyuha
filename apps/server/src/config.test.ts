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
  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
