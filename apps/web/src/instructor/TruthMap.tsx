import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { useTranslation } from 'react-i18next';
import type { AreaBounds, PerceivedStateDto, TruthViewDto } from '@vyuha/shared';
import { TruthLayer } from './truthLayer';

const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

interface Props {
  bounds: AreaBounds;
  truth: Pick<TruthViewDto, 'units'>;
  /** The trainee being watched; their believed contacts are drawn as dashed markers. */
  watched: PerceivedStateDto | null;
  onTilesOffline: () => void;
}

/** Ground truth: every unit (both sides) at its real position. */
export function TruthMap({ bounds, truth, watched, onTilesOffline }: Props) {
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
    let fellBack = false;
    const map = new MapLibreMap({
      container,
      style: MAP_STYLE_URL,
      bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
      fitBoundsOptions: { padding: 30 },
      attributionControl: { compact: true },
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.on('error', () => {
      if (!fellBack && !map.isStyleLoaded()) {
        fellBack = true;
        map.setStyle(OFFLINE_STYLE);
        offlineRef.current();
      }
    });
    const layer = new TruthLayer(map);
    layerRef.current = layer;
    return () => {
      layer.clear();
      layerRef.current = null;
      map.remove();
    };
  }, [bounds]);

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
