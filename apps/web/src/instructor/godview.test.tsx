import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Ack,
  InstructorInput,
  LobbyView,
  PerceivedStateDto,
  TruthViewDto,
} from '@vyuha/shared';
import { contact, perceived } from '@/test/fixtures';
import type { SessionLive } from '@/lib/useSessionSocket';

// MapLibre needs WebGL (not in jsdom): stand-ins that expose what they were given.
vi.mock('./TruthMap', () => ({
  TruthMap: (p: { truth: TruthViewDto; watched: PerceivedStateDto | null }) => (
    <div
      data-testid="truth-map"
      data-units={p.truth.units.length}
      data-believed={p.watched?.contacts.length ?? -1}
    />
  ),
}));
vi.mock('@/cockpit/CockpitMap', () => ({
  CockpitMap: (p: { perceived: PerceivedStateDto }) => (
    <div data-testid="perceived-map" data-player={p.perceived.playerId} />
  ),
}));
const control = vi.fn();
const speed = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    sessionControl: (...a: unknown[]) => control(...a),
    setSpeed: (...a: unknown[]) => speed(...a),
  },
}));

import { GodView } from './GodView';

const lobby: LobbyView = {
  session: {
    id: 's1',
    code: 'ABC234',
    status: 'RUNNING',
    speed: 1,
    tick: 0,
    scenarioId: 'x',
    scenarioTitle: 'Op',
    areaBounds: { south: 34, west: 77, north: 35, east: 78 },
    createdAt: '2026-01-01T00:00:00Z',
  },
  teams: [
    {
      id: 't',
      name: 'Alpha',
      pace: { primary: 'VHF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' },
    },
  ],
  players: [
    { id: 'p1', userId: 'u1', name: 'Asha', teamId: 't', role: 'PL_CDR', unitId: 'b-pl' },
    { id: 'p2', userId: 'u2', name: 'Bilal', teamId: 't', role: 'SECTION_CDR', unitId: 'b-sec1' },
  ],
  units: [],
};

const m = {
  decisionCount: 0,
  scoredDecisionCount: 0,
  avgLatencyTicks: null,
  brierScore: null,
  meanConfidence: null,
  accuracy: null,
  gradeCount: 0,
  gradingAccuracy: null,
  channelSwitchCount: 0,
  spoofActedCount: 0,
  lastDecision: null,
};
const drift = { missed: 1, ghost: 0, avgPositionErrorM: 100, friendlyAvgErrorM: 0 };

