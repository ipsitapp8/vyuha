import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlineStyle, parseMapMode, requiredFontStacks, terrainStyle } from './basemap';

// vitest runs with apps/web as the working directory
const publicDir = `${resolve('public')}/`;

describe('map mode', () => {
  it('defaults to offline and only switches to online when asked', () => {
    expect(parseMapMode(undefined)).toBe('offline');
    expect(parseMapMode('offline')).toBe('offline');
    expect(parseMapMode('ONLINE')).toBe('offline');
    expect(parseMapMode('online')).toBe('online');
  });
});

describe('offline style', () => {
  it('contains no URL that leaves this origin', () => {
    const json = JSON.stringify(offlineStyle());
    const urls = json.match(/[a-z][a-z0-9+.-]*:\/\/[^"\\ ]+/gi) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      const real = url.replace(/^pmtiles:\/\//, '');
      expect(new URL(real).origin, url).toBe(window.location.origin);
    }
    expect(json).not.toMatch(
      /openfreemap|protomaps\.(github\.io|com)|openstreetmap\.org|unpkg|cdn/i,
    );
  });

  it('draws the basemap layers from the local PMTiles source', () => {
    const style = offlineStyle();
    expect(style.layers.length).toBeGreaterThan(30);
    expect(Object.keys(style.sources)).toEqual(['protomaps']);
    expect(style.glyphs).toContain('/map-assets/fonts/{fontstack}/{range}.pbf');
    expect(style.sprite).toContain('/map-assets/sprites/v4/light');
  });
});

describe('bundled offline assets', () => {
  it('has a real PMTiles archive for the exercise area', () => {
    const file = `${publicDir}tiles/area.pmtiles`;
    expect(existsSync(file), 'run scripts/fetch-tiles.sh once while online').toBe(true);
    expect(statSync(file).size).toBeGreaterThan(100_000);
    expect(readFileSync(file).subarray(0, 7).toString('latin1')).toBe('PMTiles');
  });

  it('has every font stack and glyph range the style asks for', () => {
    const stacks = requiredFontStacks();
    expect(stacks.length).toBeGreaterThan(0);
    for (const stack of stacks) {
      // MapLibre requests 0-255 first, then further 256-glyph ranges as labels need them.
      expect(existsSync(`${publicDir}map-assets/fonts/${stack}/0-255.pbf`), stack).toBe(true);
      expect(existsSync(`${publicDir}map-assets/fonts/${stack}/256-511.pbf`), stack).toBe(true);
    }
  });

  it('has the sprite sheet at both pixel ratios', () => {
    for (const f of ['light.json', 'light.png', 'light@2x.json', 'light@2x.png']) {
      expect(existsSync(`${publicDir}map-assets/sprites/v4/${f}`), f).toBe(true);
    }
    const index = JSON.parse(readFileSync(`${publicDir}map-assets/sprites/v4/light.json`, 'utf8'));
    expect(Object.keys(index).length).toBeGreaterThan(10);
  });
});

describe('terrain fallback style', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a self-contained image source over the area bounds', () => {
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      putImageData,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,AAAA',
    );
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
    );
    const bounds = { south: 34, west: 77, north: 34.2, east: 77.3 };
    const grid = {
      rows: 3,
      cols: 3,
      bbox: bounds,
      elevations: [3000, 3100, 3200, 3000, 3100, 3200, 3000, 3100, 3200],
    };
    const style = terrainStyle(grid, bounds);
    expect(putImageData).toHaveBeenCalledOnce();
    expect(style.layers.map((l) => l.id)).toEqual(['bg', 'terrain-shade']);
    const source = style.sources['basemap-terrain'];
    expect(source?.type).toBe('image');
    expect(JSON.stringify(style)).not.toMatch(/https?:\/\//);
  });
});
