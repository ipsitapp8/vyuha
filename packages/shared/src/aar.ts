import { z } from 'zod';
import { channelSchema, latLonSchema } from './scenario';
import { perceivedStateSchema, playerRoleSchema, sessionStatusSchema } from './session';

// ---- Analysis (mirrors the engine's AarAnalysis) --------------------------------------------

const calibrationBinSchema = z.object({
  from: z.number(),
  to: z.number(),
  count: z.number().int(),
  meanConfidence: z.number(),
  accuracy: z.number(),
});

const driftPointSchema = z.object({
  tick: z.number().int(),
  missed: z.number(),
  ghost: z.number(),
  avgPositionErrorM: z.number(),
  friendlyAvgErrorM: z.number(),
});

const channelRecord = z.object({
  VHF: z.number(),
  HF: z.number(),
  SATCOM: z.number(),
  DATALINK: z.number(),
  RUNNER: z.number(),
});

const playerSummarySchema = z.object({
  playerId: z.string(),
  name: z.string(),
  role: z.string(),
  teamId: z.string(),
  decisionCount: z.number().int(),
  scoredDecisionCount: z.number().int(),
  avgLatencyTicks: z.number().nullable(),
  brierScore: z.number().nullable(),
  gradeCount: z.number().int(),
  gradingAccuracy: z.number().nullable(),
  channelSwitchCount: z.number().int(),
  spoofActedCount: z.number().int(),
  spoofsReceived: z.number().int(),
  spoofsChallenged: z.number().int(),
  /** 0..100, null when no spoofed order reached the trainee. */
  spoofsChallengedPct: z.number().nullable(),
  meanConfidence: z.number().nullable(),
  accuracy: z.number().nullable(),
  probeCount: z.number().int(),
  /** Mean situation-awareness probe score, 0..100; null when no probe was run. */
  saScore: z.number().nullable(),
  drift: z
    .object({
      samples: z.number().int(),
      meanMissed: z.number(),
      meanGhost: z.number(),
      meanPositionErrorM: z.number(),
      maxPositionErrorM: z.number(),
    })
    .nullable(),
});

const outcomesSchema = z.object({
  DELIVERED: z.number().int(),
  DELAYED: z.number().int(),
  DROPPED: z.number().int(),
  CORRUPTED: z.number().int(),
});

const probeChannel = z.union([channelSchema, z.literal('NONE')]);

/** One trainee's result for one situation-awareness probe: their answers beside the frozen truth. */
export const probeScoreSchema = z.object({
  probeId: z.string(),
  probeTick: z.number().int(),
  playerId: z.string(),
  answered: z.boolean(),
  score: z.number(),
  contactScore: z.number(),
  teammateScore: z.number(),
  channelCorrect: z.boolean(),
  matched: z.array(z.object({ unitId: z.string(), marker: z.number().int(), errorM: z.number() })),
  missedUnitIds: z.array(z.string()),
  ghostCount: z.number().int(),
  avgContactErrorM: z.number().nullable(),
  teammateErrors: z.array(z.object({ unitId: z.string(), errorM: z.number().nullable() })),
  avgTeammateErrorM: z.number().nullable(),
  answer: z
    .object({
      contacts: z.array(latLonSchema),
      teammates: z.array(z.object({ unitId: z.string(), position: latLonSchema })),
      jammedChannel: probeChannel,
    })
    .nullable(),
  truth: z.object({
    hostiles: z.array(z.object({ unitId: z.string(), type: z.string(), position: latLonSchema })),
    teammates: z.array(z.object({ unitId: z.string(), position: latLonSchema })),
    jammedChannel: probeChannel,
  }),
});
export type ProbeScoreDto = z.infer<typeof probeScoreSchema>;

export const probeReviewSchema = z.object({
  probeId: z.string(),
  tick: z.number().int(),
  results: z.array(probeScoreSchema),
});
export type ProbeReviewDto = z.infer<typeof probeReviewSchema>;

