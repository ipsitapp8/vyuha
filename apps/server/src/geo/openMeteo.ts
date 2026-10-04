import { chunk, type GeoPoint } from '@vyuha/engine';
import { z } from 'zod';

export interface GeoNetwork {
  /** Elevation in metres for every point, same order. */
  fetchElevations(
    points: readonly GeoPoint[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<number[]>;
  fetchWeather(
    at: GeoPoint,
  ): Promise<{ visibilityM: number; precipitationMm: number; windKph: number }>;
}

export interface OpenMeteoOptions {
  elevationUrl: string;
  forecastUrl: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  /** Wait after a per-minute 429 (Open-Meteo asks for one minute). */
  rateLimitWaitMs?: number;
}

/** Thrown when an upstream call cannot succeed (after retries, or on a non-retryable status). */
export class GeoNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeoNetworkError';
  }
}

const elevationBody = z.object({ elevation: z.array(z.number().finite()) });
const weatherBody = z.object({
  current: z.object({
    visibility: z.number().nullable().optional(),
    precipitation: z.number().nullable().optional(),
    wind_speed_10m: z.number().nullable().optional(),
  }),
});

const rateLimitBody = z.object({ reason: z.string() });

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isRetryableStatus = (s: number): boolean => s === 429 || s >= 500;

export function createOpenMeteoNetwork(opts: OpenMeteoOptions): GeoNetwork {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const batchSize = opts.batchSize ?? 100;
  const maxAttempts = opts.maxAttempts ?? 4;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const rateLimitWaitMs = opts.rateLimitWaitMs ?? 61_000;

  /** GET JSON with a per-attempt timeout and exponential backoff on network errors, 429 and 5xx. */
  async function getJson(url: string): Promise<unknown> {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let waitMs = baseDelayMs * 2 ** (attempt - 1);
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return await res.json();
        lastError = `HTTP ${res.status}`;
        if (res.status === 429) {
          const body: unknown = await res.json().catch(() => null);
          const parsed = rateLimitBody.safeParse(body);
          const why = parsed.success ? parsed.data.reason : 'rate limit exceeded';
          lastError = `HTTP 429: ${why}`;
          // Hourly/daily quotas will not clear within a request: fail fast with the upstream reason.
          if (/hourly|daily/i.test(why))
            throw new GeoNetworkError(`Open-Meteo quota reached (${why})`);
          waitMs = rateLimitWaitMs;
        } else if (!isRetryableStatus(res.status)) {
          throw new GeoNetworkError(`Open-Meteo rejected the request (${lastError})`);
        }
      } catch (err) {
        if (err instanceof GeoNetworkError) throw err;
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < maxAttempts) await sleep(waitMs);
    }
    throw new GeoNetworkError(
      `Open-Meteo unreachable after ${maxAttempts} attempts (${lastError})`,
    );
  }

  return {
    async fetchElevations(points, onProgress) {
      const out: number[] = [];
      for (const batch of chunk(points, batchSize)) {
        const lat = batch.map((p) => p.lat.toFixed(5)).join(',');
        const lon = batch.map((p) => p.lon.toFixed(5)).join(',');
        const json = await getJson(`${opts.elevationUrl}?latitude=${lat}&longitude=${lon}`);
        const parsed = elevationBody.safeParse(json);
        if (!parsed.success || parsed.data.elevation.length !== batch.length) {
          throw new GeoNetworkError('Open-Meteo returned an unexpected elevation response');
        }
        out.push(...parsed.data.elevation);
        onProgress?.(out.length, points.length);
      }
      return out;
    },

    async fetchWeather(at) {
      const url =
        `${opts.forecastUrl}?latitude=${at.lat.toFixed(5)}&longitude=${at.lon.toFixed(5)}` +
        '&current=visibility,precipitation,wind_speed_10m&wind_speed_unit=kmh';
      const parsed = weatherBody.safeParse(await getJson(url));
      if (!parsed.success)
        throw new GeoNetworkError('Open-Meteo returned an unexpected weather response');
      const c = parsed.data.current;
      return {
        visibilityM: Math.max(0, c.visibility ?? 10_000),
        precipitationMm: Math.max(0, c.precipitation ?? 0),
        windKph: Math.max(0, c.wind_speed_10m ?? 0),
      };
    },
  };
}
