import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Ack, LobbyView, PerceivedStateDto, PlayerAction } from '@vyuha/shared';
import { contact, perceived } from '@/test/fixtures';
import type { SessionLive } from '@/lib/useSessionSocket';
import {
  blankPicture,
  canSubmit,
  draftMarkers,
  emptyDraft,
  placePoint,
  removeContact,
  toAnswer,
} from './probe';

vi.mock('./CockpitMap', () => ({
  CockpitMap: (props: {
    picture: PerceivedStateDto;
    pickMode: boolean;
    probeMarkers?: { label: string }[];
    onPick: (p: { lat: number; lon: number }) => void;
  }) => (
    <div
      data-testid="map"
      data-contacts={props.picture.contacts.length}
      data-friendlies={props.picture.friendlies.length}
      data-pick={props.pickMode}
      data-markers={(props.probeMarkers ?? []).map((m) => m.label).join('|')}
    >
      <button type="button" onClick={() => props.onPick({ lat: 34.2, lon: 77.6 })}>
        stub-click-map
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
const getMySaScores = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, api: { getMySaScores: (...a: unknown[]) => getMySaScores(...a) } };
});

import { CockpitPage } from './CockpitPage';

const lobby: LobbyView = {
  session: {
    id: 's',
    code: 'ABC234',
    status: 'PAUSED',
    speed: 1,
    tick: 0,
    scenarioId: 'x',
    scenarioTitle: 'Op Silent Ridge',
    areaBounds: { south: 34.08, west: 77.45, north: 34.26, east: 77.7 },
    createdAt: '2026-01-01T00:00:00Z',
    clean: false,
    baselineOfId: null,
  },
  teams: [
    {
      id: 't',
      name: 'Alpha',
      pace: { primary: 'VHF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' },
    },
  ],
  players: [],
  units: [],
};

const withProbe = (): PerceivedStateDto =>
  perceived({
    contacts: [contact()],
    friendlies: [
      {
        unitId: 'b-sec1',
        name: 'Alpha Section 1',
        type: 'INFANTRY_SECTION',
        position: { lat: 34.18, lon: 77.6 },
        observedTick: 90,
        ageTicks: 10,
      },
    ],
    probe: { id: 'probe-1', tick: 100, expiresAtTick: 130 },
  });

const acts: PlayerAction[] = [];
let ackOk = true;
function setLive(over: Partial<SessionLive> = {}): void {
  live.current = {
    connection: 'connected',
    error: null,
    role: 'TRAINEE',
    playerId: 'p1',
    lobby,
    status: { status: 'PAUSED', tick: 100, speed: 1 },
    perceived: withProbe(),
    truth: null,
    playerEvents: [],
    truthEvents: [],
    act: async (a): Promise<Ack> => {
      acts.push(a);
      return ackOk
        ? { ok: true }
        : { ok: false, error: { code: 'SESSION_STATE', message: 'closed' } };
    },
    instruct: async (): Promise<Ack> => ({ ok: true }),
    watch: async (): Promise<Ack> => ({ ok: true }),
    ...over,
  };
}
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/session/abc234']}>
      <Routes>
        <Route path="/session/:code" element={<CockpitPage />} />
      </Routes>
    </MemoryRouter>,
  );

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  acts.length = 0;
  ackOk = true;
  getMySaScores.mockReset();
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

describe('probe draft', () => {
  it('places contacts, then one teammate, and returns to marking contacts', () => {
    let d = emptyDraft();
    d = placePoint(d, { lat: 1, lon: 1 });
    d = placePoint({ ...d, target: { kind: 'teammate', unitId: 'b-sec1' } }, { lat: 2, lon: 2 });
    expect(d.contacts).toEqual([{ lat: 1, lon: 1 }]);
    expect(d.teammates).toEqual({ 'b-sec1': { lat: 2, lon: 2 } });
    expect(d.target).toEqual({ kind: 'contact' });
    expect(removeContact(d, 0).contacts).toEqual([]);
  });

  it('caps the contacts at 20 and needs the channel answer before it can be sent', () => {
    let d = emptyDraft();
    for (let i = 0; i < 25; i++) d = placePoint(d, { lat: i, lon: i });
    expect(d.contacts).toHaveLength(20);
    expect(canSubmit(d)).toBe(false);
    expect(canSubmit({ ...d, jammedChannel: 'NONE' })).toBe(true);
  });

  it('builds the validated action and the map markers', () => {
    const d = {
      ...emptyDraft(),
      contacts: [{ lat: 1, lon: 1 }],
      teammates: { 'b-sec1': { lat: 2, lon: 2 } },
      jammedChannel: 'HF' as const,
    };
    expect(toAnswer('probe-1', d)).toEqual({
      type: 'PROBE_ANSWER',
      probeId: 'probe-1',
      contacts: [{ lat: 1, lon: 1 }],
      teammates: [{ unitId: 'b-sec1', position: { lat: 2, lon: 2 } }],
      jammedChannel: 'HF',
    });
    expect(draftMarkers(d, { 'b-sec1': 'Section 1' }, (n) => `C${n}`).map((m) => m.label)).toEqual([
      'C1',
      'Section 1',
    ]);
  });

  it('blanks the picture: contacts and teammates are hidden, the own unit stays', () => {
    const blank = blankPicture(withProbe());
    expect(blank.contacts).toEqual([]);
    expect(blank.friendlies).toEqual([]);
    expect(blank.self.unitId).toBe('b-pl');
  });
});

