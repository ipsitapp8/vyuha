import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { channelSchema, type Channel, type PaceDefaults } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';

const CHANNELS = channelSchema.options;
const SLOTS = [
  'primary',
  'alternate',
  'contingency',
  'emergency',
] as const satisfies readonly (keyof PaceDefaults)[];

interface Props {
  pace: PaceDefaults;
  disabled?: boolean;
  onSave: (pace: PaceDefaults) => Promise<void>;
}

/** PACE comms plan: four different channels in priority order. */
export function PaceEditor({ pace, disabled, onSave }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PaceDefaults>(pace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const distinct = new Set(Object.values(draft)).size === 4;
  const dirty = SLOTS.some((s) => draft[s] !== pace[s]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('cockpit.lobby.paceSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SLOTS.map((s) => (
          <Select
            key={s}
            label={t(`cockpit.pace.${s}`)}
            value={draft[s]}
            disabled={disabled || saving}
            options={CHANNELS.map((c) => ({ value: c, label: c }))}
            onChange={(v) => setDraft({ ...draft, [s]: v as Channel })}
          />
        ))}
      </div>
      {!distinct ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {t('cockpit.pace.distinct')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <Button
        className="mt-3"
        variant="outline"
        disabled={disabled || saving || !distinct || !dirty}
        onClick={() => void save()}
      >
        {saving ? t('cockpit.pace.saving') : t('cockpit.pace.save')}
      </Button>
    </div>
  );
}
