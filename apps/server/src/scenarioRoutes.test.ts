import { afterEach, describe, expect, it } from 'vitest';
import { scenarioDetailSchema, type Inject } from '@vyuha/shared';
import { SILENT_RIDGE_ID, silentRidge } from './seed/silentRidge';
import { closeEnv, makeEnv, type Env } from './sessions/testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const INST = 'inst@x.io';
const jam = (id: string, tick: number): Inject => ({
  id,
  tick,
  title: `Jam ${id}`,
  type: 'JAM_CHANNEL',
  channel: 'VHF',
  intensity: 0.5,
  durationTicks: 60,
});

describe('GET /scenarios/:id', () => {
  it('returns the full definition to instructors only', async () => {
    env = await makeEnv();
    const ok = await env.api('GET', `/scenarios/${SILENT_RIDGE_ID}`, INST);
    expect(ok.status).toBe(200);
    const detail = scenarioDetailSchema.parse(ok.body);
    expect(detail.msel).toHaveLength(14);
    expect(detail.initialUnits.length).toBeGreaterThan(10);
    expect((await env.api('GET', `/scenarios/${SILENT_RIDGE_ID}`, 'pl@x.io')).status).toBe(403);
    expect((await env.api('GET', '/scenarios/nope', INST)).status).toBe(404);
    const anon = await env.app.fastify.inject({
      method: 'GET',
      url: `/scenarios/${SILENT_RIDGE_ID}`,
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('PUT /scenarios/:id/msel', () => {
  const put = (e: Env, body: unknown, as = INST, id = SILENT_RIDGE_ID) =>
    e.api('PUT', `/scenarios/${id}/msel`, as, body);

  it('saves a valid MSEL, sorted by time', async () => {
    env = await makeEnv();
    const res = await put(env, { msel: [jam('b', 90), jam('a', 10)] });
    expect(res.status).toBe(200);
    expect(scenarioDetailSchema.parse(res.body).msel.map((i) => i.id)).toEqual(['a', 'b']);
    const reread = scenarioDetailSchema.parse(
      (await env.api('GET', `/scenarios/${SILENT_RIDGE_ID}`, INST)).body,
    );
    expect(reread.msel.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('rejects malformed injects with Zod issues', async () => {
    env = await makeEnv();
    const res = await put(env, { msel: [{ id: 'x', tick: -5, title: '', type: 'JAM_CHANNEL' }] });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect((await put(env, { nope: [] })).status).toBe(400);
    expect((await put(env, { msel: [{ ...jam('x', 1), channel: 'RUNNER' }] })).status).toBe(400);
  });

  it('rejects injects that do not fit the scenario (unknown units, wrong sides, outside the area)', async () => {
    env = await makeEnv();
    const bad: Inject[] = [
      {
        id: 'a',
        tick: 5,
        title: 'Ghost',
        type: 'SPOOF_ORDER',
        purportedSender: 'HQ',
        targetUnitId: 'nope',
        orderText: 'x',
      },
      {
        id: 'b',
        tick: 6,
        title: 'Spoof a hostile',
        type: 'SPOOF_ORDER',
        purportedSender: 'HQ',
        targetUnitId: 'r-recce',
        orderText: 'x',
      },
      {
        id: 'c',
        tick: 7,
        title: 'Far away',
        type: 'ADVERSARY_MOVE',
        unitId: 'r-recce',
        destination: { lat: 10, lon: 10 },
      },
      {
        id: 'd',
        tick: 8,
        title: 'Move our own',
        type: 'ADVERSARY_MOVE',
        unitId: 'b-pl',
        destination:
          silentRidge.areaBounds.south > 0 ? { lat: 34.2, lon: 77.6 } : { lat: 0, lon: 0 },
      },
      jam('a', 9),
    ];
    const res = await put(env, { msel: bad });
    expect(res.status).toBe(400);
    const issues = (res.body as { error: { issues: { message: string }[] } }).error.issues
      .map((i) => i.message)
      .join('\n');
    expect(issues).toContain('"nope" is not a unit');
    expect(issues).toContain('wrong side');
    expect(issues).toContain('outside the exercise area');
    expect(issues).toContain('Duplicate inject id a');
  });

  it('is instructor-only and 404s for unknown scenarios', async () => {
    env = await makeEnv();
    expect((await put(env, { msel: [] }, 'pl@x.io')).status).toBe(403);
    expect((await put(env, { msel: [] }, INST, 'nope')).status).toBe(404);
    const anon = await env.app.fastify.inject({
      method: 'PUT',
      url: `/scenarios/${SILENT_RIDGE_ID}/msel`,
      payload: { msel: [] },
    });
    expect(anon.statusCode).toBe(401);
  });
});
