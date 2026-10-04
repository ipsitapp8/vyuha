import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { loginBodySchema, type LoginBody, type Role } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { AppHeader } from '@/components/AppHeader';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';
import { apiErrorText, validationText } from '@/lib/messages';

const OTHER_PORTAL: Record<Role, { role: Role; path: string }> = {
  INSTRUCTOR: { role: 'TRAINEE', path: '/login/trainee' },
  TRAINEE: { role: 'INSTRUCTOR', path: '/login/instructor' },
};

/**
 * Sign-in for one of the two portals. The portal is sent with the credentials, so the server refuses an
 * account of the other kind without signing it in.
 */
export function LoginPage({ portal }: { portal: Role }) {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginBody>({ resolver: zodResolver(loginBodySchema) });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const user = await login({ ...values, portal });
      navigate(homePathFor(user.role), { replace: true });
    } catch (err) {
      setSubmitError(
        err instanceof ApiRequestError && err.status === 403
          ? t(`auth.portal.${portal}.wrongAccount`)
          : apiErrorText(t, err),
      );
    }
  });

  const other = OTHER_PORTAL[portal];
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-md px-4 py-10">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex w-full flex-col gap-4 rounded border border-border bg-background p-6 shadow-sm"
        >
          <div>
            <h1 className="border-b-2 border-saffron pb-2 text-2xl font-bold text-primary">
              {t(`auth.portal.${portal}.title`)}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{t(`auth.portal.${portal}.intro`)}</p>
          </div>
          <FormField
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            error={validationText(t, errors.email?.message)}
            {...register('email')}
          />
          <FormField
            label={t('auth.password')}
            type="password"
            autoComplete="current-password"
            error={validationText(t, errors.password?.message)}
            {...register('password')}
          />
          {submitError ? (
            <p role="alert" className="text-sm text-red-700">
              {submitError}
            </p>
          ) : null}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('auth.signingIn') : t('auth.signInTitle')}
          </Button>
          {portal === 'TRAINEE' ? (
            <p className="text-center text-sm text-muted-foreground">
              {t('auth.newTrainee')}{' '}
              <Link className="text-primary underline" to="/register">
                {t('auth.createAccount')}
              </Link>
            </p>
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              {t('auth.portal.INSTRUCTOR.note')}
            </p>
          )}
          <p className="border-t border-border pt-3 text-center text-sm">
            {t(`auth.portal.${other.role}.switchPrompt`)}{' '}
            <Link className="text-primary underline" to={other.path}>
              {t(`auth.portal.${other.role}.cta`)}
            </Link>
          </p>
        </form>
      </main>
    </>
  );
}
