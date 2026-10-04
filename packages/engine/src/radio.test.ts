import { describe, expect, it } from 'vitest';
import { haversineM } from './geometry';
import { mulberry32 } from './prng';
import {
  channelQuality,
  corruptPosition,
  corruptText,
  deliverMessage,
  distanceFactor,
  elevationAt,
  lineOfSight,
  losFactor,
  weatherFactor,
  type LinkEnv,
} from './radio';
import { CLEAR, makeTerrain } from './testkit';
import type { Channel } from './types';

const west = { lat: 34.1, lon: 77.03 };
const east = { lat: 34.1, lon: 77.17 };

const zeroJam = (): Record<Channel, number> => ({
  VHF: 0,
  HF: 0,
  SATCOM: 0,
  DATALINK: 0,
  RUNNER: 0,
});
const env = (
  ridge: number,
  jam: Partial<Record<Channel, number>> = {},
  satcomUp = true,
): LinkEnv => ({
  terrain: makeTerrain(3000, ridge),
  weather: CLEAR,
  jamming: { ...zeroJam(), ...jam },
  satcomUp,
});

describe('lineOfSight', () => {
  it('is clear over flat terrain at short range', () => {
    expect(lineOfSight(makeTerrain(), west, { lat: 34.1, lon: 77.05 })).toBe(true);
  });
  it('accounts for earth curvature: 13 km between 2 m antennas is beyond the horizon, masts fix it', () => {
    expect(lineOfSight(makeTerrain(), west, east)).toBe(false);
    expect(lineOfSight(makeTerrain(), west, east, { aHeightM: 15, bHeightM: 15 })).toBe(true);
  });
  it('is blocked by a ridge between the two points', () => {
    expect(lineOfSight(makeTerrain(3000, 4500), west, east)).toBe(false);
  });
  it('is restored when one end is high enough (drone over the ridge)', () => {
    expect(lineOfSight(makeTerrain(3000, 4500), west, east, { aHeightM: 4000 })).toBe(true);
  });
  it('clamps coordinates outside the grid instead of failing', () => {
    expect(elevationAt(makeTerrain(), { lat: 90, lon: 0 })).toBe(3000);
  });
});

describe('channel quality model', () => {
  it('distance factor falls quadratically to 0 at range; SATCOM ignores distance', () => {
    expect(distanceFactor('VHF', 0)).toBe(1);
    expect(distanceFactor('VHF', 12_500)).toBeCloseTo(0.75, 9);
    expect(distanceFactor('VHF', 30_000)).toBe(0);
    expect(distanceFactor('SATCOM', 1e7)).toBe(1);
  });
  it('terrain blocks VHF/DATALINK hard, HF barely, SATCOM not at all', () => {
    expect(losFactor('VHF', false)).toBeLessThan(0.2);
    expect(losFactor('DATALINK', false)).toBeLessThan(0.2);
    expect(losFactor('HF', false)).toBeGreaterThan(0.8);
    expect(losFactor('SATCOM', false)).toBe(1);
    expect(losFactor('VHF', true)).toBe(1);
  });
  it('weather hurts HF most and RUNNER not at all', () => {
    const storm = { visibilityM: 500, precipitationMm: 8, windKph: 60 };
    expect(weatherFactor('HF', storm)).toBeLessThan(weatherFactor('VHF', storm));
    expect(weatherFactor('HF', CLEAR)).toBeGreaterThan(0.9);
    expect(weatherFactor('RUNNER', storm)).toBe(1);
    expect(weatherFactor('SATCOM', storm)).toBeLessThan(1);
    expect(weatherFactor('DATALINK', storm)).toBeLessThan(1);
  });
  it('quality is exactly base x distance x los x (1-jamming) x weather', () => {
    const q = channelQuality('VHF', {
      distanceM: 12_500,
      los: false,
      jamming: 0.5,
      weather: CLEAR,
      satcomUp: true,
    });
    expect(q).toBeCloseTo(0.95 * 0.75 * 0.15 * 0.5 * (1 - 0.0), 9);
  });
  it('SATCOM outage zeroes SATCOM; RUNNER is always 1 even under jamming', () => {
    const base = { distanceM: 1000, los: true, jamming: 0.9, weather: CLEAR };
    expect(channelQuality('SATCOM', { ...base, satcomUp: false })).toBe(0);
    expect(channelQuality('RUNNER', { ...base, satcomUp: true })).toBe(1);
  });
});

