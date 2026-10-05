import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { message, perceived } from '@/test/fixtures';
import { RadioAudioControls } from './RadioAudioControls';
import { newRadioMessages } from './useRadioAudio';

afterEach(cleanup);

describe('which messages are heard', () => {
  const inbox = [
    message({ id: 'old', kind: 'TEXT', text: 'old traffic' }),
    message({ id: 't1', kind: 'TEXT', channel: 'HF', text: 'Contact north' }),
    message({ id: 'o1', kind: 'ORDER', channel: 'VHF', from: 'Battalion HQ', text: 'Withdraw' }),
    message({ id: 'b1', kind: 'POSITION', text: 'beacon' }),
    message({ id: 'r1', kind: 'REPORT', text: 'sensor report' }),
    message({ id: 'g1', kind: 'TEXT', channel: 'RUNNER', text: 'gr#d 44' }),
  ];
  const p = perceived({
    inbox,
    comms: {
      activeChannel: 'VHF',
      pace: { primary: 'VHF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' },
      switchPenaltyActive: false,
      signal: { VHF: 0.2, HF: 0.7, SATCOM: 0.9, DATALINK: 0.8, RUNNER: null },
    },
  });

  it('only new text and orders, each with its own channel quality', () => {
    const fresh = newRadioMessages(new Set(['old']), p);
    expect(fresh.map((m) => m.id)).toEqual(['t1', 'o1', 'g1']);
    expect(fresh[0]).toMatchObject({ channel: 'HF', quality: 0.7, jammed: false, garbled: false });
    // an order is announced with its sender; a weak channel counts as jammed
    expect(fresh[1]).toMatchObject({ text: 'Battalion HQ. Withdraw', quality: 0.2, jammed: true });
    // a runner has no radio link, and visible damage marks the message as garbled
    expect(fresh[2]).toMatchObject({ channel: 'RUNNER', quality: null, garbled: true });
  });

  it('nothing is new once every message has been seen', () => {
    expect(newRadioMessages(new Set(inbox.map((m) => m.id)), p)).toEqual([]);
  });
});

describe('RadioAudioControls', () => {
  it('is on by default, mutes, and changes the volume', async () => {
    const user = userEvent.setup();
    const setPrefs = vi.fn();
    const { rerender } = render(
      <RadioAudioControls prefs={{ muted: false, volume: 0.8 }} setPrefs={setPrefs} available />,
    );
    const toggle = screen.getByRole('button', { name: 'Radio audio on' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);
    expect(setPrefs).toHaveBeenLastCalledWith({ muted: true, volume: 0.8 });

    rerender(
      <RadioAudioControls prefs={{ muted: true, volume: 0.8 }} setPrefs={setPrefs} available />,
    );
    expect(screen.getByRole('button', { name: 'Radio audio off' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByLabelText('Volume')).toBeDisabled();
  });

  it('says so when the browser has no audio support', () => {
    render(
      <RadioAudioControls
        prefs={{ muted: false, volume: 1 }}
        setPrefs={vi.fn()}
        available={false}
      />,
    );
    expect(screen.getByText('Radio audio is not available in this browser.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
