import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement, type ReactElement } from 'react';
import { LEARNING_TEXT_EN, learningTextEn } from '@vyuha/shared';
import en from '@/i18n/en.json';
import { setLanguage } from '@/i18n';
import { i18n } from '@/i18n';
import { aarDecisionDetail, aarSnapshot, aarSummary } from './fixtures';
import {
  calibrationChart,
  channelChart,
  driftChart,
  flowGraph,
  latencyChart,
  lossColor,
} from './chartData';

// jsdom has no layout: give charts a fixed size, and replace the WebGL maps with stubs.
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
vi.mock('@/instructor/TruthMap', () => ({
  TruthMap: (p: { truth: { units: unknown[] }; watched: { playerId: string } | null }) => (
    <div
      data-testid="truth-map"
      data-units={p.truth.units.length}
      data-watched={p.watched?.playerId ?? ''}
    />
  ),
}));
vi.mock('@/cockpit/CockpitMap', () => ({
  CockpitMap: (p: { perceived: { playerId: string; tick: number } }) => (
    <div
      data-testid="perceived-map"
      data-player={p.perceived.playerId}
      data-tick={p.perceived.tick}
    />
  ),
}));
const getAar = vi.fn();
const getAarSnapshot = vi.fn();
const getAarDecision = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    api: {
      getAar: (...a: unknown[]) => getAar(...a),
      getAarSnapshot: (...a: unknown[]) => getAarSnapshot(...a),
      getAarDecision: (...a: unknown[]) => getAarDecision(...a),
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

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiRequestError } from '@/lib/api';
import { AarPage } from '@/pages/AarPage';
import { AarCharts } from './AarCharts';
import { FlowGraph } from './FlowGraph';
import { GhostReplay } from './GhostReplay';
import { KeyEvents, LearningList, learningText, timelineText } from './LearningPoints';

const t = i18n.t.bind(i18n);
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getAar.mockReset().mockResolvedValue(aarSummary());
  getAarSnapshot
    .mockReset()
    .mockImplementation(async (_id: string, tick: number, pid: string | null) =>
      aarSnapshot(tick, pid),
    );
  getAarDecision
    .mockReset()
    .mockImplementation(async (_s: string, id: string) => aarDecisionDetail(id));
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

