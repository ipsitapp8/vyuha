import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APP_NAME } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { Button } from '@/components/ui/button';

export function AppHeader() {
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
      setError('Could not sign out. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <span className="text-xl font-semibold tracking-widest text-primary">{APP_NAME}</span>
      <div className="flex items-center gap-3 text-sm">
        {error ? (
          <span role="alert" className="text-red-400">
            {error}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {user?.name} · {user?.role}
        </span>
        <Button variant="outline" onClick={() => void onLogout()} disabled={busy}>
          {busy ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </header>
  );
}
