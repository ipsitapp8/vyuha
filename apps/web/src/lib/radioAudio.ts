import { mulberry32 } from '@vyuha/engine';
import type { Channel } from '@vyuha/shared';

/**
 * Radio audio for the trainee cockpit. Client-side only: it plays what the trainee has already been
 * sent (the delivered text and the signal bars of its channel) and never touches the simulation.
 *
 * The browser's speech synthesiser cannot be routed through Web Audio, so the effect has two layers
 * that run together: the voice (clipped and dropped words, lower volume, as the link gets worse) and a
 * Web Audio bed (band-passed static whose level follows the link, dropout bursts and squelch clicks).
 */

export interface RadioInput {
  /** Stable per message, so the same message always sounds the same. */
  id: string;
  text: string;
  channel: Channel;
  /** Perceived link quality of that channel, 0..1; null when it cannot be measured (runner). */
  quality: number | null;
  /** The text shows visible damage. */
  garbled: boolean;
  /** The channel is jammed. */
  jammed: boolean;
}

export interface RadioSegment {
  text: string;
  /** Silence (filled with a static burst) after this segment, before the next. */
  gapAfterMs: number;
}

export interface RadioPlan {
  /** False for a message carried by hand: plain speech, no static, no squelch. */
  radio: boolean;
  segments: RadioSegment[];
  /** 0..1 */
  speechVolume: number;
  rate: number;
  pitch: number;
  /** 0..1: level of the static bed under the voice. */
  noiseGain: number;
  /** Band-pass of the static, as a narrow voice-band radio would sound. */
  bandpass: { centerHz: number; q: number };
  /** Words lost to the link (dropped entirely), for tests and captions. */
  droppedWords: number;
  clippedWords: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** FNV-1a: a stable 32-bit seed from the message id. */
export function seedOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const JAMMED_NOISE = 0.9;
const JAMMED_SPEECH = 0.22;

/**
 * Decides how one message sounds. Pure and seeded: lower quality means louder static, more dropped
 * and clipped words and a quieter voice; a garbled message is scrambled further; a jammed channel is
 * mostly noise.
 */
export function planRadio(input: RadioInput): RadioPlan {
  const words = input.text
    .replace(/#/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (input.channel === 'RUNNER' || input.quality === null) {
    return {
      radio: false,
      segments: words.length ? [{ text: words.join(' '), gapAfterMs: 0 }] : [],
      speechVolume: 1,
      rate: 1,
      pitch: 1,
      noiseGain: 0,
      bandpass: { centerHz: 1700, q: 0.9 },
      droppedWords: 0,
      clippedWords: 0,
    };
  }

  const rng = mulberry32(seedOf(input.id));
  const quality = clamp(input.quality, 0, 1);
  const loss = 1 - quality;
  const dropProb = input.jammed
    ? 0.55
    : clamp((loss - 0.25) * 0.6, 0, 0.45) + (input.garbled ? 0.12 : 0);
  const clipProb = clamp(loss * 0.5, 0, 0.5) + (input.garbled ? 0.25 : 0);

  const segments: RadioSegment[] = [];
  let current: string[] = [];
  let dropped = 0;
  let clipped = 0;
  const flush = (gapAfterMs: number): void => {
    if (current.length > 0) segments.push({ text: current.join(' '), gapAfterMs });
    else if (segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last) last.gapAfterMs += gapAfterMs;
    }
    current = [];
  };
  for (const word of words) {
    const roll = rng.next();
    if (roll < dropProb) {
      dropped++;
      flush(120 + Math.floor(rng.next() * 260));
      continue;
    }
    if (rng.next() < clipProb && word.length > 2) {
      clipped++;
      const keep = Math.max(1, Math.ceil(word.length / 2));
      // A garbled word loses its start instead of its end half of the time.
      current.push(
        input.garbled && rng.next() < 0.5 ? word.slice(word.length - keep) : word.slice(0, keep),
      );
      continue;
    }
    current.push(word);
  }
  flush(0);
  const last = segments[segments.length - 1];
  if (last) last.gapAfterMs = 0;

