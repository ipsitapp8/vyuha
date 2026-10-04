import type { LatLon } from '@vyuha/shared';

export const EARTH_RADIUS_M = 6_371_000;
const M_PER_DEG_LAT = 111_320;

const rad = (d: number): number => (d * Math.PI) / 180;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a -> b in degrees [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Offsets a point by metres east/north (flat-earth approximation, fine at scenario scale). */
export function offsetByMeters(p: LatLon, eastM: number, northM: number): LatLon {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(rad(p.lat));
  return { lat: p.lat + northM / M_PER_DEG_LAT, lon: p.lon + eastM / mPerDegLon };
}

/** Offsets a point by a distance along a compass bearing. */
export function offsetByBearing(p: LatLon, bearing: number, distM: number): LatLon {
  return offsetByMeters(p, distM * Math.sin(rad(bearing)), distM * Math.cos(rad(bearing)));
}

/** Moves from `from` toward `to` by at most `distM`; reports arrival. */
export function stepToward(
  from: LatLon,
  to: LatLon,
  distM: number,
): { position: LatLon; arrived: boolean } {
  const total = haversineM(from, to);
  if (total <= distM || total === 0) return { position: { ...to }, arrived: true };
  const f = distM / total;
  return {
    position: { lat: from.lat + (to.lat - from.lat) * f, lon: from.lon + (to.lon - from.lon) * f },
    arrived: false,
  };
}

export function lerpLatLon(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
