import { describe, expect, it } from 'vitest';
import { loginBodySchema, registerBodySchema } from './auth';
import { areaBoundsSchema, injectSchema, paceDefaultsSchema } from './scenario';

describe('auth schemas', () => {
  it('normalises email and accepts a valid registration', () => {
    const r = registerBodySchema.parse({
      name: ' Asha Rao ',
      email: ' A@B.IN ',
      password: 'abcdef12',
    });
    expect(r).toEqual({ name: 'Asha Rao', email: 'a@b.in', password: 'abcdef12' });
  });
  it('rejects weak passwords and bad emails', () => {
    expect(
      registerBodySchema.safeParse({ name: 'Asha', email: 'a@b.in', password: 'abcdefgh' }).success,
    ).toBe(false);
    expect(
      registerBodySchema.safeParse({ name: 'Asha', email: 'nope', password: 'abcdef12' }).success,
    ).toBe(false);
    expect(loginBodySchema.safeParse({ email: 'a@b.in', password: '' }).success).toBe(false);
  });
});

describe('scenario schemas', () => {
  it('rejects inverted bounds', () => {
    expect(areaBoundsSchema.safeParse({ south: 2, north: 1, west: 0, east: 1 }).success).toBe(
      false,
    );
  });
  it('requires four distinct PACE channels', () => {
    expect(
      paceDefaultsSchema.safeParse({
        primary: 'VHF',
        alternate: 'VHF',
        contingency: 'HF',
        emergency: 'RUNNER',
      }).success,
    ).toBe(false);
  });
  it('discriminates injects by type and rejects jamming the runner', () => {
    const base = { id: 'i', tick: 1, title: 't' };
    expect(
      injectSchema.safeParse({ ...base, type: 'SATCOM_OUTAGE', durationTicks: 5 }).success,
    ).toBe(true);
    expect(
      injectSchema.safeParse({
        ...base,
        type: 'JAM_CHANNEL',
        channel: 'RUNNER',
        intensity: 0.5,
        durationTicks: 5,
      }).success,
    ).toBe(false);
    expect(injectSchema.safeParse({ ...base, type: 'SATCOM_OUTAGE' }).success).toBe(false);
  });
});
