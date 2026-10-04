import { useTranslation } from 'react-i18next';
import { AppHeader } from '@/components/AppHeader';
import { PortalCards } from '@/components/PortalCards';

const STEPS = ['1', '2', '3', '4', '5'] as const;

export function LandingPage() {
  const { t } = useTranslation();
  return (
    <>
      <AppHeader />
      <main>
        <section className="border-b border-border bg-secondary">
          <div className="mx-auto max-w-7xl px-4 py-12">
            <h1 className="max-w-3xl text-3xl font-bold text-primary sm:text-4xl">
              {t('landing.heroTitle')}
            </h1>
            <p className="mt-4 max-w-3xl text-lg">{t('landing.heroBody')}</p>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pt-10" aria-labelledby="signin-title">
          <h2 id="signin-title" className="border-b-2 border-primary pb-1 text-2xl font-bold">
            {t('auth.chooseTitle')}
          </h2>
          <div className="mt-6">
            <PortalCards />
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-10" aria-labelledby="how-title">
          <h2 id="how-title" className="border-b-2 border-saffron pb-1 text-2xl font-bold">
            {t('landing.howTitle')}
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((n) => (
              <li key={n} className="rounded border border-border bg-background p-4 shadow-sm">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {n}
                </span>
                <h3 className="mt-3 font-semibold">{t(`landing.steps.${n}.title`)}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t(`landing.steps.${n}.body`)}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </>
  );
}
