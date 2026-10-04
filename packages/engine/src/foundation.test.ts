import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  clamp,
  haversineM,
  lerpLatLon,
  offsetByBearing,
  offsetByMeters,
  stepToward,
} from './geometry';
import { gaussian, mulberry32, pick, randInt, randRange } from './prng';

describe('prng helpers', () => {
  it('resumes the exact sequence from a saved state', () => {
    const a = mulberry32(99);
    for (let i = 0; i < 10; i++) a.next();
    const b = mulberry32(a.state());
    for (let i = 0; i < 50; i++) expect(b.next()).toBe(a.next());
  });
  it('randRange and randInt stay in bounds', () => {
    const r = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      const f = randRange(r, 10, 20);
      expect(f).toBeGreaterThanOrEqual(10);
      expect(f).toBeLessThan(20);
      const n = randInt(r, 1, 6);
      expect(Number.isInteger(n) && n >= 1 && n <= 6).toBe(true);
    }
  });
  it('gaussian is roughly standard normal', () => {
    const r = mulberry32(5);
    const xs = Array.from({ length: 4000 }, () => gaussian(r));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.08);
    expect(sd).toBeGreaterThan(0.9);
    expect(sd).toBeLessThan(1.1);
  });
  it('pick returns members and throws on empty', () => {
    const r = mulberry32(1);
    expect(['a', 'b', 'c']).toContain(pick(r, ['a', 'b', 'c']));
    expect(() => pick(r, [])).toThrow(RangeError);
  });
});

describe('geometry', () => {
  it('haversine: one degree of latitude is about 111.2 km', () => {
    const d = haversineM({ lat: 10, lon: 20 }, { lat: 11, lon: 20 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
    expect(haversineM({ lat: 1, lon: 1 }, { lat: 1, lon: 1 })).toBe(0);
  });
  it('bearing: north is 0, east is 90', () => {
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 5);
    expect(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 5);
  });
  it('offsetByMeters / offsetByBearing round-trip to the requested distance', () => {
    const p = { lat: 34.1, lon: 77.5 };
    expect(Math.abs(haversineM(p, offsetByMeters(p, 300, 400)) - 500)).toBeLessThan(2);
    expect(Math.abs(haversineM(p, offsetByBearing(p, 45, 1000)) - 1000)).toBeLessThan(3);
  });
  it('stepToward moves partially, then arrives exactly', () => {
    const a = { lat: 34, lon: 77 };
    const b = { lat: 34.01, lon: 77 };
    const part = stepToward(a, b, 200);
    expect(part.arrived).toBe(false);
    expect(haversineM(a, part.position)).toBeCloseTo(200, 0);
    expect(stepToward(a, b, 5000)).toEqual({ position: b, arrived: true });
    expect(stepToward(a, a, 10).arrived).toBe(true);
  });
  it('lerp and clamp', () => {
    expect(lerpLatLon({ lat: 0, lon: 0 }, { lat: 2, lon: 4 }, 0.5)).toEqual({ lat: 1, lon: 2 });
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
});