const near = { lat: 34.1, lon: 77.05 }; // ~2 km from `west`, same side of the ridge
const link = (channel: Channel, to = east) => ({
  channel,
  from: west,
  to,
  fromHeightM: 3,
  toHeightM: 3,
});

function tally(channel: Channel, e: LinkEnv, n = 3000, to = east): Record<string, number> {
  const rng = mulberry32(11);
  const out: Record<string, number> = { DELIVERED: 0, DELAYED: 0, DROPPED: 0, CORRUPTED: 0 };
  for (let i = 0; i < n; i++) {
    const r = deliverMessage(rng, link(channel, to), e);
    out[r.outcome] = (out[r.outcome] ?? 0) + 1;
  }
  return out;
}

describe('deliverMessage', () => {
  it('delivers nearly everything on a clear line of sight', () => {
    const t = tally('VHF', env(0), 3000, near);
    expect(t['DELIVERED']! / 3000).toBeGreaterThan(0.8);
  });
  it('a ridge turns VHF into mostly drops, but HF still gets through', () => {
    const vhf = tally('VHF', env(4500));
    const hf = tally('HF', env(4500));
    expect(vhf['DROPPED']! / 3000).toBeGreaterThan(0.35);
    expect(hf['DELIVERED']! + hf['DELAYED']!).toBeGreaterThan(vhf['DELIVERED']! + vhf['DELAYED']!);
  });
  it('produces all four outcomes at middling quality', () => {
    const t = tally('VHF', env(0, { VHF: 0.6 }), 3000, near);
    for (const k of ['DELIVERED', 'DELAYED', 'DROPPED', 'CORRUPTED'])
      expect(t[k]).toBeGreaterThan(0);
  });
  it('drops everything when SATCOM is down and nothing is lost on RUNNER', () => {
    expect(tally('SATCOM', env(0, {}, false), 200)['DROPPED']).toBe(200);
    const r = deliverMessage(mulberry32(1), link('RUNNER'), env(0, { VHF: 1 }));
    expect(r.outcome).toBe('DELIVERED');
    expect(r.delayTicks).toBe(Math.ceil(haversineM(west, east) / 4));
  });
  it('delay grows as quality falls', () => {
    const avgDelay = (jam: number): number => {
      const rng = mulberry32(21);
      const delays: number[] = [];
      for (let i = 0; i < 4000; i++) {
        const r = deliverMessage(rng, link('VHF'), env(0, { VHF: jam }));
        if (r.outcome === 'DELAYED' && r.delayTicks !== null) delays.push(r.delayTicks);
      }
      return delays.reduce((a, b) => a + b, 0) / delays.length;
    };
    expect(avgDelay(0.7)).toBeGreaterThan(avgDelay(0.2));
  });
  it('is deterministic for a given seed', () => {
    const a = deliverMessage(mulberry32(8), link('VHF'), env(4500));
    const b = deliverMessage(mulberry32(8), link('VHF'), env(4500));
    expect(a).toEqual(b);
  });
});

describe('corruption', () => {
  it('mutates digits in text', () => {
    const out = corruptText(mulberry32(2), 'Move to grid 1234 5678 now');
    expect(out).not.toBe('Move to grid 1234 5678 now');
    expect(out.replace(/[0-9]/g, '')).toBe('Move to grid   now');
  });
  it('still changes text that contains no digits', () => {
    expect(corruptText(mulberry32(2), 'Hold position')).not.toBe('Hold position');
    expect(corruptText(mulberry32(2), '')).toBe('');
  });
  it('displaces positions by 0.8-3 km', () => {
    const p = { lat: 34.1, lon: 77.1 };
    const d = haversineM(p, corruptPosition(mulberry32(4), p));
    expect(d).toBeGreaterThan(780);
    expect(d).toBeLessThan(3020);
  });
});
