import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { APP_NAME, registerBodySchema, type RegisterBody } from '@vyuha/shared';
import { useAuth } from '@/auth/AuthContext';
import { homePathFor } from '@/auth/guards';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/lib/api';

export function RegisterPage() {
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
      setSubmitError(
        err instanceof ApiRequestError ? err.message : 'Something went wrong. Try again.',
      );
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} noValidate className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-center text-3xl font-semibold tracking-widest text-primary">
          {APP_NAME}
        </h1>
        <h2 className="text-center text-muted-foreground">Create a trainee account</h2>
        <FormField
          label="Full name"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          {...register('password')}
        />
        {submitError ? (
          <p role="alert" className="text-sm text-red-400">
            {submitError}
          </p>
        ) : null}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already registered?{' '}
          <Link className="text-primary underline" to="/login">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
