import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_TEXT_SIZE_INDEX,
  TEXT_SIZE_PERCENTS,
  applyPrefs,
  readPrefs,
  savePrefs,
  stepSize,
  type DisplayPrefs,
} from '@/lib/displayPrefs';

const btn =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-sm border border-border px-2 font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const idle = 'bg-background hover:bg-secondary';
const on = 'bg-primary text-primary-foreground';

/** Text size (A- A A+) and high-contrast switch, the reader controls government portals carry. */
export function DisplayControls() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => readPrefs());

  useEffect(() => {
    applyPrefs(prefs);
    savePrefs(prefs);
  }, [prefs]);

  const last = TEXT_SIZE_PERCENTS.length - 1;
  return (
    <div className="flex items-center gap-2">
      <div role="group" aria-label={t('shell.textSize')} className="flex items-center gap-1">
        <button
          type="button"
          className={`${btn} ${idle} text-xs`}
          aria-label={t('shell.smaller')}
          disabled={prefs.sizeIndex === 0}
          onClick={() => setPrefs((p) => ({ ...p, sizeIndex: stepSize(p.sizeIndex, -1) }))}
        >
          A<span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          className={`${btn} ${prefs.sizeIndex === DEFAULT_TEXT_SIZE_INDEX ? on : idle} text-sm`}
          aria-label={t('shell.defaultSize')}
          aria-pressed={prefs.sizeIndex === DEFAULT_TEXT_SIZE_INDEX}
          onClick={() => setPrefs((p) => ({ ...p, sizeIndex: DEFAULT_TEXT_SIZE_INDEX }))}
        >
          A
        </button>
        <button
          type="button"
          className={`${btn} ${idle} text-base`}
          aria-label={t('shell.larger')}
          disabled={prefs.sizeIndex === last}
          onClick={() => setPrefs((p) => ({ ...p, sizeIndex: stepSize(p.sizeIndex, 1) }))}
        >
          A<span aria-hidden="true">+</span>
        </button>
      </div>
      <button
        type="button"
        className={`${btn} gap-1 text-xs ${prefs.highContrast ? on : idle}`}
        aria-pressed={prefs.highContrast}
        onClick={() => setPrefs((p) => ({ ...p, highContrast: !p.highContrast }))}
      >
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 rounded-full border border-current"
          style={{ background: 'linear-gradient(90deg, currentColor 50%, transparent 50%)' }}
        />
        {t('shell.contrast')}
      </button>
    </div>
  );
}
