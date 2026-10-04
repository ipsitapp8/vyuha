import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Inject, LobbyView, TruthViewDto } from '@vyuha/shared';
import { DegradationPanel } from './DegradationPanel';
import { InjectEditor, type UnitRef } from './InjectEditor';
import { MselTimeline, type MselEntry } from './MselTimeline';
import { TraineeCards } from './TraineeCards';

const units: UnitRef[] = [
  { id: 'b-pl', name: 'Alpha Platoon', side: 'BLUE' },
  { id: 'b-hq', name: 'Battalion HQ', side: 'BLUE' },
  { id: 'r-recce', name: 'Hostile Recce', side: 'RED' },
];
const anchor = { lat: 34.17, lon: 77.57 };

describe('InjectEditor', () => {
  it('builds a jam inject from the form (intensity as 0..1) and validates with the shared schema', async () => {
    const onSubmit = vi.fn();
    render(
      <InjectEditor
        withTick
        defaultTick={90}
        units={units}
        anchor={anchor}
        submitLabel="Go"
        onSubmit={onSubmit}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'HF');
    fireEvent.change(screen.getByLabelText(/Intensity/), { target: { value: '80' } });
    await userEvent.clear(screen.getByLabelText('Duration (seconds)'));
    await userEvent.type(screen.getByLabelText('Duration (seconds)'), '45');
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onSubmit).toHaveBeenCalledWith({
      id: 'new',
      tick: 90,
      title: 'Jamming on HF',
      type: 'JAM_CHANNEL',
      channel: 'HF',
      intensity: 0.8,
      durationTicks: 45,
    });
  });

  it('offers only the right units: friendly for orders, hostile for adversary injects', async () => {
    const { rerender } = render(
      <InjectEditor
        fixedType="SPOOF_ORDER"
        withTick={false}
        units={units}
        anchor={anchor}
        submitLabel="Go"
        onSubmit={() => undefined}
      />,
    );
    const target = screen.getByLabelText('Target unit');
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Alpha Platoon (b-pl)', 'Battalion HQ (b-hq)']);
    rerender(
      <InjectEditor
        key="adv"
        fixedType="ADVERSARY_MOVE"
        withTick={false}
        units={units}
        anchor={anchor}
        submitLabel="Go"
        onSubmit={() => undefined}
      />,
    );
    expect(within(screen.getByLabelText('Unit')).getAllByRole('option')).toHaveLength(1);
  });

  it('builds spoof, runner, weather, conflicting, adversary and SATCOM injects', async () => {
    const out: Inject[] = [];
    const submit = async (
      type: Parameters<typeof InjectEditor>[0]['fixedType'],
      fill?: () => Promise<void>,
    ) => {
      const { unmount } = render(
        <InjectEditor
          fixedType={type}
          withTick={false}
          units={units}
          anchor={anchor}
          submitLabel="Go"
          onSubmit={(i) => void out.push(i)}
        />,
      );
      if (fill) await fill();
      await userEvent.click(screen.getByRole('button', { name: 'Go' }));
      unmount();
    };
    await submit('SPOOF_ORDER', async () => {
      await userEvent.type(screen.getByLabelText('Order text'), 'Withdraw now');
    });
    await submit('RUNNER_DISPATCH', async () => {
      await userEvent.type(screen.getByLabelText('Message text'), 'Hold the line');
    });
    await submit('WEATHER_CHANGE');
    await submit('CONFLICTING_REPORTS');
    await submit('ADVERSARY_MOVE');
    await submit('SATCOM_OUTAGE');
    expect(out.map((i) => i.type)).toEqual([
      'SPOOF_ORDER',
      'RUNNER_DISPATCH',
      'WEATHER_CHANGE',
      'CONFLICTING_REPORTS',
      'ADVERSARY_MOVE',
      'SATCOM_OUTAGE',
    ]);
    expect(out[0]).toMatchObject({
      purportedSender: 'Battalion HQ',
      targetUnitId: 'b-pl',
      orderText: 'Withdraw now',
    });
    expect(out[2]).toMatchObject({ visibilityM: 5000, precipitationMm: 0, windKph: 10 });
    expect(out[3]).toMatchObject({ unitId: 'r-recce', altPosition: { lat: 34.17, lon: 77.57 } });
  });

  it('shows validation problems instead of submitting bad values', async () => {
    const onSubmit = vi.fn();
    render(
      <InjectEditor
        fixedType="SPOOF_ORDER"
        withTick={false}
        units={units}
        anchor={anchor}
        submitLabel="Go"
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Check these fields:');
    expect(screen.getByRole('alert')).toHaveTextContent('orderText');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a failure from the server and re-enables the form', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Too many actions, slow down.'));
    render(
      <InjectEditor
        fixedType="SATCOM_OUTAGE"
        withTick={false}
        units={units}
        anchor={anchor}
        submitLabel="Go"
        onSubmit={onSubmit}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('Too many actions, slow down.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeEnabled();
  });

  it('edits an existing inject, keeping its values, and lets you pick the type when creating', async () => {
    const onSubmit = vi.fn();
    const existing: Inject = {
      id: 'j1',
      tick: 120,
      title: 'Heavy VHF',
      type: 'JAM_CHANNEL',
      channel: 'VHF',
      intensity: 0.75,
      durationTicks: 300,
    };
    const { unmount } = render(
      <InjectEditor
        initial={existing}
        withTick
        units={units}
        anchor={anchor}
        submitLabel="Save"
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText('Time (seconds into the exercise)')).toHaveValue(120);
    expect(screen.getByLabelText(/Intensity: 75%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(existing);
    unmount();
    render(
      <InjectEditor
        withTick
        units={units}
        anchor={anchor}
        submitLabel="Add"
        onSubmit={() => undefined}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('Inject type'), 'WEATHER_CHANGE');
    expect(screen.getByLabelText('Visibility (m)')).toBeInTheDocument();
  });
});

const entry = (id: string, tick: number, fired: boolean, title = `Inject ${id}`): MselEntry => ({
  fired,
  inject: { id, tick, title, type: 'SATCOM_OUTAGE', durationTicks: 30 },
});

describe('MselTimeline', () => {
  const base = { tick: 100, units, anchor };

  it('shows fired and scheduled injects on a horizontal timeline with a now marker', () => {
    render(
      <MselTimeline
        {...base}
        entries={[entry('a', 60, true), entry('b', 400, false)]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const group = screen.getByRole('group', { name: 'Timeline of scheduled and fired injects' });
    const fired = within(group).getByRole('button', { name: /01:00.*Fired/ });
    const scheduled = within(group).getByRole('button', { name: /06:40.*Scheduled/ });
    expect(fired).toBeInTheDocument();
    expect(scheduled).toBeInTheDocument();
    expect(within(group).getByLabelText(/Now 01:40/)).toBeInTheDocument();
  });

  it('adds a new inject at a time after now', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <MselTimeline {...base} entries={[]} onAdd={onAdd} onUpdate={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.getByText('No injects scheduled.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add inject' }));
    await userEvent.selectOptions(screen.getByLabelText('Inject type'), 'SATCOM_OUTAGE');
    expect(screen.getByLabelText('Time (seconds into the exercise)')).toHaveValue(130);
    await userEvent.click(screen.getAllByRole('button', { name: 'Add inject' })[1] as HTMLElement);
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SATCOM_OUTAGE', tick: 130 }),
    );
    expect(await screen.findByText('MSEL updated.')).toBeInTheDocument();
  });

  it('edits and removes a scheduled inject', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(
      <MselTimeline
        {...base}
        entries={[entry('b', 400, false, 'Cut SATCOM')]}
        onAdd={vi.fn()}
        onUpdate={onUpdate}
        onRemove={onRemove}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Cut SATCOM/ }));
    const time = screen.getByLabelText('Time (seconds into the exercise)');
    await userEvent.clear(time);
    await userEvent.type(time, '500');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'b', tick: 500 }));

    await userEvent.click(screen.getByRole('button', { name: /Cut SATCOM/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove inject' }));
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('shows a fired inject read-only', async () => {
    render(
      <MselTimeline
        {...base}
        entries={[entry('a', 60, true, 'Early jam')]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Early jam/ }));
    expect(screen.getByText(/already fired and can no longer be changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove inject' })).toBeNull();
  });
});

const truth = (over: Partial<TruthViewDto> = {}): TruthViewDto => ({
  tick: 120,
  units: [],
  jamming: { VHF: 0.5, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
  satcomUp: true,
  weather: { visibilityM: 9000, precipitationMm: 0, windKph: 5 },
  manualJamming: { VHF: 0.2, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 },
  msel: [],
  players: {},
  drift: {},
  ...over,
});

describe('DegradationPanel', () => {
  it('sets a per-channel level when the slider is released, and shows the effective level', () => {
    const onSet = vi.fn().mockResolvedValue(true);
    render(<DegradationPanel truth={truth()} onSet={onSet} />);
    expect(screen.getByText('effective 50%')).toBeInTheDocument();
    const slider = screen.getByLabelText('VHF radio manual level');
    expect(slider).toHaveValue('20');
    fireEvent.change(slider, { target: { value: '85' } });
    expect(onSet).not.toHaveBeenCalled(); // still dragging
    fireEvent.keyUp(slider);
    expect(onSet).toHaveBeenCalledWith('VHF', 0.85);
  });

  it('does not resend an unchanged level, and reports SATCOM state', () => {
    const onSet = vi.fn().mockResolvedValue(true);
    render(<DegradationPanel truth={truth({ satcomUp: false })} onSet={onSet} />);
    fireEvent.keyUp(screen.getByLabelText('HF radio manual level'));
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByText('SATCOM DOWN')).toBeInTheDocument();
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

describe('TraineeCards', () => {
  const metrics = (
    over: Partial<TruthViewDto['players'][string]> = {},
  ): TruthViewDto['players'][string] => ({
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
    ...over,
  });
  const drift = { missed: 2, ghost: 1, avgPositionErrorM: 450, friendlyAvgErrorM: 120 };

  it('shows drift, last decision, latency, calibration and spoofs for each trainee', () => {
    const t = truth({
      players: {
        p1: metrics({
          decisionCount: 3,
          scoredDecisionCount: 2,
          avgLatencyTicks: 22.4,
          brierScore: 0.3,
          meanConfidence: 72,
          accuracy: 50,
          gradeCount: 1,
          gradingAccuracy: 0.8,
          channelSwitchCount: 2,
          spoofActedCount: 1,
          lastDecision: {
            tick: 95,
            actionType: 'COMPLY_ORDER',
            confidence: 90,
            outcome: 0,
            rationale: 'Looked like HQ',
          },
        }),
        p2: metrics(),
      },
      drift: { p1: drift, p2: { ...drift, missed: 0 } },
    });
    render(<TraineeCards lobby={lobby} truth={t} watchedId={null} onWatch={() => undefined} />);
    const card = within(screen.getByTestId('card-p1'));
    expect(card.getByText('Asha')).toBeInTheDocument();
    expect(card.getByText(/450 m/)).toBeInTheDocument();
    expect(card.getByText('stated 72% · correct 50%')).toBeInTheDocument();
    expect(card.getByText('Brier score 0.30 (lower is better)')).toBeInTheDocument();
    expect(card.getByText('22 s')).toBeInTheDocument();
    expect(card.getByText('80%')).toBeInTheDocument();
    expect(card.getByText(/Comply with order at 90% \(wrong\), 01:35/)).toBeInTheDocument();
    expect(card.getByText('“Looked like HQ”')).toBeInTheDocument();
    expect(card.getByText('1', { selector: 'dd.font-semibold' })).toHaveClass('text-red-400');
    const empty = within(screen.getByTestId('card-p2'));
    expect(empty.getByText('None yet')).toBeInTheDocument();
  });

  it('lets the instructor pick whose eyes to look through', async () => {
    const onWatch = vi.fn();
    const t = truth({ players: { p1: metrics(), p2: metrics() }, drift: { p1: drift, p2: drift } });
    const { rerender } = render(
      <TraineeCards lobby={lobby} truth={t} watchedId={null} onWatch={onWatch} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Watch: Bilal' }));
    expect(onWatch).toHaveBeenCalledWith('p2');
    rerender(<TraineeCards lobby={lobby} truth={t} watchedId="p2" onWatch={onWatch} />);
    expect(screen.getByRole('button', { name: 'Watching: Bilal' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
