import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@/lib/maplibre';
import { useTranslation } from 'react-i18next';
import { attachBasemap, INITIAL_STYLE } from '@/lib/basemap';
import type { AreaBounds } from '@vyuha/shared';
import { EMPTY_LINE } from '@/cockpit/markers';
import type { ProbePoint, ProbeLink } from './probeData';

interface Props {
  bounds: AreaBounds;
  scenarioId: string;
  points: readonly ProbePoint[];
  links: readonly ProbeLink[];
}

const LINK_SOURCE = 'probe-links';

/** One probe on the map: the true positions (solid), the trainee's answers (hollow) and the error lines. */
export function ProbeMap({ bounds, scenarioId, points, links }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const linksRef = useRef(links);

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
    const ensureLinks = (): void => {
      if (map.getSource(LINK_SOURCE)) return;
      map.addSource(LINK_SOURCE, { type: 'geojson', data: EMPTY_LINE });
      map.addLayer({
        id: LINK_SOURCE,
        type: 'line',
        source: LINK_SOURCE,
        paint: { 'line-color': '#b45309', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      setLinks(map, linksRef.current);
    };
    map.on('style.load', ensureLinks);
    const detach = attachBasemap(map, { bounds, scenarioId, onFallback: () => undefined });
    return () => {
      detach();
      map.remove();
      mapRef.current = null;
    };
  }, [bounds, scenarioId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const placed = points.map((p) => {
      const el = document.createElement('div');
      el.className = `vy-marker vy-probe-review vy-pr-${p.kind}`;
      el.innerHTML = '<span class="vy-dot"></span><span class="vy-label"></span>';
      const label = el.querySelector('.vy-label');
      if (label) label.textContent = p.label;
      el.setAttribute('aria-label', p.label);
      return new Marker({ element: el }).setLngLat([p.position.lon, p.position.lat]).addTo(map);
    });
    return () => {
      for (const m of placed) m.remove();
    };
  }, [points]);

  useEffect(() => {
    linksRef.current = links;
    const map = mapRef.current;
    if (map?.getSource(LINK_SOURCE)) setLinks(map, links);
  }, [links]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={t('aar.probes.mapLabel')}
      className="h-full w-full"
    />
  );
}

function setLinks(map: MapLibreMap, links: readonly ProbeLink[]): void {
  const source = map.getSource(LINK_SOURCE);
  if (source && 'setData' in source && typeof source.setData === 'function') {
    (source.setData as (d: unknown) => void)({
      type: 'FeatureCollection',
      features: links.map((l) => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [l.from.lon, l.from.lat],
            [l.to.lon, l.to.lat],
          ],
        },
      })),
    });
  }
}
