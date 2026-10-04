import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LobbyView, PlayerAction } from '@vyuha/shared';
import { LanguageToggle } from '@/components/LanguageToggle';
import { setLanguage } from '@/i18n';
import { contact, message, perceived } from '@/test/fixtures';
import { AdmiraltyGrader } from './AdmiraltyGrader';
import { AlertStack } from './AlertStack';
import { CommsPanel } from './CommsPanel';
import { DecisionDialog } from './DecisionDialog';
import { orderAlerts } from './logic';
import { ReportsPanel } from './ReportsPanel';

const ok = () => vi.fn<(a: PlayerAction) => Promise<boolean>>().mockResolvedValue(true);

describe('AlertStack (spoof alert flow)', () => {
  it('flags an unverified order and sends Authenticate', async () => {
    const send = ok();
    const p = perceived({ inbox: [message({ id: 'm9', from: 'Battalion HQ' })] });
    render(<AlertStack alerts={orderAlerts(p)} pending={false} send={send} />);
    expect(screen.getByText('New order from Battalion HQ')).toBeInTheDocument();
    expect(screen.getByText(/can be forged/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    expect(send).toHaveBeenCalledWith({ type: 'AUTHENTICATE', messageId: 'm9' });
  });

  it('shows a live countdown while authenticating, with no button', () => {
    const p = perceived({
      tick: 100,
      inbox: [message({ authState: 'PENDING', authResolvesAtTick: 109 })],
    });
    render(<AlertStack alerts={orderAlerts(p)} pending={false} send={ok()} />);
    expect(screen.getByRole('timer')).toHaveTextContent('Authenticating… 9s');
    expect(screen.queryByRole('button', { name: 'Authenticate' })).toBeNull();
  });

  it('reveals a fake order loudly and lets the trainee dismiss the result', async () => {
    const p = perceived({ inbox: [message({ authState: 'FAILED' })] });
    render(<AlertStack alerts={orderAlerts(p)} pending={false} send={ok()} />);
    expect(screen.getByText('That order was FAKE')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('That order was FAKE')).toBeNull();
  });

  it('renders nothing when there are no orders, and disables Authenticate while an action is pending', () => {
    const { container, rerender } = render(<AlertStack alerts={[]} pending={false} send={ok()} />);
    expect(container).toBeEmptyDOMElement();
    const p = perceived({ inbox: [message()] });
    rerender(<AlertStack alerts={orderAlerts(p)} pending send={ok()} />);
    expect(screen.getByRole('button', { name: 'Authenticate' })).toBeDisabled();
  });
});

describe('DecisionDialog', () => {
  const p = perceived({
    contacts: [contact({ id: 'rpt-7', type: 'RECCE' })],
    inbox: [message({ id: 'o1' })],
  });

  it('requires a 10+ character rationale before submitting', async () => {
    const send = ok();
    render(
      <DecisionDialog
        perceived={p}
        initialContactId={null}
        onClose={() => undefined}
        send={send}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Submit decision' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Rationale/), 'too short');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Rationale/), ' now long enough');
    expect(submit).toBeEnabled();
  });

  it('sends action, confidence, rationale and references, then closes', async () => {
    const send = ok();
    const onClose = vi.fn();
    render(<DecisionDialog perceived={p} initialContactId="rpt-7" onClose={onClose} send={send} />);
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'ENGAGE');
    await userEvent.selectOptions(screen.getByLabelText('Based on order (optional)'), 'o1');
    await userEvent.type(screen.getByLabelText(/Rationale/), 'Visual confirmed by two sources');
    await userEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(send).toHaveBeenCalledWith({
      type: 'DECISION',
      actionType: 'ENGAGE',
      confidence: 60,
      rationale: 'Visual confirmed by two sources',
      targetContactId: 'rpt-7',
      basedOnMessageId: 'o1',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open when the server refuses the decision', async () => {
    const send = vi.fn<(a: PlayerAction) => Promise<boolean>>().mockResolvedValue(false);
    const onClose = vi.fn();
    render(<DecisionDialog perceived={p} initialContactId={null} onClose={onClose} send={send} />);
    await userEvent.type(screen.getByLabelText(/Rationale/), 'A perfectly good rationale');
    await userEvent.click(screen.getByRole('button', { name: 'Submit decision' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is a modal dialog: focus starts inside, Tab wraps, Escape closes', async () => {
    const onClose = vi.fn();
    render(<DecisionDialog perceived={p} initialContactId={null} onClose={onClose} send={ok()} />);
    const dialog = screen.getByRole('dialog', { name: 'Record a decision' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.type(screen.getByLabelText(/Rationale/), 'A perfectly good rationale');
    screen.getByRole('button', { name: 'Submit decision' }).focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AdmiraltyGrader', () => {
  it('grades A1-F6 with two radio groups and only saves a complete, changed grade', async () => {
    const onSave = vi.fn();
    render(<AdmiraltyGrader id="rpt-1" initial={null} disabled={false} onSave={onSave} />);
    const save = screen.getByRole('button', { name: 'Save grade' });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'B: Usually reliable' }));
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: '2: Probably true' }));
    expect(screen.getByRole('radio', { name: 'B: Usually reliable' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith('B', 2);
  });

  it('offers a regrade of an existing grade', () => {
    render(
      <AdmiraltyGrader
        id="x"
        initial={{ reliability: 'D', credibility: 4 }}
        disabled={false}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Regrade (D4)' })).toBeDisabled();
  });
});

describe('ReportsPanel', () => {
  it('lists contacts with source, shows grading state, and sends GRADE_REPORT', async () => {
    const send = ok();
    const p = perceived({
      contacts: [
        contact({ id: 'rpt-1', type: 'RECCE', ageTicks: 130, source: 'Falcon UAV', via: 'DIRECT' }),
        contact({
          id: 'rpt-2',
          type: 'MECH_INFANTRY_COMPANY',
          source: 'Own sensor',
          grade: { reliability: 'E', credibility: 5 },
        }),
      ],
    });
    render(
      <ReportsPanel
        perceived={p}
        selectedId={null}
        pending={false}
        send={send}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByText('Reports (2)')).toBeInTheDocument();
    expect(screen.getByText(/2m 10s ago/)).toBeInTheDocument();
    expect(screen.getByText('Your grade: E5')).toBeInTheDocument();
    expect(screen.getByText('Not graded yet')).toBeInTheDocument();
    const first = screen.getAllByRole('listitem')[0];
    if (!first) throw new Error('no contact card');
    await userEvent.click(within(first).getByRole('radio', { name: 'C: Fairly reliable' }));
    await userEvent.click(within(first).getByRole('radio', { name: '3: Possibly true' }));
    await userEvent.click(within(first).getByRole('button', { name: 'Save grade' }));
    expect(send).toHaveBeenCalledWith({
      type: 'GRADE_REPORT',
      reportId: 'rpt-1',
      reliability: 'C',
      credibility: 3,
    });
  });

  it('shows an empty state and can open a decision about a contact', async () => {
    const onDecide = vi.fn();
    const { rerender } = render(
      <ReportsPanel
        perceived={perceived()}
        selectedId={null}
        pending={false}
        send={ok()}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByText('No contacts reported yet.')).toBeInTheDocument();
    rerender(
      <ReportsPanel
        perceived={perceived({ contacts: [contact({ id: 'rpt-3' })] })}
        selectedId="rpt-3"
        pending={false}
        send={ok()}
        onDecide={onDecide}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Decide on this contact' }));
    expect(onDecide).toHaveBeenCalledWith('rpt-3');
  });
});

const lobby: LobbyView = {
  session: {
    id: 's',
    code: 'ABC234',
    status: 'RUNNING',
    speed: 1,
    tick: 0,
    scenarioId: 'x',
    scenarioTitle: 'Op',
    areaBounds: { south: 1, west: 1, north: 2, east: 2 },
    createdAt: '2026-01-01T00:00:00Z',
  },
  teams: [],
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
  units: [],
};

describe('CommsPanel', () => {
  it('shows live signal bars per channel, the active channel and PACE', () => {
    const p = perceived();
    p.comms.signal.HF = 0.1;
    render(<CommsPanel perceived={p} lobby={lobby} selfId="p1" pending={false} send={ok()} />);
    expect(screen.getByRole('img', { name: 'VHF radio signal: 90%' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'HF radio signal: 10%' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('PACE: VHF / HF / SATCOM / RUNNER')).toBeInTheDocument();
  });

  it('warns when the active channel is badly degraded', () => {
    const p = perceived();
    p.comms.signal.VHF = 0.05;
    render(<CommsPanel perceived={p} lobby={lobby} selfId="p1" pending={false} send={ok()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/badly degraded/);
  });

  it('flags delayed and garbled messages only when detectable', () => {
    const p = perceived({
      inbox: [
        message({
          id: 'a',
          kind: 'TEXT',
          requiresAuth: false,
          sentTick: 10,
          receivedTick: 11,
          text: 'Fine 1234',
        }),
        message({
          id: 'b',
          kind: 'TEXT',
          requiresAuth: false,
          sentTick: 10,
          receivedTick: 60,
          text: 'Late one',
        }),
        message({
          id: 'c',
          kind: 'TEXT',
          requiresAuth: false,
          sentTick: 10,
          receivedTick: 11,
          text: 'Hol# at grid',
        }),
      ],
    });
    render(<CommsPanel perceived={p} lobby={lobby} selfId="p1" pending={false} send={ok()} />);
    expect(screen.getAllByText(/Delayed in transit \(50s\)/)).toHaveLength(1);
    expect(screen.getAllByText(/Garbled: parts of this message/)).toHaveLength(1);
  });

  it('sends messages and channel switches over the chosen channel', async () => {
    const send = ok();
    render(
      <CommsPanel perceived={perceived()} lobby={lobby} selfId="p1" pending={false} send={send} />,
    );
    await userEvent.type(screen.getByLabelText('Message'), 'Contact north');
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'HF');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(send).toHaveBeenCalledWith({
      type: 'SEND_MESSAGE',
      toPlayerId: 'p2',
      channel: 'HF',
      text: 'Contact north',
    });

    await userEvent.selectOptions(screen.getByLabelText('Team channel'), 'SATCOM');
    await userEvent.click(screen.getByRole('button', { name: 'Switch channel' }));
    expect(send).toHaveBeenCalledWith({ type: 'SWITCH_CHANNEL', channel: 'SATCOM' });
  });

  it('authenticates an order from the inbox and shows the verified state', async () => {
    const send = ok();
    const { rerender } = render(
      <CommsPanel
        perceived={perceived({ inbox: [message({ id: 'o1' })] })}
        lobby={lobby}
        selfId="p1"
        pending={false}
        send={send}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Authenticate' }));
    expect(send).toHaveBeenCalledWith({ type: 'AUTHENTICATE', messageId: 'o1' });
    rerender(
      <CommsPanel
        perceived={perceived({ inbox: [message({ id: 'o1', authState: 'VERIFIED' })] })}
        lobby={lobby}
        selfId="p1"
        pending={false}
        send={send}
      />,
    );
    expect(screen.getByText('Verified genuine')).toBeInTheDocument();
  });
});

describe('LanguageToggle', () => {
  it('switches the UI between English and Hindi', async () => {
    setLanguage('en');
    render(<LanguageToggle />);
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(screen.getByRole('button', { name: 'हिन्दी' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: 'भाषा' })).toBeInTheDocument();
    setLanguage('en');
  });
});
