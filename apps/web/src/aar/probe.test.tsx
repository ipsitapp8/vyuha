import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cloneElement, isValidElement, type ReactElement } from 'react';
import type { ProbeScoreDto } from '@vyuha/shared';
import { aarSummary } from './fixtures';
import { probeMapData, saChart } from './probeData';

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
vi.mock('./ProbeMap', () => ({
  ProbeMap: (p: { points: { kind: string }[]; links: unknown[] }) => (
    <div
      data-testid="probe-map"
      data-kinds={p.points.map((x) => x.kind).join('|')}
      data-links={p.links.length}
    />
  ),
}));

import { ProbeReview } from './ProbeReview';

const base = aarSummary();
const [first, second] = base.meta.players;
if (!first || !second) throw new Error('fixture needs two players');

const result = (over: Partial<ProbeScoreDto>): ProbeScoreDto => ({
  probeId: 'probe-1',
  probeTick: 90,
  playerId: first.id,
  answered: true,
  score: 64,
  contactScore: 0.4,
  teammateScore: 0.8,
  channelCorrect: true,
  matched: [{ unitId: 'r-recce', marker: 0, errorM: 800 }],
  missedUnitIds: ['r-mech'],
  ghostCount: 1,
  avgContactErrorM: 800,
  teammateErrors: [{ unitId: second.unitId, errorM: 300 }],
  avgTeammateErrorM: 300,
  answer: {
    contacts: [
      { lat: 34.2, lon: 77.6 },
      { lat: 34.1, lon: 77.5 },
    ],
    teammates: [{ unitId: second.unitId, position: { lat: 34.18, lon: 77.58 } }],
    jammedChannel: 'VHF',
  },
  truth: {
    hostiles: [
      { unitId: 'r-recce', type: 'RECCE', position: { lat: 34.205, lon: 77.605 } },
      { unitId: 'r-mech', type: 'MECH_INFANTRY_COMPANY', position: { lat: 34.25, lon: 77.69 } },
    ],
    teammates: [{ unitId: second.unitId, position: { lat: 34.18, lon: 77.585 } }],
    jammedChannel: 'VHF',
  },
  ...over,
});

const silent = result({
  playerId: second.id,
  answered: false,
  score: 0,
  matched: [],
  missedUnitIds: ['r-recce', 'r-mech'],
  ghostCount: 0,
  avgContactErrorM: null,
  avgTeammateErrorM: null,
  answer: null,
  channelCorrect: false,
});

const withProbes = () => {
  const s = aarSummary();
  s.analysis.probes = [
    { probeId: 'probe-1', tick: 90, results: [result({}), silent] },
    {
      probeId: 'probe-2',
      tick: 200,
      results: [result({ probeId: 'probe-2', probeTick: 200, score: 81 })],
    },
  ];
  return s;
};

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

const labels = {
  hostile: (t: string) => t,
  missed: (t: string) => `${t} missed`,
  teammate: (n: string) => n,
  marked: (n: number) => `M${n}`,
  ghost: (n: number) => `G${n}`,
  saidTeammate: (n: string) => `${n}?`,
};

describe('probe map data', () => {
  it('draws the truth, the answers, ghosts and misses, and a line for every matched pair', () => {
    const { points, links } = probeMapData(result({}), { [second.unitId]: 'Bilal' }, labels);
    expect(points.map((p) => p.kind)).toEqual([
      'true-hostile',
      'missed-hostile',
      'true-teammate',
      'said-contact',
      'ghost-contact',
      'said-teammate',
    ]);
    expect(points.map((p) => p.label)).toEqual([
      'RECCE',
      'MECH_INFANTRY_COMPANY missed',
      'Bilal',
      'M1',
      'G2',
      'Bilal?',
    ]);
    expect(links).toHaveLength(2); // matched contact + placed teammate
  });

  it('an unanswered probe shows only the truth, all hostiles missed', () => {
    const { points, links } = probeMapData(silent, {}, labels);
    expect(points.map((p) => p.kind)).toEqual([
      'missed-hostile',
      'missed-hostile',
      'true-teammate',
    ]);
    expect(links).toEqual([]);
  });

  it('SA over time: one row per probe, one column per trainee who was scored', () => {
    const chart = saChart(withProbes());
    expect(chart.rows).toEqual([
      { tick: 90, [first.id]: 64, [second.id]: 0 },
      { tick: 200, [first.id]: 81 },
    ]);
    expect(chart.players.map((p) => p.id)).toEqual([first.id, second.id]);
  });
});

describe('ProbeReview', () => {
  it('says so when no probe was run', () => {
    render(<ProbeReview summary={aarSummary()} />);
    expect(screen.getByText('No freeze probe was run in this exercise.')).toBeInTheDocument();
    expect(screen.queryByTestId('probe-map')).toBeNull();
  });

  it('shows the score, the numbers behind it and the answers over the truth map', () => {
    render(<ProbeReview summary={withProbes()} />);
    const section = screen.getByRole('region', { name: 'Situation awareness probes' });
    expect(within(section).getByLabelText('Situation awareness score')).toHaveTextContent('64');
    expect(within(section).getByText('1 of 2')).toBeInTheDocument();
    expect(within(section).getByText('800 m')).toBeInTheDocument();
    expect(within(section).getByText('300 m')).toBeInTheDocument();
    expect(within(section).getByText('said VHF radio, was VHF radio')).toBeInTheDocument();
    const map = screen.getByTestId('probe-map');
    expect(map).toHaveAttribute('data-links', '2');
    expect(map.getAttribute('data-kinds')).toContain('ghost-contact');
    expect(section.querySelectorAll('.recharts-line')).toHaveLength(2);
  });

  it('switches probe and trainee; an unanswered probe is called out', async () => {
    const user = userEvent.setup();
    render(<ProbeReview summary={withProbes()} />);
    await user.selectOptions(screen.getByLabelText('Trainee'), second.id);
    expect(screen.getByText('This trainee did not answer the probe: score 0.')).toBeInTheDocument();
    expect(screen.getByTestId('probe-map')).toHaveAttribute('data-links', '0');
    await user.selectOptions(screen.getByLabelText('Probe'), 'probe-2');
    expect(screen.getByLabelText('Situation awareness score')).toHaveTextContent('81');
  });
});
