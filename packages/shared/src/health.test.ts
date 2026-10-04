import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a valid payload', () => {
    expect(healthResponseSchema.parse({ ok: true, db: false })).toEqual({ ok: true, db: false });
  });
  it('rejects a malformed payload', () => {
    expect(healthResponseSchema.safeParse({ ok: 'yes' }).success).toBe(false);
  });
});
