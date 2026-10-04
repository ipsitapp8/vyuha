import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { initI18n } from '@/i18n';
import { RouteErrorBoundary } from './ErrorBoundary';

function Bomb(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('shows a recoverable message instead of a blank page and clears on navigation', async () => {
    await initI18n('en');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={['/bad']}>
        <nav>
          <Link to="/ok">go ok</Link>
        </nav>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/bad" element={<Bomb />} />
            <Route path="/ok" element={<p>fine now</p>} />
          </Routes>
        </RouteErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke on this screen');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to start page' })).toHaveAttribute('href', '/');
    expect(spy).toHaveBeenCalledWith('UI render error', expect.any(Error), expect.any(String));

    await userEvent.click(screen.getByRole('link', { name: 'go ok' }));
    expect(screen.getByText('fine now')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
