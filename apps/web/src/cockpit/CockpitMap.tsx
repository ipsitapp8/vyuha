import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, NavigationControl, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { useTranslation } from 'react-i18next';
import type { AreaBounds, LatLon, PerceivedStateDto } from '@vyuha/shared';
import { EMPTY_LINE, MarkerLayer } from './markers';

const MAP_STYLE_URL: string =
  import.meta.env.VITE_MAP_STYLE_URL ?? 'https://tiles.openfreemap.org/styles/liberty';

// Used when the tile style cannot load (air-gapped / offline): markers still render on a plain field.
const OFFLINE_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } }],
};

interface Props {
  bounds: AreaBounds;
  /** Live: own unit and its destination. */
  perceived: PerceivedStateDto;
  /** Possibly frozen snapshot used for teammates and contacts. */
  picture: PerceivedStateDto;
  selectedContactId: string | null;
  onSelectContact: (id: string) => void;
  /** When set, the next map click is reported through `onPick` (move / ISR tools). */
  pickMode: boolean;
  onPick: (point: LatLon) => void;
  onTilesOffline: () => void;
}

/** Tactical map: own unit, teammates (last known), and reported contacts as accessible markers. */
export function CockpitMap({
  bounds,
  perceived,
  picture,
  selectedContactId,
  onSelectContact,
  pickMode,
  onPick,
  onTilesOffline,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const layerRef = useRef<MarkerLayer | null>(null);
  const onSelectRef = useRef(onSelectContact);
  const onPickRef = useRef(onPick);
  const pickModeRef = useRef(pickMode);
  const offlineRef = useRef(onTilesOffline);

  useEffect(() => {
    onSelectRef.current = onSelectContact;
    onPickRef.current = onPick;
    pickModeRef.current = pickMode;
    offlineRef.current = onTilesOffline;
  });

  // Create the map once.
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
    mapRef.current = map;
    const layer = new MarkerLayer(map, (id) => onSelectRef.current(id));
    layerRef.current = layer;
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');

    const ensureLine = (): void => {
      if (map.getSource('dest')) return;
      map.addSource('dest', { type: 'geojson', data: EMPTY_LINE });
      map.addLayer({
        id: 'dest',
        type: 'line',
        source: 'dest',
        paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
    };
    map.on('style.load', ensureLine);
    map.on('error', () => {
      if (!fellBack && !map.isStyleLoaded()) {
        fellBack = true;
        map.setStyle(OFFLINE_STYLE);
        offlineRef.current();
      }
    });
    map.on('click', (e) => {
      if (pickModeRef.current) onPickRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    return () => {
      layer.clear();
      layerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [bounds]);

  useEffect(() => {
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode]);

  // Keep markers and the destination line in step with the latest state.
  useEffect(() => {
    layerRef.current?.sync(perceived, picture, selectedContactId, t);
  }, [perceived, picture, selectedContactId, t]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={t('cockpit.map.label')}
      className="h-full w-full"
    />
  );
}
