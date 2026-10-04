export type Rgb = readonly [number, number, number];

// Hypsometric ramp: low valley (blue-green) -> green -> tan -> brown -> snow white.
const STOPS: readonly (readonly [number, Rgb])[] = [
  [0, [38, 110, 140]],
  [0.25, [76, 160, 90]],
  [0.5, [214, 200, 110]],
  [0.75, [150, 100, 60]],
  [1, [245, 245, 250]],
];

/** Maps elevation to RGB by linear interpolation along the ramp; clamps outside [min, max]. */
export function elevationColor(elevation: number, min: number, max: number): Rgb {
  const t = max > min ? Math.min(1, Math.max(0, (elevation - min) / (max - min))) : 0;
  for (let i = 1; i < STOPS.length; i++) {
    const hi = STOPS[i];
    const lo = STOPS[i - 1];
    if (!hi || !lo) break;
    if (t <= hi[0]) {
      const f = (t - lo[0]) / (hi[0] - lo[0]);
      return [
        Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f),
        Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f),
        Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f),
      ];
    }
  }
  return STOPS[STOPS.length - 1]?.[1] ?? [255, 255, 255];
}

export const RAMP_CSS_GRADIENT = `linear-gradient(to right, ${STOPS.map(
  ([t, c]) => `rgb(${c.join(',')}) ${t * 100}%`,
).join(', ')})`;
