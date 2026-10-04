import { mulberry32, type Rng } from '@vyuha/engine';
import type { PerceivedStateDto, PlayerAction } from '@vyuha/shared';

/**
 * Scripted demo trainees. A bot only ever reads its own perceived picture and sends ordinary player
 * actions, exactly like a person at the cockpit. How well it does is never written down anywhere: its
 * reaction time, habits and confidence follow from a skill level, and the engine then scores what
 * happened. Same session index + same bot index = the same behaviour, so runs are repeatable.
 */

export interface Skill {
  /** Ticks between seeing something and acting on it. */
  reactTicks: number;
  /** Share of received contact reports the bot grades (0..1). */
  gradeShare: number;
  /** How the bot treats an order that needs authentication. */
  authenticates: 'never' | 'sometimes' | 'always';
  /** How it states confidence in a decision. */
  confidence: 'always-high' | 'moderate' | 'calibrated';
  /** Ticks of badly degraded primary channel before the bot switches along the PACE plan (null: never). */
  switchAfterTicks: number | null;
}

/** Three sessions of a trainee who gets better at working under degraded communications. */
export const SKILL_BY_SESSION: readonly Skill[] = [
  {
    reactTicks: 28,
    gradeShare: 0.3,
    authenticates: 'never',
    confidence: 'always-high',
    switchAfterTicks: null,
  },
  {
    reactTicks: 16,
    gradeShare: 0.6,
    authenticates: 'sometimes',
    confidence: 'moderate',
    switchAfterTicks: 60,
  },
  {
    reactTicks: 6,
    gradeShare: 1,
    authenticates: 'always',
    confidence: 'calibrated',
    switchAfterTicks: 15,
  },
];

/** How often a bot looks at its screen. */
export const CHECK_EVERY_TICKS = 3;
const MAX_CONTACT_DECISIONS = 12;
/** A bot only has time to act on about one report in three, so decisions spread over the exercise. */
const ACT_ON_ONE_IN = 3;
const MAX_GRADES = 8;
/** A channel at or below this signal quality counts as badly degraded. */
const BAD_SIGNAL = 0.25;

type Reliability = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface BotMemory {
  firstSeen: Map<string, number>;
  handledOrders: Set<string>;
  authRequested: Set<string>;
  gradedContacts: Set<string>;
  decidedContacts: Set<string>;
  contactDecisions: number;
  badSignalSince: number | null;
  switched: boolean;
}

/** Small stable string hash (FNV-1a) so which reports a bot picks is repeatable. */
function stableHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export const newBotMemory = (): BotMemory => ({
  firstSeen: new Map(),
  handledOrders: new Set(),
  authRequested: new Set(),
  gradedContacts: new Set(),
  decidedContacts: new Set(),
  contactDecisions: 0,
  badSignalSince: null,
  switched: false,
});

/** The bot's own estimate of a report, from what it can see: where it came from and how old it is. */
export function gradeContact(c: PerceivedStateDto['contacts'][number]): {
  reliability: Reliability;
  credibility: 1 | 2 | 3 | 4 | 5 | 6;
} {
  if (c.ageTicks > 120) return { reliability: 'D', credibility: 4 };
  if (c.via === 'DIRECT') return { reliability: 'B', credibility: 2 };
  return { reliability: 'C', credibility: 3 };
}

function statedConfidence(
  skill: Skill,
  quality: Reliability | 'verified' | 'refused' | 'ungraded',
): number {
  if (skill.confidence === 'always-high') return 90;
  if (skill.confidence === 'moderate') return 75;
  switch (quality) {
    case 'verified':
      return 90;
    case 'refused':
      return 85;
    case 'A':
    case 'B':
      return 80;
    case 'C':
      return 62;
    case 'D':
      return 45;
    case 'ungraded':
      return 55;
    default:
      return 30;
  }
}

const decision = (
  actionType: Extract<PlayerAction, { type: 'DECISION' }>['actionType'],
  confidence: number,
  rationale: string,
  extra: { targetContactId?: string; basedOnMessageId?: string } = {},
): PlayerAction => ({ type: 'DECISION', actionType, confidence, rationale, ...extra });

/**
 * What one bot does at this moment. `rng` is seeded per bot and session so the small amount of
 * variation (reaction jitter, which reports it happens to grade) is repeatable.
 */