  return {
    radio: true,
    segments,
    speechVolume: input.jammed ? JAMMED_SPEECH : clamp(0.35 + 0.65 * quality, 0.3, 1),
    rate: clamp(1.02 + (input.garbled ? 0.12 : 0) - loss * 0.08, 0.85, 1.2),
    pitch: input.garbled ? 0.85 : 1,
    noiseGain: input.jammed ? JAMMED_NOISE : clamp(0.06 + 0.74 * loss, 0, 0.8),
    bandpass: { centerHz: 1700, q: 0.9 + loss * 1.6 },
    droppedWords: dropped,
    clippedWords: clipped,
  };
}

// ---- Preferences ---------------------------------------------------------------------------

export interface RadioPrefs {
  muted: boolean;
  /** 0..1 */
  volume: number;
}
export const DEFAULT_RADIO_PREFS: RadioPrefs = { muted: false, volume: 0.8 };
const PREFS_KEY = 'vyuha.radioAudio';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRadioPrefs(store: Pick<Storage, 'getItem'> | null = storage()): RadioPrefs {
  try {
    const raw = store?.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_RADIO_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_RADIO_PREFS;
    const p = parsed as Record<string, unknown>;
    return {
      muted: p['muted'] === true,
      volume:
        typeof p['volume'] === 'number' ? clamp(p['volume'], 0, 1) : DEFAULT_RADIO_PREFS.volume,
    };
  } catch {
    return DEFAULT_RADIO_PREFS;
  }
}

export function saveRadioPrefs(
  prefs: RadioPrefs,
  store: Pick<Storage, 'setItem'> | null = storage(),
): void {
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked: the choice just will not persist */
  }
}

// ---- Playback ------------------------------------------------------------------------------

/** The browser pieces the player uses; injected so it can be tested and so a missing piece is survivable. */
export interface RadioEnv {
  AudioContext?: new () => AudioContext;
  speechSynthesis?: SpeechSynthesis;
  Utterance?: new (text: string) => SpeechSynthesisUtterance;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export function browserRadioEnv(): RadioEnv {
  const w = typeof window === 'undefined' ? undefined : window;
  const legacy = w as (Window & { webkitAudioContext?: new () => AudioContext }) | undefined;
  return {
    ...((w?.AudioContext ?? legacy?.webkitAudioContext)
      ? { AudioContext: w?.AudioContext ?? legacy?.webkitAudioContext }
      : {}),
    ...(w && 'speechSynthesis' in w && typeof SpeechSynthesisUtterance !== 'undefined'
      ? { speechSynthesis: w.speechSynthesis, Utterance: SpeechSynthesisUtterance }
      : {}),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  } as RadioEnv;
}

/** Voice for a UI language: a Hindi voice when Hindi is selected and the browser has one. */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice | null {
  const want = language.startsWith('hi') ? 'hi' : 'en';
  return (
    voices.find((v) => v.lang.toLowerCase().startsWith(`${want}-in`)) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(want)) ??
    null
  );
}

const SQUELCH_MS = 70;
const WORD_MS = 380;
const MAX_QUEUE = 4;

interface Job {
  plan: RadioPlan;
  language: string;
}

/**
 * Plays radio plans one after the other. Every browser feature is optional: without speech synthesis
 * the static and squelch still play, without Web Audio the voice still speaks, with neither it is a
 * no-op. It never throws into the page.
 */
export class RadioPlayer {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private readonly queue: Job[] = [];
  private busy = false;
  private prefs: RadioPrefs = DEFAULT_RADIO_PREFS;
  private timers: unknown[] = [];
  private bed: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  constructor(private readonly env: RadioEnv = browserRadioEnv()) {}

  setPrefs(prefs: RadioPrefs): void {
    this.prefs = prefs;
    if (prefs.muted) this.stop();
  }

  /** True when at least one of the two layers can play. */
  get available(): boolean {
    return (
      Boolean(this.env.AudioContext) || Boolean(this.env.speechSynthesis && this.env.Utterance)
    );
  }

  enqueue(plan: RadioPlan, language: string): void {
    if (this.prefs.muted || !this.available || plan.segments.length === 0) return;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift(); // a backlog would lag behind the exercise
    this.queue.push({ plan, language });
    if (!this.busy) this.next();
  }

  stop(): void {
    this.queue.length = 0;
    for (const t of this.timers) this.env.clearTimeout(t);
    this.timers = [];
    this.safely(() => this.env.speechSynthesis?.cancel());
    this.stopBed();
    this.busy = false;
  }

