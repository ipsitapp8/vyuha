/**
 * Reader preferences, as on government portals: text size (A- / A / A+) and a high-contrast theme.
 * Both are remembered in this browser and applied to <html>, so every rem-based size follows.
 */

/** Root font size in percent of the browser default (16 px). Index 2 is the default, 17 px. */
export const TEXT_SIZE_PERCENTS = [90, 100, 106.25, 118.75, 131.25] as const;
export const DEFAULT_TEXT_SIZE_INDEX = 2;

const SIZE_KEY = 'vyuha.textSize';
const CONTRAST_KEY = 'vyuha.contrast';

export interface DisplayPrefs {
  /** Index into TEXT_SIZE_PERCENTS. */
  sizeIndex: number;
  highContrast: boolean;
}

const clampIndex = (i: number): number =>
  Math.min(TEXT_SIZE_PERCENTS.length - 1, Math.max(0, Math.round(i)));

/** One step bigger or smaller, staying inside the available sizes. */
export const stepSize = (index: number, direction: -1 | 1): number => clampIndex(index + direction);

export function readPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): DisplayPrefs {
  let sizeIndex = DEFAULT_TEXT_SIZE_INDEX;
  let highContrast = false;
  try {
    const raw = storage?.getItem(SIZE_KEY);
    const parsed = raw === null || raw === undefined ? NaN : Number(raw);
    if (Number.isInteger(parsed)) sizeIndex = clampIndex(parsed);
    highContrast = storage?.getItem(CONTRAST_KEY) === 'true';
  } catch {
    /* storage blocked: defaults */
  }
  return { sizeIndex, highContrast };
}

export function savePrefs(
  prefs: DisplayPrefs,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(SIZE_KEY, String(prefs.sizeIndex));
    storage?.setItem(CONTRAST_KEY, String(prefs.highContrast));
  } catch {
    /* storage blocked: the choice just will not persist */
  }
}

/** Applies the preferences to the document. */
export function applyPrefs(
  prefs: DisplayPrefs,
  root: HTMLElement = document.documentElement,
): void {
  const percent = TEXT_SIZE_PERCENTS[clampIndex(prefs.sizeIndex)] ?? 100;
  root.style.fontSize = `${percent}%`;
  root.classList.toggle('hc', prefs.highContrast);
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