export function botActions(
  view: PerceivedStateDto,
  mem: BotMemory,
  skill: Skill,
  botIndex: number,
  rng: Rng,
): PlayerAction[] {
  const actions: PlayerAction[] = [];
  const tick = view.tick;
  const seenFor = (id: string): number => {
    const first = mem.firstSeen.get(id);
    if (first !== undefined) return tick - first;
    mem.firstSeen.set(id, tick);
    return 0;
  };
  const ready = (id: string, jitter: number): boolean => seenFor(id) >= skill.reactTicks + jitter;

  // ---- keep communicating: move along the PACE plan when the active channel stays bad ----
  const active = view.comms.activeChannel;
  const signal = view.comms.signal[active];
  if (signal !== null && signal <= BAD_SIGNAL) mem.badSignalSince ??= tick;
  else mem.badSignalSince = null;
  if (
    !mem.switched &&
    skill.switchAfterTicks !== null &&
    view.role === 'PL_CDR' &&
    mem.badSignalSince !== null &&
    tick - mem.badSignalSince >= skill.switchAfterTicks
  ) {
    mem.switched = true;
    const next = view.comms.pace.alternate;
    if (next !== active) actions.push({ type: 'SWITCH_CHANNEL', channel: next });
  }

  // ---- orders that need authentication (the scripted spoof is one of them) ----
  const authenticate =
    skill.authenticates === 'always' || (skill.authenticates === 'sometimes' && botIndex % 2 === 0);
  for (const m of view.inbox) {
    if (m.kind !== 'ORDER' || !m.requiresAuth || mem.handledOrders.has(m.id)) continue;
    if (!ready(m.id, Math.floor(rng.next() * 4))) continue;
    if (!authenticate) {
      mem.handledOrders.add(m.id);
      actions.push(
        decision(
          'COMPLY_ORDER',
          statedConfidence(skill, 'ungraded') + 25,
          'Order came over the net from HQ, carrying it out',
          {
            basedOnMessageId: m.id,
          },
        ),
      );
    } else if (m.authState === 'NONE' && !mem.authRequested.has(m.id)) {
      mem.authRequested.add(m.id);
      actions.push({ type: 'AUTHENTICATE', messageId: m.id });
    } else if (m.authState === 'VERIFIED') {
      mem.handledOrders.add(m.id);
      actions.push(
        decision(
          'COMPLY_ORDER',
          statedConfidence(skill, 'verified'),
          'Order authenticated with HQ, carrying it out',
          {
            basedOnMessageId: m.id,
          },
        ),
      );
    } else if (m.authState === 'FAILED') {
      mem.handledOrders.add(m.id);
      actions.push(
        decision(
          'IGNORE_ORDER',
          statedConfidence(skill, 'refused'),
          'Authentication failed, treating the order as false',
          {
            basedOnMessageId: m.id,
          },
        ),
      );
    }
  }

  // ---- contact reports: grade some, then act on the ones that look solid ----
  for (const c of view.contacts) {
    if (mem.decidedContacts.has(c.id)) continue;
    const jitter = Math.floor(rng.next() * 4);
    if (!ready(c.id, jitter)) continue;

    const grade = gradeContact(c);
    const willGrade =
      !c.grade &&
      !mem.gradedContacts.has(c.id) &&
      mem.gradedContacts.size < MAX_GRADES &&
      rng.next() < skill.gradeShare;
    if (willGrade) {
      mem.gradedContacts.add(c.id);
      actions.push({ type: 'GRADE_REPORT', reportId: c.id, ...grade });
    }
    if (mem.contactDecisions >= MAX_CONTACT_DECISIONS) continue;
    if (stableHash(`${botIndex}:${c.id}`) % ACT_ON_ONE_IN !== 0) continue;
    // Only act on a report once it has been graded (by this bot or earlier).
    const graded = Boolean(c.grade) || mem.gradedContacts.has(c.id);
    if (!graded && skill.gradeShare >= 1) continue;
    mem.decidedContacts.add(c.id);
    mem.contactDecisions += 1;
    const quality: Reliability | 'ungraded' = graded ? grade.reliability : 'ungraded';
    const solid = quality === 'A' || quality === 'B' || quality === 'C';
    actions.push(
      solid
        ? decision(
            'ENGAGE',
            statedConfidence(skill, quality),
            `Report from ${c.source} looks solid, engaging`,
            {
              targetContactId: c.id,
            },
          )
        : decision(
            'REQUEST_SUPPORT',
            statedConfidence(skill, quality),
            `Report from ${c.source} is doubtful, asking for support`,
            {
              targetContactId: c.id,
            },
          ),
    );
  }
  return actions;
}

/** Seeded generator for a bot in a session, so reruns behave identically. */
export const botRng = (sessionIndex: number, botIndex: number): Rng =>
  mulberry32(26248 + sessionIndex * 1009 + botIndex * 31);
