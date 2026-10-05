import { useTranslation } from 'react-i18next';
import { MapPin, X } from 'lucide-react';
import { channelSchema, type PerceivedStateDto, type ProbeChannel } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/Select';
import { canSubmit, removeContact, type ProbeDraft } from './probe';

const CHANNELS = channelSchema.options.filter((c) => c !== 'RUNNER');
const UNSET = '';

interface Props {
  perceived: PerceivedStateDto;
  draft: ProbeDraft;
  onChange: (next: ProbeDraft) => void;
  submitted: boolean;
  sending: boolean;
  onSubmit: () => void;
}

const coord = (p: { lat: number; lon: number }): string =>
  `${p.lat.toFixed(4)}°N ${p.lon.toFixed(4)}°E`;

/**
 * The situation-awareness questionnaire shown while the exercise is frozen: where are the hostile
 * contacts, where are your teammates, and which channel is jammed. Answered from memory.
 */
export function ProbePanel({ perceived, draft, onChange, submitted, sending, onSubmit }: Props) {
  const { t } = useTranslation();
  if (submitted) {
    return (
      <section aria-label={t('cockpit.probe.title')} className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('cockpit.probe.title')}</h2>
        <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
          {t('cockpit.probe.sent')}
        </p>
      </section>
    );
  }
  const placing = draft.target;
  return (
    <section aria-label={t('cockpit.probe.title')} className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t('cockpit.probe.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('cockpit.probe.intro')}</p>
      </div>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-semibold">{t('cockpit.probe.q1')}</legend>
        <p className="text-sm text-muted-foreground">{t('cockpit.probe.q1Help')}</p>
        <Button
          variant={placing.kind === 'contact' ? 'default' : 'outline'}
          className="mt-2"
          aria-pressed={placing.kind === 'contact'}
          onClick={() => onChange({ ...draft, target: { kind: 'contact' } })}
        >
          <MapPin className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('cockpit.probe.markContacts')}
        </Button>
        {draft.contacts.length === 0 ? (
          <p className="mt-2 text-sm">{t('cockpit.probe.noContacts')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label={t('cockpit.probe.marked')}>
            {draft.contacts.map((c, i) => (
              <li key={`${c.lat}-${c.lon}-${i}`} className="flex items-center justify-between">
                <span>
                  {t('cockpit.probe.contactN', { n: i + 1 })} · {coord(c)}
                </span>
                <Button
                  variant="outline"
                  aria-label={t('cockpit.probe.removeContact', { n: i + 1 })}
                  onClick={() => onChange(removeContact(draft, i))}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-semibold">{t('cockpit.probe.q2')}</legend>
        {perceived.friendlies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('cockpit.probe.noTeammates')}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {perceived.friendlies.map((f) => {
              const placed = draft.teammates[f.unitId];
              const active = placing.kind === 'teammate' && placing.unitId === f.unitId;
              return (
                <li key={f.unitId} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{f.name}</span>
                    <span className="block text-muted-foreground">
                      {placed ? coord(placed) : t('cockpit.probe.notPlaced')}
                    </span>
                  </span>
                  <Button
                    variant={active ? 'default' : 'outline'}
                    aria-pressed={active}
                    onClick={() =>
                      onChange({ ...draft, target: { kind: 'teammate', unitId: f.unitId } })
                    }
                  >
                    {active
                      ? t('cockpit.probe.clickMap')
                      : t('cockpit.probe.place', { name: f.name })}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-semibold">{t('cockpit.probe.q3')}</legend>
        <Select
          label={t('cockpit.probe.q3Label')}
          value={draft.jammedChannel ?? UNSET}
          options={[
            { value: UNSET, label: t('cockpit.probe.choose') },
            { value: 'NONE', label: t('cockpit.probe.none') },
            ...CHANNELS.map((c) => ({ value: c, label: t(`channels.${c}`) })),
          ]}
          onChange={(v) =>
            onChange({ ...draft, jammedChannel: v === UNSET ? null : (v as ProbeChannel) })
          }
        />
      </fieldset>

      <Button disabled={!canSubmit(draft) || sending} onClick={onSubmit}>
        {sending ? t('cockpit.probe.sending') : t('cockpit.probe.submit')}
      </Button>
      {!canSubmit(draft) ? (
        <p className="text-xs text-muted-foreground">{t('cockpit.probe.needChannel')}</p>
      ) : null}
    </section>
  );
}
