/**
 * Terrain grid maths. Grid convention (shared by ingestion, storage, UI and the simulation):
 * row-major, row 0 = NORTH edge, col 0 = WEST edge; samples sit on the bbox edges, so
 * lat(row) = north - row * (north - south) / (rows - 1), lon(col) = west + col * (east - west) / (cols - 1).
 */
export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface TerrainGridData {
  rows: number;
  cols: number;
  bbox: GeoBounds;
  elevations: readonly number[];
}

function assertDims(rows: number, cols: number): void {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 2 || cols < 2) {
    throw new RangeError('Grid must have at least 2 rows and 2 columns');
  }
}

/** Coordinates of every grid sample, in row-major order (matches `elevations` layout). */
export function sampleGridPoints(bbox: GeoBounds, rows: number, cols: number): GeoPoint[] {
  assertDims(rows, cols);
  const points: GeoPoint[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = bbox.north - (r * (bbox.north - bbox.south)) / (rows - 1);
    for (let c = 0; c < cols; c++) {
      points.push({ lat, lon: bbox.west + (c * (bbox.east - bbox.west)) / (cols - 1) });
    }
  }
  return points;
}

/** Splits items into consecutive chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('Chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isValidGrid(grid: TerrainGridData): boolean {
  return (
    grid.rows >= 2 &&
    grid.cols >= 2 &&
    grid.elevations.length === grid.rows * grid.cols &&
    grid.elevations.every((e) => Number.isFinite(e))
  );
}

/** Bilinear elevation (metres) at a coordinate, or null when it lies outside the grid's bbox. */
export function bilinearElevation(grid: TerrainGridData, lat: number, lon: number): number | null {
  const { bbox, rows, cols, elevations } = grid;
  if (lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east) return null;

  const y = ((bbox.north - lat) / (bbox.north - bbox.south)) * (rows - 1);
  const x = ((lon - bbox.west) / (bbox.east - bbox.west)) * (cols - 1);
  const r0 = Math.min(Math.floor(y), rows - 2);
  const c0 = Math.min(Math.floor(x), cols - 2);
  const fy = y - r0;
  const fx = x - c0;

  const at = (r: number, c: number): number => {
    const v = elevations[r * cols + c];
    if (v === undefined) throw new RangeError('Elevation array shorter than rows*cols');
    return v;
  };
  const top = at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx;
  const bottom = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

export function elevationRange(grid: TerrainGridData): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const e of grid.elevations) {
    if (e < min) min = e;
    if (e > max) max = e;
  }
  return { min, max };
}
