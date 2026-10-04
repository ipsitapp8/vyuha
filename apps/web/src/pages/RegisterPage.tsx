import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { APP_NAME, registerBodySchema, type RegisterBody } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { FormField } from '@/components/FormField';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';
import { apiErrorText, validationText } from '@/lib/messages';

export function RegisterPage() {
  const { t } = useTranslation();
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterBody>({ resolver: zodResolver(registerBodySchema) });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const user = await registerUser(values);
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
        <h2 className="text-center text-muted-foreground">{t('auth.createTrainee')}</h2>
        <FormField
          label={t('auth.fullName')}
          autoComplete="name"
          error={validationText(t, errors.name?.message)}
          {...register('name')}
        />
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
          autoComplete="new-password"
          error={validationText(t, errors.password?.message)}
          {...register('password')}
        />
        {submitError ? (
          <p role="alert" className="text-sm text-red-400">
            {submitError}
          </p>
        ) : null}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t('auth.creating') : t('auth.createAccount')}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.alreadyRegistered')}{' '}
          <Link className="text-primary underline" to="/login">
            {t('auth.signInLink')}
          </Link>
        </p>
      </form>
    </main>
  );
}
