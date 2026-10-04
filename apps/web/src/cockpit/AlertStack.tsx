import { useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PlayerAction } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import type { OrderAlert } from './logic';

interface Props {
  alerts: OrderAlert[];
  pending: boolean;
  send: (a: PlayerAction) => Promise<boolean>;
}

/**
 * Spoof-alert flow: every order that arrives is flagged as unverified with an Authenticate button;
 * once pressed, a countdown runs until the (possibly "FAILED") result is revealed.
 */
export function AlertStack({ alerts, pending, send }: Props) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const visible = alerts.filter(
    (a) =>
      !(a.message.authState === 'VERIFIED' || a.message.authState === 'FAILED') ||
      !dismissed.has(a.message.id),
  );
  if (visible.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={t('cockpit.alert.region')}
      aria-live="assertive"
      className="flex flex-col gap-2"
    >
      {visible.map(({ message: m, secondsLeft }) => {
        const state = m.authState;
        const tone =
          state === 'FAILED'
            ? 'border-red-500 bg-red-50/90'
            : state === 'VERIFIED'
              ? 'border-primary bg-emerald-50/90'
              : 'border-amber-700 bg-amber-50/90';
        return (
          <div key={m.id} className={`rounded-lg border-2 p-3 text-sm shadow-lg ${tone}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="flex items-center gap-2 font-semibold">
                {state === 'FAILED' ? <ShieldX className="h-5 w-5" aria-hidden="true" /> : null}
                {state === 'VERIFIED' ? (
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                ) : null}
                {state === 'NONE' || state === 'PENDING' ? (
                  <ShieldAlert className="h-5 w-5" aria-hidden="true" />
                ) : null}
                {state === 'FAILED'
                  ? t('cockpit.alert.failedTitle')
                  : state === 'VERIFIED'
                    ? t('cockpit.alert.verifiedTitle')
                    : t('cockpit.alert.newOrder', { from: m.from })}
              </p>
              {state === 'VERIFIED' || state === 'FAILED' ? (
                <button
                  type="button"
                  aria-label={t('cockpit.alert.dismiss')}
                  onClick={() => setDismissed(new Set(dismissed).add(m.id))}
                  className="rounded p-1 hover:bg-white/10"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <p className="mt-1">“{m.text}”</p>
            {state === 'NONE' ? (
              <>
                <p className="mt-1 text-xs opacity-80">{t('cockpit.alert.unverifiedWarn')}</p>
                <Button
                  className="mt-2"
                  disabled={pending}
                  onClick={() => void send({ type: 'AUTHENTICATE', messageId: m.id })}
                >
                  {t('cockpit.orders.authenticate')}
                </Button>
              </>
            ) : null}
            {state === 'PENDING' ? (
              <p role="timer" className="mt-2 font-mono">
                {secondsLeft === null
                  ? t('cockpit.orders.pendingUnknown')
                  : t('cockpit.orders.pending', { n: secondsLeft })}
              </p>
            ) : null}
            {state === 'FAILED' ? (
              <p className="mt-1 font-semibold">{t('cockpit.orders.failed')}</p>
            ) : null}
            {state === 'VERIFIED' ? <p className="mt-1">{t('cockpit.orders.verified')}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
