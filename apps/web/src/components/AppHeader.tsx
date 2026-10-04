import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { APP_NAME } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';

export function AppHeader() {
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

  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <span className="text-xl font-semibold tracking-widest text-primary">{APP_NAME}</span>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <LanguageToggle />
        {error ? (
          <span role="alert" className="text-red-400">
            {error}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {user?.name} · {user ? t(`roles.${user.role}`) : ''}
        </span>
        <Button variant="outline" onClick={() => void onLogout()} disabled={busy}>
          {busy ? t('common.signingOut') : t('common.signOut')}
        </Button>
      </div>
    </header>
  );
}