const truth: TruthViewDto = {
  tick: 200,
  units: [
    {
      id: 'b-pl',
      name: 'Alpha Platoon',
      side: 'BLUE',
      domain: 'LAND',
      type: 'INFANTRY_PLATOON',
      position: { lat: 34.1, lon: 77.1 },
      heading: 0,
      status: 'ACTIVE',
      destination: null,
    },
    {
      id: 'r-recce',
      name: 'Hostile Recce',
      side: 'RED',
      domain: 'LAND',
      type: 'RECCE',
      position: { lat: 34.2, lon: 77.2 },
      heading: 0,
      status: 'ACTIVE',
      destination: null,
    },
  ],
  jamming: { VHF: 0.3, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
  satcomUp: true,
  weather: { visibilityM: 9000, precipitationMm: 0, windKph: 5 },
  manualJamming: { VHF: 0, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
  msel: [
    {
      fired: false,
      inject: { id: 'j1', tick: 400, title: 'Late jam', type: 'SATCOM_OUTAGE', durationTicks: 30 },
    },
  ],
  players: { p1: m, p2: m },
  drift: { p1: drift, p2: drift },
};

const ok = async (): Promise<Ack> => ({ ok: true });
const instruct = vi.fn<(i: InstructorInput) => Promise<Ack>>(ok);
const watch = vi.fn<(id: string | null) => Promise<Ack>>(ok);

function live(over: Partial<SessionLive> = {}): SessionLive {
  return {
    connection: 'connected',
    error: null,
    role: 'INSTRUCTOR',
    playerId: null,
    lobby,
    status: { status: 'RUNNING', tick: 200, speed: 1 },
    perceived: null,
    truth,
    playerEvents: [],
    truthEvents: [],
    act: ok,
    instruct,
    watch,
    ...over,
  };
}

const run = vi.fn(async (fn: () => Promise<LobbyView>) => void (await fn()));
const renderGod = (l: SessionLive, status: 'RUNNING' | 'PAUSED' | 'ENDED' = 'RUNNING') =>
  render(<GodView lobby={lobby} live={l} status={status} speed={1} busy={false} run={run} />);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  instruct.mockClear();
  watch.mockClear();
  control.mockReset().mockResolvedValue(lobby);
  speed.mockReset().mockResolvedValue(lobby);
  run.mockClear();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

describe('GodView', () => {
  it('waits for the first tick', () => {
    renderGod(live({ truth: null }));
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the first tick…');
  });

  it('shows the truth map beside a prompt to pick a trainee', () => {
    renderGod(live());
    expect(screen.getByTestId('truth-map')).toHaveAttribute('data-units', '2');
    expect(screen.getByText(/Pick a trainee below/)).toBeInTheDocument();
    expect(screen.queryByTestId('perceived-map')).toBeNull();
  });

  it('watching a trainee puts their picture next to the truth, and overlays what they believe', async () => {
    const view = perceived({
      playerId: 'p2',
      contacts: [contact({ id: 'c1' }), contact({ id: 'c2' })],
    });
    const { rerender } = renderGod(live());
    await userEvent.click(screen.getByRole('button', { name: 'Watch: Bilal' }));
    expect(watch).toHaveBeenCalledWith('p2');
    rerender(
      <GodView
        lobby={lobby}
        live={live({ perceived: view })}
        status="RUNNING"
        speed={1}
        busy={false}
        run={run}
      />,
    );
    expect(screen.getByTestId('perceived-map')).toHaveAttribute('data-player', 'p2');
    expect(screen.getByTestId('truth-map')).toHaveAttribute('data-believed', '2');
    expect(screen.getByText('Picture of Bilal')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Watching: Bilal' }));
    expect(watch).toHaveBeenLastCalledWith(null);
  });

  it('ignores a stale picture of someone who is no longer being watched', async () => {
    renderGod(live({ perceived: perceived({ playerId: 'p1' }) }));
    expect(screen.queryByTestId('perceived-map')).toBeNull();
  });

  it('fires a live inject straight away (no time field) and confirms it', async () => {
    renderGod(live());
    await userEvent.click(screen.getByRole('button', { name: 'Cut SATCOM' }));
    expect(
      screen.queryByLabelText('Time (seconds into the exercise)', {
        selector: 'section [aria-label="Live injects"] input',
      }),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Fire inject now' }));
    expect(instruct).toHaveBeenCalledWith({
      type: 'INJECT_NOW',
      inject: expect.objectContaining({ type: 'SATCOM_OUTAGE', durationTicks: 120, tick: 0 }),
    });
    expect(await screen.findByText(/trainees see it on the next tick/)).toBeInTheDocument();
  });

  it('offers all five quick injects and fires a spoofed order with its text', async () => {
    renderGod(live());
    const panel = within(screen.getByLabelText('Live injects'));
    for (const name of [
      'Jam a channel',
      'Cut SATCOM',
      'Spoof an order',
      'Conflicting report',
      'Weather change',
    ]) {
      expect(panel.getByRole('button', { name })).toBeInTheDocument();
    }
    await userEvent.click(panel.getByRole('button', { name: 'Spoof an order' }));
    await userEvent.type(screen.getByLabelText('Order text'), 'Fall back to the ridge');
    await userEvent.click(screen.getByRole('button', { name: 'Fire inject now' }));
    expect(instruct).toHaveBeenCalledWith({
      type: 'INJECT_NOW',
      inject: expect.objectContaining({
        type: 'SPOOF_ORDER',
        orderText: 'Fall back to the ridge',
        targetUnitId: 'b-pl',
      }),
    });
  });

  it('shows the server error when an inject is refused', async () => {
    instruct.mockResolvedValueOnce({ ok: false, error: { code: 'SESSION_STATE', message: 'x' } });
    renderGod(live());
    await userEvent.click(screen.getByRole('button', { name: 'Cut SATCOM' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fire inject now' }));
    expect(
      await screen.findByText('That exercise has already started or ended.'),
    ).toBeInTheDocument();
  });

  it('disables quick injects while paused', () => {
    renderGod(live(), 'PAUSED');
    expect(screen.getByRole('button', { name: 'Jam a channel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('drives the exercise: pause, speed and end go through the session API', async () => {
    renderGod(live());
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(control).toHaveBeenCalledWith('s1', 'pause');
    await userEvent.click(screen.getByRole('button', { name: '4x' }));
    expect(speed).toHaveBeenCalledWith('s1', 4);
    await userEvent.click(screen.getByRole('button', { name: 'End exercise' }));
    expect(control).toHaveBeenCalledWith('s1', 'end');
  });

  it('shows an ended exercise without controls', () => {
    renderGod(live(), 'ENDED');
    expect(screen.getByText('The exercise has ended.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('timeline edits are sent as MSEL changes', async () => {
    renderGod(live());
    await userEvent.click(screen.getByRole('button', { name: /Late jam/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove inject' }));
    expect(instruct).toHaveBeenCalledWith({ type: 'MSEL_REMOVE', injectId: 'j1' });
  });

  it('degradation sliders send a jamming level', async () => {
    renderGod(live());
    const slider = screen.getByLabelText('HF radio manual level');
    fireEvent.change(slider, { target: { value: '10' } });
    fireEvent.keyUp(slider);
    expect(instruct).toHaveBeenCalledWith({ type: 'SET_JAMMING', channel: 'HF', intensity: 0.1 });
  });

  it('lists refused inputs and fired injects in the truth event feed', () => {
    renderGod(
      live({
        truthEvents: [
          {
            tick: 61,
            type: 'INJECT_FIRED',
            visibleTo: ['instructor'],
            payload: { title: 'Light VHF jamming begins' },
          },
          {
            tick: 70,
            type: 'INPUT_REJECTED',
            visibleTo: ['instructor'],
            payload: { reason: 'inject has already fired' },
          },
          {
            tick: 71,
            type: 'MESSAGE_OUTCOME',
            visibleTo: ['instructor'],
            payload: {
              kind: 'TEXT',
              channel: 'VHF',
              outcome: 'CORRUPTED',
              quality: 0.4,
              los: false,
            },
          },
        ],
      }),
    );
    expect(screen.getByText(/Light VHF jamming begins/)).toBeInTheDocument();
    expect(screen.getByText(/Refused: inject has already fired/)).toBeInTheDocument();
    expect(
      screen.getByText(/TEXT on VHF: corrupted \(quality 0.40, line of sight no\)/),
    ).toBeInTheDocument();
  });

  it('renders in Hindi without errors', async () => {
    const { setLanguage } = await import('@/i18n');
    setLanguage('hi');
    renderGod(live());
    expect(screen.getByRole('heading', { name: 'तत्काल इंजेक्ट' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'सैटकॉम काटें' })).toBeInTheDocument();
    setLanguage('en');
  });
});
