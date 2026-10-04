import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { loginBodySchema, type LoginBody } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { FormField } from '@/components/FormField';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { apiErrorText, validationText } from '@/lib/messages';

export function LoginPage() {
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
      const user = await login(values);
      navigate(homePathFor(user.role), { replace: true });
    } catch (err) {
      setSubmitError(apiErrorText(t, err));
    }
  });

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-md px-4 py-10">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex w-full flex-col gap-4 rounded border border-border bg-background p-6 shadow-sm"
        >
          <h1 className="border-b-2 border-saffron pb-2 text-2xl font-bold text-primary">
            {t('auth.signInTitle')}
          </h1>
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
          <p className="text-center text-sm text-muted-foreground">
            {t('auth.newTrainee')}{' '}
            <Link className="text-primary underline" to="/register">
              {t('auth.createAccount')}
            </Link>
          </p>
        </form>
      </main>
    </>
  );
}
