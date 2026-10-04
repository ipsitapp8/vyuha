import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { TFunction } from 'i18next';
import type { LatLon, PerceivedStateDto, TruthViewDto } from '@vyuha/shared';
import { currentTracks } from '@/cockpit/logic';

const lngLat = (p: LatLon): [number, number] => [p.lon, p.lat];

interface Entry {
  marker: Marker;
  el: HTMLElement;
}

/**
 * Markers for the God View truth map: every unit at its true position (by side and domain), plus,
 * optionally, dashed "believed" markers for what the watched trainee thinks is out there, so the
 * gap between truth and perception is visible at a glance.
 */
export class TruthLayer {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly map: MapLibreMap) {}

  private upsert(
    seen: Set<string>,
    key: string,
    className: string,
    at: LatLon,
    label: string,
    opacity = 1,
  ): void {
    let entry = this.entries.get(key);
    if (!entry) {
      const el = document.createElement('div');
      el.innerHTML = '<span class="vy-dot"></span><span class="vy-label"></span>';
      entry = { marker: new Marker({ element: el }).setLngLat(lngLat(at)).addTo(this.map), el };
      this.entries.set(key, entry);
    }
    entry.marker.setLngLat(lngLat(at));
    entry.el.className = `vy-marker ${className}`;
    const labelEl = entry.el.querySelector('.vy-label');
    if (labelEl) labelEl.textContent = label;
    entry.el.setAttribute('aria-label', label);
    entry.el.style.opacity = String(opacity);
    seen.add(key);
  }

  sync(truth: Pick<TruthViewDto, 'units'>, watched: PerceivedStateDto | null, t: TFunction): void {
    const seen = new Set<string>();
    for (const u of truth.units) {
      const dead = u.status === 'DESTROYED' || u.status === 'OFFLINE';
      this.upsert(
        seen,
        `u:${u.id}`,
        `vy-truth vy-t-${u.side} vy-d-${u.domain}`,
        u.position,
        u.name,
        dead ? 0.35 : 1,
      );
    }
    if (watched) {
      for (const c of currentTracks(watched.contacts, null)) {
        const type = t(`unitTypes.${c.type}` as 'unitTypes.RECCE', { defaultValue: c.type });
        this.upsert(
          seen,
          `b:${c.id}`,
          'vy-believed',
          c.position,
          t('god.maps.overlay', { type }),
          0.85,
        );
      }
    }
    for (const [key, entry] of this.entries) {
      if (!seen.has(key)) {
        entry.marker.remove();
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    for (const e of this.entries.values()) e.marker.remove();
    this.entries.clear();
  }
}
