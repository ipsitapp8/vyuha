import { cloneElement, isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ProgressResponse, ProgressSession } from '@vyuha/shared';
import { ApiRequestError } from '@/lib/api';

const getProgress = vi.fn();
const getProgressTrainees = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const real: Record<string, unknown> = await orig();
  return {
    ...real,
    api: {
      getProgress: (...a: unknown[]) => getProgress(...a),
      getProgressTrainees: (...a: unknown[]) => getProgressTrainees(...a),
    },
  };
});

let me = { id: 'u1', name: 'Asha', email: 'a@x.io', role: 'TRAINEE' as 'TRAINEE' | 'INSTRUCTOR' };
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ user: me, status: 'ready', logout: vi.fn() }),
}));

// jsdom has no layout, so give the charts a fixed size.
vi.mock('recharts', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    ResponsiveContainer: ({ children }: { children: ReactElement }) => (
      <div style={{ width: 600, height: 300 }}>
        {isValidElement(children)
          ? cloneElement(children as ReactElement<{ width: number; height: number }>, {
              width: 600,
              height: 300,
            })
          : children}
      </div>
    ),
  };
});

import { ProgressIndexPage, ProgressPage } from './ProgressPage';

const session = (n: number, over: Partial<ProgressSession['metrics']> = {}): ProgressSession => ({
  sessionId: `s${n}`,
  code: `CODE${n}`,
  scenarioTitle: 'Op Silent Ridge',
  endedAt: `2026-01-0${n}T10:00:00.000Z`,
  metrics: {
    avgDecisionLatencyMs: 30_000,
    latencyUnderJammingMs: 40_000,
    brierScore: 0.4,
    spoofsChallengedPct: 50,
    reportGradingAccuracy: 0.6,
    ...over,
  },
});

