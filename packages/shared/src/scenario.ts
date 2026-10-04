import { z } from 'zod';

export const channelSchema = z.enum(['VHF', 'HF', 'SATCOM', 'DATALINK', 'RUNNER']);
export type Channel = z.infer<typeof channelSchema>;

export const latLonSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type LatLon = z.infer<typeof latLonSchema>;

export const areaBoundsSchema = z
  .object({
    south: z.number().min(-90).max(90),
    west: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
  })
  .refine((b) => b.south < b.north && b.west < b.east, {
    message: 'Bounds must satisfy south < north and west < east',
  });
export type AreaBounds = z.infer<typeof areaBoundsSchema>;

export const sideSchema = z.enum(['BLUE', 'RED', 'NEUTRAL']);
export const domainSchema = z.enum(['LAND', 'AIR', 'CYBER', 'EW']);
export const unitStatusSchema = z.enum(['ACTIVE', 'DAMAGED', 'DESTROYED', 'OFFLINE']);

export const unitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  side: sideSchema,
  domain: domainSchema,
  type: z.string().min(1),
  position: latLonSchema,
  heading: z.number().min(0).lt(360),
  speed: z.number().min(0),
  strength: z.number().min(0).max(100),
  status: unitStatusSchema,
});
export type ScenarioUnit = z.infer<typeof unitSchema>;

export const paceDefaultsSchema = z
  .object({
    primary: channelSchema,
    alternate: channelSchema,
    contingency: channelSchema,
    emergency: channelSchema,
  })
  .refine((p) => new Set([p.primary, p.alternate, p.contingency, p.emergency]).size === 4, {
    message: 'PACE channels must all be different',
  });
export type PaceDefaults = z.infer<typeof paceDefaultsSchema>;

const injectBase = {
  id: z.string().min(1),
  tick: z.number().int().min(0),
  title: z.string().min(1).max(120),
};

export const injectSchema = z.discriminatedUnion('type', [
  z.object({
    ...injectBase,
    type: z.literal('JAM_CHANNEL'),
    channel: channelSchema.exclude(['RUNNER']),
    intensity: z.number().min(0).max(1),
    durationTicks: z.number().int().min(1),
  }),
  z.object({
    ...injectBase,
    type: z.literal('SATCOM_OUTAGE'),
    durationTicks: z.number().int().min(1),
  }),
  z.object({
    ...injectBase,
    type: z.literal('CONFLICTING_REPORTS'),
    unitId: z.string().min(1),
    altPosition: latLonSchema,
    altType: z.string().min(1),
  }),
  z.object({
    ...injectBase,
    type: z.literal('SPOOF_ORDER'),
    purportedSender: z.string().min(1),
    targetUnitId: z.string().min(1),
    orderText: z.string().min(1).max(500),
  }),
  z.object({
    ...injectBase,
    type: z.literal('RUNNER_DISPATCH'),
    fromUnitId: z.string().min(1),
    toUnitId: z.string().min(1),
    messageText: z.string().min(1).max(500),
  }),
  z.object({
    ...injectBase,
    type: z.literal('WEATHER_CHANGE'),
    visibilityM: z.number().min(0),
    precipitationMm: z.number().min(0),
    windKph: z.number().min(0),
  }),
  z.object({
    ...injectBase,
    type: z.literal('ADVERSARY_MOVE'),
    unitId: z.string().min(1),
    destination: latLonSchema,
  }),
]);
export type Inject = z.infer<typeof injectSchema>;
export type InjectType = Inject['type'];

export const mselSchema = z.array(injectSchema);
export type Msel = z.infer<typeof mselSchema>;

export const scenarioDefinitionSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  areaBounds: areaBoundsSchema,
  seed: z.number().int().min(0).max(0xffffffff),
  msel: mselSchema,
  initialUnits: z.array(unitSchema).min(1),
  paceDefaults: paceDefaultsSchema,
});
export type ScenarioDefinition = z.infer<typeof scenarioDefinitionSchema>;

export const scenarioSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  areaBounds: areaBoundsSchema,
  seed: z.number().int(),
  injectCount: z.number().int(),
  unitCount: z.number().int(),
});
export type ScenarioSummary = z.infer<typeof scenarioSummarySchema>;

export const scenarioListResponseSchema = z.object({ scenarios: z.array(scenarioSummarySchema) });
export type ScenarioListResponse = z.infer<typeof scenarioListResponseSchema>;

export const scenarioDetailSchema = scenarioDefinitionSchema.extend({ id: z.string() });
export type ScenarioDetail = z.infer<typeof scenarioDetailSchema>;

export const updateMselBodySchema = z.object({ msel: mselSchema });
export type UpdateMselBody = z.infer<typeof updateMselBodySchema>;

/**
 * Cross-checks an MSEL against the scenario it belongs to (the Zod schema only checks shapes).
 * Returns human-readable problems; an empty list means the MSEL is consistent.
 */
export function validateMselReferences(
  msel: readonly Inject[],
  units: readonly Pick<ScenarioUnit, 'id' | 'side'>[],
  bounds?: AreaBounds,
): string[] {
  const problems: string[] = [];
  const side = new Map(units.map((u) => [u.id, u.side]));
  const seen = new Set<string>();
  const inside = (p: LatLon): boolean =>
    !bounds ||
    (p.lat >= bounds.south &&
      p.lat <= bounds.north &&
      p.lon >= bounds.west &&
      p.lon <= bounds.east);

  for (const i of msel) {
    const at = `"${i.title}" (${i.id})`;
    if (seen.has(i.id)) problems.push(`Duplicate inject id ${i.id}.`);
    seen.add(i.id);
    const need = (
      unitId: string,
      label: string,
      ok?: (s: ScenarioUnit['side']) => boolean,
    ): void => {
      const s = side.get(unitId);
      if (!s) problems.push(`${at}: ${label} "${unitId}" is not a unit in this scenario.`);
      else if (ok && !ok(s))
        problems.push(`${at}: ${label} "${unitId}" has the wrong side for this inject.`);
    };
    switch (i.type) {
      case 'CONFLICTING_REPORTS':
        need(i.unitId, 'unit', (s) => s !== 'BLUE');
        if (!inside(i.altPosition))
          problems.push(`${at}: alternative position is outside the exercise area.`);
        break;
      case 'SPOOF_ORDER':
        need(i.targetUnitId, 'target unit', (s) => s === 'BLUE');
        break;
      case 'RUNNER_DISPATCH':
        need(i.fromUnitId, 'sender unit', (s) => s === 'BLUE');
        need(i.toUnitId, 'recipient unit', (s) => s === 'BLUE');
        break;
      case 'ADVERSARY_MOVE':
        need(i.unitId, 'unit', (s) => s !== 'BLUE');
        if (!inside(i.destination))
          problems.push(`${at}: destination is outside the exercise area.`);
        break;
      default:
        break;
    }
  }
  return problems;
}
