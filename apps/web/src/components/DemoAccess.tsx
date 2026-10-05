import { useTranslation } from 'react-i18next';
import type { Role } from '@vyuha/shared';
import { Button } from '@/components/ui/button';

/** Shared demo accounts that `pnpm db:seed` creates; a public demo resets their password to `VITE_DEMO_PASSWORD`. */
const DEMO_EMAIL: Record<Role, string> = {
  INSTRUCTOR: 'instructor@vyuha.local',
  TRAINEE: 'trainee1@vyuha.local',
};

const configuredPassword: unknown = import.meta.env.VITE_DEMO_PASSWORD;
export const DEMO_PASSWORD =
  typeof configuredPassword === 'string' && configuredPassword.length > 0
    ? configuredPassword
    : 'Vyuha@123';

const flag: unknown = import.meta.env.VITE_SHOW_DEMO_LOGIN;
/** On by default so anyone trying the prototype can sign in; set `VITE_SHOW_DEMO_LOGIN=false` for a real deployment. */
export const SHOW_DEMO_LOGIN = flag !== 'false';

interface Props {
  role: Role;
  onFill: (email: string, password: string) => void;
}

/** Tells a visitor which demo email and password work on this sign-in page, with a button that fills them in. */
export function DemoAccess({ role, onFill }: Props) {
  const { t } = useTranslation();
  if (!SHOW_DEMO_LOGIN) return null;
  const email = DEMO_EMAIL[role];
  return (
    <aside
      aria-labelledby={`demo-title-${role}`}
      className="rounded border border-dashed border-primary bg-secondary p-3 text-sm"
    >
      <h2 id={`demo-title-${role}`} className="font-semibold text-primary">
        {t('auth.demo.title')}
      </h2>
      <p className="mt-1 text-muted-foreground">{t(`auth.demo.${role}.hint`)}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-medium">{t('auth.email')}</dt>
        <dd>
          <code className="break-all">{email}</code>
        </dd>
        <dt className="font-medium">{t('auth.password')}</dt>
        <dd>
          <code>{DEMO_PASSWORD}</code>
        </dd>
      </dl>
      <Button
        type="button"
        variant="outline"
        className="mt-3 w-full border-primary text-primary"
        onClick={() => onFill(email, DEMO_PASSWORD)}
      >
        {t('auth.demo.fill')}
      </Button>
    </aside>
  );
}
