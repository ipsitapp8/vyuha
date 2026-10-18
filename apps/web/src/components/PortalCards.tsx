import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Presentation, Users } from 'lucide-react';

const ctaBase =
  'inline-flex h-12 items-center justify-center gap-3 rounded-sm px-8 text-sm font-semibold no-underline transition-colors';

/** The two ways in: one for instructors, one for trainees. */
export function PortalCards() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section aria-labelledby="portal-instructor" className="vy-portal-card">
        <Presentation aria-hidden="true" strokeWidth={1.5} className="vy-portal-icon" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="portal-instructor" className="text-2xl font-bold text-navy">
            {t('auth.portal.INSTRUCTOR.cta')}
          </h2>
          <p className="mt-2 max-w-sm flex-1 text-sm leading-relaxed text-muted-foreground">
            {t('auth.portal.INSTRUCTOR.intro')}
          </p>
          <div className="mt-5">
            <Link
              to="/login/instructor"
              className={`${ctaBase} w-full bg-navy text-white hover:bg-navy/90 sm:w-auto sm:min-w-[19rem]`}
            >
              {t('auth.portal.INSTRUCTOR.cta')}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('auth.portal.INSTRUCTOR.note')}</p>
        </div>
      </section>

      <section aria-labelledby="portal-trainee" className="vy-portal-card">
        <Users aria-hidden="true" strokeWidth={1.5} className="vy-portal-icon" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id="portal-trainee" className="text-2xl font-bold text-navy">
            {t('auth.portal.TRAINEE.cta')}
          </h2>
          <p className="mt-2 max-w-sm flex-1 text-sm leading-relaxed text-muted-foreground">
            {t('auth.portal.TRAINEE.intro')}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-3">
            <Link
              to="/login/trainee"
              className={`${ctaBase} w-full border border-navy bg-background text-navy hover:bg-secondary sm:w-auto sm:min-w-[14rem]`}
            >
              {t('auth.portal.TRAINEE.cta')}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
            <Link className="text-sm text-olive underline" to="/register">
              {t('auth.createTrainee')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
