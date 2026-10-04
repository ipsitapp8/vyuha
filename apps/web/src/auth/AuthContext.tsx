import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginBody, PublicUser, RegisterBody } from '@vyuha/shared';
import { api } from '@/lib/api';

type AuthStatus = 'loading' | 'ready' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  user: PublicUser | null;
  retry: () => void;
  login: (body: LoginBody) => Promise<PublicUser>;
  register: (body: RegisterBody) => Promise<PublicUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<PublicUser | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);

  const login = useCallback(async (body: LoginBody) => {
    const u = await api.login(body);
    setUser(u);
    return u;
  }, []);

  const register = useCallback(async (body: RegisterBody) => {
    const u = await api.register(body);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ status, user, retry, login, register, logout }),
    [status, user, retry, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