const progress = (sessions: ProgressSession[], isDemoBot = false): ProgressResponse => ({
  user: { id: 'u1', name: 'Asha', isDemoBot },
  sessions,
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/progress" element={<ProgressIndexPage />} />
        <Route path="/progress/:userId" element={<ProgressPage />} />
        <Route path="/trainee" element={<p>trainee home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  me = { id: 'u1', name: 'Asha', email: 'a@x.io', role: 'TRAINEE' };
  getProgress.mockReset();
  getProgressTrainees.mockReset();
  getProgressTrainees.mockResolvedValue({ trainees: [] });
});
afterEach(() => vi.clearAllMocks());

describe('ProgressPage', () => {
  it('shows "Need 2+ sessions for a trend" instead of empty charts with fewer than two sessions', async () => {
    getProgress.mockResolvedValue(progress([session(1)]));
    renderAt('/progress/u1');
    expect(await screen.findByText('Need 2+ sessions for a trend')).toBeInTheDocument();
    expect(screen.getByText('1 session so far')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Brier score/ })).not.toBeInTheDocument();
    expect(document.querySelector('svg.recharts-surface')).toBeNull();
  });

  it('also shows it for a trainee with no sessions at all', async () => {
    getProgress.mockResolvedValue(progress([]));
    renderAt('/progress/u1');
    expect(await screen.findByText('Need 2+ sessions for a trend')).toBeInTheDocument();
    expect(screen.getByText('0 sessions so far')).toBeInTheDocument();
  });

  it('shows the 3rd-vs-1st delay change, the Brier arrow, a chart per metric and the numbers', async () => {
    getProgress.mockResolvedValue(
      progress([
        session(1, { latencyUnderJammingMs: 40_000, brierScore: 0.6 }),
        session(2, { latencyUnderJammingMs: 35_000, brierScore: 0.4 }),
        session(3, { latencyUnderJammingMs: 30_000, brierScore: 0.2 }),
      ]),
    );
    renderAt('/progress/u1');

    const delay = await screen.findByRole('region', {
      name: 'Session 3 vs session 1: decision delay under jamming',
    });
    expect(within(delay).getByText('-25%')).toBeInTheDocument();
    expect(within(delay).getByText(/From 40 s to 30 s/)).toBeInTheDocument();

    const brier = screen.getByRole('region', { name: 'Brier score trend' });
    expect(within(brier).getByText('improving')).toBeInTheDocument();
    expect(within(brier).getByText('↓')).toBeInTheDocument();
    expect(within(brier).getByText(/Latest 0\.20, average 0\.40/)).toBeInTheDocument();

    for (const title of [
      'Average decision latency (s)',
      'Decision latency under jamming (s)',
      'Brier score (lower is better)',
      'Fake orders challenged (%)',
      'Report grading accuracy (%)',
    ]) {
      const chart = screen.getAllByRole('region', { name: title })[0] as HTMLElement;
      expect(chart.querySelector('svg.recharts-surface')).not.toBeNull();
    }

    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 sessions
    expect(within(table).getByText('2026-01-03')).toBeInTheDocument();
  });

  it('compares the latest with the 1st when there are only two sessions, and says when it cannot', async () => {
    getProgress.mockResolvedValue(
      progress([
        session(1, { latencyUnderJammingMs: 50_000 }),
        session(2, { latencyUnderJammingMs: 25_000 }),
      ]),
    );
    renderAt('/progress/u1');
    expect(
      await screen.findByRole('region', {
        name: 'Session 2 vs session 1: decision delay under jamming',
      }),
    ).toHaveTextContent('-50%');
  });

  it('explains a missing comparison and charts with no data', async () => {
    getProgress.mockResolvedValue(
      progress([
        session(1, { latencyUnderJammingMs: null, brierScore: null }),
        session(2, { latencyUnderJammingMs: null, brierScore: null }),
      ]),
    );
    renderAt('/progress/u1');
    expect(
      await screen.findByText(/No decisions under jamming in one of these sessions/),
    ).toBeInTheDocument();
    expect(screen.getByText('Not enough scored decisions to show a trend.')).toBeInTheDocument();
    expect(screen.getAllByText('Not measurable in these sessions.').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('marks a demo bot next to the name', async () => {
    getProgress.mockResolvedValue(progress([session(1), session(2)], true));
    renderAt('/progress/u1');
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Progress of Asha');
    expect(within(heading).getByText('Demo bot')).toBeInTheDocument();
  });

  it('shows the server refusal and lets the user retry', async () => {
    getProgress.mockRejectedValueOnce(new ApiRequestError('no', 403, 'FORBIDDEN'));
    renderAt('/progress/u1');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    getProgress.mockResolvedValue(progress([session(1), session(2)]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('lets an instructor switch trainee and marks demo bots in the list', async () => {
    me = { id: 'i1', name: 'Col', email: 'i@x.io', role: 'INSTRUCTOR' };
    getProgressTrainees.mockResolvedValue({
      trainees: [
        { id: 'u1', name: 'Asha', isDemoBot: false, sessionCount: 3 },
        { id: 'b1', name: 'Bot One', isDemoBot: true, sessionCount: 3 },
      ],
    });
    getProgress.mockResolvedValue(progress([session(1), session(2)]));
    renderAt('/progress/u1');
    const select = await screen.findByRole('combobox', { name: 'Trainee' });
    expect(within(select).getByRole('option', { name: 'Bot One (Demo bot)' })).toBeInTheDocument();

    getProgress.mockResolvedValue({
      user: { id: 'b1', name: 'Bot One', isDemoBot: true },
      sessions: [session(1), session(2)],
    });
    await userEvent.selectOptions(select, 'b1');
    await waitFor(() => expect(getProgress).toHaveBeenLastCalledWith('b1'));
    expect(await screen.findByText('Progress of Bot One')).toBeInTheDocument();
  });
});

describe('ProgressIndexPage', () => {
  it('sends a trainee straight to their own progress', async () => {
    getProgress.mockResolvedValue(progress([session(1), session(2)]));
    renderAt('/progress');
    await waitFor(() => expect(getProgress).toHaveBeenCalledWith('u1'));
    expect(getProgressTrainees).not.toHaveBeenCalled();
  });

  it('lists every trainee for an instructor, with the demo bot marked', async () => {
    me = { id: 'i1', name: 'Col', email: 'i@x.io', role: 'INSTRUCTOR' };
    getProgressTrainees.mockResolvedValue({
      trainees: [
        { id: 'u1', name: 'Asha', isDemoBot: false, sessionCount: 1 },
        { id: 'b1', name: 'Bot One', isDemoBot: true, sessionCount: 3 },
      ],
    });
    renderAt('/progress');
    await screen.findByText('Bot One');
    const rows = within(screen.getByRole('main')).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText('Demo bot')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByText('Demo bot')).not.toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('3 sessions so far')).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'View progress' }),
    ).toHaveAttribute('href', '/progress/u1');
  });

  it('shows an empty state and an error state', async () => {
    me = { id: 'i1', name: 'Col', email: 'i@x.io', role: 'INSTRUCTOR' };
    getProgressTrainees.mockResolvedValueOnce({ trainees: [] });
    renderAt('/progress');
    expect(await screen.findByText('No trainees yet.')).toBeInTheDocument();

    getProgressTrainees.mockRejectedValueOnce(new ApiRequestError('x', 500, 'INTERNAL_ERROR'));
    renderAt('/progress');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
