import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ScenarioSummary, SessionListResponse } from '@vyuha/shared';
import { ApiRequestError } from '@/lib/api';

const listScenarios = vi.fn();
const listSessions = vi.fn();
const createSession = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const real: Record<string, unknown> = await orig();
  return {
    ...real,
    api: {
      listScenarios: (...a: unknown[]) => listScenarios(...a),
      listSessions: (...a: unknown[]) => listSessions(...a),
      createSession: (...a: unknown[]) => createSession(...a),
    },
  };
});
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'i', name: 'Col', email: 'i@x.io', role: 'INSTRUCTOR' },
    status: 'ready',
    logout: vi.fn(),
  }),
}));

import { InstructorHome } from './InstructorHome';

const scenario: ScenarioSummary = {
  id: 'sc1',
  title: 'Op Silent Ridge',
  description: 'A blue platoon holds the valley.',
  areaBounds: { south: 34, west: 77, north: 35, east: 78 },
  seed: 26248,
  injectCount: 14,
  unitCount: 14,
};

type Row = SessionListResponse['sessions'][number];
const row = (n: number, status: Row['status'], playerCount = 3): Row => ({
  id: `s${n}`,
  code: `CODE${String(n).padStart(2, '0')}`,
  status,
  scenarioTitle: 'Op Silent Ridge',
  playerCount,
  createdAt: '2026-01-01T10:00:00.000Z',
  clean: false,
  baselineOfId: null,
});

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/instructor']}>
      <Routes>
        <Route path="/instructor" element={<InstructorHome />} />
        <Route path="/instructor/sessions/:id" element={<p>session page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listScenarios.mockReset().mockResolvedValue([scenario]);
  listSessions.mockReset().mockResolvedValue([]);
  createSession.mockReset();
});

describe('InstructorHome', () => {
  it('starts an exercise from the scenario card with one click', async () => {
    createSession.mockResolvedValue({ session: { id: 'new1' } });
    renderHome();
    await userEvent.click(await screen.findByRole('button', { name: 'Create exercise session' }));
    expect(createSession).toHaveBeenCalledWith('sc1');
    expect(await screen.findByText('session page')).toBeInTheDocument();
  });

  it('shows why creating a session failed and lets the instructor try again', async () => {
    createSession.mockRejectedValueOnce(new ApiRequestError('boom', 500, 'INTERNAL_ERROR'));
    renderHome();
    await userEvent.click(await screen.findByRole('button', { name: 'Create exercise session' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create exercise session' })).toBeEnabled();
  });

  it('lists sessions in a table with status, trainee count and the right actions', async () => {
    listSessions.mockResolvedValue([row(1, 'RUNNING', 1), row(2, 'ENDED'), row(3, 'LOBBY', 0)]);
    renderHome();
    const table = within(await screen.findByRole('table'));
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Scenario',
      'Code',
      'Status',
      'Trainees',
      'Actions',
    ]);
    const running = within(table.getByText('CODE01').closest('tr') as HTMLElement);
    expect(running.getByText('Running')).toBeInTheDocument();
    expect(running.getByText('1 trainee')).toBeInTheDocument(); // singular
    expect(running.queryByRole('link', { name: 'Review' })).not.toBeInTheDocument();
    const ended = within(table.getByText('CODE02').closest('tr') as HTMLElement);
    expect(ended.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/aar/s2');
    expect(ended.getByText('3 trainees')).toBeInTheDocument();
    expect(
      within(table.getByText('CODE03').closest('tr') as HTMLElement).getByText('0 trainees'),
    ).toBeInTheDocument();
  });

  it('shows the latest eight sessions and expands to all of them', async () => {
    listSessions.mockResolvedValue(Array.from({ length: 12 }, (_, i) => row(i + 1, 'ENDED')));
    renderHome();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
    const more = screen.getByRole('button', { name: 'Show all 12 sessions' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 12);
    await userEvent.click(screen.getByRole('button', { name: 'Show only the latest 8' }));
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 8);
  });

  it('shows no expand button for a short list, and an empty and an error state', async () => {
    listSessions.mockResolvedValue([row(1, 'ENDED')]);
    const { unmount } = renderHome();
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
    unmount();

    listSessions.mockResolvedValue([]);
    const second = renderHome();
    expect(await screen.findByText(/No sessions yet/)).toBeInTheDocument();
    second.unmount();

    listSessions.mockRejectedValue(new ApiRequestError('x', 500, 'INTERNAL_ERROR'));
    renderHome();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
