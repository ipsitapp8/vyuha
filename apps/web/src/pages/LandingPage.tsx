import { Link } from 'react-router-dom';
import { APP_NAME, APP_TAGLINE } from '@vyuha/shared';
import { Button } from '@/components/ui/button';

export function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-5xl font-bold tracking-[0.3em] text-primary sm:text-7xl">{APP_NAME}</h1>
      <p className="max-w-xl text-lg text-muted-foreground">{APP_TAGLINE}</p>
      <Button asChild size="lg">
        <Link to="/login">Login</Link>
      </Button>
    </main>
  );
}
