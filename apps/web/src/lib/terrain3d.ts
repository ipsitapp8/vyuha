import { addProtocol, type Map as MapLibreMap } from 'maplibre-gl';
import { bilinearElevation, elevationRange } from '@vyuha/engine';
import type { TerrainGridDto } from '@vyuha/shared';
import { api } from './api';

/**
 * 3D terrain from the elevation grid the scenario already stores. MapLibre wants elevation as
 * "raster-dem" image tiles; instead of a tile server, a small protocol handler paints each tile in the
 * browser from the grid, so the 3D view works with the network unplugged.
 */

export const DEM_PROTOCOL = 'vyuhadem';
export const DEM_SOURCE = 'vyuha-dem';
export const DEM_TILE_SIZE = 256;
const DEM_MAX_ZOOM = 12;
/** The grid is coarse (64 x 64), so relief is stretched a little to read at a glance. */
export const TERRAIN_EXAGGERATION = 1.6;
export const TERRAIN_PITCH = 60;

/** Longitude of a tile's left edge and latitude of its top edge (Web Mercator). */
export function tileLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
export function tileLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768. */
export function encodeTerrarium(elevationM: number): [number, number, number] {
  const v = Math.min(65535.99, Math.max(0, elevationM + 32768));
  return [Math.floor(v / 256), Math.floor(v % 256), Math.floor((v - Math.floor(v)) * 256)];
}
export const decodeTerrarium = (r: number, g: number, b: number): number =>
  r * 256 + g + b / 256 - 32768;

/**
 * One elevation tile as RGBA pixels. Points outside the grid take the height of its nearest edge, so
 * the terrain runs out flat instead of dropping off a cliff at the border of the exercise area.
 */
export function demTile(
  grid: TerrainGridDto,
  z: number,
  x: number,
  y: number,
  size = DEM_TILE_SIZE,
): Uint8ClampedArray<ArrayBuffer> {
  const { bbox } = grid;
  const { min } = elevationRange(grid);
  const eps = 1e-9;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let py = 0; py < size; py++) {
    const lat = tileLat(y + (py + 0.5) / size, z);
    const clampedLat = Math.min(bbox.north - eps, Math.max(bbox.south + eps, lat));
    for (let px = 0; px < size; px++) {
      const lon = tileLon(x + (px + 0.5) / size, z);
      const clampedLon = Math.min(bbox.east - eps, Math.max(bbox.west + eps, lon));
      const h = bilinearElevation(grid, clampedLat, clampedLon) ?? min;
      const [r, g, b] = encodeTerrarium(h);
      const i = (py * size + px) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const DEM_URL = new RegExp(`^${DEM_PROTOCOL}://([^/]+)/(\\d+)/(\\d+)/(\\d+)$`);

export function parseDemUrl(
  url: string,
): { scenarioId: string; z: number; x: number; y: number } | null {
  const m = DEM_URL.exec(url);
  if (!m) return null;
  return {
    scenarioId: decodeURIComponent(m[1] ?? ''),
    z: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
  };
}

const grids = new Map<string, Promise<TerrainGridDto>>();
/** The scenario's elevation grid, fetched once from the VYUHA server (never from the internet). */
export function terrainGrid(scenarioId: string): Promise<TerrainGridDto> {
  let hit = grids.get(scenarioId);
  if (!hit) {
    hit = api.getScenarioTerrain(scenarioId);
    grids.set(scenarioId, hit);
    hit.catch(() => grids.delete(scenarioId));
  }
  return hit;
}

async function tileImage(
  pixels: Uint8ClampedArray<ArrayBuffer>,
): Promise<ImageBitmap | ArrayBuffer> {
  const image = new ImageData(pixels, DEM_TILE_SIZE, DEM_TILE_SIZE);
  if (typeof createImageBitmap === 'function') return createImageBitmap(image);
  const canvas = document.createElement('canvas');
  canvas.width = DEM_TILE_SIZE;
  canvas.height = DEM_TILE_SIZE;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not encode the elevation tile');
  return blob.arrayBuffer();
}

let registered = false;
function registerDemProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol(DEM_PROTOCOL, async (request) => {
    const tile = parseDemUrl(request.url);
    if (!tile) throw new Error(`Bad elevation tile address: ${request.url}`);
    const grid = await terrainGrid(tile.scenarioId);
    return { data: await tileImage(demTile(grid, tile.z, tile.x, tile.y)) };
  });
}

/** Turns the 3D terrain on or off. Safe to call again after the map's style has been replaced. */
export function applyTerrain3d(map: MapLibreMap, scenarioId: string, on: boolean): void {
  try {
    if (!on) {
      if (map.getTerrain()) map.setTerrain(null);
      if (map.getPitch() !== 0) map.easeTo({ pitch: 0, duration: 400 });
      map.getContainer().dataset['terrain3d'] = 'off';
      return;
    }
    registerDemProtocol();
    if (!map.getSource(DEM_SOURCE)) {
      map.addSource(DEM_SOURCE, {
        type: 'raster-dem',
        tiles: [`${DEM_PROTOCOL}://${encodeURIComponent(scenarioId)}/{z}/{x}/{y}`],
        encoding: 'terrarium',
        tileSize: DEM_TILE_SIZE,
        maxzoom: DEM_MAX_ZOOM,
      });
    }
    map.setTerrain({ source: DEM_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
    if (map.getPitch() < TERRAIN_PITCH) map.easeTo({ pitch: TERRAIN_PITCH, duration: 400 });
    // set only once the terrain is really on, so tests (and CSS) can tell
    map.getContainer().dataset['terrain3d'] = 'on';
  } catch {
    /* the style is being swapped: the caller applies it again on the next style.load */
  }
}

// ---- Preference (shared by the trainee and instructor maps) ---------------------------------

const PREF_KEY = 'vyuha.terrain3d';

export function readTerrain3dPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveTerrain3dPref(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, String(on));
  } catch {
    /* storage blocked: the choice just will not persist */
  }
}
