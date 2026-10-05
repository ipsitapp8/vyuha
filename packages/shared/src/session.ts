import { z } from 'zod';
import { apiErrorCodeSchema } from './errors';
import {
  areaBoundsSchema,
  channelSchema,
  injectSchema,
  latLonSchema,
  paceDefaultsSchema,
  unitStatusSchema,
} from './scenario';

// ---- Sessions (REST) ---------------------------------------------------------------------

export const sessionStatusSchema = z.enum(['LOBBY', 'RUNNING', 'PAUSED', 'ENDED']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const playerRoleSchema = z.enum(['PL_CDR', 'SECTION_CDR', 'EW_OFFICER', 'ISR_OPERATOR']);
export type PlayerRole = z.infer<typeof playerRoleSchema>;

export const speedSchema = z.union([z.literal(1), z.literal(2), z.literal(4)]);
export type Speed = z.infer<typeof speedSchema>;

export const SESSION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const sessionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9]{6}$/, 'Session code is 6 letters/digits'));

export const createSessionBodySchema = z.object({ scenarioId: z.string().min(1) });
export const joinSessionBodySchema = z.object({ code: sessionCodeSchema });
export const createTeamBodySchema = z.object({
  name: z.string().trim().min(1, 'Team name is required').max(40),
  pace: paceDefaultsSchema.optional(),
});
export const updateTeamBodySchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    pace: paceDefaultsSchema.optional(),
  })
  .refine((b) => b.name !== undefined || b.pace !== undefined, { message: 'Nothing to update' });
export const updatePaceBodySchema = z.object({ pace: paceDefaultsSchema });
export const assignPlayerBodySchema = z
  .object({
    teamId: z.string().min(1).nullable().optional(),
    role: playerRoleSchema.nullable().optional(),
    unitId: z.string().min(1).nullable().optional(),
  })
  .refine((b) => b.teamId !== undefined || b.role !== undefined || b.unitId !== undefined, {
    message: 'Nothing to update',
  });
export const setSpeedBodySchema = z.object({ speed: speedSchema });

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type JoinSessionBody = z.infer<typeof joinSessionBodySchema>;
export type CreateTeamBody = z.infer<typeof createTeamBodySchema>;
export type UpdateTeamBody = z.infer<typeof updateTeamBodySchema>;
export type UpdatePaceBody = z.infer<typeof updatePaceBodySchema>;
export type AssignPlayerBody = z.infer<typeof assignPlayerBodySchema>;
export type SetSpeedBody = z.infer<typeof setSpeedBodySchema>;

export const lobbyViewSchema = z.object({
  session: z.object({
    id: z.string(),
    code: z.string(),
    status: sessionStatusSchema,
    speed: speedSchema,
    tick: z.number().int().min(0),
    scenarioId: z.string(),
    scenarioTitle: z.string(),
    areaBounds: areaBoundsSchema,
    createdAt: z.string(),
    /** Baseline run: every degradation is switched off. */
    clean: z.boolean(),
    /** For a baseline run: the finished session it is the twin of. */
    baselineOfId: z.string().nullable(),
  }),
  teams: z.array(z.object({ id: z.string(), name: z.string(), pace: paceDefaultsSchema })),
  players: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      name: z.string(),
      isDemoBot: z.boolean(),
      teamId: z.string().nullable(),
      role: playerRoleSchema.nullable(),
      unitId: z.string().nullable(),
    }),
  ),
  /** Friendly units that can be assigned to players. */
  units: z.array(
    z.object({ id: z.string(), name: z.string(), type: z.string(), domain: z.string() }),
  ),
});
export type LobbyView = z.infer<typeof lobbyViewSchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      status: sessionStatusSchema,
      scenarioTitle: z.string(),
      playerCount: z.number().int(),
      createdAt: z.string(),
      clean: z.boolean(),
      baselineOfId: z.string().nullable(),
    }),
  ),
});
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const joinSessionResponseSchema = z.object({
  sessionId: z.string(),
  code: z.string(),
  playerId: z.string(),
});
export type JoinSessionResponse = z.infer<typeof joinSessionResponseSchema>;

// ---- Socket contracts ----------------------------------------------------------------------

export const SOCKET_EVENTS = {
  instructorInput: 'instructor:input',
  watch: 'instructor:watch',
  join: 'session:join',
  action: 'action',
  lobbyUpdate: 'lobby:update',
  status: 'session:status',
  perceived: 'perceived:state',
  playerEvents: 'player:events',
  truth: 'truth:state',
  truthEvents: 'truth:events',
  error: 'error:event',
} as const;

export const joinPayloadSchema = z.object({ code: sessionCodeSchema });
export type JoinPayload = z.infer<typeof joinPayloadSchema>;

const text = z.string().trim().min(1).max(500);
const reliabilitySchema = z.enum(['A', 'B', 'C', 'D', 'E', 'F']);
const credibilitySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export const decisionActionSchema = z.enum([
  'ENGAGE',
  'HOLD',
  'WITHDRAW',
  'REPOSITION',
  'REPORT_UP',
  'COMPLY_ORDER',
  'IGNORE_ORDER',
  'REQUEST_SUPPORT',
]);

