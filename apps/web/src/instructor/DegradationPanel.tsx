import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TruthViewDto } from '@vyuha/shared';

const CHANNELS = ['VHF', 'HF', 'SATCOM', 'DATALINK'] as const;
type Ch = (typeof CHANNELS)[number];

interface Props {
  truth: TruthViewDto;
  /** Resolves false when the server refused the change. */
  onSet: (channel: Ch, intensity: number) => Promise<boolean>;
}

/** Per-channel degradation sliders: a constant jamming level on top of scripted and adaptive jamming. */
export function DegradationPanel({ truth, onSet }: Props) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState<Partial<Record<Ch, number>>>({});

  const commit = (channel: Ch): void => {
    const value = drag[channel];
    if (value === undefined) return;
    setDrag((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== channel)));
    if (value / 100 !== truth.manualJamming[channel]) void onSet(channel, value / 100);
  };

  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('god.degrade.title')}
    >
      <h2 className="font-semibold">{t('god.degrade.title')}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t('god.degrade.help')}</p>
      <ul className="flex flex-col gap-3 text-sm">
        {CHANNELS.map((c) => {
          const manual = Math.round((drag[c] ?? truth.manualJamming[c] * 100) / 5) * 5;
          return (
            <li key={c} className="grid grid-cols-[6.5rem_1fr_3rem_6rem] items-center gap-2">
              <label htmlFor={`deg-${c}`}>
                {t('god.degrade.level', { channel: t(`channels.${c}`) })}
              </label>
              <input
                id={`deg-${c}`}
                type="range"
                min={0}
                max={100}
                step={5}
                value={manual}
                onChange={(e) => setDrag({ ...drag, [c]: Number(e.target.value) })}
                onPointerUp={() => commit(c)}
                onKeyUp={() => commit(c)}
                onBlur={() => commit(c)}
              />
              <span className="text-right">{manual}%</span>
              <span className="text-xs text-muted-foreground">
                {t('god.degrade.effective', { n: Math.round(truth.jamming[c] * 100) })}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-sm text-muted-foreground">
        {t('god.degrade.satcom', {
          state: truth.satcomUp ? t('god.degrade.up') : t('god.degrade.down'),
        })}
      </p>
    </section>
  );
}
