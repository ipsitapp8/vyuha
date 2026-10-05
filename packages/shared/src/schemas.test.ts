import { describe, expect, it } from 'vitest';
import { loginBodySchema, registerBodySchema } from './auth';
import {
  areaBoundsSchema,
  injectSchema,
  paceDefaultsSchema,
  validateMselReferences,
} from './scenario';

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

describe('validateMselReferences', () => {
  const units = [
    { id: 'b-1', side: 'BLUE' as const },
    { id: 'r-1', side: 'RED' as const },
  ];
  const bounds = { south: 0, west: 0, north: 10, east: 10 };
  const base = { id: 'i', tick: 1, title: 't' };

  it('accepts a consistent MSEL', () => {
    expect(
      validateMselReferences(
        [
          {
            ...base,
            id: 'a',
            type: 'SPOOF_ORDER',
            purportedSender: 'HQ',
            targetUnitId: 'b-1',
            orderText: 'x',
          },
          {
            ...base,
            id: 'b',
            type: 'RUNNER_DISPATCH',
            fromUnitId: 'b-1',
            toUnitId: 'b-1',
            messageText: 'x',
          },
          {
            ...base,
            id: 'c',
            type: 'ADVERSARY_MOVE',
            unitId: 'r-1',
            destination: { lat: 5, lon: 5 },
          },
          {
            ...base,
            id: 'd',
            type: 'CONFLICTING_REPORTS',
            unitId: 'r-1',
            altPosition: { lat: 1, lon: 1 },
            altType: 'X',
          },
          { ...base, id: 'e', type: 'SATCOM_OUTAGE', durationTicks: 3 },
        ],
        units,
        bounds,
      ),
    ).toEqual([]);
  });

  it('reports unknown units, wrong sides, duplicates and out-of-area points', () => {
    const problems = validateMselReferences(
      [
        {
          ...base,
          id: 'a',
          type: 'RUNNER_DISPATCH',
          fromUnitId: 'r-1',
          toUnitId: 'zz',
          messageText: 'x',
        },
        {
          ...base,
          id: 'a',
          type: 'CONFLICTING_REPORTS',
          unitId: 'b-1',
          altPosition: { lat: 50, lon: 50 },
          altType: 'X',
        },
      ],
      units,
      bounds,
    );
    expect(problems).toHaveLength(5);
    expect(problems.join('|')).toMatch(/wrong side.*"zz" is not a unit|"zz" is not a unit/s);
    expect(
      validateMselReferences(
        [{ ...base, type: 'ADVERSARY_MOVE', unitId: 'r-1', destination: { lat: 50, lon: 50 } }],
        units,
      ),
    ).toEqual([]);
  });

  it('checks the air and cyber injects: the UAV must be a friendly air unit, the C2 target friendly', () => {
    const withDomains = [
      { id: 'b-uav', side: 'BLUE' as const, domain: 'AIR' as const },
      { id: 'b-pl', side: 'BLUE' as const, domain: 'LAND' as const },
      { id: 'r-uav', side: 'RED' as const, domain: 'AIR' as const },
    ];
    const gps = (unitId: string) => ({
      ...base,
      id: `g-${unitId}`,
      type: 'GPS_SPOOF' as const,
      unitId,
      offsetM: 1500,
      bearingDeg: 45,
      durationTicks: 120,
    });
    const c2 = (targetUnitId: string) => ({
      ...base,
      id: `c-${targetUnitId}`,
      type: 'C2_COMPROMISE' as const,
      targetUnitId,
      driftMps: 5,
      durationTicks: 300,
    });
    expect(validateMselReferences([gps('b-uav'), c2('b-pl')], withDomains, bounds)).toEqual([]);
    const problems = validateMselReferences(
      [gps('b-pl'), gps('r-uav'), gps('nope'), c2('r-uav')],
      withDomains,
      bounds,
    );
    expect(problems).toHaveLength(4);
    expect(problems.join(' ')).toMatch(/not an air unit/);
    // shapes: offset, bearing and drift have sensible limits
    expect(injectSchema.safeParse({ ...gps('b-uav'), offsetM: 5 }).success).toBe(false);
    expect(injectSchema.safeParse({ ...gps('b-uav'), bearingDeg: 360 }).success).toBe(false);
    expect(injectSchema.safeParse({ ...c2('b-pl'), driftMps: 0 }).success).toBe(false);
    expect(injectSchema.safeParse(gps('b-uav')).success).toBe(true);
    expect(injectSchema.safeParse(c2('b-pl')).success).toBe(true);
  });
});
