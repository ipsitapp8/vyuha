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
