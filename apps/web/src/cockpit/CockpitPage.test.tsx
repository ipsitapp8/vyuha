import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Ack, LobbyView, PerceivedStateDto, PlayerAction } from '@vyuha/shared';
import { contact, message, perceived } from '@/test/fixtures';
import type { SessionLive } from '@/lib/useSessionSocket';

// MapLibre needs WebGL, which jsdom does not have: replace the map with a stub that exposes its callbacks.
vi.mock('./CockpitMap', () => ({
  CockpitMap: (props: {
    picture: PerceivedStateDto;
    pickMode: boolean;
    onPick: (p: { lat: number; lon: number }) => void;
    onSelectContact: (id: string) => void;
  }) => (
    <div
      data-testid="map"
      data-contacts={props.picture.contacts.length}
      data-tick={props.picture.tick}
      data-pick={props.pickMode}
    >
      <button type="button" onClick={() => props.onPick({ lat: 34.2, lon: 77.6 })}>
        stub-click-map
      </button>
      <button
        type="button"
        onClick={() => props.onSelectContact(props.picture.contacts[0]?.id ?? '')}
      >
        stub-select-contact
      </button>
    </div>
  ),
}));

const live: { current: SessionLive } = { current: undefined as unknown as SessionLive };
vi.mock('@/lib/useSessionSocket', () => ({ useSessionSocket: () => live.current }));
vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u', name: 'Asha', email: 'a@x.io', role: 'TRAINEE' },
    status: 'ready',
    logout: vi.fn(),
  }),
}));

import { CockpitPage } from './CockpitPage';

const lobby: LobbyView = {
  session: {
    id: 's',
    code: 'ABC234',
    status: 'RUNNING',
    speed: 1,
    tick: 0,
    scenarioId: 'x',
    scenarioTitle: 'Op Silent Ridge',
    areaBounds: { south: 34.08, west: 77.45, north: 34.26, east: 77.7 },
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
    {
      id: 'p1',
      userId: 'u1',
      name: 'Asha',
      isDemoBot: false,
      teamId: 't',
      role: 'PL_CDR',
      unitId: 'b-pl',
    },
    {
      id: 'p2',
      userId: 'u2',
      name: 'Bilal',
      isDemoBot: false,
      teamId: 't',
      role: 'SECTION_CDR',
      unitId: 'b-sec1',
    },
  ],
  units: [{ id: 'b-pl', name: 'Alpha Platoon', type: 'INFANTRY_PLATOON', domain: 'LAND' }],
};

