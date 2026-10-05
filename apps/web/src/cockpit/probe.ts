import type { LatLon, PerceivedStateDto, PlayerAction, ProbeChannel } from '@vyuha/shared';
import { PROBE_MAX_CONTACTS } from '@vyuha/shared';

/** What the next click on the map places: a hostile contact, or one teammate's unit. */
export type ProbeTarget = { kind: 'contact' } | { kind: 'teammate'; unitId: string };

/** A trainee's answer to a situation-awareness probe while they are still filling it in. */
export interface ProbeDraft {
  contacts: LatLon[];
  teammates: Record<string, LatLon>;
  jammedChannel: ProbeChannel | null;
  target: ProbeTarget;
}

export const emptyDraft = (): ProbeDraft => ({
  contacts: [],
  teammates: {},
  jammedChannel: null,
  target: { kind: 'contact' },
});

/** Places a point for whatever the draft is currently aimed at. */
export function placePoint(draft: ProbeDraft, point: LatLon): ProbeDraft {
  if (draft.target.kind === 'teammate') {
    return {
      ...draft,
      teammates: { ...draft.teammates, [draft.target.unitId]: point },
      target: { kind: 'contact' },
    };
  }
  if (draft.contacts.length >= PROBE_MAX_CONTACTS) return draft;
  return { ...draft, contacts: [...draft.contacts, point] };
}

export const removeContact = (draft: ProbeDraft, index: number): ProbeDraft => ({
  ...draft,
  contacts: draft.contacts.filter((_, i) => i !== index),
});

/** The channel question must be answered; markers are optional ("I believe nothing is out there"). */
export const canSubmit = (draft: ProbeDraft): boolean => draft.jammedChannel !== null;

export function toAnswer(probeId: string, draft: ProbeDraft): PlayerAction {
  return {
    type: 'PROBE_ANSWER',
    probeId,
    contacts: draft.contacts,
    teammates: Object.entries(draft.teammates).map(([unitId, position]) => ({ unitId, position })),
    jammedChannel: draft.jammedChannel ?? 'NONE',
  };
}

export interface ProbeMarker {
  key: string;
  kind: 'contact' | 'teammate';
  label: string;
  position: LatLon;
}

export function draftMarkers(
  draft: ProbeDraft,
  names: Record<string, string>,
  contactLabel: (n: number) => string,
): ProbeMarker[] {
  return [
    ...draft.contacts.map((position, i): ProbeMarker => ({
      key: `c${i}`,
      kind: 'contact',
      label: contactLabel(i + 1),
      position,
    })),
    ...Object.entries(draft.teammates).map(([unitId, position]): ProbeMarker => ({
      key: `t${unitId}`,
      kind: 'teammate',
      label: names[unitId] ?? unitId,
      position,
    })),
  ];
}

/**
 * SAGAT blanks the display: while a probe is open the trainee answers from memory, so the map keeps
 * only their own unit and hides the reported contacts and the teammates' last-known positions.
 */
export const blankPicture = (p: PerceivedStateDto): PerceivedStateDto => ({
  ...p,
  contacts: [],
  friendlies: [],
});
