import { describe, expect, it, vi } from 'vitest';
import { createOpenMeteoNetwork, GeoNetworkError } from './openMeteo';

const URLS = { elevationUrl: 'http://x/elev', forecastUrl: 'http://x/forecast' };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 34 + i / 1000, lon: 77 }));

function elevationFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const lat = new URL(String(input)).searchParams.get('latitude') ?? '';
    return json({ elevation: lat.split(',').map(() => 3000) });
  });
}

describe('fetchElevations', () => {
  it('batches 250 points into 3 requests of at most 100 and keeps order', async () => {
    const fetchFn = elevationFetch();
    const net = createOpenMeteoNetwork({ ...URLS, fetchFn });
    const progress: number[] = [];
    const out = await net.fetchElevations(pts(250), (done) => progress.push(done));
    expect(out).toHaveLength(250);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const sizes = fetchFn.mock.calls.map(
      ([u]) => (new URL(String(u)).searchParams.get('latitude') ?? '').split(',').length,
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(progress).toEqual([100, 200, 250]);
  });

  it('retries 5xx with exponential backoff then succeeds', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      calls++;
      return calls < 3 ? json({}, 503) : json({ elevation: [10] });
    });
    const net = createOpenMeteoNetwork({
      ...URLS,
      fetchFn,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await net.fetchElevations(pts(1))).toEqual([10]);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('retries network errors and gives up after maxAttempts with a clear error', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const net = createOpenMeteoNetwork({ ...URLS, fetchFn, sleep: async () => {}, maxAttempts: 3 });
    await expect(net.fetchElevations(pts(1))).rejects.toThrow(
      /unreachable after 3 attempts.*fetch failed/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('waits the rate-limit window on a per-minute 429 and fails fast on hourly quota', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const minutely = vi.fn<typeof fetch>(async () =>
      ++n === 1
        ? json({ error: true, reason: 'Minutely API request limit exceeded.' }, 429)
        : json({ elevation: [5] }),
    );
    const net = createOpenMeteoNetwork({
      ...URLS,
      fetchFn: minutely,
      sleep: async (ms) => void sleeps.push(ms),
      rateLimitWaitMs: 61_000,
    });
    expect(await net.fetchElevations(pts(1))).toEqual([5]);
    expect(sleeps).toEqual([61_000]);

    const hourly = vi.fn<typeof fetch>(async () =>
      json({ reason: 'Hourly API request limit exceeded.' }, 429),
    );
    const net2 = createOpenMeteoNetwork({ ...URLS, fetchFn: hourly, sleep: async () => {} });
    await expect(net2.fetchElevations(pts(1))).rejects.toBeInstanceOf(GeoNetworkError);
    expect(hourly).toHaveBeenCalledTimes(1);
  });

  it('does not retry other 4xx and rejects malformed or short responses', async () => {
    const bad = vi.fn<typeof fetch>(async () => json({}, 400));
    await expect(
      createOpenMeteoNetwork({ ...URLS, fetchFn: bad, sleep: async () => {} }).fetchElevations(
        pts(1),
      ),
    ).rejects.toThrow(/rejected/);
    expect(bad).toHaveBeenCalledTimes(1);

    const short = vi.fn<typeof fetch>(async () => json({ elevation: [1] }));
    await expect(
      createOpenMeteoNetwork({ ...URLS, fetchFn: short }).fetchElevations(pts(2)),
    ).rejects.toThrow(/unexpected elevation response/);
  });

  it('passes an abort signal so each attempt times out', async () => {
    const fetchFn = elevationFetch();
    await createOpenMeteoNetwork({ ...URLS, fetchFn, timeoutMs: 1234 }).fetchElevations(pts(1));
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchWeather', () => {
  it('maps visibility, precipitation and wind, defaulting nulls', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      json({ current: { visibility: 43380, precipitation: 0.4, wind_speed_10m: 4.6 } }),
    );
    const w = await createOpenMeteoNetwork({ ...URLS, fetchFn }).fetchWeather({
      lat: 34.17,
      lon: 77.57,
    });
    expect(w).toEqual({ visibilityM: 43380, precipitationMm: 0.4, windKph: 4.6 });
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(url.searchParams.get('current')).toContain('visibility');

    const nulls = vi.fn<typeof fetch>(async () => json({ current: { visibility: null } }));
    expect(
      await createOpenMeteoNetwork({ ...URLS, fetchFn: nulls }).fetchWeather({ lat: 0, lon: 0 }),
    ).toEqual({
      visibilityM: 10_000,
      precipitationMm: 0,
      windKph: 0,
    });
  });
});
