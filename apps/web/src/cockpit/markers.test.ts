import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { i18n } from '@/i18n';
import { contact as baseContact, perceived } from '@/test/fixtures';

// Each contact gets its own spot (>1 km apart) so the map keeps them as separate tracks.
let spot = 0;
const contact = (over: Parameters<typeof baseContact>[0] = {}) =>
  baseContact({ position: { lat: 34.2 + 0.01 * ++spot, lon: 77.6 }, ...over });

// MapLibre markers need a WebGL map; the layer only needs `setLngLat/addTo/remove` and an element.
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

import { MarkerLayer } from './markers';

const t = i18n.t.bind(i18n);
const setData = vi.fn();
const fakeMap = {
  getSource: (id: string) => (id === 'dest' ? { setData } : undefined),
} as unknown as MapLibreMap;
const markers = (): HTMLElement[] => [...live].map((m) => (m as { element: HTMLElement }).element);

beforeEach(() => {
  live.clear();
  setData.mockClear();
});

describe('MarkerLayer', () => {
  it('draws own unit, teammates (last known, with age) and contacts', () => {
    const layer = new MarkerLayer(fakeMap, () => undefined);
    const p = perceived({
      friendlies: [
        {
          unitId: 'b-sec1',
          name: 'Alpha Section 1',
          type: 'INFANTRY_SECTION',
          position: { lat: 34.19, lon: 77.6 },
          observedTick: 40,
          ageTicks: 60,
        },
      ],
      contacts: [contact({ id: 'rpt-1', type: 'RECCE', ageTicks: 130 })],
    });
    layer.sync(p, p, null, t);
    const labels = markers().map((m) => m.getAttribute('aria-label'));
    expect(labels).toEqual([
      'You: Alpha Platoon',
      'Alpha Section 1 (last known) · 1m ago',
      'Recce party · seen 2m 10s ago',
    ]);
  });

  it('removes markers that disappear and moves the ones that remain', () => {
    const layer = new MarkerLayer(fakeMap, () => undefined);
    const a = perceived({ contacts: [contact({ id: 'rpt-1' }), contact({ id: 'rpt-2' })] });
    layer.sync(a, a, null, t);
    expect(markers()).toHaveLength(3);
    const b = perceived({
      contacts: [contact({ id: 'rpt-2', position: { lat: 34.3, lon: 77.7 } })],
    });
    layer.sync(b, b, null, t);
    expect(markers()).toHaveLength(2);
    const moved = [...live].find((m) => (m as { lngLat: number[] }).lngLat[0] === 77.7);
    expect(moved).toBeDefined();
    layer.clear();
    expect(markers()).toHaveLength(0);
  });

  it("styles by the trainee's own grade: low-confidence reports are dashed and faded; old ones fade", () => {
    const layer = new MarkerLayer(fakeMap, () => undefined);
    const p = perceived({
      contacts: [
        contact({ id: 'good', grade: { reliability: 'A', credibility: 1 }, ageTicks: 0 }),
        contact({ id: 'low', grade: { reliability: 'E', credibility: 5 }, ageTicks: 0 }),
        contact({ id: 'old', grade: null, ageTicks: 590 }),
      ],
    });
    layer.sync(p, p, 'low', t);
    const contactMarkers = () => markers().filter((m) => m.classList.contains('vy-contact'));
    const [good, low, old] = contactMarkers();
    expect(good?.classList.contains('vy-low')).toBe(false);
    expect(low?.classList.contains('vy-low')).toBe(true);
    expect(low?.classList.contains('vy-selected')).toBe(true);
    expect(Number(low?.style.opacity)).toBeLessThan(Number(good?.style.opacity));
    expect(Number(old?.style.opacity)).toBeLessThan(0.45);
  });

  it('ghost and real contacts are indistinguishable: same markup shape', () => {
    const layer = new MarkerLayer(fakeMap, () => undefined);
    const p = perceived({ contacts: [contact({ id: 'real' }), contact({ id: 'ghost' })] });
    layer.sync(p, p, null, t);
    const [a, b] = markers().filter((m) => m.classList.contains('vy-contact'));
    expect(a?.className).toBe(b?.className);
    expect(a?.innerHTML).toBe(b?.innerHTML);
  });

  it('contact markers are keyboard-accessible buttons that report selection', () => {
    const onSelect = vi.fn();
    const layer = new MarkerLayer(fakeMap, onSelect);
    const p = perceived({ contacts: [contact({ id: 'rpt-9' })] });
    layer.sync(p, p, null, t);
    const button = markers().find((m) => m.tagName === 'BUTTON');
    expect(button?.getAttribute('type')).toBe('button');
    button?.click();
    expect(onSelect).toHaveBeenCalledWith('rpt-9');
  });

  it('keeps the live own unit while the shared picture is frozen', () => {
    const layer = new MarkerLayer(fakeMap, () => undefined);
    const frozen = perceived({ tick: 100, contacts: [contact({ id: 'rpt-1' })] });
    const liveNow = perceived({
      tick: 130,
      contacts: [contact({ id: 'rpt-1' }), contact({ id: 'rpt-2' })],
    });
    liveNow.self.position = { lat: 34.3, lon: 77.8 };
    layer.sync(liveNow, frozen, null, t);
    expect(markers().filter((m) => m.classList.contains('vy-contact'))).toHaveLength(1);
    const own = [...live].find((m) =>
      (m as { element: HTMLElement }).element.classList.contains('vy-own'),
    );
    expect((own as { lngLat: number[] }).lngLat).toEqual([77.8, 34.3]);
  });

  it('draws a line from the unit to its destination, and clears it on arrival', () => {
    const layer = new MarkerLayer(fakeMap, () => undefined);
    const p = perceived();
    p.self.destination = { lat: 34.2, lon: 77.7 };
    layer.sync(p, p, null, t);
    expect(setData.mock.calls.at(-1)?.[0]).toMatchObject({
      geometry: {
        type: 'LineString',
        coordinates: [
          [77.59, 34.175],
          [77.7, 34.2],
        ],
      },
    });
    p.self.destination = null;
    layer.sync(p, p, null, t);
    expect(setData.mock.calls.at(-1)?.[0]).toEqual({ type: 'FeatureCollection', features: [] });
  });
});