export const PROBE_MAX_CONTACTS = 20;
export const PROBE_MAX_TEAMMATES = 16;
export const probeChannelSchema = z.union([channelSchema, z.literal('NONE')]);
export type ProbeChannel = z.infer<typeof probeChannelSchema>;

/** Everything a trainee can do in a running session. The server adds the player id from the socket. */
export const playerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SEND_MESSAGE'),
    toPlayerId: z.string().min(1),
    channel: channelSchema,
    text,
    position: latLonSchema.optional(),
  }),
  z.object({ type: z.literal('MOVE_UNIT'), unitId: z.string().min(1), destination: latLonSchema }),
  z.object({ type: z.literal('REQUEST_ISR'), target: latLonSchema }),
  z.object({
    type: z.literal('GRADE_REPORT'),
    reportId: z.string().min(1),
    reliability: reliabilitySchema,
    credibility: credibilitySchema,
  }),
  z.object({ type: z.literal('AUTHENTICATE'), messageId: z.string().min(1) }),
  z.object({ type: z.literal('SWITCH_CHANNEL'), channel: channelSchema }),
  z.object({
    type: z.literal('DECISION'),
    actionType: decisionActionSchema,
    confidence: z.number().int().min(0).max(100),
    rationale: z.string().trim().min(10, 'Rationale must be at least 10 characters').max(1000),
    targetContactId: z.string().min(1).optional(),
    basedOnMessageId: z.string().min(1).optional(),
  }),
  // Answer to a situation-awareness probe (SAGAT). Accepted while the exercise is frozen.
  z.object({
    type: z.literal('PROBE_ANSWER'),
    probeId: z.string().min(1).max(64),
    contacts: z.array(latLonSchema).max(PROBE_MAX_CONTACTS),
    teammates: z
      .array(z.object({ unitId: z.string().min(1).max(64), position: latLonSchema }))
      .max(PROBE_MAX_TEAMMATES)
      .refine((list) => new Set(list.map((t) => t.unitId)).size === list.length, {
        message: 'Each teammate can be placed once',
      }),
    jammedChannel: probeChannelSchema,
  }),
]);
export type PlayerAction = z.infer<typeof playerActionSchema>;

/** Everything the instructor can do to a live exercise. The server assigns ids to new injects. */
export const instructorInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('INJECT_NOW'), inject: injectSchema }),
  z.object({
    type: z.literal('SET_JAMMING'),
    channel: channelSchema.exclude(['RUNNER']),
    intensity: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal('MSEL_ADD'), inject: injectSchema }),
  z.object({ type: z.literal('MSEL_UPDATE'), inject: injectSchema }),
  z.object({ type: z.literal('MSEL_REMOVE'), injectId: z.string().min(1) }),
  // Opens a situation-awareness probe. The server assigns the id (POST /sessions/:id/probe also pauses).
  z.object({ type: z.literal('PROBE_START'), probeId: z.string().min(1).max(64) }),
  // Closes any open probe; trainees who have not answered score zero. Sent when the exercise ends.
  z.object({ type: z.literal('PROBE_CLOSE') }),
]);
export type InstructorInput = z.infer<typeof instructorInputSchema>;

/** Which trainee's perceived picture the instructor is looking at (null = nobody). */
export const watchPayloadSchema = z.object({ playerId: z.string().min(1).nullable() });
export type WatchPayload = z.infer<typeof watchPayloadSchema>;

export const ackSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: apiErrorCodeSchema, message: z.string() }),
  }),
]);
export type Ack = z.infer<typeof ackSchema>;

export const sessionStatusEventSchema = z.object({
  status: sessionStatusSchema,
  tick: z.number().int().min(0),
  speed: speedSchema,
});
export type SessionStatusEvent = z.infer<typeof sessionStatusEventSchema>;

export const joinAckSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    role: z.enum(['INSTRUCTOR', 'TRAINEE']),
    playerId: z.string().nullable(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: apiErrorCodeSchema, message: z.string() }),
  }),
]);
export type JoinAck = z.infer<typeof joinAckSchema>;

const pointNullable = latLonSchema.nullable();
const signalSchema = z.object({
  VHF: z.number().nullable(),
  HF: z.number().nullable(),
  SATCOM: z.number().nullable(),
  DATALINK: z.number().nullable(),
  RUNNER: z.number().nullable(),
});
const weatherViewSchema = z.object({
  visibilityM: z.number(),
  precipitationMm: z.number(),
  windKph: z.number(),
});

