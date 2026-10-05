import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { useTranslation } from 'react-i18next';
import { attachBasemap, INITIAL_STYLE } from '@/lib/basemap';
import { applyTerrain3d } from '@/lib/terrain3d';
import type { AreaBounds, PerceivedStateDto, TruthViewDto } from '@vyuha/shared';
import { TruthLayer } from './truthLayer';

interface Props {
  bounds: AreaBounds;
  /** Scenario whose terrain backs the map when tiles are unavailable. */
  scenarioId: string;
  truth: Pick<TruthViewDto, 'units'>;
  /** The trainee being watched; their believed contacts are drawn as dashed markers. */
  watched: PerceivedStateDto | null;
  onTilesOffline: () => void;
  /** Show the ground in 3D, built from the scenario's stored elevation grid (works offline). */
  terrain3d?: boolean;
}

/** Ground truth: every unit (both sides) at its real position. */
export function TruthMap({
  bounds,
  scenarioId,
  truth,
  watched,
  onTilesOffline,
  terrain3d = false,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TruthLayer | null>(null);
  const offlineRef = useRef(onTilesOffline);
  const mapRef = useRef<MapLibreMap | null>(null);
  const terrainRef = useRef(terrain3d);

  useEffect(() => {
    offlineRef.current = onTilesOffline;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = new MapLibreMap({
      container,
      style: INITIAL_STYLE,
      bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      fitBoundsOptions: { padding: 30 },
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.on('style.load', () => applyTerrain3d(map, scenarioId, terrainRef.current));
    const detachBasemap = attachBasemap(map, {
      bounds,
      scenarioId,
      onFallback: () => offlineRef.current(),
    });
    const layer = new TruthLayer(map);
    layerRef.current = layer;
    return () => {
      detachBasemap();
      layer.clear();
      layerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [bounds, scenarioId]);

  useEffect(() => {
    terrainRef.current = terrain3d;
    const map = mapRef.current;
    // Not gated on isStyleLoaded(): that is also false while tiles load. If the style really is not
    // there yet the call is a no-op and the style.load handler applies it.
    if (map) applyTerrain3d(map, scenarioId, terrain3d);
  }, [terrain3d, scenarioId]);

  useEffect(() => {
    layerRef.current?.sync(truth, watched, t);
  }, [truth, watched, t]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={t('god.maps.truthLabel')}
      className="h-full w-full"
    />
  );
}
