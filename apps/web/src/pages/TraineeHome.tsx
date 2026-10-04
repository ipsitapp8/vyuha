import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { joinSessionBodySchema, type JoinSessionBody } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import { api, ApiRequestError } from '@/lib/api';

export function TraineeHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<JoinSessionBody>({ resolver: zodResolver(joinSessionBodySchema) });

  const onSubmit = handleSubmit(async ({ code }) => {
    setSubmitError(null);
    try {
      const joined = await api.joinSession(code);
      navigate(`/session/${joined.code}`);
    } catch (err) {
      setSubmitError(err instanceof ApiRequestError ? err.message : 'Could not join. Try again.');
    }
  });

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-md px-4 py-6">
        <h1 className="mb-1 text-2xl font-semibold">Welcome, {user?.name}</h1>
        <p className="mb-6 text-muted-foreground">
          Enter the 6-character code your instructor gave you.
        </p>
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-4 rounded-lg border border-border bg-secondary p-4"
        >
          <FormField
            label="Session code"
            autoComplete="off"
            maxLength={6}
            className="h-12 rounded-md border border-border bg-background px-3 text-center font-mono text-2xl uppercase tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            error={errors.code?.message}
            {...register('code')}
          />
          {submitError ? (
            <p role="alert" className="text-sm text-red-400">
              {submitError}
            </p>
          ) : null}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Joining…' : 'Join exercise'}
          </Button>
        </form>
      </main>
    </>
  );
}
