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
  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });
});
