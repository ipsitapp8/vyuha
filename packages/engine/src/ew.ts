import type { Channel } from '@vyuha/shared';
import { ADAPT_DECAY, ADAPT_MAX, ADAPT_RATE, CHANNELS, JAMMABLE_CHANNELS } from './config';
import { clamp } from './geometry';
import type { JamWindow, TeamState } from './types';

export function zeroLevels(): Record<Channel, number> {
  return { VHF: 0, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 };
}

export function zeroUsage(): Record<Channel, number> {
  return zeroLevels();
}

/**
 * Effective jamming per channel: independent sources combine as 1 - prod(1 - level).
 * Sources: scripted/live jam windows, instructor manual levels, and the adaptive adversary.
 * RUNNER is never jammed.
 */
export function effectiveJamming(
  tick: number,
  windows: readonly JamWindow[],
  manual: Record<Channel, number>,
  adaptive: Record<Channel, number>,
  adversaryActive: boolean,
): Record<Channel, number> {
  const out = zeroLevels();
  for (const ch of JAMMABLE_CHANNELS) {
    let remaining = 1;
    for (const w of windows) {
      if (w.channel === ch && tick < w.untilTick) remaining *= 1 - clamp(w.intensity, 0, 1);
    }
    remaining *= 1 - clamp(manual[ch], 0, 1);
    if (adversaryActive) remaining *= 1 - clamp(adaptive[ch], 0, ADAPT_MAX);
    out[ch] = clamp(1 - remaining, 0, 1);
  }
  return out;
}

/** The channel a team used most in the window (ties resolved by channel order); null if unused. */
export function mostUsedChannel(usage: Record<Channel, number>): Channel | null {
  let best: Channel | null = null;
  let bestCount = 0;
  for (const ch of JAMMABLE_CHANNELS) {
    if (usage[ch] > bestCount) {
      best = ch;
      bestCount = usage[ch];
    }
  }
  return best;
}

/**
 * Reliance-adaptive EW: raise jamming on every team's most-used channel by `adaptRate`
 * (once per team that used it) and decay all other channels. Pure; returns new levels.
 */
export function adaptJamming(
  adaptive: Record<Channel, number>,
  teams: readonly Pick<TeamState, 'usage'>[],
  adaptRate: number = ADAPT_RATE,
  decay: number = ADAPT_DECAY,
): Record<Channel, number> {
  const targeted = new Set<Channel>();
  const out = { ...adaptive };
  for (const team of teams) {
    const top = mostUsedChannel(team.usage);
    if (top) {
      out[top] = Math.min(ADAPT_MAX, out[top] + adaptRate);
      targeted.add(top);
    }
  }
  for (const ch of CHANNELS) {
    if (!targeted.has(ch)) out[ch] = Math.max(0, out[ch] - decay);
  }
  out.RUNNER = 0;
  return out;
}
