import { describe, expect, it } from 'vitest';
import { elevationRange, isValidGrid } from '@vyuha/engine';
import { bundledGeo } from './bundled';
import { SILENT_RIDGE_ID, silentRidge } from '../seed/silentRidge';

describe('bundled Op Silent Ridge geodata', () => {
  const geo = bundledGeo(SILENT_RIDGE_ID);

  it('ships a valid 64x64 grid covering the scenario bounds', () => {
    expect(geo).not.toBeNull();
    expect(geo?.terrain.rows).toBe(64);
    expect(geo?.terrain.cols).toBe(64);
    expect(geo?.terrain.bbox).toEqual(silentRidge.areaBounds);
    expect(geo && isValidGrid(geo.terrain)).toBe(true);
  });

  it('contains real high-altitude Ladakh terrain (Leh is ~3,500 m, ridges far higher)', () => {
    const { min, max } = elevationRange(geo!.terrain);
    expect(min).toBeGreaterThan(3000);
    expect(max).toBeGreaterThan(4500);
  });

  it('has sane weather values and no bundle for other scenarios', () => {
    expect(geo?.weather.visibilityM).toBeGreaterThan(0);
    expect(bundledGeo('other')).toBeNull();
  });
});
