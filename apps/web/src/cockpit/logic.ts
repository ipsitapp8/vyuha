import { haversineM } from '@vyuha/engine';
import type { Channel, PerceivedStateDto } from '@vyuha/shared';

type Contact = PerceivedStateDto['contacts'][number];
type Grade = Contact['grade'];
type Message = PerceivedStateDto['inbox'][number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The trainee's own Admiralty grade says D-F reliability or credibility 5-6: treat as low confidence. */
export function isLowConfidence(grade: Grade): boolean {
  if (!grade) return false;
  return grade.reliability >= 'D' || grade.credibility >= 5;
}

/** Older contacts fade (to 35 % at 10 minutes); low-confidence reports are faded further. */
export function contactOpacity(ageTicks: number, grade: Grade): number {
  const base = clamp(1 - (Math.max(0, ageTicks) / 600) * 0.65, 0.35, 1);
  return isLowConfidence(grade) ? base * 0.6 : base;
}

export interface Degradation {
  /** 0 (clean) .. 1 (unusable): how bad the active channel is. */
  jamLevel: number;
  jammed: boolean;
  /** Data-link effectively gone: the shared picture stops updating. */
  datalinkLost: boolean;
}

const JAMMED_AT = 0.3;
export const DATALINK_LOST_BELOW = 0.05;

/** Static noise follows the signal bars of the channel the team is using; RUNNER is never degraded. */
export function computeDegradation(p: PerceivedStateDto): Degradation {
  const signal = p.comms.signal[p.comms.activeChannel];
  const jamLevel = signal === null ? 0 : clamp(1 - signal / 0.5, 0, 1);
  const datalink = p.comms.signal.DATALINK;
  return {
    jamLevel,
    jammed: jamLevel >= JAMMED_AT,
    datalinkLost: datalink !== null && datalink < DATALINK_LOST_BELOW,
  };
}

/** Typical one-way latency (ticks) per channel; the receiver can compare transit time against it. */
const EXPECTED_TRANSIT: Record<Channel, number> = {
  VHF: 1,
  HF: 3,
  SATCOM: 8,
  DATALINK: 1,
  RUNNER: Infinity,
};
const DELAY_SLACK = 5;

export interface DeliveryFlags {
  /** Transit seconds when clearly slower than the channel normally is; otherwise null. */
  delayedBy: number | null;
  /** Visible damage only: digit changes cannot be seen, but replaced characters can. */
  garbled: boolean;
}

/** "Delayed" and "corrupted" are only flagged when the receiver could actually notice them. */
export function deliveryFlags(
  m: Pick<Message, 'channel' | 'sentTick' | 'receivedTick' | 'text'>,
): DeliveryFlags {
  const transit = m.receivedTick - m.sentTick;
  const delayed = transit > EXPECTED_TRANSIT[m.channel] + DELAY_SLACK;
  return { delayedBy: delayed ? transit : null, garbled: m.text.includes('#') };
}

export interface OrderAlert {
  message: Message;
  /** Seconds until the authentication result (PENDING only). */
  secondsLeft: number | null;
}

const RESOLVED_ALERT_WINDOW = 180;

/** Orders that need attention: unverified or authenticating, plus recent results. */
export function orderAlerts(p: PerceivedStateDto): OrderAlert[] {
  return p.inbox
    .filter((m) => m.requiresAuth)
    .filter(
      (m) =>
        m.authState === 'NONE' ||
        m.authState === 'PENDING' ||
        p.tick - m.receivedTick <= RESOLVED_ALERT_WINDOW,
    )
    .map((message) => ({
      message,
      secondsLeft:
        message.authState === 'PENDING' && message.authResolvesAtTick !== null
          ? Math.max(0, message.authResolvesAtTick - p.tick)
          : null,
    }))
    .reverse();
}

/** Association gate: 400 m plus how far a moving unit could have travelled between the two sightings. */
const GATE_BASE_M = 400;
const GATE_SPEED_MPS = 12;
const GATE_MAX_M = 3000;

/**
 * Picture compilation for the map: repeated sightings of the same thing (same reported type within
 * a movement-aware gate) collapse to the freshest report so the map stays readable. Everything stays in the Reports list,
 * conflicting reports (different place or type) both remain, and the selected contact is always kept.
 */
export function currentTracks(contacts: readonly Contact[], keepId: string | null): Contact[] {
  const newestFirst = [...contacts].sort(
    (a, b) => b.observedTick - a.observedTick || a.id.localeCompare(b.id),
  );
  const kept: Contact[] = [];
  for (const c of newestFirst) {
    const superseded = kept.some(
      (k) =>
        k.type === c.type &&
        haversineM(k.position, c.position) <
          Math.min(
            GATE_MAX_M,
            GATE_BASE_M + GATE_SPEED_MPS * Math.abs(k.observedTick - c.observedTick),
          ),
    );
    if (c.id === keepId || !superseded) kept.push(c);
  }
  return kept;
}
