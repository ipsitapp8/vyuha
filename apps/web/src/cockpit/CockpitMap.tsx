import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { useTranslation } from 'react-i18next';
import { attachBasemap, INITIAL_STYLE } from '@/lib/basemap';
import { applyTerrain3d } from '@/lib/terrain3d';
import type { AreaBounds, LatLon, PerceivedStateDto } from '@vyuha/shared';
import { EMPTY_LINE, MarkerLayer } from './markers';
import type { ProbeMarker } from './probe';

interface Props {
  bounds: AreaBounds;
  /** Scenario whose terrain backs the map when tiles are unavailable. */
  scenarioId: string;
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
  /** Show the ground in 3D, built from the scenario's stored elevation grid (works offline). */
  terrain3d?: boolean;
  /** Markers the trainee has placed while answering a situation-awareness probe. */
  probeMarkers?: readonly ProbeMarker[];
}

/** Tactical map: own unit, teammates (last known), and reported contacts as accessible markers. */
export function CockpitMap({
  bounds,
  scenarioId,
  perceived,
  picture,
  selectedContactId,
  onSelectContact,
  pickMode,
  onPick,
  onTilesOffline,
  terrain3d = false,
  probeMarkers,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const layerRef = useRef<MarkerLayer | null>(null);
  const onSelectRef = useRef(onSelectContact);
  const onPickRef = useRef(onPick);
  const pickModeRef = useRef(pickMode);
  const offlineRef = useRef(onTilesOffline);
  const terrainRef = useRef(terrain3d);

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
    const map = new MapLibreMap({
      container,
      style: INITIAL_STYLE,
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
    // a new style drops every source, the elevation one included: put the terrain back
    map.on('style.load', () => applyTerrain3d(map, scenarioId, terrainRef.current));
    const detachBasemap = attachBasemap(map, {
      bounds,
      scenarioId,
      onFallback: () => offlineRef.current(),
    });
    map.on('click', (e) => {
      if (pickModeRef.current) onPickRef.current({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

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
    const canvas = mapRef.current?.getCanvas();
    if (canvas) canvas.style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode]);

  // Keep markers and the destination line in step with the latest state.
  useEffect(() => {
    layerRef.current?.sync(perceived, picture, selectedContactId, t);
  }, [perceived, picture, selectedContactId, t]);

  // The trainee's own probe answers: plain markers that come and go with the draft.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !probeMarkers || probeMarkers.length === 0) return;
    const placed = probeMarkers.map((m) => {
      const el = document.createElement('div');
      el.className = `vy-marker vy-probe vy-probe-${m.kind}`;
      el.innerHTML = '<span class="vy-dot"></span><span class="vy-label"></span>';
      const label = el.querySelector('.vy-label');
      if (label) label.textContent = m.label;
      el.setAttribute('aria-label', m.label);
      return new Marker({ element: el }).setLngLat([m.position.lon, m.position.lat]).addTo(map);
    });
    return () => {
      for (const m of placed) m.remove();
    };
  }, [probeMarkers]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={t('cockpit.map.label')}
      className="h-full w-full"
    />
  );
}