/** What a trainee may see of their own probes once the exercise has ended: scores, never the truth. */
export const mySaScoresResponseSchema = z.object({
  probes: z.array(
    z.object({
      probeId: z.string(),
      tick: z.number().int(),
      answered: z.boolean(),
      score: z.number(),
      channelCorrect: z.boolean(),
      contactsFound: z.number().int(),
      contactsMissed: z.number().int(),
      ghostCount: z.number().int(),
      avgContactErrorM: z.number().nullable(),
      avgTeammateErrorM: z.number().nullable(),
    }),
  ),
  /** Mean over the probes, 0..100; null when there were none. */
  saScore: z.number().nullable(),
});
export type MySaScoresResponse = z.infer<typeof mySaScoresResponseSchema>;

export const learningPointSchema = z.object({
  rule: z.string(),
  severity: z.enum(['good', 'info', 'warn']),
  playerId: z.string().nullable(),
  teamId: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type LearningPointDto = z.infer<typeof learningPointSchema>;

export const timelineItemSchema = z.object({
  tick: z.number().int(),
  kind: z.enum([
    'INJECT',
    'SPOOF',
    'AUTH',
    'CHANNEL_SWITCH',
    'DECISION',
    'JAMMING',
    'C2_DETECTED',
    'UAV_SPOOF_ACTED',
  ]),
  playerId: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type TimelineItemDto = z.infer<typeof timelineItemSchema>;

export const aarDecisionSchema = z.object({
  id: z.string(),
  playerId: z.string(),
  tick: z.number().int(),
  actionType: z.string(),
  confidence: z.number(),
  rationale: z.string(),
  targetContactId: z.string().nullable(),
  basedOnMessageId: z.string().nullable(),
  outcome: z.union([z.literal(0), z.literal(1)]).nullable(),
  latencyTicks: z.number().nullable(),
  spoofActed: z.boolean(),
});
export type AarDecisionDto = z.infer<typeof aarDecisionSchema>;

export const aarSummarySchema = z.object({
  meta: z.object({
    sessionId: z.string(),
    code: z.string(),
    scenarioTitle: z.string(),
    status: sessionStatusSchema,
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    durationTicks: z.number().int(),
    teams: z.array(z.object({ id: z.string(), name: z.string(), primary: channelSchema })),
    players: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        isDemoBot: z.boolean(),
        role: playerRoleSchema,
        teamId: z.string(),
        unitId: z.string(),
      }),
    ),
    scenarioId: z.string(),
    areaBounds: z.object({
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    }),
  }),
  decisions: z.array(aarDecisionSchema),
  analysis: z.object({
    players: z.array(playerSummarySchema),
    drift: z.record(z.string(), z.array(driftPointSchema)),
    calibration: z.object({
      overall: z.array(calibrationBinSchema),
      byPlayer: z.record(z.string(), z.array(calibrationBinSchema)),
    }),
    channels: z.array(
      z.object({
        tick: z.number().int(),
        usage: channelRecord,
        jamming: channelRecord,
        satcomUp: z.boolean(),
      }),
    ),
    flow: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        kind: z.string(),
        channel: channelSchema,
        total: z.number().int(),
        outcomes: outcomesSchema,
      }),
    ),
    timeline: z.array(timelineItemSchema),
    learning: z.array(learningPointSchema),
    probes: z.array(probeReviewSchema),
  }),
});
export type AarSummary = z.infer<typeof aarSummarySchema>;

// ---- Ghost replay ----------------------------------------------------------------------------

export const aarTruthSchema = z.object({
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
      status: z.enum(['ACTIVE', 'DAMAGED', 'DESTROYED', 'OFFLINE']),
      destination: latLonSchema.nullable(),
    }),
  ),
  jamming: channelRecord,
  satcomUp: z.boolean(),
});
export type AarTruth = z.infer<typeof aarTruthSchema>;

export const aarSnapshotSchema = z.object({
  tick: z.number().int(),
  truth: aarTruthSchema,
  perceived: perceivedStateSchema.nullable(),
});
export type AarSnapshot = z.infer<typeof aarSnapshotSchema>;

