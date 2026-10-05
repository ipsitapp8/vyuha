import { Volume2, VolumeX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { RadioAudioControls as Controls } from './useRadioAudio';

/** Mute toggle and volume slider for the radio audio. On by default. */
export function RadioAudioControls({ prefs, setPrefs, available }: Controls) {
  const { t } = useTranslation();
  if (!available) {
    return <p className="text-xs text-muted-foreground">{t('cockpit.audio.unavailable')}</p>;
  }
  const percent = Math.round(prefs.volume * 100);
  return (
    <div
      role="group"
      aria-label={t('cockpit.audio.label')}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <Button
        variant="outline"
        aria-pressed={!prefs.muted}
        onClick={() => setPrefs({ ...prefs, muted: !prefs.muted })}
      >
        {prefs.muted ? (
          <VolumeX className="mr-1 h-4 w-4" aria-hidden="true" />
        ) : (
          <Volume2 className="mr-1 h-4 w-4" aria-hidden="true" />
        )}
        {prefs.muted ? t('cockpit.audio.off') : t('cockpit.audio.on')}
      </Button>
      <label className="flex items-center gap-2">
        <span>{t('cockpit.audio.volume')}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={percent}
          disabled={prefs.muted}
          aria-valuetext={`${percent}%`}
          onChange={(e) => setPrefs({ ...prefs, volume: Number(e.target.value) / 100 })}
        />
      </label>
    </div>
  );
}
