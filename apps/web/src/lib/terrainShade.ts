import { bilinearElevation, elevationRange } from '@vyuha/engine';
import type { AreaBounds, TerrainGridDto } from '@vyuha/shared';
import { elevationColor } from './terrainColor';

export interface Shaded {
  width: number;
  height: number;
  /** RGBA, row 0 = northern edge. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQUATOR = 111_320;
/** Sun from the north-west at 45 degrees, the cartographic default. */
const AZIMUTH = (315 * Math.PI) / 180;
const ZENITH = (45 * Math.PI) / 180;
/** Heights are stretched so a coarse 90 m grid still reads as relief. */
const EXAGGERATION = 2;

/** A contour interval of 100, 250, 500, 1000 ... m that gives roughly eight lines across the range. */
export function contourInterval(rangeM: number): number {
  const target = Math.max(rangeM, 1) / 8;
  for (const step of [50, 100, 250, 500, 1000, 2000]) if (step >= target) return step;
  return 2000;
}

/**
 * Hillshade + hypsometric tint + contour lines drawn from the stored elevation grid. This is the base map
 * of last resort: it needs no tiles, no network and no extra data, so a map is never blank.
 */
export function shadeTerrain(grid: TerrainGridDto, bounds: AreaBounds, width = 512): Shaded {
  const midLat = ((bounds.north + bounds.south) / 2) * (Math.PI / 180);
  const latSpan = bounds.north - bounds.south;
  const lonSpan = bounds.east - bounds.west;
  const cosLat = Math.cos(midLat);
  const height = Math.max(2, Math.round((width * latSpan) / (lonSpan * cosLat)));
  const { min, max } = elevationRange(grid);

  // Resample the coarse grid to pixel resolution.
  const elev = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const lat = bounds.north - ((y + 0.5) / height) * latSpan;
    for (let x = 0; x < width; x++) {
      const lon = bounds.west + ((x + 0.5) / width) * lonSpan;
      elev[y * width + x] = bilinearElevation(grid, lat, lon) ?? min;
    }
  }

  const dx = (lonSpan * M_PER_DEG_LON_EQUATOR * cosLat) / width;
  const dy = (latSpan * M_PER_DEG_LAT) / height;
  const interval = contourInterval(max - min);
  const at = (x: number, y: number): number =>
    elev[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))] ?? min;
  const band = (x: number, y: number): number => Math.floor(at(x, y) / interval);

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dzdx = ((at(x + 1, y) - at(x - 1, y)) / (2 * dx)) * EXAGGERATION;
      const dzdy = ((at(x, y + 1) - at(x, y - 1)) / (2 * dy)) * EXAGGERATION;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const lit = Math.max(
        0,
        Math.cos(ZENITH) * Math.cos(slope) +
          Math.sin(ZENITH) * Math.sin(slope) * Math.cos(AZIMUTH - aspect),
      );
      const [r, g, b] = elevationColor(at(x, y), min, max);
      const contour = band(x, y) !== band(x + 1, y) || band(x, y) !== band(x, y + 1);
      const k = (0.4 + 0.75 * lit) * (contour ? 0.6 : 1);
      const i = (y * width + x) * 4;
      data[i] = r * k;
      data[i + 1] = g * k;
      data[i + 2] = b * k;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}
