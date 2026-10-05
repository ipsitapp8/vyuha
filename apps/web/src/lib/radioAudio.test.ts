import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RADIO_PREFS,
  pickVoice,
  planRadio,
  RadioPlayer,
  readRadioPrefs,
  saveRadioPrefs,
  seedOf,
  type RadioEnv,
  type RadioInput,
} from './radioAudio';

const TEXT =
  'Alpha one this is Alpha two contact north of the bridge moving east request orders over';
const input = (over: Partial<RadioInput> = {}): RadioInput => ({
  id: 'm-1',
  text: TEXT,
  channel: 'VHF',
  quality: 0.9,
  garbled: false,
  jammed: false,
  ...over,
});
const spoken = (p: ReturnType<typeof planRadio>): string => p.segments.map((s) => s.text).join(' ');

describe('planRadio', () => {
  it('is deterministic per message and differs between messages', () => {
    expect(planRadio(input({ quality: 0.4 }))).toEqual(planRadio(input({ quality: 0.4 })));
    expect(seedOf('m-1')).not.toBe(seedOf('m-2'));
  });

  it('a clean link is the full text with a quiet static bed', () => {
    const p = planRadio(input({ quality: 1 }));
    expect(p.radio).toBe(true);
    expect(spoken(p)).toBe(TEXT);
    expect(p.droppedWords).toBe(0);
    expect(p.noiseGain).toBeLessThan(0.1);
    expect(p.speechVolume).toBe(1);
  });

  it('lower quality means louder static, a quieter voice and more words lost or clipped', () => {
    const levels = [1, 0.7, 0.4, 0.15].map((quality) => planRadio(input({ quality })));
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1]!;
      const cur = levels[i]!;
      expect(cur.noiseGain).toBeGreaterThan(prev.noiseGain);
      expect(cur.speechVolume).toBeLessThan(prev.speechVolume);
    }
    const worst = levels.at(-1)!;
    expect(worst.droppedWords + worst.clippedWords).toBeGreaterThan(3);
    expect(spoken(worst).length).toBeLessThan(TEXT.length);
    // dropped words leave gaps (dropouts) between what is left
    expect(worst.segments.some((s) => s.gapAfterMs > 0)).toBe(true);
    expect(worst.segments.at(-1)?.gapAfterMs).toBe(0);
  });

  it('a jammed channel is mostly noise', () => {
    const p = planRadio(input({ quality: 0.1, jammed: true }));
    expect(p.noiseGain).toBeGreaterThanOrEqual(0.9);
    expect(p.speechVolume).toBeLessThan(0.3);
    expect(p.droppedWords).toBeGreaterThan(4);
  });

  it('a garbled message is scrambled further than a clean one on the same link', () => {
    const clean = planRadio(input({ quality: 0.8 }));
    const garbled = planRadio(input({ quality: 0.8, garbled: true, text: `${TEXT} gr#d 4#71` }));
    expect(garbled.clippedWords + garbled.droppedWords).toBeGreaterThan(
      clean.clippedWords + clean.droppedWords,
    );
    expect(garbled.pitch).toBeLessThan(1);
    expect(spoken(garbled)).not.toContain('#');
  });

  it('a runner message is plain speech: no static, no squelch', () => {
    const p = planRadio(input({ channel: 'RUNNER', quality: null }));
    expect(p.radio).toBe(false);
    expect(p.noiseGain).toBe(0);
    expect(spoken(p)).toBe(TEXT);
  });

  it('an empty message plans nothing', () => {
    expect(planRadio(input({ text: '   ' })).segments).toEqual([]);
  });
});

describe('voices and preferences', () => {
  const voice = (lang: string): SpeechSynthesisVoice => ({ lang }) as SpeechSynthesisVoice;
  it('prefers a Hindi voice when Hindi is selected, and falls back to none', () => {
    const voices = [voice('en-US'), voice('en-IN'), voice('hi-IN')];
    expect(pickVoice(voices, 'hi')?.lang).toBe('hi-IN');
    expect(pickVoice(voices, 'en')?.lang).toBe('en-IN');
    expect(pickVoice([voice('fr-FR')], 'hi')).toBeNull();
  });

  it('is on by default and remembers the choice; a broken store is survivable', () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    expect(readRadioPrefs(store)).toEqual(DEFAULT_RADIO_PREFS);
    expect(DEFAULT_RADIO_PREFS.muted).toBe(false);
    saveRadioPrefs({ muted: true, volume: 0.3 }, store);
    expect(readRadioPrefs(store)).toEqual({ muted: true, volume: 0.3 });
    data.set('vyuha.radioAudio', '{not json');
    expect(readRadioPrefs(store)).toEqual(DEFAULT_RADIO_PREFS);
    data.set('vyuha.radioAudio', JSON.stringify({ volume: 7 }));
    expect(readRadioPrefs(store).volume).toBe(1);
  });
});

