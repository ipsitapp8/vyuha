import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),
  OPEN_METEO_ELEVATION_URL: z.string().url().default('https://api.open-meteo.com/v1/elevation'),
  OPEN_METEO_FORECAST_URL: z.string().url().default('https://api.open-meteo.com/v1/forecast'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `Invalid or missing environment variables:\n${lines.join('\n')}\n` +
        'Copy apps/server/.env.example to apps/server/.env and fill in the values.',
    );
  }
  return parsed.data;
}
