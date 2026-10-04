import { Navigate, Outlet, useLocation } from 'react-router-dom';
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

/** Gate: renders children only for signed-in users with an allowed role. */
export function RequireRole({ role }: { role: Role }) {
  const { status, user, retry } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <Centered>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </Centered>
    );
  }
  if (status === 'error') {
    return (
      <Centered>
        <p role="alert" className="text-red-400">
          Could not reach the VYUHA server.
        </p>
        <Button onClick={retry}>Retry</Button>
      </Centered>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.role !== role) return <Navigate to={homePathFor(user.role)} replace />;
  return <Outlet />;
}

/** Gate for /login and /register: signed-in users go straight to their home page. */
export function GuestOnly() {
  const { status, user } = useAuth();
  if (status === 'loading') {
    return (
      <Centered>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </Centered>
    );
  }
  if (user) return <Navigate to={homePathFor(user.role)} replace />;
  return <Outlet />;
}
