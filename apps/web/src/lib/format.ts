import type { TFunction } from 'i18next';

/** Exercise time as mm:ss (1 tick = 1 s). */
export function clock(tick: number): string {
  const t = Math.max(0, Math.floor(tick));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** "just now", "42s ago", "2m ago", "2m 5s ago": how long ago something was seen. */
export function formatAge(t: TFunction, ageTicks: number): string {
  const age = Math.max(0, Math.floor(ageTicks));
  if (age < 3) return t('age.now');
  if (age < 60) return t('age.seconds', { n: age });
  const m = Math.floor(age / 60);
  const s = age % 60;
  if (age < 600 && s >= 5) return t('age.minutesSeconds', { m, s });
  return t('age.minutes', { n: m });
}

export const latLonText = (p: { lat: number; lon: number }): string =>
  `${p.lat.toFixed(4)}°N ${p.lon.toFixed(4)}°E`;
