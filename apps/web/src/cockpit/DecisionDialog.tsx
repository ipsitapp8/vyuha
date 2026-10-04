import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { decisionActionSchema, type PerceivedStateDto, type PlayerAction } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { clock, formatAge } from '@/lib/format';

const ACTIONS = decisionActionSchema.options;
type Action = (typeof ACTIONS)[number];
const MIN_RATIONALE = 10;

interface Props {
  perceived: PerceivedStateDto;
  initialContactId: string | null;
  onClose: () => void;
  /** Resolves true when the server accepted the decision. */
  send: (a: PlayerAction) => Promise<boolean>;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * Modal for recording a decision: action, confidence (0-100) and a written rationale of at least
 * 10 characters. Mount it to open it; it traps focus, closes on Escape and restores focus.
 */
export function DecisionDialog({ perceived, initialContactId, onClose, send }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<Action>('HOLD');
  const [confidence, setConfidence] = useState(60);
  const [rationale, setRationale] = useState('');
  const [contactId, setContactId] = useState(initialContactId ?? '');
  const [messageId, setMessageId] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const valid = rationale.trim().length >= MIN_RATIONALE;
  const orders = perceived.inbox.filter((m) => m.requiresAuth);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = nodes?.[0];
    const last = nodes?.[nodes.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    const ok = await send({
      type: 'DECISION',
      actionType: action,
      confidence,
      rationale: rationale.trim(),
      ...(contactId ? { targetContactId: contactId } : {}),
      ...(messageId ? { basedOnMessageId: messageId } : {}),
    });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-border bg-background p-5 shadow-2xl sm:rounded-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            {t('cockpit.decision.title')}
          </h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded p-1 hover:bg-secondary"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Select
            label={t('cockpit.decision.action')}
            value={action}
            options={ACTIONS.map((a) => ({ value: a, label: t(`actions.${a}`) }))}
            onChange={(v) => setAction(v as Action)}
          />
          <Select
            label={t('cockpit.decision.contact')}
            value={contactId}
            options={[
              { value: '', label: t('cockpit.decision.none') },
              ...perceived.contacts.map((c) => ({
                value: c.id,
                label: `${t(`unitTypes.${c.type}` as 'unitTypes.RECCE', { defaultValue: c.type })} · ${formatAge(t, c.ageTicks)}`,
              })),
            ]}
            onChange={setContactId}
          />
          <Select
            label={t('cockpit.decision.order')}
            value={messageId}
            options={[
              { value: '', label: t('cockpit.decision.none') },
              ...orders.map((m) => ({
                value: m.id,
                label: `${m.from} · ${clock(m.receivedTick)}`,
              })),
            ]}
            onChange={setMessageId}
          />
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('cockpit.decision.confidence', { value: confidence })}
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('cockpit.decision.rationale')}
            <textarea
              value={rationale}
              rows={3}
              maxLength={1000}
              aria-invalid={touched && !valid}
              onChange={(e) => setRationale(e.target.value)}
              className="rounded-md border border-border bg-background p-2 text-sm font-normal"
            />
          </label>
          {touched && !valid ? (
            <p role="alert" className="-mt-2 text-sm text-red-700">
              {t('cockpit.decision.rationaleShort')}
            </p>
          ) : null}
          <Button type="submit" disabled={busy || !valid}>
            {t('cockpit.decision.submit')}
          </Button>
        </form>
      </div>
    </div>
  );
}
