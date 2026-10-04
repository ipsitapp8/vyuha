import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { useTranslation } from 'react-i18next';
import { attachBasemap, INITIAL_STYLE } from '@/lib/basemap';
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
}

/** Ground truth: every unit (both sides) at its real position. */
export function TruthMap({ bounds, scenarioId, truth, watched, onTilesOffline }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TruthLayer | null>(null);
  const offlineRef = useRef(onTilesOffline);

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
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
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
    };
  }, [bounds, scenarioId]);

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