describe('chart data', () => {
  const s = aarSummary();

  it('drift: one row per sample tick with a column per trainee', () => {
    const d = driftChart(s);
    expect(d.series.map((x) => x.name)).toEqual(['Asha', 'Bilal']);
    expect(d.rows).toEqual([
      { tick: 10, 'p:p1': 300, 'p:p2': 900 },
      { tick: 20, 'p:p1': 200 },
    ]);
  });

  it('latency: a bar per decision that has a latency, numbered by decision order', () => {
    expect(latencyChart(s).map((b) => [b.n, b.name, b.seconds])).toEqual([
      [1, 'Asha', 12],
      [2, 'Bilal', 40],
    ]);
  });

  it('calibration: stated confidence against actual correctness', () => {
    expect(calibrationChart(s)).toEqual([
      { confidence: 93, accuracy: 50, count: 2 },
      { confidence: 50, accuracy: 100, count: 1 },
    ]);
  });

  it('channels: usage summed and jamming as percent; long exercises are resampled to at most N rows', () => {
    const rows = channelChart(s, 60);
    expect(rows[1]).toMatchObject({ tick: 10, VHF: 2, HF: 1, jamVHF: 80 });
    const many = aarSummary();
    many.analysis.channels = Array.from({ length: 300 }, (_, i) => ({
      tick: i * 10,
      usage: { VHF: 1, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
      jamming: { VHF: 0.5, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
      satcomUp: true,
    }));
    const resampled = channelChart(many, 60);
    expect(resampled.length).toBeLessThanOrEqual(60);
    expect(resampled.reduce((a, r) => a + r.VHF, 0)).toBe(300);
  });

  it('flow graph: players on a circle, unmanned senders added, links merged per channel with loss share', () => {
    const g = flowGraph(s, 'ALL', 380, (id) => `unit ${id}`);
    expect(g.nodes.map((n) => n.label)).toEqual(['Asha', 'Bilal', 'unit b-hq']);
    expect(g.nodes[2]?.unmanned).toBe(true);
    expect(g.links).toHaveLength(3);
    const vhf = g.links.find((l) => l.from === 'p1' && l.channel === 'VHF');
    expect(vhf).toMatchObject({ total: 4, lost: 2, lostShare: 0.5 });
    expect(flowGraph(s, 'TEXT').links).toHaveLength(2);
    expect(flowGraph(s, 'TEXT').nodes).toHaveLength(2);
  });

  it('loss colour runs from green to red', () => {
    expect(lossColor(0)).toBe('rgb(74,222,128)');
    expect(lossColor(1)).toBe('rgb(239,68,68)');
    expect(lossColor(5)).toBe(lossColor(1));
  });
});

describe('learning points wording', () => {
  it('the on-screen English equals the shared template that the PDF uses, for every rule', () => {
    const rules = en.aar.learning.rules as Record<string, string>;
    expect(Object.keys(rules).sort()).toEqual(Object.keys(LEARNING_TEXT_EN).sort());
    for (const [rule, template] of Object.entries(LEARNING_TEXT_EN))
      expect(rules[rule]).toBe(template);
  });

  it('renders each point with the trainee, severity and parameters, in English and Hindi', () => {
    render(<LearningList summary={aarSummary()} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute('data-severity', 'warn');
    expect(items[0]).toHaveTextContent(
      'Bilal: Acted on an order that had not been authenticated and was spoofed, 1 time(s).',
    );
    expect(items[1]).toHaveTextContent(
      'Team Alpha did not switch away from heavily jammed VHF for 200 s.',
    );
    expect(items[2]).toHaveAttribute('data-severity', 'good');
    cleanup();
    setLanguage('hi');
    render(<LearningList summary={aarSummary()} />);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(
      'बिना प्रमाणित किए नकली आदेश पर 1 बार कार्रवाई की।',
    );
    setLanguage('en');
  });

  it('falls back to the shared English text for a rule the locale does not know', () => {
    const p = {
      rule: 'FUTURE_RULE',
      severity: 'info' as const,
      playerId: null,
      teamId: null,
      params: {},
    };
    expect(learningText(t, p)).toBe(learningTextEn(p));
  });

  it('shows an empty state', () => {
    const s = aarSummary();
    s.analysis.learning = [];
    render(<LearningList summary={s} />);
    expect(screen.getByText('No notable observations.')).toBeInTheDocument();
  });

  it('key events read as sentences with names and times', () => {
    render(<KeyEvents summary={aarSummary()} />);
    for (const text of [
      'Inject fired: Light VHF jamming begins',
      'Spoofed order delivered to Bilal: "Withdraw now"',
      'Bilal authentication result: FAILED',
      'Asha switched the team channel VHF → HF',
      'Bilal decided Comply with order at 95% (wrong)',
      'Jamming changed: heaviest on VHF at 80%',
    ]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    const names = (id: string | null): string => (id === null ? 'Exercise control' : id);
    expect(
      timelineText(
        t,
        { tick: 1, kind: 'INJECT', playerId: null, params: { title: 'X', source: 'LIVE' } },
        names,
      ),
    ).toBe('Live inject fired: X');
  });
});

describe('AarCharts', () => {
  it('draws the four review charts with titles, legends and axes', () => {
    const { container } = render(<AarCharts summary={aarSummary()} />);
    for (const name of [
      'Picture drift over time',
      'Decision latency per decision',
      'Confidence calibration',
      'Channel usage vs jamming',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(container.querySelectorAll('.recharts-wrapper').length).toBe(4);
    expect(screen.getByText('Asha')).toBeInTheDocument();
    expect(screen.getByText('Perfect calibration')).toBeInTheDocument();
    expect(screen.getByText('VHF jamming %')).toBeInTheDocument();
  });

  it('shows "not enough data" instead of an empty chart', () => {
    const s = aarSummary();
    s.decisions = [];
    s.analysis.drift = {};
    s.analysis.calibration.overall = [];
    s.analysis.channels = [];
    render(<AarCharts summary={s} />);
    expect(screen.getAllByText('Not enough data yet.')).toHaveLength(4);
  });
});

describe('FlowGraph', () => {
  it('shows who sent what to whom, and what was lost; the filter adds relays and beacons', async () => {
    render(<FlowGraph summary={aarSummary()} />);
    expect(screen.getByRole('img', { name: /who sent messages to whom/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('flow-link')).toHaveLength(2);
    const rows = screen.getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Asha')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('50%'); // 2 of 4 lost on VHF
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'ALL');
    expect(screen.getAllByTestId('flow-link')).toHaveLength(3);
    expect(screen.getAllByText('Unmanned unit b-hq').length).toBeGreaterThan(0);
  });

  it('has an empty state', () => {
    const s = aarSummary();
    s.analysis.flow = [];
    render(<FlowGraph summary={s} />);
    expect(screen.getByText('No messages in this view.')).toBeInTheDocument();
  });
});

describe('GhostReplay', () => {
  it('loads the first moment for the first trainee, with truth and perception side by side', async () => {
    render(<GhostReplay summary={aarSummary()} />);
    await waitFor(() => expect(screen.getByTestId('truth-map')).toBeInTheDocument());
    expect(getAarSnapshot).toHaveBeenCalledWith('s1', 0, 'p1');
    expect(screen.getByTestId('perceived-map')).toHaveAttribute('data-player', 'p1');
    expect(screen.getByTestId('truth-map')).toHaveAttribute('data-units', '2');
    expect(screen.getByTestId('truth-map')).toHaveAttribute('data-watched', 'p1');
    expect(screen.getByRole('timer')).toHaveTextContent('00:00 / 10:00');
  });

  it('scrubbing fetches that exact moment (and shows the jamming that was in force)', async () => {
    render(<GhostReplay summary={aarSummary()} />);
    await screen.findByTestId('truth-map');
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '330' } });
    await waitFor(() => expect(getAarSnapshot).toHaveBeenCalledWith('s1', 330, 'p1'));
    await waitFor(() =>
      expect(screen.getByTestId('perceived-map')).toHaveAttribute('data-tick', '330'),
    );
    expect(await screen.findByText(/Jamming now: VHF 80%/)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('05:30 / 10:00');
  });

  it('switching trainee refetches for that trainee', async () => {
    render(<GhostReplay summary={aarSummary()} />);
    await screen.findByTestId('truth-map');
    await userEvent.selectOptions(screen.getByLabelText('Trainee'), 'p2');
    await waitFor(() => expect(getAarSnapshot).toHaveBeenCalledWith('s1', 0, 'p2'));
    expect(await screen.findByText('What Bilal saw')).toBeInTheDocument();
  });

  it('decision markers (colour-coded by result) jump to that moment and open rationale, confidence and both snapshots', async () => {
    render(<GhostReplay summary={aarSummary()} />);
    await screen.findByTestId('truth-map');
    const markers = within(screen.getByRole('group', { name: /Decisions/ })).getAllByRole('button');
    expect(markers).toHaveLength(3);
    await userEvent.click(
      screen.getByRole('button', { name: /05:00 · Bilal · Comply with order · wrong/ }),
    );
    await waitFor(() => expect(getAarSnapshot).toHaveBeenCalledWith('s1', 300, 'p2'));
    const panel = await screen.findByRole('region', { name: 'Decision' });
    expect(within(panel).getByText('“It came from HQ”')).toBeInTheDocument();
    expect(within(panel).getByText('95%')).toBeInTheDocument();
    expect(within(panel).getByText('wrong')).toBeInTheDocument();
    expect(within(panel).getByText('Acted on an unverified, spoofed order.')).toBeInTheDocument();
    expect(await within(panel).findByText('What they saw')).toBeInTheDocument();
    expect(within(panel).getByText(/Recce party · seen 20s ago/)).toBeInTheDocument();
    expect(within(panel).getByText('What was true')).toBeInTheDocument();
    expect(
      within(panel).getByText(/Recce party at 34.2000, 77.2000 \(ACTIVE\)/),
    ).toBeInTheDocument();
    expect(getAarDecision).toHaveBeenCalledWith('s1', 'd2');
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Decision' })).toBeNull();
  });

  it('plays forward through the exercise and stops at the end', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = aarSummary();
    s.meta.durationTicks = 12;
    render(<GhostReplay summary={s} />);
    await screen.findByTestId('truth-map');
    await userEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent('00:12 / 00:12');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument(); // stopped by itself
  });

  it('shows an error if a moment cannot be loaded, and a decision-detail error', async () => {
    getAarSnapshot.mockRejectedValueOnce(new ApiRequestError('x', 500, 'INTERNAL_ERROR'));
    render(<GhostReplay summary={aarSummary()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server error. Try again.',
    );
    getAarDecision.mockRejectedValueOnce(new ApiRequestError('x', 404, 'NOT_FOUND'));
    await userEvent.click(screen.getByRole('button', { name: /02:00 · Asha/ }));
    expect(await screen.findByText('Not found.')).toBeInTheDocument();
  });

  it('copes with an exercise that had no decisions', async () => {
    const s = aarSummary();
    s.decisions = [];
    render(<GhostReplay summary={s} />);
    expect(await screen.findByText('No decisions were recorded.')).toBeInTheDocument();
  });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/aar/s1']}>
      <Routes>
        <Route path="/aar/:sessionId" element={<AarPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AarPage', () => {
  it('shows loading, then the whole review, with working export links', async () => {
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the review…');
    expect(await screen.findByRole('heading', { name: 'After Action Review' })).toBeInTheDocument();
    expect(
      screen.getByText(/Op Silent Ridge · Code ABC234 · 10:00 long · 2 trainees/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download PDF report/ })).toHaveAttribute(
      'href',
      'http://api.test/aar/s1/export.pdf',
    );
    expect(screen.getByRole('link', { name: /Download decisions \(CSV\)/ })).toHaveAttribute(
      'href',
      'http://api.test/aar/s1/export.csv',
    );
    expect(screen.getByRole('link', { name: /Download event log \(JSON\)/ })).toHaveAttribute(
      'href',
      'http://api.test/aar/s1/export.json',
    );
    for (const link of screen.getAllByRole('link', { name: /Download/ }))
      expect(link).toHaveAttribute('download');
    const table = within(screen.getByRole('region', { name: 'Trainee summary' }));
    expect(table.getByText('Bilal').closest('tr')).toHaveTextContent('95%');
    // spoofs challenged: Bilal received one fake order and challenged it; Asha was never sent one
    expect(table.getByRole('columnheader', { name: 'Challenged' })).toBeInTheDocument();
    expect(table.getByText('Bilal').closest('tr')).toHaveTextContent('100% (1/1)');
    expect(table.getByText('Asha').closest('tr')).not.toHaveTextContent('(0/0)');
    for (const name of [
      'Key learning points',
      'Ghost replay',
      'Picture drift over time',
      'Team message flow',
      'Key events',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('shows the server reason when the review is not available yet, and can retry', async () => {
    getAar.mockRejectedValueOnce(
      new ApiRequestError(
        'The review is available once the exercise has ended',
        409,
        'SESSION_STATE',
      ),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That exercise has already started or ended.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'After Action Review' })).toBeInTheDocument();
  });

  it('renders in Hindi', async () => {
    setLanguage('hi');
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'अभ्यास-उपरांत समीक्षा' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /PDF रिपोर्ट डाउनलोड करें/ })).toBeInTheDocument();
    setLanguage('en');
  });
});
