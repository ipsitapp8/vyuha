import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AarCompare } from '@vyuha/shared';
import { aarSummary } from './fixtures';
import { compareMetrics, decisionMarks, driftRows, latencyRows } from './compareData';

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
vi.mock('@/instructor/TruthMap', () => ({ TruthMap: () => <div data-testid="truth-map" /> }));
vi.mock('@/cockpit/CockpitMap', () => ({ CockpitMap: () => <div data-testid="perceived-map" /> }));
const getAar = vi.fn();
const getAarCompare = vi.fn();
const createBaseline = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    api: {
      getAar: (...a: unknown[]) => getAar(...a),
      getAarCompare: (...a: unknown[]) => getAarCompare(...a),
      createBaseline: (...a: unknown[]) => createBaseline(...a),
      getAarSnapshot: vi.fn(async () => {
        throw new Error('not used');
      }),
      aarExportUrl: (id: string, kind: string) => `http://api.test/aar/${id}/export.${kind}`,
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

import { AarPage } from '@/pages/AarPage';
import { BaselineCompare } from './BaselineCompare';

const decision = (
  id: string,
  playerId: string,
  tick: number,
  latency: number | null,
  outcome: 0 | 1 | null,
) => ({
  id,
  playerId,
  tick,
  actionType: 'REPORT_UP',
  confidence: 70,
  rationale: 'because',
  targetContactId: null,
  basedOnMessageId: null,
  outcome,
  latencyTicks: latency,
  spoofActed: false,
});
const point = (tick: number, err: number) => ({
  tick,
  missed: 1,
  ghost: 0,
  avgPositionErrorM: err,
  friendlyAvgErrorM: 0,
});
const cmp: AarCompare = {
  scenarioTitle: 'Op Silent Ridge',
  degraded: {
    sessionId: 's1',
    code: 'DEG234',
    durationTicks: 600,
    decisions: [
      decision('d1', 'pd', 150, 60, 0),
      decision('d2', 'pd', 450, 40, 1),
      decision('dx', 'other', 100, 5, 1),
    ],
    drift: { pd: [point(10, 900), point(20, 1100)] },
    players: [
      {
        playerId: 'pd',
        userId: 'u1',
        name: 'Asha',
        decisionCount: 2,
        avgLatencyTicks: 50,
        accuracy: 50,
        brierScore: 0.3,
        meanPositionErrorM: 1000,
        meanMissed: 2,
      },
    ],
  },
  baseline: {
    sessionId: 's2',
    code: 'BAS234',
    durationTicks: 300,
    decisions: [decision('b1', 'pb', 150, 12, 1)],
    drift: { pb: [point(10, 200), point(30, 250)] },
    players: [
      {
        playerId: 'pb',
        userId: 'u1',
        name: 'Asha',
        decisionCount: 1,
        avgLatencyTicks: 12,
        accuracy: 100,
        brierScore: null,
        meanPositionErrorM: 225,
        meanMissed: 0.5,
      },
    ],
  },
  trainees: [{ userId: 'u1', name: 'Asha', degradedPlayerId: 'pd', baselinePlayerId: 'pb' }],
};
const asha = cmp.trainees[0]!;

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getAar.mockReset();
  getAarCompare.mockReset().mockResolvedValue(cmp);
  createBaseline.mockReset();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

describe('comparison data', () => {
  it('puts the two runs side by side per measure, with the cost of degradation', () => {
    const rows = Object.fromEntries(compareMetrics(cmp, asha).map((r) => [r.key, r]));
    expect(rows['latency']).toMatchObject({
      degraded: 50,
      baseline: 12,
      delta: 38,
      lowerIsBetter: true,
    });
    expect(rows['accuracy']).toMatchObject({
      degraded: 50,
      baseline: 100,
      delta: -50,
      lowerIsBetter: false,
    });
    expect(rows['positionError']?.delta).toBe(775);
    // a measure missing on one side has no difference
    expect(rows['brier']).toMatchObject({ degraded: 0.3, baseline: null, delta: null });
  });

  it('places each run’s decisions along its own length, in time order, for that trainee only', () => {
    expect(decisionMarks(cmp.degraded, 'pd').map((m) => [m.id, m.percent])).toEqual([
      ['d1', 25],
      ['d2', 75],
    ]);
    expect(decisionMarks(cmp.baseline, 'pb').map((m) => m.percent)).toEqual([50]);
  });

  it('pairs latency by decision number and drift by time', () => {
    expect(latencyRows(cmp, asha)).toEqual([
      { n: 1, degraded: 60, baseline: 12 },
      { n: 2, degraded: 40, baseline: null },
    ]);
    expect(driftRows(cmp, asha)).toEqual([
      { tick: 10, degraded: 900, baseline: 200 },
      { tick: 20, degraded: 1100, baseline: null },
      { tick: 30, degraded: null, baseline: 250 },
    ]);
  });
});

describe('BaselineCompare', () => {
  it('shows the table, both decision timelines and both charts', async () => {
    render(<BaselineCompare sessionId="s1" />);
    const section = await screen.findByRole('region', {
      name: 'Degraded run against clean baseline',
    });
    const latency = await within(section).findByRole('row', { name: /Average decision latency/ });
    expect(
      within(latency)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['50', '12', '+38']);
    expect(
      within(section).getByRole('img', { name: 'Degraded run: 2 decisions along the exercise' }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('img', { name: 'Baseline run: 1 decisions along the exercise' }),
    ).toBeInTheDocument();
    expect(within(section).getByText(/after 60 s/)).toBeInTheDocument();
    expect(section.querySelectorAll('.recharts-bar')).toHaveLength(2);
    expect(section.querySelectorAll('.recharts-line')).toHaveLength(2);
    expect(getAarCompare).toHaveBeenCalledWith('s1');
  });

  it('says so when nobody played both runs, and offers a retry when loading fails', async () => {
    const user = userEvent.setup();
    getAarCompare.mockRejectedValueOnce(new Error('offline'));
    getAarCompare.mockResolvedValue({ ...cmp, trainees: [] });
    render(<BaselineCompare sessionId="s1" />);
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No trainee played both runs/)).toBeInTheDocument();
  });
});

