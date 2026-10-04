import { describe, expect, it } from 'vitest';
import {
  bilinearElevation,
  chunk,
  elevationRange,
  isValidGrid,
  sampleGridPoints,
  type TerrainGridData,
} from './terrain';

const bbox = { south: 0, west: 10, north: 4, east: 18 };

describe('sampleGridPoints', () => {
  it('returns rows*cols points row-major, north-west first, corners on the bbox', () => {
    const pts = sampleGridPoints(bbox, 3, 5);
    expect(pts).toHaveLength(15);
    expect(pts[0]).toEqual({ lat: 4, lon: 10 });
    expect(pts[4]).toEqual({ lat: 4, lon: 18 });
    expect(pts[14]).toEqual({ lat: 0, lon: 18 });
    expect(pts[5]).toEqual({ lat: 2, lon: 10 });
  });
  it('rejects degenerate grids', () => {
    expect(() => sampleGridPoints(bbox, 1, 5)).toThrow(RangeError);
  });
});

describe('chunk', () => {
  it('splits into batches of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
  it('splits a 64x64 grid into 41 batches of <=100', () => {
    const batches = chunk(sampleGridPoints(bbox, 64, 64), 100);
    expect(batches).toHaveLength(41);
    expect(batches.every((b) => b.length <= 100)).toBe(true);
    expect(batches.flat()).toHaveLength(4096);
  });
});

// 3x3 plane: elevation = 100*(col) + 10*(2-row)  -> linear in lon and lat
const plane: TerrainGridData = {
  rows: 3,
  cols: 3,
  bbox: { south: 0, west: 0, north: 2, east: 2 },
  elevations: [0, 100, 200, 10, 110, 210, 20, 120, 220].map((_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    return 100 * c + 10 * (2 - r);
  }),
};

describe('bilinearElevation', () => {
  it('returns exact samples on grid nodes', () => {
    expect(bilinearElevation(plane, 2, 0)).toBe(20); // NW node
    expect(bilinearElevation(plane, 0, 2)).toBe(200); // SE node
    expect(bilinearElevation(plane, 1, 1)).toBe(110);
  });
  it('interpolates linearly between nodes', () => {
    // elevation = 100*lon + 10*lat for this plane
    expect(bilinearElevation(plane, 0.5, 1.5)).toBeCloseTo(155, 9);
    expect(bilinearElevation(plane, 1.25, 0.4)).toBeCloseTo(52.5, 9);
  });
  it('interpolates a non-planar cell as the bilinear blend of its four corners', () => {
    const g: TerrainGridData = {
      rows: 2,
      cols: 2,
      bbox: { south: 0, west: 0, north: 1, east: 1 },
      elevations: [0, 100, 200, 300], // NW, NE, SW, SE
    };
    expect(bilinearElevation(g, 0.5, 0.5)).toBeCloseTo(150, 9);
    expect(bilinearElevation(g, 1, 0.5)).toBeCloseTo(50, 9); // north edge midpoint
  });
  it('returns null outside the bbox', () => {
    expect(bilinearElevation(plane, 2.01, 1)).toBeNull();
    expect(bilinearElevation(plane, 1, -0.01)).toBeNull();
  });
});

describe('grid validation and range', () => {
  it('validates element count and finiteness', () => {
    expect(isValidGrid(plane)).toBe(true);
    expect(isValidGrid({ ...plane, elevations: [1, 2, 3] })).toBe(false);
    expect(isValidGrid({ ...plane, elevations: [...plane.elevations.slice(1), NaN] })).toBe(false);
  });
  it('computes min/max', () => {
    expect(elevationRange(plane)).toEqual({ min: 0, max: 220 });
  });
});
