import { describe, expect, it } from 'vitest';
import type { InjectType } from '@vyuha/shared';
import { silentRidge } from './silentRidge';

describe('Op Silent Ridge scenario', () => {
  const { msel, initialUnits: units, areaBounds: b } = silentRidge;

  it('has at least 12 injects covering every required inject kind', () => {
    expect(msel.length).toBeGreaterThanOrEqual(12);
    const kinds = new Set<InjectType>(msel.map((i) => i.type));
    const required: InjectType[] = [
      'JAM_CHANNEL',
      'CONFLICTING_REPORTS',
      'SPOOF_ORDER',
      'SATCOM_OUTAGE',
      'RUNNER_DISPATCH',
      'WEATHER_CHANGE',
    ];
    for (const k of required) expect(kinds.has(k)).toBe(true);
  });

  it('has unique, time-ordered inject ids', () => {
    expect(new Set(msel.map((i) => i.id)).size).toBe(msel.length);
    const ticks = msel.map((i) => i.tick);
    expect(ticks).toEqual([...ticks].sort((a, c) => a - c));
  });

  it('has BLUE and RED units across LAND, AIR, CYBER and EW with unique ids inside the bounds', () => {
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
    for (const side of ['BLUE', 'RED'] as const) {
      const domains = new Set(units.filter((u) => u.side === side).map((u) => u.domain));
      expect([...domains].sort()).toEqual(['AIR', 'CYBER', 'EW', 'LAND']);
    }
    for (const u of units) {
      expect(u.position.lat).toBeGreaterThan(b.south);
      expect(u.position.lat).toBeLessThan(b.north);
      expect(u.position.lon).toBeGreaterThan(b.west);
      expect(u.position.lon).toBeLessThan(b.east);
    }
  });

  it('only references existing units from injects', () => {
    const ids = new Set(units.map((u) => u.id));
    for (const i of msel) {
      if ('unitId' in i) expect(ids.has(i.unitId)).toBe(true);
      if ('targetUnitId' in i) expect(ids.has(i.targetUnitId)).toBe(true);
      if ('fromUnitId' in i) expect(ids.has(i.fromUnitId)).toBe(true);
      if ('toUnitId' in i) expect(ids.has(i.toUnitId)).toBe(true);
    }
  });
});
