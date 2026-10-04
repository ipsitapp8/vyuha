import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { APP_NAME, loginBodySchema, type LoginBody } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { FormField } from '@/components/FormField';
import { LanguageToggle } from '@/components/LanguageToggle';
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
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>
      <form onSubmit={onSubmit} noValidate className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-center text-3xl font-semibold tracking-widest text-primary">
          {APP_NAME}
        </h1>
        <h2 className="text-center text-muted-foreground">{t('auth.signInTitle')}</h2>
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
          <p role="alert" className="text-sm text-red-400">
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
  );
}