  dispose(): void {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) this.safely(() => void ctx.close());
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      /* audio is a nicety: a browser quirk must never break the cockpit */
    }
  }

  private later(fn: () => void, ms: number): void {
    const handle = this.env.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== handle);
      fn();
    }, ms);
    this.timers.push(handle);
  }

  private context(): AudioContext | null {
    if (!this.env.AudioContext) return null;
    try {
      this.ctx ??= new this.env.AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return this.ctx;
    } catch {
      return null;
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const length = Math.floor(ctx.sampleRate * 1.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Seeded so the static is the same on every machine; it only has to sound like noise.
    const rng = mulberry32(0x5eed);
    for (let i = 0; i < length; i++) data[i] = rng.next() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }

  /** A short burst of band-passed noise: the squelch click and the dropout fill. */
  private burst(plan: RadioPlan, level: number, ms: number): void {
    const ctx = this.context();
    if (!ctx) return;
    this.safely(() => {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer(ctx);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = plan.bandpass.centerHz;
      filter.Q.value = plan.bandpass.q;
      const gain = ctx.createGain();
      gain.gain.value = clamp(level * this.prefs.volume, 0, 1);
      source.connect(filter).connect(gain).connect(ctx.destination);
      source.start();
      source.stop(ctx.currentTime + ms / 1000);
    });
  }

  private startBed(plan: RadioPlan): void {
    const ctx = this.context();
    if (!ctx || plan.noiseGain <= 0) return;
    this.safely(() => {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer(ctx);
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = plan.bandpass.centerHz;
      filter.Q.value = plan.bandpass.q;
      const gain = ctx.createGain();
      gain.gain.value = clamp(plan.noiseGain * this.prefs.volume, 0, 1);
      source.connect(filter).connect(gain).connect(ctx.destination);
      source.start();
      this.bed = { source, gain };
    });
  }

  private stopBed(): void {
    const bed = this.bed;
    this.bed = null;
    if (bed) this.safely(() => bed.source.stop());
  }

  private next(): void {
    const job = this.queue.shift();
    if (!job) {
      this.busy = false;
      return;
    }
    this.busy = true;
    const { plan } = job;
    const finish = (): void => {
      this.stopBed();
      if (plan.radio) this.burst(plan, 0.5, SQUELCH_MS);
      this.later(() => this.next(), plan.radio ? SQUELCH_MS + 150 : 150);
    };
    if (plan.radio) {
      this.burst(plan, 0.5, SQUELCH_MS);
      this.startBed(plan);
    }
    this.speak(job, 0, finish);
  }

  private speak(job: Job, index: number, done: () => void): void {
    const segment = job.plan.segments[index];
    if (!segment) return done();
    const { speechSynthesis: synth, Utterance } = this.env;
    const after = (): void => {
      if (segment.gapAfterMs > 0) {
        // a dropout: the voice is gone and the static swells
        this.burst(job.plan, clamp(job.plan.noiseGain + 0.25, 0, 1), segment.gapAfterMs);
        this.later(() => this.speak(job, index + 1, done), segment.gapAfterMs);
      } else {
        this.speak(job, index + 1, done);
      }
    };
    const words = segment.text.split(' ').length;
    const estimateMs = Math.ceil((words * WORD_MS) / job.plan.rate);
    if (!synth || !Utterance) {
      // No voice in this browser: keep the static running for as long as the words would have taken.
      this.later(after, estimateMs);
      return;
    }
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      after();
    };
    try {
      const u = new Utterance(segment.text);
      u.volume = clamp(job.plan.speechVolume * this.prefs.volume, 0, 1);
      u.rate = job.plan.rate;
      u.pitch = job.plan.pitch;
      u.lang = job.language.startsWith('hi') ? 'hi-IN' : 'en-IN';
      const voice = pickVoice(synth.getVoices(), job.language);
      if (voice) u.voice = voice;
      u.onend = end;
      u.onerror = end;
      synth.speak(u);
      // Some browsers never fire `end` (tab in the background, voice missing): do not hang the queue.
      this.later(end, estimateMs * 2 + 2500);
    } catch {
      this.later(end, estimateMs);
    }
  }
}
