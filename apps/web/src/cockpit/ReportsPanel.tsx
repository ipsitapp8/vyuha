import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PerceivedStateDto, PlayerAction } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import { formatAge, latLonText } from '@/lib/format';
import { AdmiraltyGrader } from './AdmiraltyGrader';
import { contactOpacity, isLowConfidence } from './logic';

type Contact = PerceivedStateDto['contacts'][number];

interface Props {
  perceived: PerceivedStateDto;
  selectedId: string | null;
  pending: boolean;
  send: (a: PlayerAction) => Promise<boolean>;
  onDecide: (contactId: string) => void;
}

/** Every reported contact is a report: shows where it came from and lets the trainee grade it A1-F6. */
export function ReportsPanel({ perceived, selectedId, pending, send, onDecide }: Props) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('cockpit.contacts.title', { count: perceived.contacts.length })}>
      <h2 className="mb-2 font-semibold">
        {t('cockpit.contacts.title', { count: perceived.contacts.length })}
      </h2>
      {perceived.contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cockpit.contacts.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {perceived.contacts.map((c) => (
            <ContactCard
              key={c.id}
              contact={c}
              selected={c.id === selectedId}
              pending={pending}
              send={send}
              onDecide={onDecide}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ContactCard({
  contact,
  selected,
  pending,
  send,
  onDecide,
}: {
  contact: Contact;
  selected: boolean;
  pending: boolean;
  send: Props['send'];
  onDecide: Props['onDecide'];
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const type = t(`unitTypes.${contact.type}` as 'unitTypes.RECCE', { defaultValue: contact.type });
  const source =
    contact.source === 'Own sensor'
      ? t('cockpit.contacts.own')
      : contact.source === 'Unknown source'
        ? t('cockpit.contacts.unknownSource')
        : contact.source;
  const grade = contact.grade ? `${contact.grade.reliability}${contact.grade.credibility}` : null;

  return (
    <li
      ref={ref}
      className={`rounded-md border p-3 text-sm ${selected ? 'border-yellow-300' : 'border-border'} ${
        isLowConfidence(contact.grade) ? 'border-dashed' : ''
      }`}
      style={{ opacity: Math.max(0.7, contactOpacity(contact.ageTicks, contact.grade)) }}
    >
      <p className="font-medium">
        {type}{' '}
        <span className="font-normal text-muted-foreground">
          · {formatAge(t, contact.ageTicks)}
        </span>
      </p>
      <p className="text-muted-foreground">
        {latLonText(contact.position)} · {source}
        {contact.via === 'DIRECT'
          ? ''
          : ` · ${t('cockpit.contacts.via', { channel: t(`channels.${contact.via}`) })}`}
      </p>
      <p className={grade ? 'mt-1 text-primary' : 'mt-1 text-amber-400'}>
        {grade ? t('cockpit.contacts.graded', { grade }) : t('cockpit.contacts.ungraded')}
      </p>
      <div className="mt-2">
        <AdmiraltyGrader
          key={grade ?? 'none'}
          id={contact.id}
          initial={contact.grade}
          disabled={pending}
          onSave={(reliability, credibility) =>
            void send({ type: 'GRADE_REPORT', reportId: contact.id, reliability, credibility })
          }
        />
      </div>
      <Button className="mt-2" variant="outline" onClick={() => onDecide(contact.id)}>
        {t('cockpit.contacts.decide')}
      </Button>
    </li>
  );
}
