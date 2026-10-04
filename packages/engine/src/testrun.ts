import type { Inject } from '@vyuha/shared';
import { mulberry32 } from './prng';
import { step } from './step';
import type { EngineEvent, EngineInput, TruthState } from './types';

export type Plan = Record<number, EngineInput[]>;

/** Runs `ticks` steps, applying `plan[tick]` inputs on that tick. */
export function run(
  initial: TruthState,
  ticks: number,
  plan: Plan = {},
): { state: TruthState; events: EngineEvent[] } {
  const rng = mulberry32(initial.rngState);
  let state = initial;
  const events: EngineEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const r = step(state, plan[state.tick + 1] ?? [], rng);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

export const ofType = (events: EngineEvent[], type: string): EngineEvent[] =>
  events.filter((e) => e.type === type);

export const jam = (
  id: string,
  tick: number,
  channel: 'VHF' | 'HF' | 'SATCOM' | 'DATALINK',
  intensity: number,
  durationTicks: number,
): Inject => ({
  id,
  tick,
  title: id,
  type: 'JAM_CHANNEL',
  channel,
  intensity,
  durationTicks,
});

export const spoof = (tick: number): Inject => ({
  id: 'spoof-1',
  tick,
  title: 'spoof',
  type: 'SPOOF_ORDER',
  purportedSender: 'Battalion HQ',
  targetUnitId: 'b-pl',
  orderText: 'Withdraw to grid 1234 5678 immediately',
});

export const sendText = (
  text = 'Contact north at grid 1234 5678',
  channel: 'VHF' | 'HF' | 'SATCOM' | 'DATALINK' | 'RUNNER' = 'VHF',
  from = 'p-pl',
  to = 'p-uav',
): EngineInput => ({
  type: 'SEND_MESSAGE',
  playerId: from,
  toPlayerId: to,
  channel,
  text,
});