describe('AAR page: baseline', () => {
  const renderPage = () =>
    render(
      <MemoryRouter initialEntries={['/aar/s1']}>
        <Routes>
          <Route path="/aar/:sessionId" element={<AarPage />} />
          <Route path="/instructor/sessions/:id" element={<p>lobby of the twin</p>} />
        </Routes>
      </MemoryRouter>,
    );
  const lobbyOf = (id: string) => ({ session: { id } });

  it('offers to create a baseline, then opens the new session', async () => {
    const user = userEvent.setup();
    getAar.mockResolvedValue(aarSummary());
    createBaseline.mockResolvedValue(lobbyOf('twin-1'));
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Create baseline run' }));
    expect(createBaseline).toHaveBeenCalledWith('s1');
    expect(await screen.findByText('lobby of the twin')).toBeInTheDocument();
  });

  it('links to a baseline that is set up but not played, without a comparison yet', async () => {
    const s = aarSummary();
    s.meta.twin = { sessionId: 's2', code: 'BAS234', status: 'LOBBY' };
    getAar.mockResolvedValue(s);
    renderPage();
    expect(await screen.findByText(/A baseline run \(BAS234\) is set up/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the baseline session' })).toHaveAttribute(
      'href',
      '/instructor/sessions/s2',
    );
    expect(screen.queryByRole('button', { name: 'Create baseline run' })).toBeNull();
    expect(getAarCompare).not.toHaveBeenCalled();
  });

  it('shows the comparison once the baseline has been played', async () => {
    const s = aarSummary();
    s.meta.twin = { sessionId: 's2', code: 'BAS234', status: 'ENDED' };
    getAar.mockResolvedValue(s);
    renderPage();
    expect(
      await screen.findByRole('region', { name: 'Degraded run against clean baseline' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('row', { name: /Average decision latency/ }),
    ).toBeInTheDocument();
  });

  it('marks a baseline run as one and links back to the degraded run', async () => {
    const s = aarSummary();
    s.meta.clean = true;
    s.meta.baselineOfId = 's0';
    s.meta.twin = { sessionId: 's0', code: 'DEG234', status: 'ENDED' };
    getAar.mockResolvedValue(s);
    renderPage();
    expect(await screen.findByText('Baseline run')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the degraded run DEG234' })).toHaveAttribute(
      'href',
      '/aar/s0',
    );
  });
});
