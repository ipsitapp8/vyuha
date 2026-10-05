import { useEffect, useRef, useState } from 'react';
import type { PerceivedStateDto } from '@vyuha/shared';
import {
  planRadio,
  RadioPlayer,
  readRadioPrefs,
  saveRadioPrefs,
  type RadioInput,
  type RadioPrefs,
} from '@/lib/radioAudio';
import { deliveryFlags } from './logic';

type Message = PerceivedStateDto['inbox'][number];
const SPOKEN_KINDS: readonly Message['kind'][] = ['TEXT', 'ORDER'];
/** Below this the trainee's own radio shows the channel as jammed (see computeDegradation). */
const JAMMED_BELOW = 0.35;

/**
 * Messages that have just arrived and should be heard: text and orders, not the automatic position
 * beacons and sensor reports (they arrive every few seconds and would talk over everything).
 */
export function newRadioMessages(
  seen: ReadonlySet<string>,
  perceived: PerceivedStateDto,
): RadioInput[] {
  return perceived.inbox
    .filter((m) => !seen.has(m.id) && SPOKEN_KINDS.includes(m.kind))
    .map((m) => {
      const quality = m.channel === 'RUNNER' ? null : perceived.comms.signal[m.channel];
      return {
        id: m.id,
        text: m.kind === 'ORDER' ? `${m.from}. ${m.text}` : m.text,
        channel: m.channel,
        quality,
        garbled: deliveryFlags(m).garbled,
        jammed: quality !== null && quality < JAMMED_BELOW,
      };
    });
}

export interface RadioAudioControls {
  prefs: RadioPrefs;
  setPrefs: (next: RadioPrefs) => void;
  /** False when the browser has neither speech synthesis nor Web Audio. */
  available: boolean;
}

/** Plays each newly delivered message as radio audio. Client-side only; nothing is sent anywhere. */
export function useRadioAudio(perceived: PerceivedStateDto, language: string): RadioAudioControls {
  const [prefs, setPrefsState] = useState<RadioPrefs>(() => readRadioPrefs());
  const playerRef = useRef<RadioPlayer | null>(null);
  // Messages already in the inbox when the cockpit opens are history, not new traffic.
  const seenRef = useRef<Set<string> | null>(null);
  // Constructing a player has no side effects: it only looks at what the browser offers.
  const [available] = useState(() => new RadioPlayer().available);

  useEffect(() => {
    const player = new RadioPlayer();
    playerRef.current = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    playerRef.current?.setPrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    if (seenRef.current === null) {
      seenRef.current = new Set(perceived.inbox.map((m) => m.id));
      return;
    }
    const fresh = newRadioMessages(seenRef.current, perceived);
    for (const m of perceived.inbox) seenRef.current.add(m.id);
    for (const input of fresh) playerRef.current?.enqueue(planRadio(input), language);
  }, [perceived, language]);

  const setPrefs = (next: RadioPrefs): void => {
    setPrefsState(next);
    saveRadioPrefs(next);
  };
  return { prefs, setPrefs, available };
}
