import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { TruthViewDto } from '@vyuha/shared';
import { i18n } from '@/i18n';
import { contact, perceived } from '@/test/fixtures';

const live = new Set<unknown>();
vi.mock('maplibre-gl', () => ({
  Marker: class {
    lngLat: [number, number] = [0, 0];
    constructor(private readonly opts: { element: HTMLElement }) {}
    get element(): HTMLElement {
      return this.opts.element;
    }
    setLngLat(p: [number, number]) {
      this.lngLat = p;
      return this;
    }
    addTo() {
      live.add(this);
      return this;
    }
    remove() {
      live.delete(this);
      return this;
    }
  },
}));

import { TruthLayer } from './truthLayer';

const t = i18n.t.bind(i18n);
const els = (): HTMLElement[] => [...live].map((m) => (m as { element: HTMLElement }).element);
const unit = (
  id: string,
  side: 'BLUE' | 'RED' | 'NEUTRAL',
  domain: string,
  status: 'ACTIVE' | 'DESTROYED' = 'ACTIVE',
) => ({
  id,
  name: id.toUpperCase(),
  side,
  domain,
  type: 'RECCE',
  position: { lat: 34.1, lon: 77.1 },
  heading: 0,
  status,
  destination: null,
});
const truth = (units: TruthViewDto['units']): TruthViewDto => ({
  tick: 1,
  units,
  jamming: { VHF: 0, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
  satcomUp: true,
  weather: { visibilityM: 1, precipitationMm: 0, windKph: 0 },
  manualJamming: { VHF: 0, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
  msel: [],
  players: {},
  drift: {},
});
const map = {} as MapLibreMap;

beforeEach(() => live.clear());

describe('TruthLayer', () => {
  it('draws every unit by side and domain, fading destroyed ones', () => {
    const layer = new TruthLayer(map);
    layer.sync(
      truth([
        unit('b1', 'BLUE', 'LAND'),
        unit('r1', 'RED', 'AIR'),
        unit('n1', 'NEUTRAL', 'LAND'),
        unit('r2', 'RED', 'EW', 'DESTROYED'),
      ]),
      null,
      t,
    );
    const classes = els().map((e) => e.className);
    expect(classes[0]).toContain('vy-t-BLUE');
    expect(classes[1]).toContain('vy-t-RED vy-d-AIR');
    expect(classes[2]).toContain('vy-t-NEUTRAL');
    expect(els()[3]?.style.opacity).toBe('0.35');
    expect(els().map((e) => e.getAttribute('aria-label'))).toEqual(['B1', 'R1', 'N1', 'R2']);
  });

  it('overlays what the watched trainee believes, collapsing repeat sightings', () => {
    const layer = new TruthLayer(map);
    const watched = perceived({
      contacts: [
        contact({ id: 'c1', observedTick: 10, position: { lat: 34.2, lon: 77.2 } }),
        contact({ id: 'c2', observedTick: 20, position: { lat: 34.2001, lon: 77.2 } }),
        contact({ id: 'c3', observedTick: 5, type: 'DRONE', position: { lat: 34.3, lon: 77.3 } }),
      ],
    });
    layer.sync(truth([unit('b1', 'BLUE', 'LAND')]), watched, t);
    const believed = els().filter((e) => e.classList.contains('vy-believed'));
    expect(believed.map((e) => e.getAttribute('aria-label'))).toEqual([
      'Believed: Recce party',
      'Believed: Drone',
    ]);
    layer.sync(truth([unit('b1', 'BLUE', 'LAND')]), null, t);
    expect(els().filter((e) => e.classList.contains('vy-believed'))).toHaveLength(0);
    layer.clear();
    expect(els()).toHaveLength(0);
  });
});
