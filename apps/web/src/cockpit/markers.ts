import { Marker, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { TFunction } from 'i18next';
import type { LatLon, PerceivedStateDto } from '@vyuha/shared';
import { formatAge } from '@/lib/format';
import { contactOpacity, currentTracks, isLowConfidence } from './logic';

type GeoData = Parameters<GeoJSONSource['setData']>[0];
export const EMPTY_LINE: GeoData = { type: 'FeatureCollection', features: [] };

const lngLat = (p: LatLon): [number, number] => [p.lon, p.lat];

interface Entry {
  marker: Marker;
  el: HTMLElement;
}

interface Look {
  opacity?: number;
  low?: boolean;
  selected?: boolean;
}

/**
 * Imperative marker layer for the tactical map: one DOM marker per own unit, teammate and contact,
 * created, moved and removed to mirror the latest perceived state. Contact markers are real buttons,
 * so they are keyboard- and screen-reader-accessible.
 */
export class MarkerLayer {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly map: MapLibreMap,
    private readonly onSelect: (contactId: string) => void,
  ) {}

  private upsert(
    seen: Set<string>,
    key: string,
    kind: 'own' | 'friendly' | 'contact',
    at: LatLon,
    label: string,
    look: Look = {},
  ): void {
    let entry = this.entries.get(key);
    if (!entry) {
      const el = document.createElement(kind === 'contact' ? 'button' : 'div');
      el.className = `vy-marker vy-${kind}`;
      el.innerHTML = '<span class="vy-dot"></span><span class="vy-label"></span>';
      if (kind === 'contact') {
        el.setAttribute('type', 'button');
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onSelect(key);
        });
      }
      entry = { marker: new Marker({ element: el }).setLngLat(lngLat(at)).addTo(this.map), el };
      this.entries.set(key, entry);
    }
    entry.marker.setLngLat(lngLat(at));
    const labelEl = entry.el.querySelector('.vy-label');
    if (labelEl) labelEl.textContent = label;
    entry.el.setAttribute('aria-label', label);
    entry.el.style.opacity = String(look.opacity ?? 1);
    entry.el.classList.toggle('vy-low', !!look.low);
    entry.el.classList.toggle('vy-selected', !!look.selected);
    seen.add(key);
  }

  /** `live` supplies the own unit and its destination; `picture` (maybe frozen) supplies everything else. */
  sync(
    live: PerceivedStateDto,
    picture: PerceivedStateDto,
    selectedContactId: string | null,
    t: TFunction,
  ): void {
    const seen = new Set<string>();
    this.upsert(
      seen,
      'own',
      'own',
      live.self.position,
      `${t('cockpit.map.you')}: ${live.self.name}`,
    );
    for (const f of picture.friendlies) {
      this.upsert(
        seen,
        `f:${f.unitId}`,
        'friendly',
        f.position,
        `${t('cockpit.map.friendly', { name: f.name })} · ${formatAge(t, f.ageTicks)}`,
        { opacity: contactOpacity(f.ageTicks, null) },
      );
    }
    for (const c of currentTracks(picture.contacts, selectedContactId)) {
      const type = t(`unitTypes.${c.type}` as 'unitTypes.RECCE', { defaultValue: c.type });
      this.upsert(
        seen,
        c.id,
        'contact',
        c.position,
        t('cockpit.map.contact', { type, age: formatAge(t, c.ageTicks) }),
        {
          opacity: contactOpacity(c.ageTicks, c.grade),
          low: isLowConfidence(c.grade),
          selected: c.id === selectedContactId,
        },
      );
    }
    for (const [key, entry] of this.entries) {
      if (!seen.has(key)) {
        entry.marker.remove();
        this.entries.delete(key);
      }
    }

    const source = this.map.getSource('dest');
    if (source && 'setData' in source) {
      const dest = live.self.destination;
      (source as GeoJSONSource).setData(
        dest
          ? {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: [lngLat(live.self.position), lngLat(dest)],
              },
            }
          : EMPTY_LINE,
      );
    }
  }

  clear(): void {
    for (const e of this.entries.values()) e.marker.remove();
    this.entries.clear();
  }
}
