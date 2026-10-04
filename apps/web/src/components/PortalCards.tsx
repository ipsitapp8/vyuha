import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** The two ways in: one for instructors, one for trainees. */
export function PortalCards() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section
        aria-labelledby="portal-instructor"
        className="flex flex-col rounded border border-border border-t-4 border-t-primary bg-background p-5 shadow-sm"
      >
        <h2 id="portal-instructor" className="text-xl font-bold text-primary">
          {t('auth.portal.INSTRUCTOR.cta')}
        </h2>
        <p className="mt-2 flex-1">{t('auth.portal.INSTRUCTOR.intro')}</p>
        <div className="mt-4">
          <Button asChild size="lg">
            <Link to="/login/instructor">{t('auth.portal.INSTRUCTOR.cta')}</Link>
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('auth.portal.INSTRUCTOR.note')}</p>
      </section>

      <section
        aria-labelledby="portal-trainee"
        className="flex flex-col rounded border border-border border-t-4 border-t-india-green bg-background p-5 shadow-sm"
      >
        <h2 id="portal-trainee" className="text-xl font-bold text-primary">
          {t('auth.portal.TRAINEE.cta')}
        </h2>
        <p className="mt-2 flex-1">{t('auth.portal.TRAINEE.intro')}</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Button asChild size="lg">
            <Link to="/login/trainee">{t('auth.portal.TRAINEE.cta')}</Link>
          </Button>
          <Link className="text-primary underline" to="/register">
            {t('auth.createTrainee')}
          </Link>
        </div>
      </section>
    </div>
  );
}