/** A decision with the two snapshots recorded at the moment it was made: what they saw vs what was true. */
export const aarDecisionDetailSchema = z.object({
  decision: aarDecisionSchema,
  perceived: perceivedStateSchema,
  truth: z.object({
    tick: z.number().int(),
    units: z.array(
      z.object({
        id: z.string(),
        side: z.enum(['BLUE', 'RED', 'NEUTRAL']),
        type: z.string(),
        position: latLonSchema,
        status: z.string(),
      }),
    ),
    jamming: channelRecord,
    satcomUp: z.boolean(),
  }),
});
export type AarDecisionDetail = z.infer<typeof aarDecisionDetailSchema>;

// ---- English wording (the on-screen review translates these ids; the PDF uses them directly) ----

export const LEARNING_TEXT_EN: Record<string, string> = {
  NO_DECISIONS: 'Recorded no decisions during the exercise.',
  ACTED_ON_LOW_GRADE: 'Acted on a report they had graded as unreliable {{count}} time(s).',
  ACTED_ON_GHOST: 'Engaged or reported a ghost contact (no real unit behind it) {{count}} time(s).',
  ACTED_ON_SPOOF:
    'Acted on an order that had not been authenticated and was spoofed, {{count}} time(s).',
  ACTED_ON_FAILED_AUTH:
    'Acted on an order after authentication had shown it to be fake, {{count}} time(s).',
  NEVER_AUTHENTICATED: 'Received {{received}} spoofed order(s) and never used Authenticate.',
  SPOOF_HANDLED_WELL: 'Received {{received}} spoofed order(s) and authenticated before acting.',
  OVERCONFIDENT:
    'Overconfident: stated {{confidence}}% confidence on average but was correct {{accuracy}}% of the time ({{decisions}} scored decisions).',
  UNDERCONFIDENT:
    'Underconfident: stated {{confidence}}% confidence on average but was correct {{accuracy}}% of the time ({{decisions}} scored decisions).',
  WELL_CALIBRATED:
    'Well calibrated: stated {{confidence}}% confidence and was correct {{accuracy}}% of the time ({{decisions}} scored decisions).',
  SLOW_DECISIONS: 'Decisions took {{seconds}} s on average after the relevant information arrived.',
  GRADING_POOR:
    'Report grading was poor: {{accuracy}}% accuracy over {{grades}} grades against the hidden true reliability.',
  GRADING_GOOD: 'Report grading was good: {{accuracy}}% accuracy over {{grades}} grades.',
  NEVER_GRADED: 'Received {{contacts}} contact reports and never graded one.',
  HIGH_DRIFT:
    'The picture was far from reality: on average {{errorM}} m of position error and {{missed}} hostile unit(s) missed.',
  ACTED_ON_SPOOFED_UAV:
    'Acted on spoofed UAV data: engaged or reported up {{count}} contact(s) placed by a UAV whose navigation was being spoofed.',
  GPS_SPOOF_SUSPECTED:
    'Graded {{count}} report(s) from the spoofed UAV as unreliable: the bad positions were noticed.',
  C2_DETECTED:
    'Detected the C2 compromise at {{time}} (tick {{tick}}), {{seconds}} s after it began, by cross-checking over {{via}}.',
  C2_NOT_DETECTED:
    'Never detected the C2 compromise: teammate positions were wrong for {{seconds}} s with no cross-check over another channel or a runner.',
  LOW_SA:
    'Situation awareness was low: {{score}} out of 100 on average over {{probes}} freeze probe(s).',
  GOOD_SA:
    'Situation awareness was strong: {{score}} out of 100 on average over {{probes}} freeze probe(s).',
  NO_SWITCH_WHILE_JAMMED:
    'Team {{team}} did not switch away from heavily jammed {{channel}} for {{seconds}} s.',
  SLOW_SWITCH: 'Team {{team}} took {{seconds}} s to leave jammed {{channel}}.',
  QUICK_SWITCH:
    'Team {{team}} left jammed {{channel}} after only {{seconds}} s: a good use of the PACE plan.',
};

export function formatTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => String(params[key] ?? ''));
}

export const learningTextEn = (p: Pick<LearningPointDto, 'rule' | 'params'>): string =>
  formatTemplate(LEARNING_TEXT_EN[p.rule] ?? p.rule, p.params);

export const formatClock = (tick: number): string => {
  const t = Math.max(0, Math.floor(tick));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
