import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

const RELIABILITY = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const CREDIBILITY = [1, 2, 3, 4, 5, 6] as const;
export type Rel = (typeof RELIABILITY)[number];
export type Cred = (typeof CREDIBILITY)[number];

interface Props {
  id: string;
  initial: { reliability: Rel; credibility: Cred } | null;
  disabled: boolean;
  onSave: (reliability: Rel, credibility: Cred) => void;
}

function Chip({
  checked,
  label,
  title,
  onClick,
}: {
  checked: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={title}
      title={title}
      onClick={onClick}
      className={
        checked
          ? 'h-8 w-8 rounded-md bg-primary text-sm font-semibold text-primary-foreground'
          : 'h-8 w-8 rounded-md border border-border text-sm hover:bg-secondary'
      }
    >
      {label}
    </button>
  );
}

/** Admiralty code grading: source reliability A-F and information credibility 1-6. */
export function AdmiraltyGrader({ id, initial, disabled, onSave }: Props) {
  const { t } = useTranslation();
  const [rel, setRel] = useState<Rel | null>(initial?.reliability ?? null);
  const [cred, setCred] = useState<Cred | null>(initial?.credibility ?? null);
  const changed =
    rel !== null &&
    cred !== null &&
    (rel !== initial?.reliability || cred !== initial?.credibility);

  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={`${t('cockpit.contacts.reliability')} (${id})`}
        className="flex flex-wrap items-center gap-1"
      >
        {RELIABILITY.map((r) => (
          <Chip
            key={r}
            checked={rel === r}
            label={r}
            title={t(`cockpit.admiralty.reliability.${r}`)}
            onClick={() => setRel(r)}
          />
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label={`${t('cockpit.contacts.credibility')} (${id})`}
        className="flex flex-wrap items-center gap-1"
      >
        {CREDIBILITY.map((c) => (
          <Chip
            key={c}
            checked={cred === c}
            label={String(c)}
            title={t(`cockpit.admiralty.credibility.${c}`)}
            onClick={() => setCred(c)}
          />
        ))}
      </div>
      <Button
        variant="outline"
        disabled={disabled || !changed}
        onClick={() => {
          if (rel !== null && cred !== null) onSave(rel, cred);
        }}
      >
        {initial
          ? t('cockpit.contacts.regrade', { grade: `${initial.reliability}${initial.credibility}` })
          : t('cockpit.contacts.save')}
      </Button>
    </div>
  );
}
