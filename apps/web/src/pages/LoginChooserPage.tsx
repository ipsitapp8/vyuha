import { useTranslation } from 'react-i18next';
import { AppHeader } from '@/components/AppHeader';
import { PortalCards } from '@/components/PortalCards';

/** /login: pick the instructor or the trainee sign-in. */
export function LoginChooserPage() {
  const { t } = useTranslation();
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-6 border-b-2 border-saffron pb-2 text-2xl font-bold text-primary">
          {t('auth.chooseTitle')}
        </h1>
        <PortalCards />
      </main>
    </>
  );
}
