import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { elevationRange } from '@vyuha/engine';
import { useTranslation } from 'react-i18next';
import type { AreaBounds, TerrainGridDto } from '@vyuha/shared';
import { attachBasemap, INITIAL_STYLE } from '@/lib/basemap';
import { elevationColor } from '@/lib/terrainColor';

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
  onError: () => void;
}

export function TerrainMap({ bounds, terrain, onError }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = new MapLibreMap({
      container,
      style: INITIAL_STYLE,
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
        onError();
      }
    };

    map.on('style.load', addOverlay);
    const detachBasemap = attachBasemap(map, { bounds, terrain, onFallback: () => undefined });

    return () => {
      detachBasemap();
      map.remove();
    };
  }, [bounds, terrain, onError]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={t('instructor.scenario.mapLabel')}
      className="h-[28rem] w-full overflow-hidden rounded-lg border border-border"
    />
  );
}