/** What the server sends a trainee each second. Mirrors the engine's PerceivedState (no truth). */
export const perceivedStateSchema = z.object({
  tick: z.number().int(),
  playerId: z.string(),
  teamId: z.string(),
  role: playerRoleSchema,
  self: z.object({
    unitId: z.string(),
    name: z.string(),
    type: z.string(),
    position: latLonSchema,
    heading: z.number(),
    speed: z.number(),
    strength: z.number(),
    status: unitStatusSchema,
    destination: pointNullable,
  }),
  friendlies: z.array(
    z.object({
      unitId: z.string(),
      name: z.string(),
      type: z.string(),
      position: latLonSchema,
      observedTick: z.number(),
      ageTicks: z.number(),
    }),
  ),
  contacts: z.array(
    z.object({
      id: z.string(),
      position: latLonSchema,
      type: z.string(),
      observedTick: z.number(),
      receivedTick: z.number(),
      ageTicks: z.number(),
      source: z.string(),
      via: z.union([channelSchema, z.literal('DIRECT')]),
      grade: z
        .object({ reliability: reliabilitySchema, credibility: credibilitySchema })
        .nullable(),
    }),
  ),
  inbox: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['TEXT', 'REPORT', 'POSITION', 'ORDER']),
      from: z.string(),
      channel: channelSchema,
      sentTick: z.number(),
      receivedTick: z.number(),
      text: z.string(),
      position: pointNullable,
      requiresAuth: z.boolean(),
      authState: z.enum(['NONE', 'PENDING', 'VERIFIED', 'FAILED']),
      authResolvesAtTick: z.number().nullable(),
    }),
  ),
  comms: z.object({
    activeChannel: channelSchema,
    pace: paceDefaultsSchema,
    switchPenaltyActive: z.boolean(),
    signal: signalSchema,
  }),
  weather: weatherViewSchema,
  /** A situation-awareness probe waiting for this trainee's answer. Carries no ground truth. */
  probe: z
    .object({ id: z.string(), tick: z.number().int(), expiresAtTick: z.number().int() })
    .nullable(),
});
export type PerceivedStateDto = z.infer<typeof perceivedStateSchema>;

export const eventDtoSchema = z.object({
  tick: z.number().int(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventDto = z.infer<typeof eventDtoSchema>;

export const truthEventDtoSchema = eventDtoSchema.extend({ visibleTo: z.array(z.string()) });
export type TruthEventDto = z.infer<typeof truthEventDtoSchema>;

export const playerMetricsViewSchema = z.object({
  decisionCount: z.number().int(),
  scoredDecisionCount: z.number().int(),
  avgLatencyTicks: z.number().nullable(),
  brierScore: z.number().nullable(),
  /** Mean stated confidence (0-100) over scored decisions, to compare with `accuracy`. */
  meanConfidence: z.number().nullable(),
  /** Share of scored decisions that were correct (0-100). */
  accuracy: z.number().nullable(),
  gradeCount: z.number().int(),
  gradingAccuracy: z.number().nullable(),
  channelSwitchCount: z.number().int(),
  spoofActedCount: z.number().int(),
  /** Situation-awareness probes scored so far, the latest score and the mean (0..100). */
  probeCount: z.number().int(),
  lastSaScore: z.number().nullable(),
  saScore: z.number().nullable(),
  lastDecision: z
    .object({
      tick: z.number().int(),
      actionType: z.string(),
      confidence: z.number(),
      outcome: z.union([z.literal(0), z.literal(1)]).nullable(),
      rationale: z.string(),
    })
    .nullable(),
});
export type PlayerMetricsView = z.infer<typeof playerMetricsViewSchema>;

/** Instructor-only ground truth snapshot. */
export const truthViewSchema = z.object({
  tick: z.number().int(),
  units: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      side: z.enum(['BLUE', 'RED', 'NEUTRAL']),
      domain: z.string(),
      type: z.string(),
      position: latLonSchema,
      heading: z.number(),
      status: unitStatusSchema,
      destination: pointNullable,
    }),
  ),
  jamming: z.object({
    VHF: z.number(),
    HF: z.number(),
    SATCOM: z.number(),
    DATALINK: z.number(),
    RUNNER: z.number(),
  }),
  satcomUp: z.boolean(),
  weather: weatherViewSchema,
  manualJamming: z.object({
    VHF: z.number(),
    HF: z.number(),
    SATCOM: z.number(),
    DATALINK: z.number(),
    RUNNER: z.number(),
  }),
  msel: z.array(z.object({ inject: injectSchema, fired: z.boolean() })),
  /** Air and cyber effects in force right now (instructor only; trainees are never told). */
  effects: z.object({
    gpsSpoofs: z.array(
      z.object({ unitId: z.string(), offsetM: z.number(), untilTick: z.number().int() }),
    ),
    c2Compromises: z.array(
      z.object({
        playerId: z.string(),
        sinceTick: z.number().int(),
        untilTick: z.number().int(),
        channel: channelSchema,
        driftM: z.number(),
      }),
    ),
  }),
  /** The open situation-awareness probe, with the trainees who have still to answer. */
  probe: z
    .object({
      id: z.string(),
      tick: z.number().int(),
      expiresAtTick: z.number().int(),
      pending: z.array(z.string()),
    })
    .nullable(),
  players: z.record(z.string(), playerMetricsViewSchema),
  drift: z.record(
    z.string(),
    z.object({
      missed: z.number(),
      ghost: z.number(),
      avgPositionErrorM: z.number(),
      friendlyAvgErrorM: z.number(),
    }),
  ),
});
export type TruthViewDto = z.infer<typeof truthViewSchema>;
