import type { Channel, LatLon } from '@vyuha/shared';
import { BASE_LATENCY_TICKS, BASE_QUALITY, RANGE_M, RUNNER_SPEED_MPS } from './config';
import { clamp, EARTH_RADIUS_M, haversineM, lerpLatLon, offsetByBearing } from './geometry';
import { randRange, type Rng } from './prng';
import { bilinearElevation, type TerrainGridData } from './terrain';
import type { DeliveryOutcome, Weather } from './types';

/** Effective-earth-radius factor for standard atmospheric refraction. */
const K_FACTOR = 4 / 3;
export const LOS_SAMPLES = 50;

/** Ground elevation (m); coordinates outside the grid are clamped to its edge. */
export function elevationAt(terrain: TerrainGridData, p: LatLon): number {
  const { bbox } = terrain;
  const lat = clamp(p.lat, bbox.south, bbox.north);
  const lon = clamp(p.lon, bbox.west, bbox.east);
  return bilinearElevation(terrain, lat, lon) ?? 0;
}

export interface LosOptions {
  /** Antenna height above ground at A / B (m). */
  aHeightM?: number;
  bHeightM?: number;
  samples?: number;
}

/**
 * Terrain line of sight between two points: samples the path (default 50 points) and checks that
 * terrain (plus earth bulge) never rises above the straight sight line between the two antennas.
 */
export function lineOfSight(
  terrain: TerrainGridData,
  a: LatLon,
  b: LatLon,
  opts: LosOptions = {},
): boolean {
  const samples = opts.samples ?? LOS_SAMPLES;
  const hA = elevationAt(terrain, a) + (opts.aHeightM ?? 2);
  const hB = elevationAt(terrain, b) + (opts.bHeightM ?? 2);
  const d = haversineM(a, b);
  for (let i = 1; i <= samples; i++) {
    const t = i / (samples + 1);
    const ground = elevationAt(terrain, lerpLatLon(a, b, t));
    const bulge = (d * t * (d * (1 - t))) / (2 * EARTH_RADIUS_M * K_FACTOR);
    const sightLine = hA + (hB - hA) * t;
    if (ground + bulge > sightLine) return false;
  }
  return true;
}

export function distanceFactor(channel: Channel, distanceM: number): number {
  const range = RANGE_M[channel];
  if (!Number.isFinite(range)) return 1;
  return clamp(1 - (distanceM / range) ** 2, 0, 1);
}

export function losFactor(channel: Channel, los: boolean): number {
  if (los) return 1;
  switch (channel) {
    case 'VHF':
      return 0.15;
    case 'DATALINK':
      return 0.1;
    case 'HF':
      return 0.85; // ground/sky wave is far less terrain-dependent
    default:
      return 1;
  }
}

export function weatherFactor(channel: Channel, w: Weather): number {
  switch (channel) {
    case 'HF':
      return 1 - Math.min(0.45, w.precipitationMm * 0.05 + w.windKph / 200);
    case 'SATCOM':
      return 1 - Math.min(0.3, w.precipitationMm * 0.03);
    case 'VHF':
      return 1 - Math.min(0.1, w.precipitationMm * 0.01);
    case 'DATALINK':
      return 1 - Math.min(0.15, w.precipitationMm * 0.02);
    default:
      return 1;
  }
}

export interface QualityInput {
  distanceM: number;
  los: boolean;
  /** Jamming level 0..1 on this channel. */
  jamming: number;
  weather: Weather;
  satcomUp: boolean;
}

/** quality = baseQuality[C] x distanceFactor x losFactor x (1 - jamming[C]) x weatherFactor[C]  (0..1) */
export function channelQuality(channel: Channel, q: QualityInput): number {
  if (channel === 'SATCOM' && !q.satcomUp) return 0;
  if (channel === 'RUNNER') return 1;
  return clamp(
    BASE_QUALITY[channel] *
      distanceFactor(channel, q.distanceM) *
      losFactor(channel, q.los) *
      (1 - clamp(q.jamming, 0, 1)) *
      weatherFactor(channel, q.weather),
    0,
    1,
  );
}

