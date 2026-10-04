import { z } from 'zod';

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.boolean(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
