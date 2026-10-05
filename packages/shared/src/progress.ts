import { z } from 'zod';

const metric = z.number().nullable();

/** The numbers tracked for a trainee in one session. Null = not measurable in that session. */
export const progressMetricsSchema = z.object({
  avgDecisionLatencyMs: metric,
  latencyUnderJammingMs: metric,
  brierScore: metric,
  /** 0..100 */
  spoofsChallengedPct: metric,
  /** 0..1 */
  reportGradingAccuracy: metric,
  /** Mean situation-awareness probe score, 0..100. */
  saScore: metric,
});
export type ProgressMetricsDto = z.infer<typeof progressMetricsSchema>;

export const progressSessionSchema = z.object({
  sessionId: z.string(),
  code: z.string(),
  scenarioTitle: z.string(),
  endedAt: z.string(),
  metrics: progressMetricsSchema,
});
export type ProgressSession = z.infer<typeof progressSessionSchema>;

export const progressUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Scripted demo trainee; shown as "Demo bot" wherever the name appears. */
  isDemoBot: z.boolean(),
});

/** GET /progress/:userId. `sessions` run oldest first. */
export const progressResponseSchema = z.object({
  user: progressUserSchema,
  sessions: z.array(progressSessionSchema),
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

/** GET /progress/trainees (instructors): who can be viewed. */
export const progressTraineesResponseSchema = z.object({
  trainees: z.array(progressUserSchema.extend({ sessionCount: z.number().int() })),
});
export type ProgressTraineesResponse = z.infer<typeof progressTraineesResponseSchema>;
