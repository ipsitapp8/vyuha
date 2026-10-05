import { addProtocol, type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { PMTiles, Protocol } from 'pmtiles';
import type { AreaBounds, TerrainGridDto } from '@vyuha/shared';
import { api } from './api';
import { shadeTerrain } from './terrainShade';

export type MapMode = 'offline' | 'online';

/** `VITE_MAP_MODE` (docker compose: `MAP_MODE`). Anything but "online" means offline, the safe default. */
export function parseMapMode(raw: unknown): MapMode {
  return raw === 'online' ? 'online' : 'offline';
}

const MAP_MODE: MapMode = parseMapMode(import.meta.env.VITE_MAP_MODE);
const ONLINE_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';

const PMTILES_PATH = 'tiles/area.pmtiles';

const BLANK: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

/** Absolute URL of a file under the web app's base path (map libraries need absolute URLs). */
function local(path: string): string {
  // string concatenation, not new URL(path): that would percent-encode the {fontstack} placeholders
  return new URL(import.meta.env.BASE_URL, window.location.href).href + path;
}

/**
 * The offline style: vector tiles from the bundled PMTiles file, glyphs and sprites from
 * `public/map-assets`. Every URL is on this origin, so it works with the network unplugged.
 */
export function offlineStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: local('map-assets/fonts/{fontstack}/{range}.pbf'),
    sprite: local('map-assets/sprites/v4/light'),
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${local(PMTILES_PATH)}`,
        // plain text: the style must not carry any external link
        attribution: '© OpenStreetMap contributors (ODbL)',
      },
    },
    layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
  };
}

/** Every font stack name used in a style value, whether a plain list or an expression. */
function collectFonts(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('Noto Sans')) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectFonts(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectFonts(v, into);
  }
}

/** Font stacks the offline style needs; a test keeps public/map-assets in step with them. */
export function requiredFontStacks(): string[] {
  const used = new Set<string>();
  for (const layer of offlineStyle().layers) {
    if (layer.type === 'symbol') collectFonts(layer.layout?.['text-font'], used);
  }
  return [...used].sort();
}

let protocolRegistered = false;
function registerPmtiles(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  const protocol = new Protocol();
  addProtocol('pmtiles', protocol.tile);
}

let available: Promise<boolean> | null = null;
/** True when `tiles/area.pmtiles` exists and is a real PMTiles archive (not an SPA fallback page). */
export function pmtilesAvailable(): Promise<boolean> {
  available ??= fetch(local(PMTILES_PATH), { headers: { Range: 'bytes=0-6' } })
    .then(async (res) => {
      if (!res.ok) return false;
      const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 7);
      return new TextDecoder().decode(head) === 'PMTiles';
    })
    .catch(() => false);
  return available;
}

/** True when the tile archive holds the whole exercise area (its tiles stop at the archive's edge). */
export function archiveCovers(archive: AreaBounds, area: AreaBounds): boolean {
  return (
    area.south >= archive.south &&
    area.north <= archive.north &&
    area.west >= archive.west &&
    area.east <= archive.east
  );
}

let archiveBounds: Promise<AreaBounds | null> | null = null;
/** The area the bundled PMTiles archive covers, read from its header; null when it cannot be read. */
export function pmtilesBounds(): Promise<AreaBounds | null> {
  archiveBounds ??= new PMTiles(local(PMTILES_PATH))
    .getHeader()
    .then((h) => ({ south: h.minLat, west: h.minLon, north: h.maxLat, east: h.maxLon }))
    .catch(() => null);
  return archiveBounds;
}

/** Base map of last resort: hillshade, elevation tint and contours from the stored terrain grid. */
export function terrainStyle(grid: TerrainGridDto, bounds: AreaBounds): StyleSpecification {
  const shaded = shadeTerrain(grid, bounds);
  const canvas = document.createElement('canvas');
  canvas.width = shaded.width;
  canvas.height = shaded.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return BLANK;
  ctx.putImageData(new ImageData(shaded.data, shaded.width, shaded.height), 0, 0);
  return {
    version: 8,
    sources: {
      'basemap-terrain': {
        type: 'image',
        url: canvas.toDataURL('image/png'),
        coordinates: [
          [bounds.west, bounds.north],
          [bounds.east, bounds.north],
          [bounds.east, bounds.south],
          [bounds.west, bounds.south],
        ],
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } },
      {
        id: 'terrain-shade',
        type: 'raster',
        source: 'basemap-terrain',
        paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
      },
    ],
  };
}

export interface BasemapOptions {
  bounds: AreaBounds;
  /** Used to fetch terrain for the fallback; pass `terrain` instead when it is already loaded. */
  scenarioId?: string;
  terrain?: TerrainGridDto | null;
  /** Called when the full base map is unavailable and the fallback is shown instead. */
  onFallback: () => void;
}

/**
 * Gives `map` its base layer: offline PMTiles (default), the online style, or, if either cannot be
 * used, a hillshade drawn from the terrain grid. Returns a function that stops any pending work.
 */
export function attachBasemap(map: MapLibreMap, opts: BasemapOptions): () => void {
  let stopped = false;
  let usedFallback = false;

  const fallBack = async (): Promise<void> => {
    if (stopped || usedFallback) return;
    usedFallback = true;
    let grid: TerrainGridDto | null = opts.terrain ?? null;
    if (!grid && opts.scenarioId) {
      try {
        grid = await api.getScenarioTerrain(opts.scenarioId);
      } catch {
        grid = null;
      }
    }
    if (stopped) return;
    map.setStyle(grid ? terrainStyle(grid, opts.bounds) : BLANK);
    opts.onFallback();
  };

  const start = async (): Promise<void> => {
    if (MAP_MODE === 'offline') {
      // The archive is cut to one area. A scenario somewhere else (the desert one) would get an empty
      // street map from it, so it takes the terrain base map instead: never a blank map.
      const covered =
        (await pmtilesAvailable()) &&
        archiveCovers((await pmtilesBounds()) ?? opts.bounds, opts.bounds);
      if (covered) {
        if (stopped) return;
        registerPmtiles();
        map.setStyle(offlineStyle());
      } else {
        await fallBack();
      }
    } else {
      map.setStyle(ONLINE_STYLE_URL);
    }
  };

  map.on('error', () => {
    if (!usedFallback && !stopped && !map.isStyleLoaded()) void fallBack();
  });
  void start();
  return () => {
    stopped = true;
  };
}

/** Style a map starts with before `attachBasemap` has chosen the real one. */
export const INITIAL_STYLE: StyleSpecification = BLANK;