const acts: PlayerAction[] = [];
function setLive(over: Partial<SessionLive> = {}): void {
  live.current = {
    connection: 'connected',
    error: null,
    role: 'TRAINEE',
    playerId: 'p1',
    lobby,
    status: { status: 'RUNNING', tick: 100, speed: 1 },
    perceived: perceived(),
    truth: null,
    playerEvents: [],
    truthEvents: [],
    act: async (a): Promise<Ack> => {
      acts.push(a);
      return { ok: true };
    },
    instruct: async (): Promise<Ack> => ({ ok: true }),
    watch: async (): Promise<Ack> => ({ ok: true }),
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/session/abc234']}>
      <Routes>
        <Route path="/session/:code" element={<CockpitPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  acts.length = 0;
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  // The cockpit must render and react to every state without a single console error.
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

describe('CockpitPage', () => {
  it('shows the cockpit: map, tabs, clock, role and unit while running', () => {
    setLive();
    renderPage();
    expect(screen.getByTestId('map')).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Exercise time' })).toHaveTextContent('01:40');
    expect(screen.getByText(/Alpha Platoon · Platoon Commander/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Comms' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Reports (0)' })).toBeInTheDocument();
  });

  it('shows the lobby before the exercise starts, and waits for the first update', () => {
    setLive({
      status: { status: 'LOBBY', tick: 0, speed: 1 },
      perceived: null,
      lobby: { ...lobby, session: { ...lobby.session, status: 'LOBBY' } },
    });
    const { unmount } = renderPage();
    expect(screen.getByText('Your assignment')).toBeInTheDocument();
    expect(
      screen.getByText('Team Alpha · Role Platoon Commander · Unit Alpha Platoon'),
    ).toBeInTheDocument();
    unmount();
    setLive({ perceived: null });
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for your first update…');
  });

  it('shows connecting, errors and the ended state', () => {
    setLive({ connection: 'connecting', lobby: null, status: null, perceived: null });
    const first = renderPage();
    expect(screen.getByText('Connecting to the exercise…')).toBeInTheDocument();
    first.unmount();
    setLive({
      error: 'Your sign-in expired. Sign in again.',
      status: { status: 'ENDED', tick: 900, speed: 1 },
      perceived: null,
    });
    renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('sign-in expired');
    expect(screen.getByText(/exercise has ended/i)).toBeInTheDocument();
  });

  it('shows a paused banner and blocks actions while paused', () => {
    setLive({ status: { status: 'PAUSED', tick: 100, speed: 1 } });
    renderPage();
    expect(screen.getByText('EXERCISE PAUSED')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record a decision' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move unit' })).toBeDisabled();
  });

  it('flags an unverified order on the map and authenticates it from there', async () => {
    setLive({ perceived: perceived({ inbox: [message({ id: 'o1', from: 'Battalion HQ' })] }) });
    renderPage();
    const region = screen.getByRole('region', { name: 'Order alerts' });
    await userEvent.click(within(region).getByRole('button', { name: 'Authenticate' }));
    expect(acts).toEqual([{ type: 'AUTHENTICATE', messageId: 'o1' }]);
  });

  it('shows static and a JAMMED badge when the active channel is degraded', () => {
    const p = perceived();
    p.comms.signal.VHF = 0.04;
    setLive({ perceived: p });
    renderPage();
    expect(screen.getByText('JAMMED')).toBeInTheDocument();
    expect(document.querySelector('.vy-static')).not.toBeNull();
  });

  it('freezes the shared picture when the data-link drops, but not the clock', () => {
    const before = perceived({ tick: 100, contacts: [contact({ id: 'rpt-1' })] });
    setLive({ perceived: before });
    const { rerender } = renderPage();
    expect(screen.getByTestId('map')).toHaveAttribute('data-contacts', '1');

    const lost = perceived({
      tick: 130,
      contacts: [contact({ id: 'rpt-1' }), contact({ id: 'rpt-2' })],
    });
    lost.comms.signal.DATALINK = 0.01;
    setLive({ perceived: lost });
    rerender(
      <MemoryRouter initialEntries={['/session/abc234']}>
        <Routes>
          <Route path="/session/:code" element={<CockpitPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/DATA-LINK LOST: contacts frozen at 01:40/)).toBeInTheDocument();
    expect(screen.getByTestId('map')).toHaveAttribute('data-contacts', '1');
    expect(screen.getByTestId('map')).toHaveAttribute('data-tick', '100');
    expect(screen.getByRole('timer', { name: 'Exercise time' })).toHaveTextContent('02:10');
  });

  it('selecting a contact on the map opens the Reports tab; Decide opens the decision modal', async () => {
    setLive({ perceived: perceived({ contacts: [contact({ id: 'rpt-1', type: 'RECCE' })] }) });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'stub-select-contact' }));
    expect(screen.getByRole('tab', { name: 'Reports (1)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Decide on this contact' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a decision' });
    expect(within(dialog).getByLabelText('About contact (optional)')).toHaveValue('rpt-1');
    await userEvent.type(within(dialog).getByLabelText(/Rationale/), 'Confirmed by the drone feed');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit decision' }));
    expect(acts.at(-1)).toMatchObject({
      type: 'DECISION',
      targetContactId: 'rpt-1',
      confidence: 60,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Decision recorded.')).toBeInTheDocument();
  });

  it('move and ISR tools turn the next map click into the right action', async () => {
    setLive();
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Move unit' }));
    expect(screen.getByRole('status', { name: '' })).toBeDefined();
    expect(
      screen.getByText('Tap the map to set a destination for Alpha Platoon.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('map')).toHaveAttribute('data-pick', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'stub-click-map' }));
    expect(acts.at(-1)).toEqual({
      type: 'MOVE_UNIT',
      unitId: 'b-pl',
      destination: { lat: 34.2, lon: 77.6 },
    });
    expect(screen.getByTestId('map')).toHaveAttribute('data-pick', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Request ISR' }));
    await userEvent.click(screen.getByRole('button', { name: 'stub-click-map' }));
    expect(acts.at(-1)).toEqual({ type: 'REQUEST_ISR', target: { lat: 34.2, lon: 77.6 } });

    await userEvent.click(screen.getByRole('button', { name: 'Move unit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('map')).toHaveAttribute('data-pick', 'false');
  });

  it('platoon commanders can pick which teammate unit to move', async () => {
    const p = perceived({
      friendlies: [
        {
          unitId: 'b-sec1',
          name: 'Alpha Section 1',
          type: 'INFANTRY_SECTION',
          position: { lat: 34.19, lon: 77.6 },
          observedTick: 80,
          ageTicks: 20,
        },
      ],
    });
    setLive({ perceived: p });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Move unit' }));
    await userEvent.selectOptions(screen.getByLabelText('Unit to move'), 'b-sec1');
    await userEvent.click(screen.getByRole('button', { name: 'stub-click-map' }));
    expect(acts.at(-1)).toMatchObject({ type: 'MOVE_UNIT', unitId: 'b-sec1' });
  });

  it('shows translated notices (including engine refusals) and server errors from actions', async () => {
    setLive({
      playerEvents: [
        { tick: 90, type: 'INPUT_REJECTED', payload: { reason: 'no ISR asset on your team' } },
        { tick: 95, type: 'AUTH_RESOLVED', payload: { result: 'FAILED' } },
      ],
      act: async (): Promise<Ack> => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }),
    });
    renderPage();
    expect(screen.getByText(/Refused: no ISR asset on your team/)).toBeInTheDocument();
    expect(screen.getByText(/Authentication result: FAILED/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Message'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Too many actions, slow down.')).toBeInTheDocument();
  });

  it('renders in Hindi without errors', async () => {
    const { setLanguage } = await import('@/i18n');
    setLanguage('hi');
    setLive({ perceived: perceived({ contacts: [contact()], inbox: [message()] }) });
    renderPage();
    expect(screen.getByRole('tab', { name: /संचार/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'निर्णय दर्ज करें' })).toBeInTheDocument();
    setLanguage('en');
  });
});
