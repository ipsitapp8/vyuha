import { useState } from 'react';
import { channelSchema, type Channel, type PaceDefaults } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';

const CHANNELS = channelSchema.options;
const SLOTS: { key: keyof PaceDefaults; label: string }[] = [
  { key: 'primary', label: 'Primary' },
  { key: 'alternate', label: 'Alternate' },
  { key: 'contingency', label: 'Contingency' },
  { key: 'emergency', label: 'Emergency' },
];

interface Props {
  pace: PaceDefaults;
  disabled?: boolean;
  onSave: (pace: PaceDefaults) => Promise<void>;
}

/** PACE comms plan: four different channels in priority order. */
export function PaceEditor({ pace, disabled, onSave }: Props) {
  const [draft, setDraft] = useState<PaceDefaults>(pace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const distinct = new Set(Object.values(draft)).size === 4;
  const dirty = SLOTS.some((s) => draft[s.key] !== pace[s.key]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the PACE plan.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SLOTS.map((s) => (
          <Select
            key={s.key}
            label={s.label}
            value={draft[s.key]}
            disabled={disabled || saving}
            options={CHANNELS.map((c) => ({ value: c, label: c }))}
            onChange={(v) => setDraft({ ...draft, [s.key]: v as Channel })}
          />
        ))}
      </div>
      {!distinct ? (
        <p role="alert" className="mt-2 text-sm text-red-400">
          Each PACE slot needs a different channel.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}
      <Button
        className="mt-3"
        variant="outline"
        disabled={disabled || saving || !distinct || !dirty}
        onClick={() => void save()}
      >
        {saving ? 'Saving…' : 'Save PACE plan'}
      </Button>
    </div>
  );
}
