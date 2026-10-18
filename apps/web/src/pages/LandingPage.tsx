import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { AppHeader } from '@/components/AppHeader';
import { PortalCards } from '@/components/PortalCards';

const STEPS = ['1', '2', '3', '4', '5'] as const;

export function LandingPage() {
  const { t } = useTranslation();
  return (
    <>
      <AppHeader />
      <main>
        <section className="vy-hero">
          <img className="vy-hero-photo" src="/landing-hero.jpg" alt="" />
          <div className="mx-auto max-w-7xl px-4 py-14 lg:py-16">
            <h1 className="max-w-2xl text-4xl font-bold leading-tight sm:text-5xl">
              {t('landing.heroTitle')}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/95">
              {t('landing.heroBody')}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Link
                to="/login"
                className="inline-flex h-12 items-center gap-4 rounded-sm bg-olive px-8 text-base font-semibold text-white no-underline shadow transition-colors hover:bg-olive/85"
              >
                {t('landing.startTraining')}
                <ArrowRight aria-hidden="true" className="h-5 w-5" />
              </Link>
              <span aria-hidden="true" className="hidden h-6 w-px bg-white/60 sm:block" />
              <a href="#how-title" className="font-medium text-white underline">
                {t('landing.learnHow')}
              </a>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pt-10" aria-labelledby="signin-title">
          <h2 id="signin-title" className="vy-section-title">
            {t('auth.chooseTitle')}
          </h2>
          <div className="mt-7">
            <PortalCards />
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 py-10" aria-labelledby="how-title">
          <h2
            id="how-title"
            className="scroll-mt-4 border-b-2 border-saffron pb-1 text-2xl font-bold"
          >
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
