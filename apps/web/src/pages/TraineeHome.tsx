import { AppHeader } from '@/components/AppHeader';
import { useAuth } from '@/auth/AuthContext';

export function TraineeHome() {
  const { user } = useAuth();
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-semibold">Welcome, {user?.name}</h1>
        <p className="mb-6 text-muted-foreground">Trainee home</p>
        <section className="rounded-lg border border-border bg-secondary p-4">
          <h2 className="font-semibold">Active exercises</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            You have not joined any exercise. Your instructor will give you a 6-character session
            code when an exercise opens.
          </p>
        </section>
      </main>
    </>
  );
}
