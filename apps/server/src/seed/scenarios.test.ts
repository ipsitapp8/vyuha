import { describe, expect, it } from 'vitest';
import { createTruthState, lineOfSight, mulberry32, step } from '@vyuha/engine';
import { validateMselReferences, type InjectType } from '@vyuha/shared';
import { bundledGeo } from '../geo/bundled';
import { HIM_PRAHARI_ID, himPrahari } from './himPrahari';
import { SEED_SCENARIOS } from './scenarios';
import { THAR_KAVACH_ID, tharKavach } from './tharKavach';

describe('every seeded scenario', () => {
  it('there are three, with unique ids, titles and seeds', () => {
    expect(SEED_SCENARIOS).toHaveLength(3);
    for (const key of ['id', 'title', 'seed'] as const) {
      const values = SEED_SCENARIOS.map((s) => (key === 'id' ? s.id : s.definition[key]));
      expect(new Set(values).size).toBe(3);
    }
  });

  for (const { id, definition } of SEED_SCENARIOS) {
    describe(definition.title, () => {
      const { msel, initialUnits: units, areaBounds: b, paceDefaults } = definition;

      it('has a 10 to 14 inject MSEL with unique, time-ordered ids that fits its own units', () => {
        expect(msel.length).toBeGreaterThanOrEqual(10);
        expect(msel.length).toBeLessThanOrEqual(14);
        expect(new Set(msel.map((i) => i.id)).size).toBe(msel.length);
        const ticks = msel.map((i) => i.tick);
        expect(ticks).toEqual([...ticks].sort((x, y) => x - y));
        expect(validateMselReferences(msel, units, b)).toEqual([]);
      });

      it('has friendly and hostile units in every domain, all inside the area', () => {
        expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
        for (const side of ['BLUE', 'RED'] as const) {
          const domains = new Set(units.filter((u) => u.side === side).map((u) => u.domain));
          expect([...domains].sort()).toEqual(['AIR', 'CYBER', 'EW', 'LAND']);
        }
        for (const u of units) {
          expect(u.position.lat).toBeGreaterThan(b.south);
          expect(u.position.lat).toBeLessThan(b.north);
          expect(u.position.lon).toBeGreaterThan(b.west);
          expect(u.position.lon).toBeLessThan(b.east);
        }
      });

      it('has its own PACE plan and bundled real terrain and weather, so it runs offline', () => {
        expect(new Set(Object.values(paceDefaults)).size).toBe(4);
        const geo = bundledGeo(id);
        expect(geo).not.toBeNull();
        expect(geo?.terrain.rows).toBe(64);
        expect(geo?.terrain.cols).toBe(64);
        expect(geo?.terrain.bbox).toEqual(b);
        expect(geo?.terrain.elevations).toHaveLength(64 * 64);
        expect(geo?.weather.visibilityM).toBeGreaterThan(0);
      });

      it('runs through its whole MSEL in the engine without a failed inject', () => {
        const geo = bundledGeo(id);
        if (!geo) throw new Error('no bundled geodata');
        const roster = {
          teams: [{ id: 't', name: 'Team', pace: paceDefaults }],
          players: [
            { id: 'p-pl', teamId: 't', unitId: 'b-pl', role: 'PL_CDR' as const },
            { id: 'p-sec', teamId: 't', unitId: 'b-sec1', role: 'SECTION_CDR' as const },
            { id: 'p-sec2', teamId: 't', unitId: 'b-sec2', role: 'EW_OFFICER' as const },
            { id: 'p-isr', teamId: 't', unitId: 'b-uav', role: 'ISR_OPERATOR' as const },
          ],
        };
        let state = createTruthState(definition, geo.terrain, geo.weather, definition.seed, roster);
        const rng = mulberry32(state.rngState);
        const types: string[] = [];
        for (let i = 0; i < 900; i++) {
          const r = step(state, [], rng);
          state = r.state;
          for (const e of r.events) types.push(e.type);
        }
        expect(types.filter((t) => t === 'INJECT_FIRED')).toHaveLength(msel.length);
        expect(types).not.toContain('INJECT_FAILED');
      });
    });
  }
});

describe('Op Him Prahari (high altitude)', () => {
  const geo = bundledGeo(HIM_PRAHARI_ID);
  const unitAt = (id: string) => {
    const u = himPrahari.initialUnits.find((x) => x.id === id);
    if (!u) throw new Error(id);
    return u.position;
  };

  it('is real high-altitude terrain: a pass above 5,000 m between HQ and the platoon', () => {
    if (!geo) throw new Error('no bundled geodata');
    expect(Math.max(...geo.terrain.elevations)).toBeGreaterThan(5200);
    expect(Math.min(...geo.terrain.elevations)).toBeGreaterThan(3000);
  });

  it('the ridge blocks VHF line of sight from HQ to the platoon and the forward section', () => {
    if (!geo) throw new Error('no bundled geodata');
    for (const far of ['b-pl', 'b-sec1']) {
      expect(
        lineOfSight(geo.terrain, unitAt('b-hq'), unitAt(far), { aHeightM: 10, bHeightM: 3 }),
      ).toBe(false);
    }
  });

  it('plans around that: HF first, SATCOM second, with a planned SATCOM outage in the MSEL', () => {
    expect(himPrahari.paceDefaults.primary).toBe('HF');
    expect(himPrahari.paceDefaults.alternate).toBe('SATCOM');
    const kinds = new Set<InjectType>(himPrahari.msel.map((i) => i.type));
    expect(kinds.has('SATCOM_OUTAGE')).toBe(true);
    expect(kinds.has('C2_COMPROMISE')).toBe(true);
  });
});

describe('Op Thar Kavach (desert)', () => {
  const geo = bundledGeo(THAR_KAVACH_ID);
  const unitAt = (id: string) => {
    const u = tharKavach.initialUnits.find((x) => x.id === id);
    if (!u) throw new Error(id);
    return u.position;
  };

  it('is real low, nearly flat desert', () => {
    if (!geo) throw new Error('no bundled geodata');
    const max = Math.max(...geo.terrain.elevations);
    const min = Math.min(...geo.terrain.elevations);
    expect(max).toBeLessThan(600);
    expect(max - min).toBeLessThan(250);
  });

  it('has long line of sight: HQ sees the platoon and both sections', () => {
    if (!geo) throw new Error('no bundled geodata');
    const clear = ['b-pl', 'b-sec1', 'b-sec2'].filter((id) =>
      lineOfSight(geo.terrain, unitAt('b-hq'), unitAt(id), { aHeightM: 10, bHeightM: 3 }),
    );
    expect(clear.length).toBeGreaterThanOrEqual(2);
  });

  it('starts on VHF, is jammed heavily, and spoofs the UAV', () => {
    expect(tharKavach.paceDefaults.primary).toBe('VHF');
    const vhfJams = tharKavach.msel.filter((i) => i.type === 'JAM_CHANNEL' && i.channel === 'VHF');
    expect(vhfJams.length).toBeGreaterThanOrEqual(2);
    expect(
      Math.max(...vhfJams.map((i) => (i.type === 'JAM_CHANNEL' ? i.intensity : 0))),
    ).toBeGreaterThanOrEqual(0.8);
    const spoof = tharKavach.msel.find((i) => i.type === 'GPS_SPOOF');
    expect(spoof && spoof.type === 'GPS_SPOOF' ? spoof.unitId : '').toBe('b-uav');
  });
});
