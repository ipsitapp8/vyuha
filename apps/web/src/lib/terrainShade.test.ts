import { describe, expect, it } from 'vitest';
import type { AreaBounds, TerrainGridDto } from '@vyuha/shared';
import { contourInterval, shadeTerrain } from './terrainShade';

const bounds: AreaBounds = { south: 34, west: 77, north: 34.2, east: 77.3 };

/** A ramp rising to the east: elevation = 3000 + 40 m per column. */
function rampGrid(): TerrainGridDto {
  const rows = 9;
  const cols = 9;
  const elevations: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) elevations.push(3000 + c * 40);
  return { rows, cols, bbox: bounds, elevations } as TerrainGridDto;
}

const px = (s: ReturnType<typeof shadeTerrain>, x: number, y: number): number[] => {
  const i = (y * s.width + x) * 4;
  return [s.data[i] ?? 0, s.data[i + 1] ?? 0, s.data[i + 2] ?? 0, s.data[i + 3] ?? 0];
};

describe('shadeTerrain', () => {
  it('returns an opaque image whose aspect follows the geography', () => {
    const s = shadeTerrain(rampGrid(), bounds, 200);
    expect(s.width).toBe(200);
    // 0.2 deg of latitude against 0.3 deg of longitude at 34.1 N
    const expected = Math.round((200 * 0.2) / (0.3 * Math.cos((34.1 * Math.PI) / 180)));
    expect(s.height).toBe(expected);
    expect(s.data).toHaveLength(s.width * s.height * 4);
    for (let i = 3; i < s.data.length; i += 4) expect(s.data[i]).toBe(255);
  });

  it('lights slopes facing the sun and darkens the others', () => {
    // Terrain rising to the east faces west, towards the north-west sun, so it is lit.
    const east = shadeTerrain(rampGrid(), bounds, 160);
    // The same terrain mirrored faces east, away from the sun.
    const mirrored = rampGrid();
    mirrored.elevations = mirrored.elevations.map((_, i) => 3000 + (8 - (i % 9)) * 40);
    const west = shadeTerrain(mirrored, bounds, 160);
    const luma = (p: number[]): number => (p[0] ?? 0) + (p[1] ?? 0) + (p[2] ?? 0);
    // Compare interior pixels away from contour lines by averaging a row.
    const mean = (s: ReturnType<typeof shadeTerrain>): number => {
      let sum = 0;
      for (let x = 20; x < 140; x++) sum += luma(px(s, x, 40));
      return sum / 120;
    };
    expect(mean(east)).toBeGreaterThan(0);
    expect(mean(east)).not.toBeCloseTo(mean(west), 0);
  });

  it('draws contour lines where the elevation crosses an interval', () => {
    const s = shadeTerrain(rampGrid(), bounds, 160);
    const row = Array.from({ length: s.width - 2 }, (_, x) => px(s, x + 1, 30)[0] ?? 0);
    // contour pixels are darker than their neighbours in an otherwise smooth ramp
    const dark = row.filter((v, i) => i > 0 && i < row.length - 1 && v < (row[i - 1] ?? 0) * 0.8);
    expect(dark.length).toBeGreaterThan(0);
  });

  it('copes with a perfectly flat grid', () => {
    const flat: TerrainGridDto = { ...rampGrid(), elevations: new Array(81).fill(3200) };
    const s = shadeTerrain(flat, bounds, 64);
    expect(Array.from(s.data).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('contourInterval', () => {
  it('scales with the elevation range', () => {
    expect(contourInterval(100)).toBe(50);
    expect(contourInterval(1200)).toBe(250);
    expect(contourInterval(4000)).toBe(500);
    expect(contourInterval(9000)).toBe(2000);
    expect(contourInterval(100000)).toBe(2000);
  });
});
