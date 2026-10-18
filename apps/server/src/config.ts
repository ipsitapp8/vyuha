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
  /**
   * Bearer token for GET /metrics (Prometheus text). Unset = the endpoint does not exist. 32+ characters.
   */
  // Empty counts as unset: Docker Compose passes `${METRICS_TOKEN:-}` through as "".
  METRICS_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'METRICS_TOKEN must be at least 32 characters').optional(),
  ),
  /**
   * A deliberate public demo (render.yaml): production may then seed and keep the published demo password
   * shown on the sign-in pages, and start-up warns instead of refusing. Anyone can sign in as the demo
   * instructor, so never set it for a real exercise deployment.
   */
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * How many reverse proxies stand between the internet and this server. The client address is then
   * read that many entries from the RIGHT of X-Forwarded-For, i.e. the entry the outermost trusted proxy
   * appended; entries further left are client-supplied and never trusted. `false` (default) uses the
   * socket address; `true` means one proxy (the same as `1`); `2`..`5` for longer chains. Only set it
   * when the server cannot be reached except through those proxies.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine(
      (v) => /^(true|false|[0-5])$/.test(v),
      'TRUST_PROXY must be false, true (one proxy) or a proxy hop count from 0 to 5',
    )
    .transform((v): boolean | number => {
      if (v === 'true') return true;
      if (v === 'false' || v === '0') return false;
      return Number(v);
    }),
});

export type Config = z.infer<typeof envSchema>;

/** The value shipped in the example files. Fine for local development, never for production. */
export const PLACEHOLDER_JWT_SECRET_PREFIX = 'change-me';

/** Database password that older example files and Compose defaults published. Never for production. */
export const PUBLISHED_DATABASE_PASSWORD = 'vyuha_dev_password';

/** The password inside a postgres:// URL, or null when it cannot be read. */
function databasePassword(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return null;
  }
}

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
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.JWT_SECRET.startsWith(PLACEHOLDER_JWT_SECRET_PREFIX)
  ) {
    throw new Error(
      'JWT_SECRET is still the published placeholder. Production refuses to start with it: ' +
        'set JWT_SECRET to 32 or more random characters (for example: openssl rand -hex 32).',
    );
  }
  if (parsed.data.NODE_ENV === 'production') {
    // A URL that carries no password (socket / trust auth, or a secret supplied by the platform some
    // other way) is not judged here; only an empty or published one is refused. The value is never shown.
    const password = databasePassword(parsed.data.DATABASE_URL);
    const hasPasswordPart = /^[a-z]+:\/\/[^/@]*:[^/@]*@/i.test(parsed.data.DATABASE_URL);
    if (password === PUBLISHED_DATABASE_PASSWORD || (hasPasswordPart && password === '')) {
      throw new Error(
        'DATABASE_URL uses an empty or published database password. Production refuses to start with ' +
          'it: set POSTGRES_PASSWORD (Docker Compose) or the database password to a random value ' +
          '(for example: openssl rand -hex 24).',
      );
    }
  }
  return parsed.data;
}
