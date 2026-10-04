import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import i18n from 'i18next';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches render errors so a bug in one screen shows a recoverable message, not a blank page. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert" className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">{i18n.t('errorBoundary.title')}</h1>
        <p className="mt-3 text-muted-foreground">{i18n.t('errorBoundary.body')}</p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={() => window.location.reload()}>{i18n.t('errorBoundary.reload')}</Button>
          <Button asChild variant="outline">
            <a href="/">{i18n.t('errorBoundary.home')}</a>
          </Button>
        </div>
      </main>
    );
  }
}

/** Boundary that clears itself when the user navigates to another route. */
export function RouteErrorBoundary({ children }: Props) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}
