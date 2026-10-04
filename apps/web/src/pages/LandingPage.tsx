import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { APP_NAME, APP_TAGLINE } from '@vyuha/shared';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';

export function LandingPage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <h1 className="text-5xl font-bold tracking-[0.3em] text-primary sm:text-7xl">{APP_NAME}</h1>
      <p className="max-w-xl text-lg text-muted-foreground">{APP_TAGLINE}</p>
      <Button asChild size="lg">
        <Link to="/login">{t('landing.signIn')}</Link>
      </Button>
    </main>
  );
}
