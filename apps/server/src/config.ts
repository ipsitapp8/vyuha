import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Comma separated allow-list of browser origins. Never '*': cookies are sent with credentials. */
  CORS_ORIGIN: z
    .string()
    .min(1, 'CORS_ORIGIN is required')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    )
    .refine((list) => list.length > 0, 'CORS_ORIGIN needs at least one origin')
    .refine(
      (list) => list.every((o) => /^https?:\/\/[^*\s/]+$/.test(o)),
      'CORS_ORIGIN must be exact http(s) origins like http://localhost:5173 (no wildcards, paths or spaces)',
    ),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OPEN_METEO_ELEVATION_URL: z.string().url().default('https://api.open-meteo.com/v1/elevation'),
  OPEN_METEO_FORECAST_URL: z.string().url().default('https://api.open-meteo.com/v1/forecast'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Where the API lives. Empty (default) serves it at the root, next to a separately hosted web app.
   * "/api" is for the single-service deployment, where the same server also serves the web app.
   */
  API_PREFIX: z
    .string()
    .regex(/^(\/[a-z0-9-]+)?$/, 'API_PREFIX must be empty or a path like /api')
    .default(''),
  /** Folder with the built web app (apps/web/dist). When set, the server serves it as well as the API. */
  WEB_DIST_DIR: z.string().min(1).optional(),
  /** Trust X-Forwarded-For from the hosting proxy so rate limits see each visitor's own address. */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Render provides the service's public address as RENDER_EXTERNAL_URL; with the web app served from
  // the same address it is the one origin that needs to be allowed.
  const parsed = envSchema.safeParse({
    ...env,
    CORS_ORIGIN: env['CORS_ORIGIN'] ?? env['RENDER_EXTERNAL_URL'],
  });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `Invalid or missing environment variables:\n${lines.join('\n')}\n` +
        'Copy apps/server/.env.example to apps/server/.env and fill in the values.',
    );
  }
  return parsed.data;
}
