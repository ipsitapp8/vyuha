import { Link } from 'react-router-dom';
import { APP_NAME } from '@vyuha/shared';

export function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-3xl font-semibold">{APP_NAME}</h1>
      <p className="text-muted-foreground">Sign-in arrives with the authentication phase.</p>
      <Link className="text-primary underline" to="/">
        Back to home
      </Link>
    </main>
  );
}