describe('cockpit during a freeze probe', () => {
  it('hides the picture and shows the three questions instead of the comms panel', () => {
    setLive();
    renderPage();
    expect(screen.getByText('EXERCISE FROZEN: SITUATION CHECK')).toBeInTheDocument();
    const map = screen.getByTestId('map');
    expect(map).toHaveAttribute('data-contacts', '0');
    expect(map).toHaveAttribute('data-friendlies', '0');
    expect(map).toHaveAttribute('data-pick', 'true');
    const panel = screen.getByRole('region', { name: 'Situation check' });
    expect(within(panel).getByText('1. Where are the hostile contacts?')).toBeInTheDocument();
    expect(within(panel).getByText('2. Where are your teammates?')).toBeInTheDocument();
    expect(
      within(panel).getByText('3. Which channel is being jammed right now?'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record a decision' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Send my answers' })).toBeDisabled();
  });

  it('marks contacts and a teammate on the map and sends one validated answer', async () => {
    const user = userEvent.setup();
    setLive();
    renderPage();
    await user.click(screen.getByText('stub-click-map'));
    await user.click(screen.getByText('stub-click-map'));
    await user.click(screen.getByRole('button', { name: 'Remove contact 2' }));
    await user.click(screen.getByRole('button', { name: 'Place Alpha Section 1' }));
    await user.click(screen.getByText('stub-click-map'));
    expect(screen.getByTestId('map')).toHaveAttribute('data-markers', 'Contact 1|Alpha Section 1');
    await user.selectOptions(screen.getByLabelText('Jammed channel'), 'VHF');
    await user.click(screen.getByRole('button', { name: 'Send my answers' }));

    expect(acts).toEqual([
      {
        type: 'PROBE_ANSWER',
        probeId: 'probe-1',
        contacts: [{ lat: 34.2, lon: 77.6 }],
        teammates: [{ unitId: 'b-sec1', position: { lat: 34.2, lon: 77.6 } }],
        jammedChannel: 'VHF',
      },
    ]);
    expect(
      await screen.findByText('Answers sent. Wait for the instructor to resume the exercise.'),
    ).toBeInTheDocument();
    // no score, and nothing about the truth, is shown during the exercise
    expect(document.body.textContent).not.toMatch(/score|out of 100/i);
  });

  it('keeps the form open and says why when the server refuses the answer', async () => {
    const user = userEvent.setup();
    ackOk = false;
    setLive();
    renderPage();
    await user.selectOptions(screen.getByLabelText('Jammed channel'), 'NONE');
    await user.click(screen.getByRole('button', { name: 'Send my answers' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send my answers' })).toBeEnabled();
  });

  it('returns to the normal cockpit when the probe is closed', () => {
    setLive({ perceived: perceived(), status: { status: 'RUNNING', tick: 101, speed: 1 } });
    renderPage();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Situation check' })).toBeNull();
  });
});

describe('after the exercise', () => {
  it('shows the trainee their own probe scores', async () => {
    getMySaScores.mockResolvedValue({
      saScore: 62,
      probes: [
        {
          probeId: 'probe-1',
          tick: 91,
          answered: true,
          score: 62,
          channelCorrect: true,
          contactsFound: 2,
          contactsMissed: 1,
          ghostCount: 0,
          avgContactErrorM: 410,
          avgTeammateErrorM: 120,
        },
        {
          probeId: 'probe-2',
          tick: 200,
          answered: false,
          score: 0,
          channelCorrect: false,
          contactsFound: 0,
          contactsMissed: 3,
          ghostCount: 0,
          avgContactErrorM: null,
          avgTeammateErrorM: null,
        },
      ],
    });
    setLive({ perceived: null, status: { status: 'ENDED', tick: 300, speed: 1 } });
    renderPage();
    const box = await screen.findByRole('region', { name: 'Your situation awareness' });
    expect(await within(box).findByText('Average score: 62 out of 100.')).toBeInTheDocument();
    expect(within(box).getAllByRole('row')).toHaveLength(3);
    expect(within(box).getByText('0 (no answer)')).toBeInTheDocument();
    expect(getMySaScores).toHaveBeenCalledWith('s');
  });

  it('says so when no probe was run, and offers a retry when loading fails', async () => {
    const user = userEvent.setup();
    getMySaScores.mockRejectedValueOnce(new Error('offline'));
    getMySaScores.mockResolvedValue({ saScore: null, probes: [] });
    setLive({ perceived: null, status: { status: 'ENDED', tick: 300, speed: 1 } });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('No situation check was run in this exercise.'),
    ).toBeInTheDocument();
  });
});
