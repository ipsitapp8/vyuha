import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Inject, ScenarioDetail } from '@vyuha/shared';
import { ApiRequestError } from '@/lib/api';

const getScenario = vi.fn();
const saveMsel = vi.fn();
vi.mock('@/lib/api', async (orig) => {
  const real: Record<string, unknown> = await orig();
  return {
    ...real,
    api: {
      getScenario: (...a: unknown[]) => getScenario(...a),
      saveMsel: (...a: unknown[]) => saveMsel(...a),
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

import { MselAuthoringPage, parseMselJson } from './MselAuthoringPage';

const jam = (id: string, tick: number, title = `Jam ${id}`): Inject => ({
  id,
  tick,
  title,
  type: 'JAM_CHANNEL',
  channel: 'VHF',
  intensity: 0.5,
  durationTicks: 60,
});

const detail = (msel: Inject[]): ScenarioDetail => ({
  id: 'sc1',
  title: 'Op Test',
  description: 'd',
  areaBounds: { south: 34, west: 77, north: 35, east: 78 },
  seed: 1,
  msel,
  initialUnits: [
    {
      id: 'b-pl',
      name: 'Alpha',
      side: 'BLUE',
      domain: 'LAND',
      type: 'INFANTRY_PLATOON',
      position: { lat: 34.1, lon: 77.1 },
      heading: 0,
      speed: 1,
      strength: 100,
      status: 'ACTIVE',
    },
    {
      id: 'r-1',
      name: 'Hostile',
      side: 'RED',
      domain: 'LAND',
      type: 'RECCE',
      position: { lat: 34.5, lon: 77.5 },
      heading: 0,
      speed: 1,
      strength: 100,
      status: 'ACTIVE',
    },
  ],
  paceDefaults: { primary: 'VHF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' },
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/instructor/scenarios/sc1/msel']}>
      <Routes>
        <Route path="/instructor/scenarios/:id/msel" element={<MselAuthoringPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getScenario.mockReset().mockResolvedValue(detail([jam('b', 120), jam('a', 30)]));
  saveMsel.mockReset().mockImplementation(async (_id: string, msel: Inject[]) => detail(msel));
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  expect(errors.mock.calls).toEqual([]);
  errors.mockRestore();
});

describe('parseMselJson', () => {
  it('accepts a bare array or { msel: [...] } and rejects everything else with a reason', () => {
    expect(parseMselJson(JSON.stringify([jam('a', 1)]))).toEqual({ ok: true, msel: [jam('a', 1)] });
    expect(parseMselJson(JSON.stringify({ msel: [jam('a', 1)] }))).toEqual({
      ok: true,
      msel: [jam('a', 1)],
    });
    expect(parseMselJson('not json')).toEqual({ ok: false, reason: 'json' });
    const bad = parseMselJson(
      JSON.stringify([{ id: 'x', tick: -1, title: 't', type: 'JAM_CHANNEL' }]),
    );
    expect(bad.ok).toBe(false);
    expect(parseMselJson('{"nope":1}').ok).toBe(false);
    expect(parseMselJson('[{"id":"x","tick":1,"title":"t","type":"WARP"}]').ok).toBe(false);
  });
});

describe('MselAuthoringPage', () => {
  it('loads the scenario MSEL sorted by time, with loading and error states', async () => {
    getScenario.mockRejectedValueOnce(new ApiRequestError('x', 404, 'NOT_FOUND'));
    const first = renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading scenario…');
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const rows = await screen.findAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Jam a')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Jam b')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save MSEL' })).toBeDisabled();
    first.unmount();
  });

  it('adds an inject through the form, then saves the sorted list', async () => {
    renderPage();
    await screen.findByText('Jam a');
    await userEvent.click(screen.getByRole('button', { name: 'Add inject' }));
    await userEvent.selectOptions(screen.getByLabelText('Inject type'), 'SATCOM_OUTAGE');
    const time = screen.getByLabelText('Time (seconds into the exercise)');
    await userEvent.clear(time);
    await userEvent.type(time, '75');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save MSEL' }));
    await waitFor(() => expect(saveMsel).toHaveBeenCalled());
    const [id, sent] = saveMsel.mock.calls[0] as [string, Inject[]];
    expect(id).toBe('sc1');
    expect(sent.map((i) => i.tick)).toEqual([30, 75, 120]);
    expect(sent[1]?.id).toMatch(/^inj-/);
    expect(await screen.findByText('MSEL saved.')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes.')).toBeNull();
  });

  it('edits and deletes injects, and can discard changes', async () => {
    renderPage();
    await screen.findByText('Jam a');
    await userEvent.click(screen.getByRole('button', { name: 'Edit: Jam a' }));
    const title = screen.getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Renamed jam');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Renamed jam')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete: Jam b' }));
    expect(screen.queryByText('Jam b')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByText('Jam a')).toBeInTheDocument();
    expect(screen.getByText('Jam b')).toBeInTheDocument();
    expect(screen.queryByText('Renamed jam')).toBeNull();
  });

  it('blocks saving while the MSEL does not fit the scenario, naming each problem', async () => {
    getScenario.mockResolvedValue(
      detail([
        {
          id: 's',
          tick: 5,
          title: 'Spoof ghost',
          type: 'SPOOF_ORDER',
          purportedSender: 'HQ',
          targetUnitId: 'zz',
          orderText: 'x',
        },
      ]),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '"zz" is not a unit in this scenario',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit: Spoof ghost' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('button', { name: 'Save MSEL' })).toBeDisabled();
  });

  it('exports the list as a JSON file', async () => {
    const create = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderPage();
    await screen.findByText('Jam a');
    await userEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    expect(create).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0]?.[0] as Blob;
    expect(JSON.parse(await blob.text())).toEqual([jam('a', 30), jam('b', 120)]);
    expect(click).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalled();
    click.mockRestore();
  });

  it('imports a valid file (replacing the list, unsaved until you save)', async () => {
    renderPage();
    await screen.findByText('Jam a');
    const file = new File(
      [JSON.stringify({ msel: [jam('n1', 10, 'Imported one'), jam('n2', 20, 'Imported two')] })],
      'msel.json',
      {
        type: 'application/json',
      },
    );
    await userEvent.upload(screen.getByLabelText('Import JSON', { selector: 'input' }), file);
    expect(
      await screen.findByText('Imported 2 injects. Review them, then save.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Imported one')).toBeInTheDocument();
    expect(screen.queryByText('Jam a')).toBeNull();
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
    expect(saveMsel).not.toHaveBeenCalled();
  });

  it('rejects invalid or unreadable files with a clear message and keeps the current list', async () => {
    renderPage();
    await screen.findByText('Jam a');
    const input = screen.getByLabelText('Import JSON', { selector: 'input' });
    await userEvent.upload(input, new File(['{not json'], 'a.json', { type: 'application/json' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is not valid JSON.');
    await userEvent.upload(
      input,
      new File(
        [
          JSON.stringify([
            {
              id: 'x',
              tick: 5,
              title: 't',
              type: 'JAM_CHANNEL',
              channel: 'RUNNER',
              intensity: 2,
              durationTicks: 0,
            },
          ]),
        ],
        'b.json',
        {
          type: 'application/json',
        },
      ),
    );
    expect(await screen.findByText(/That file is not a valid MSEL:/)).toBeInTheDocument();
    expect(screen.getByText('Jam a')).toBeInTheDocument();
  });

  it('shows the server message when saving fails', async () => {
    saveMsel.mockRejectedValueOnce(
      new ApiRequestError('The MSEL does not fit this scenario', 400, 'VALIDATION_ERROR'),
    );
    renderPage();
    await screen.findByText('Jam a');
    await userEvent.click(screen.getByRole('button', { name: 'Delete: Jam b' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save MSEL' }));
    expect(await screen.findByText('The MSEL does not fit this scenario')).toBeInTheDocument();
  });

  it('renders in Hindi', async () => {
    const { setLanguage } = await import('@/i18n');
    setLanguage('hi');
    renderPage();
    expect(await screen.findByRole('button', { name: 'इंजेक्ट जोड़ें' })).toBeInTheDocument();
    setLanguage('en');
  });
});
