import { useState, type MouseEvent } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { APP_NAME, APP_TAGLINE } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { BrandMark } from '@/components/BrandMark';
import { DisplayControls } from '@/components/DisplayControls';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';

/** Moves keyboard and screen-reader focus to the page's <main>. */
function skipToMain(e: MouseEvent<HTMLAnchorElement>): void {
  e.preventDefault();
  const main = document.querySelector('main');
  if (!main) return;
  main.setAttribute('tabindex', '-1');
  main.focus();
  if (typeof main.scrollIntoView === 'function') main.scrollIntoView();
}

/** The tricolour rule that sits under the utility bar on Indian government portals. */
function Tricolour() {
  return (
    <div aria-hidden="true" className="flex h-1.5 w-full">
      <span className="flex-1 bg-saffron" />
      <span className="flex-1 border-y border-border bg-white" />
      <span className="flex-1 bg-india-green" />
    </div>
  );
}

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `block border-b-4 px-4 py-3 text-sm font-semibold text-white hover:bg-white/10 ${
    isActive ? 'border-saffron bg-white/10' : 'border-transparent'
  }`;

/**
 * Site header in the style of a government portal: utility bar (reader controls, language), tricolour
 * rule, the name and purpose of the service, and a main menu for the signed-in role. `compact` keeps only
 * one slim row, for the cockpit where every pixel of the map counts.
 */
export function AppHeader({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogout = async () => {
    setBusy(true);
    setError(null);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch {
      setError(t('common.signOutFailed'));
    } finally {
      setBusy(false);
    }
  };

  const signOut = user ? (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {error ? (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      ) : null}
      <span>
        <span className="font-semibold">{user.name}</span>
        <span className="text-muted-foreground"> · {t(`roles.${user.role}`)}</span>
      </span>
      <Button variant="outline" onClick={() => void onLogout()} disabled={busy}>
        {busy ? t('common.signingOut') : t('common.signOut')}
      </Button>
    </div>
  ) : null;

  const links = !user
    ? [
        { to: '/', label: t('shell.nav.home'), end: true },
        { to: '/login/instructor', label: t('auth.portal.INSTRUCTOR.cta'), end: false },
        { to: '/login/trainee', label: t('auth.portal.TRAINEE.cta'), end: false },
        { to: '/register', label: t('auth.createTrainee'), end: false },
      ]
    : user.role === 'INSTRUCTOR'
      ? [
          { to: '/instructor', label: t('shell.nav.instructorHome'), end: false },
          { to: '/progress', label: t('progress.nav.instructor'), end: false },
        ]
      : [
          { to: '/trainee', label: t('shell.nav.traineeHome'), end: false },
          { to: '/progress', label: t('progress.nav.trainee'), end: false },
        ];

  return (
    <>
      <a href="#main" className="skip-link" onClick={skipToMain}>
        {t('shell.skip')}
      </a>
      <header>
        <div className="border-b border-border bg-secondary">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-1.5">
            {compact ? (
              <Link to={user ? (user.role === 'INSTRUCTOR' ? '/instructor' : '/trainee') : '/'}>
                <span className="text-lg font-bold tracking-widest text-primary">{APP_NAME}</span>
              </Link>
            ) : (
              <p className="text-xs text-muted-foreground">{t('shell.siteNote')}</p>
            )}
            <div className="flex flex-wrap items-center gap-4">
              <DisplayControls />
              <LanguageToggle />
              {compact ? signOut : null}
            </div>
          </div>
        </div>
        <Tricolour />

        {compact ? null : (
          <>
            <div className="border-b border-border bg-background">
              <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3">
                <Link to="/" className="flex items-center gap-3 text-primary no-underline">
                  <BrandMark />
                  <span>
                    <span className="block text-3xl font-bold leading-none tracking-[0.2em]">
                      {APP_NAME}
                    </span>
                    <span className="mt-1 block text-sm font-medium text-foreground">
                      {APP_TAGLINE}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t('shell.subtitle')}
                    </span>
                  </span>
                </Link>
                {signOut}
              </div>
            </div>
            <nav aria-label={t('shell.mainMenu')} className="bg-navy">
              <ul className="mx-auto flex max-w-7xl flex-wrap px-2">
                {links.map((l) => (
                  <li key={l.to}>
                    <NavLink to={l.to} end={l.end} className={navClass}>
                      {l.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          </>
        )}
      </header>
    </>
  );
}
