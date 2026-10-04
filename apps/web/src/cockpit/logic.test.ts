import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { clock, formatAge } from '@/lib/format';
import { ackErrorText, apiErrorText, reasonText, validationText } from '@/lib/messages';
import { ApiRequestError } from '@/lib/api';
import { contact, message, perceived } from '@/test/fixtures';
import {
  currentTracks,
  computeDegradation,
  contactOpacity,
  deliveryFlags,
  isLowConfidence,
  orderAlerts,
} from './logic';

const t = i18n.t.bind(i18n);

describe('report confidence styling', () => {
  it("only the trainee's own D-F / credibility 5-6 grades count as low confidence", () => {
    expect(isLowConfidence(null)).toBe(false);
    expect(isLowConfidence({ reliability: 'B', credibility: 2 })).toBe(false);
    expect(isLowConfidence({ reliability: 'C', credibility: 4 })).toBe(false);
    expect(isLowConfidence({ reliability: 'D', credibility: 2 })).toBe(true);
    expect(isLowConfidence({ reliability: 'A', credibility: 5 })).toBe(true);
  });

  it('fades contacts with age and fades low-confidence ones further', () => {
    expect(contactOpacity(0, null)).toBe(1);
    expect(contactOpacity(300, null)).toBeLessThan(contactOpacity(30, null));
    expect(contactOpacity(5000, null)).toBeCloseTo(0.35, 9);
    expect(contactOpacity(0, { reliability: 'F', credibility: 6 })).toBeCloseTo(0.6, 9);
  });
});

describe('channel degradation effects', () => {
  it('static follows the signal of the channel the team is using', () => {
    expect(computeDegradation(perceived()).jammed).toBe(false);
    const bad = perceived();
    bad.comms.signal.VHF = 0.05;
    const d = computeDegradation(bad);
    expect(d.jammed).toBe(true);
    expect(d.jamLevel).toBeGreaterThan(0.85);
    const dead = perceived();
    dead.comms.signal.VHF = 0;
    expect(computeDegradation(dead).jamLevel).toBe(1);
  });

  it('the runner can never be jammed', () => {
    const p = perceived();
    p.comms.activeChannel = 'RUNNER';
    p.comms.signal.VHF = 0;
    expect(computeDegradation(p)).toMatchObject({ jamLevel: 0, jammed: false });
  });

  it('the picture freezes only when the data-link is effectively gone', () => {
    const p = perceived();
    p.comms.signal.DATALINK = 0.2;
    expect(computeDegradation(p).datalinkLost).toBe(false);
    p.comms.signal.DATALINK = 0.02;
    expect(computeDegradation(p).datalinkLost).toBe(true);
    p.comms.signal.DATALINK = null;
    expect(computeDegradation(p).datalinkLost).toBe(false);
  });
});

describe('delivery flags (only what the receiver could notice)', () => {
  const base = {
    channel: 'VHF' as const,
    sentTick: 10,
    receivedTick: 11,
    text: 'Hold at grid 1234',
  };
  it('normal traffic is unflagged, and altered digits are invisible', () => {
    expect(deliveryFlags(base)).toEqual({ delayedBy: null, garbled: false });
  });
  it('flags clearly late messages relative to the channel (SATCOM is normally slow)', () => {
    expect(deliveryFlags({ ...base, receivedTick: 40 }).delayedBy).toBe(30);
    expect(deliveryFlags({ ...base, channel: 'SATCOM', receivedTick: 19 }).delayedBy).toBeNull();
    expect(deliveryFlags({ ...base, channel: 'RUNNER', receivedTick: 900 }).delayedBy).toBeNull();
  });
  it('flags visibly garbled text', () => {
    expect(deliveryFlags({ ...base, text: 'Hol# position' }).garbled).toBe(true);
  });
});

describe('map tracks', () => {
  const at = (id: string, tick: number, lat: number, type = 'RECCE') =>
    contact({ id, observedTick: tick, position: { lat, lon: 77.6 }, type });
  it('keeps only the freshest sighting of the same thing, but all distinct or conflicting ones', () => {
    const list = [
      at('old', 10, 34.2),
      at('new', 50, 34.2005), // ~55 m away, same type: supersedes 'old'
      at('far', 20, 34.25), // distinct place
      at('other-type', 30, 34.2, 'DRONE'), // conflicting type at the same place
    ];
    expect(currentTracks(list, null).map((c) => c.id)).toEqual(['new', 'other-type', 'far']);
  });
  it('gates by how far a unit could have moved: older sightings merge across longer distances', () => {
    const list = [at('then', 0, 34.2), at('now', 100, 34.21)]; // ~1.1 km apart, 100 s apart
    expect(currentTracks(list, null).map((c) => c.id)).toEqual(['now']);
    const quick = [at('then', 98, 34.2), at('now', 100, 34.21)]; // same distance, only 2 s apart: two units
    expect(currentTracks(quick, null)).toHaveLength(2);
  });
  it('always keeps the selected contact', () => {
    const list = [at('old', 10, 34.2), at('new', 50, 34.2005)];
    expect(
      currentTracks(list, 'old')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['new', 'old']);
  });
});

describe('order alerts', () => {
  it('lists unverified and pending orders with a countdown, newest first, and recent results only', () => {
    const p = perceived({
      tick: 500,
      inbox: [
        message({ id: 'old-verified', authState: 'VERIFIED', receivedTick: 100 }),
        message({ id: 'a', authState: 'NONE', receivedTick: 490 }),
        message({ id: 'b', authState: 'PENDING', authResolvesAtTick: 507, receivedTick: 495 }),
        message({ id: 'fresh-failed', authState: 'FAILED', receivedTick: 480 }),
        message({ id: 'chat', requiresAuth: false, kind: 'TEXT' }),
      ],
    });
    const alerts = orderAlerts(p);
    expect(alerts.map((a) => a.message.id)).toEqual(['fresh-failed', 'b', 'a']);
    expect(alerts.find((a) => a.message.id === 'b')?.secondsLeft).toBe(7);
    expect(alerts.find((a) => a.message.id === 'a')?.secondsLeft).toBeNull();
  });
});

describe('formatting and message helpers', () => {
  it('formats exercise time and ages', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(125)).toBe('02:05');
    expect(formatAge(t, 1)).toBe('just now');
    expect(formatAge(t, 42)).toBe('42s ago');
    expect(formatAge(t, 120)).toBe('2m ago');
    expect(formatAge(t, 125)).toBe('2m 5s ago');
    expect(formatAge(t, 4000)).toBe('66m ago');
  });

  it('translates known server/engine messages and passes unknown ones through', () => {
    expect(validationText(t, 'Enter a valid email address')).toBe('Enter a valid email address');
    expect(validationText(t, 'Something custom')).toBe('Something custom');
    expect(validationText(t, undefined)).toBeUndefined();
    expect(reasonText(t, 'no ISR asset on your team')).toBe('no ISR asset on your team');
    expect(reasonText(t, 'brand new reason')).toBe('brand new reason');
    expect(apiErrorText(t, new ApiRequestError('x', 401, 'INVALID_CREDENTIALS'))).toBe(
      'Incorrect email or password.',
    );
    expect(apiErrorText(t, new ApiRequestError('That role is taken', 409, 'CONFLICT'))).toBe(
      'That role is taken',
    );
    expect(apiErrorText(t, new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(ackErrorText(t, { code: 'RATE_LIMITED', message: 'x' })).toBe(
      'Too many actions, slow down.',
    );
    expect(ackErrorText(t, { code: 'VALIDATION_ERROR', message: 'detail' })).toBe('detail');
  });
});