export interface LinkEnv {
  terrain: TerrainGridData;
  weather: Weather;
  jamming: Record<Channel, number>;
  satcomUp: boolean;
}

export interface Link {
  channel: Channel;
  from: LatLon;
  to: LatLon;
  fromHeightM: number;
  toHeightM: number;
}

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  quality: number;
  los: boolean;
  distanceM: number;
  /** Ticks from send to arrival (undefined for DROPPED). */
  delayTicks: number | null;
  jamming: number;
}

export function linkQuality(
  link: Link,
  env: LinkEnv,
): { quality: number; los: boolean; distanceM: number } {
  const distanceM = haversineM(link.from, link.to);
  const los = lineOfSight(env.terrain, link.from, link.to, {
    aHeightM: link.fromHeightM,
    bHeightM: link.toHeightM,
  });
  const quality = channelQuality(link.channel, {
    distanceM,
    los,
    jamming: env.jamming[link.channel],
    weather: env.weather,
    satcomUp: env.satcomUp,
  });
  return { quality, los, distanceM };
}

/**
 * Seeded delivery outcome for one message A -> B on a channel. Always consumes exactly 2 draws.
 * Probabilities scale with (1 - quality): drop 0.5x, corrupt 0.3x, delay 0.6x (evaluated in that order).
 */
export function deliverMessage(rng: Rng, link: Link, env: LinkEnv): DeliveryResult {
  const { quality, los, distanceM } = linkQuality(link, env);
  const jamming = env.jamming[link.channel];
  const u = rng.next();
  const v = rng.next();

  if (link.channel === 'RUNNER') {
    return {
      outcome: 'DELIVERED',
      quality: 1,
      los,
      distanceM,
      delayTicks: Math.ceil(distanceM / RUNNER_SPEED_MPS),
      jamming: 0,
    };
  }

  const bad = 1 - quality;
  const pDrop = quality <= 0 ? 1 : bad * 0.5;
  const pCorrupt = pDrop + bad * 0.3;
  const pDelay = pCorrupt + bad * 0.6;
  const base = BASE_LATENCY_TICKS[link.channel];

  if (u < pDrop) return { outcome: 'DROPPED', quality, los, distanceM, delayTicks: null, jamming };
  if (u < pCorrupt) {
    return { outcome: 'CORRUPTED', quality, los, distanceM, delayTicks: base, jamming };
  }
  if (u < pDelay) {
    const extra = Math.ceil(bad * 40 * (0.5 + v));
    return { outcome: 'DELAYED', quality, los, distanceM, delayTicks: base + extra, jamming };
  }
  return { outcome: 'DELIVERED', quality, los, distanceM, delayTicks: base, jamming };
}

/** Mutates digits (numbers/grids) in a text; guarantees at least one change when digits exist. */
export function corruptText(rng: Rng, text: string): string {
  const chars = [...text];
  let changed = false;
  const mutate = (i: number): void => {
    const c = chars[i];
    if (c === undefined) return;
    const next = (Number(c) + 1 + Math.floor(rng.next() * 9)) % 10;
    chars[i] = String(next);
    changed = true;
  };
  chars.forEach((c, i) => {
    if (/[0-9]/.test(c) && rng.next() < 0.4) mutate(i);
  });
  if (!changed) {
    const firstDigit = chars.findIndex((c) => /[0-9]/.test(c));
    if (firstDigit >= 0) mutate(firstDigit);
    else if (chars.length > 0) chars[Math.min(chars.length - 1, 3)] = '#';
  }
  return chars.join('');
}

/** Displaces a position by 0.8 - 3 km in a random direction. */
export function corruptPosition(rng: Rng, p: LatLon): LatLon {
  return offsetByBearing(p, randRange(rng, 0, 360), randRange(rng, 800, 3000));
}
