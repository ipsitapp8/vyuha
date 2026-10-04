import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { registerBodySchema, type RegisterBody } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { FormField } from '@/components/FormField';
import { AppHeader } from '@/components/AppHeader';
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
    <>
      <AppHeader />
      <main className="mx-auto max-w-md px-4 py-10">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex w-full flex-col gap-4 rounded border border-border bg-background p-6 shadow-sm"
        >
          <h1 className="border-b-2 border-saffron pb-2 text-2xl font-bold text-primary">
            {t('auth.createTrainee')}
          </h1>
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
            <p role="alert" className="text-sm text-red-700">
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
    </>
  );
}
