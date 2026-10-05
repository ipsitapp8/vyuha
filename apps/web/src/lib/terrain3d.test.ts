import { describe, expect, it } from 'vitest';
import { bilinearElevation } from '@vyuha/engine';
import type { TerrainGridDto } from '@vyuha/shared';
import {
  decodeTerrarium,
  demTile,
  DEM_PROTOCOL,
  encodeTerrarium,
  parseDemUrl,
  tileLat,
  tileLon,
} from './terrain3d';

/** 3 x 3 grid over a small box in Ladakh: 3000 m in the south-west rising to 3800 m in the north-east. */
const grid: TerrainGridDto = {
  rows: 3,
  cols: 3,
  bbox: { south: 34.0, west: 77.0, north: 34.2, east: 77.2 },
  elevations: [3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800],
};

describe('terrarium encoding', () => {
  it('round-trips elevations to well under a metre', () => {
    for (const h of [-420, 0, 3524.37, 8848.86]) {
      expect(decodeTerrarium(...encodeTerrarium(h))).toBeCloseTo(h, 1);
    }
  });
});

describe('tile addressing', () => {
  it('maps tile corners to longitude and latitude', () => {
    expect(tileLon(0, 0)).toBe(-180);
    expect(tileLon(1, 1)).toBe(0);
    expect(tileLat(0, 0)).toBeCloseTo(85.0511, 3);
    expect(tileLat(1, 1)).toBeCloseTo(0, 6);
  });

  it('parses only its own addresses', () => {
    expect(parseDemUrl(`${DEM_PROTOCOL}://scenario-op-silent-ridge/11/1463/817`)).toEqual({
      scenarioId: 'scenario-op-silent-ridge',
      z: 11,
      x: 1463,
      y: 817,
    });
    expect(parseDemUrl('https://tiles.example.com/11/1/2.png')).toBeNull();
    expect(parseDemUrl(`${DEM_PROTOCOL}://x/1/2`)).toBeNull();
  });
});

describe('elevation tiles from the stored grid', () => {
  // the zoom-11 tile around the middle of the grid
  const z = 11;
  const lon = 77.1;
  const lat = 34.1;
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const size = 64;
  const tile = demTile(grid, z, x, y, size);
  const heightAt = (px: number, py: number): number => {
    const i = (py * size + px) * 4;
    return decodeTerrarium(tile[i] ?? 0, tile[i + 1] ?? 0, tile[i + 2] ?? 0);
  };
  const lonOf = (px: number): number => tileLon(x + (px + 0.5) / size, z);
  const latOf = (py: number): number => tileLat(y + (py + 0.5) / size, z);

  it('is an opaque RGBA image of the requested size', () => {
    expect(tile).toHaveLength(size * size * 4);
    expect(tile[3]).toBe(255);
  });

  it('matches the grid at every pixel inside the exercise area', () => {
    let checked = 0;
    for (let py = 0; py < size; py += 5) {
      for (let px = 0; px < size; px += 5) {
        const want = bilinearElevation(grid, latOf(py), lonOf(px));
        if (want === null) continue;
        expect(heightAt(px, py)).toBeCloseTo(want, 0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('runs out flat past the border: no heights outside the range of the grid', () => {
    // a tile well to the west of the grid takes the height of the nearest edge
    const outside = demTile(grid, z, x - 3, y, 16);
    for (let i = 0; i < outside.length; i += 4) {
      const h = decodeTerrarium(outside[i] ?? 0, outside[i + 1] ?? 0, outside[i + 2] ?? 0);
      expect(h).toBeGreaterThanOrEqual(2999);
      expect(h).toBeLessThanOrEqual(3801);
    }
  });

  it('is computed from the grid alone, so the same tile always has the same bytes', () => {
    expect(Array.from(demTile(grid, z, x, y, size))).toEqual(Array.from(tile));
  });
});
