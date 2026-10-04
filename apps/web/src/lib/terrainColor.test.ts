import { describe, expect, it } from 'vitest';
import { elevationColor } from './terrainColor';

describe('elevationColor', () => {
  it('returns the ramp ends at min and max', () => {
    expect(elevationColor(3000, 3000, 6000)).toEqual([38, 110, 140]);
    expect(elevationColor(6000, 3000, 6000)).toEqual([245, 245, 250]);
  });
  it('clamps values outside the range', () => {
    expect(elevationColor(0, 3000, 6000)).toEqual(elevationColor(3000, 3000, 6000));
    expect(elevationColor(9000, 3000, 6000)).toEqual(elevationColor(6000, 3000, 6000));
  });
  it('is the midpoint colour halfway and handles a flat grid', () => {
    expect(elevationColor(4500, 3000, 6000)).toEqual([214, 200, 110]);
    expect(elevationColor(100, 100, 100)).toEqual([38, 110, 140]);
  });
});
