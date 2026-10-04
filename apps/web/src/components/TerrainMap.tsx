import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { elevationRange } from '@vyuha/engine';
import type { AreaBounds, TerrainGridDto } from '@vyuha/shared';
import { elevationColor } from '@/lib/terrainColor';

const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';

// Used when the tile style cannot be loaded (air-gapped / offline): the terrain overlay still renders.
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

function renderHeatmap(grid: TerrainGridDto): string {
  const canvas = document.createElement('canvas');
  canvas.width = grid.cols;
  canvas.height = grid.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  const img = ctx.createImageData(grid.cols, grid.rows);
  const { min, max } = elevationRange(grid);
  grid.elevations.forEach((e, i) => {
    const [r, g, b] = elevationColor(e, min, max);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 170;
  });
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

interface Props {
  bounds: AreaBounds;
  terrain: TerrainGridDto | null;
  onError: (message: string) => void;
}

export function TerrainMap({ bounds, terrain, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let usedFallback = false;

    const map = new MapLibreMap({
      container,
      style: MAP_STYLE_URL,
      bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      fitBoundsOptions: { padding: 20 },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    const addOverlay = (): void => {
      if (!terrain || map.getSource('terrain')) return;
      try {
        map.addSource('terrain', {
          type: 'image',
          url: renderHeatmap(terrain),
          coordinates: [
            [bounds.west, bounds.north],
            [bounds.east, bounds.north],
            [bounds.east, bounds.south],
            [bounds.west, bounds.south],
          ],
        });
        map.addLayer({
          id: 'terrain',
          type: 'raster',
          source: 'terrain',
          paint: { 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
        });
      } catch {
        onError('Could not draw the terrain overlay.');
      }
    };

    map.on('style.load', addOverlay);
    map.on('error', () => {
      if (!usedFallback && !map.isStyleLoaded()) {
        usedFallback = true;
        map.setStyle(OFFLINE_STYLE);
      }
    });

    return () => map.remove();
  }, [bounds, terrain, onError]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="Map of the scenario area with a terrain elevation heat overlay"
      className="h-[28rem] w-full overflow-hidden rounded-lg border border-border"
    />
  );
}
