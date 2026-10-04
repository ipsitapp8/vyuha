import { useCallback, useEffect, useState } from 'react';
import type { ScenarioSummary } from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { api, ApiRequestError } from '@/lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; scenarios: ScenarioSummary[] };

export function InstructorHome() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const fetchScenarios = useCallback(() => {
    api
      .listScenarios()
      .then((scenarios) => setState({ kind: 'ready', scenarios }))
      .catch((err: unknown) =>
        setState({
          kind: 'error',
          message: err instanceof ApiRequestError ? err.message : 'Could not load scenarios.',
        }),
      );
  }, []);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    fetchScenarios();
  }, [fetchScenarios]);

  useEffect(fetchScenarios, [fetchScenarios]);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-6">
        <h1 className="mb-1 text-2xl font-semibold">Instructor home</h1>
        <p className="mb-6 text-muted-foreground">Scenarios available for exercises.</p>

        {state.kind === 'loading' ? <p role="status">Loading scenarios…</p> : null}
        {state.kind === 'error' ? (
          <div role="alert" className="flex items-center gap-3 text-red-400">
            <span>{state.message}</span>
            <Button variant="outline" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : null}
        {state.kind === 'ready' && state.scenarios.length === 0 ? (
          <p className="text-muted-foreground">
            No scenarios yet. Run `pnpm db:seed` to load the demo scenario.
          </p>
        ) : null}
        {state.kind === 'ready' ? (
          <ul className="grid gap-4 sm:grid-cols-2">
            {state.scenarios.map((s) => (
              <li key={s.id} className="rounded-lg border border-border bg-secondary p-4">
                <h2 className="text-lg font-semibold">{s.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{s.description}</p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Units</dt>
                    <dd>{s.unitCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Injects</dt>
                    <dd>{s.injectCount}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Seed</dt>
                    <dd>{s.seed}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  Area {s.areaBounds.south.toFixed(2)}°N–{s.areaBounds.north.toFixed(2)}°N,{' '}
                  {s.areaBounds.west.toFixed(2)}°E–{s.areaBounds.east.toFixed(2)}°E
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </>
  );
}