function fakeEnv(opts: { speech: boolean; audio: boolean }) {
  const spoken: { text: string; volume: number; lang: string }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const nodes = { sources: 0, stopped: 0, gains: [] as number[] };
  class Utterance {
    volume = 1;
    rate = 1;
    pitch = 1;
    lang = '';
    voice: SpeechSynthesisVoice | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }
  class Ctx {
    state = 'running';
    sampleRate = 8000;
    currentTime = 0;
    destination = {};
    createBuffer() {
      return { getChannelData: () => new Float32Array(12000) };
    }
    createBufferSource() {
      nodes.sources++;
      return {
        buffer: null,
        loop: false,
        connect: (n: unknown) => n,
        start: () => undefined,
        stop: () => void nodes.stopped++,
      };
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect: (n: unknown) => n };
    }
    createGain() {
      const gain = { value: 0 };
      nodes.gains.push(0);
      const index = nodes.gains.length - 1;
      return {
        gain: {
          set value(v: number) {
            gain.value = v;
            nodes.gains[index] = v;
          },
          get value() {
            return gain.value;
          },
        },
        connect: (n: unknown) => n,
      };
    }
    resume = async () => undefined;
    close = async () => undefined;
  }
  const synth = {
    getVoices: () => [],
    cancel: vi.fn(),
    speak: (u: Utterance) => {
      spoken.push({ text: u.text, volume: u.volume, lang: u.lang });
      u.onend?.();
    },
  };
  const env = {
    ...(opts.audio ? { AudioContext: Ctx } : {}),
    ...(opts.speech ? { speechSynthesis: synth, Utterance } : {}),
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h: unknown) => {
      const i = timers.indexOf(h as { fn: () => void; ms: number });
      if (i >= 0) timers.splice(i, 1);
    },
  } as unknown as RadioEnv;
  const drain = (): void => {
    for (let guard = 0; timers.length > 0 && guard < 200; guard++) timers.shift()?.fn();
  };
  return { env, spoken, nodes, synth, drain };
}

describe('RadioPlayer', () => {
  it('speaks the planned words at the planned volume with static and squelch around them', () => {
    const f = fakeEnv({ speech: true, audio: true });
    const player = new RadioPlayer(f.env);
    player.setPrefs({ muted: false, volume: 0.5 });
    const plan = planRadio(input({ quality: 0.6 }));
    player.enqueue(plan, 'en');
    f.drain();
    expect(f.spoken.map((s) => s.text).join(' ')).toBe(plan.segments.map((s) => s.text).join(' '));
    expect(f.spoken[0]?.volume).toBeCloseTo(plan.speechVolume * 0.5);
    expect(f.spoken[0]?.lang).toBe('en-IN');
    // opening squelch + static bed + closing squelch at least
    expect(f.nodes.sources).toBeGreaterThanOrEqual(3);
    expect(f.nodes.gains).toContain(Math.min(1, plan.noiseGain * 0.5));
  });

  it('uses the Hindi language tag when Hindi is selected', () => {
    const f = fakeEnv({ speech: true, audio: false });
    const player = new RadioPlayer(f.env);
    player.enqueue(planRadio(input()), 'hi');
    f.drain();
    expect(f.spoken[0]?.lang).toBe('hi-IN');
  });

  it('muted plays nothing, and muting stops what is playing', () => {
    const f = fakeEnv({ speech: true, audio: true });
    const player = new RadioPlayer(f.env);
    player.setPrefs({ muted: true, volume: 1 });
    player.enqueue(planRadio(input()), 'en');
    f.drain();
    expect(f.spoken).toEqual([]);
    expect(f.nodes.sources).toBe(0);
    player.setPrefs({ muted: false, volume: 1 });
    player.enqueue(planRadio(input()), 'en');
    player.setPrefs({ muted: true, volume: 1 });
    expect(f.synth.cancel).toHaveBeenCalled();
  });

  it('still plays the static when speech synthesis is missing, and is a no-op with neither', () => {
    const noSpeech = fakeEnv({ speech: false, audio: true });
    const a = new RadioPlayer(noSpeech.env);
    expect(a.available).toBe(true);
    expect(() => {
      a.enqueue(planRadio(input({ quality: 0.3 })), 'en');
      noSpeech.drain();
    }).not.toThrow();
    expect(noSpeech.nodes.sources).toBeGreaterThan(0);

    const nothing = fakeEnv({ speech: false, audio: false });
    const b = new RadioPlayer(nothing.env);
    expect(b.available).toBe(false);
    expect(() => {
      b.enqueue(planRadio(input()), 'en');
      nothing.drain();
      b.dispose();
    }).not.toThrow();
  });

  it('survives a speech engine that throws', () => {
    const f = fakeEnv({ speech: true, audio: false });
    f.synth.speak = () => {
      throw new Error('synthesis-failed');
    };
    const player = new RadioPlayer(f.env);
    expect(() => {
      player.enqueue(planRadio(input()), 'en');
      f.drain();
    }).not.toThrow();
  });
});
