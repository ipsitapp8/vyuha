import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_SIZE_INDEX,
  TEXT_SIZE_PERCENTS,
  applyPrefs,
  readPrefs,
  savePrefs,
  stepSize,
} from './displayPrefs';

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
};

describe('display preferences', () => {
  it('defaults to the standard size without high contrast', () => {
    expect(readPrefs(memory())).toEqual({
      sizeIndex: DEFAULT_TEXT_SIZE_INDEX,
      highContrast: false,
    });
  });

  it('steps the size and stops at both ends', () => {
    const last = TEXT_SIZE_PERCENTS.length - 1;
    expect(stepSize(2, 1)).toBe(3);
    expect(stepSize(2, -1)).toBe(1);
    expect(stepSize(last, 1)).toBe(last);
    expect(stepSize(0, -1)).toBe(0);
  });

  it('remembers choices and ignores damaged stored values', () => {
    const store = memory();
    savePrefs({ sizeIndex: 4, highContrast: true }, store);
    expect(readPrefs(store)).toEqual({ sizeIndex: 4, highContrast: true });
    expect(readPrefs(memory({ 'vyuha.textSize': 'huge', 'vyuha.contrast': 'maybe' }))).toEqual({
      sizeIndex: DEFAULT_TEXT_SIZE_INDEX,
      highContrast: false,
    });
    expect(readPrefs(memory({ 'vyuha.textSize': '99' })).sizeIndex).toBe(
      TEXT_SIZE_PERCENTS.length - 1,
    );
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readPrefs(broken).sizeIndex).toBe(DEFAULT_TEXT_SIZE_INDEX);
    expect(() => savePrefs({ sizeIndex: 1, highContrast: false }, broken)).not.toThrow();
  });

  it('applies the size and the contrast class to the document', () => {
    const root = document.createElement('html');
    applyPrefs({ sizeIndex: 4, highContrast: true }, root);
    expect(root.style.fontSize).toBe('131.25%');
    expect(root.classList.contains('hc')).toBe(true);
    applyPrefs({ sizeIndex: 0, highContrast: false }, root);
    expect(root.style.fontSize).toBe('90%');
    expect(root.classList.contains('hc')).toBe(false);
  });
});
