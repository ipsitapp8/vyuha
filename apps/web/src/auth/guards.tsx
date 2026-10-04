import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Role } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import { useAuth } from './AuthContext';

export function homePathFor(role: Role): string {
  return role === 'INSTRUCTOR' ? '/instructor' : '/trainee';
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      {children}
    </main>
  );
}

/** Gate: renders children only for signed-in users; with `role`, only for that role. */
export function RequireRole({ role }: { role?: Role }) {
  const { t } = useTranslation();
  const { status, user, retry } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <Centered>
        <p role="status" className="text-muted-foreground">
          {t('common.loading')}
        </p>
      </Centered>
    );
  }
  if (status === 'error') {
    return (
      <Centered>
        <p role="alert" className="text-red-700">
          {t('common.serverUnreachable')}
        </p>
        <Button onClick={retry}>{t('common.retry')}</Button>
      </Centered>
    );
  }
  if (!user) {
    const to =
      role === 'INSTRUCTOR'
        ? '/login/instructor'
        : role === 'TRAINEE'
          ? '/login/trainee'
          : '/login';
    return <Navigate to={to} replace state={{ from: location.pathname }} />;
  }
  if (role && user.role !== role) return <Navigate to={homePathFor(user.role)} replace />;
  return <Outlet />;
}

/** Gate for /login and /register: signed-in users go straight to their home page. */
export function GuestOnly() {
  const { t } = useTranslation();
  const { status, user } = useAuth();
  if (status === 'loading') {
    return (
      <Centered>
        <p role="status" className="text-muted-foreground">
          {t('common.loading')}
        </p>
      </Centered>
    );
  }
  if (user) return <Navigate to={homePathFor(user.role)} replace />;
  return <Outlet />;
}
