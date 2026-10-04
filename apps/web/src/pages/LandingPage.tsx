import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';

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
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/login">{t('landing.signIn')}</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/register">{t('landing.createAccount')}</Link>
              </Button>
            </div>
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

        <section className="mx-auto max-w-7xl px-4 pb-4" aria-labelledby="who-title">
          <h2 id="who-title" className="border-b-2 border-india-green pb-1 text-2xl font-bold">
            {t('landing.whoTitle')}
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <article className="rounded border border-border p-5">
              <h3 className="text-lg font-semibold text-primary">{t('landing.instructorTitle')}</h3>
              <p className="mt-2">{t('landing.instructorBody')}</p>
            </article>
            <article className="rounded border border-border p-5">
              <h3 className="text-lg font-semibold text-primary">{t('landing.traineeTitle')}</h3>
              <p className="mt-2">{t('landing.traineeBody')}</p>
            </article>
          </div>
        </section>
      </main>
    </>
  );
}
