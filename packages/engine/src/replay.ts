import { mulberry32 } from './prng';
import { step } from './step';
import type { EngineEvent, EngineInput, TruthState } from './types';

/**
 * Deterministic replay: re-runs the exercise from `initial` to `untilTick`, applying the recorded
 * inputs at the tick on which each was originally applied (tick = state.tick + 1 of that step).
 * Same initial state + same inputs => identical state and events. Used for AAR and server resume.
 */
export function replay(
  initial: TruthState,
  inputsByTick: ReadonlyMap<number, readonly EngineInput[]>,
  untilTick: number,
): { state: TruthState; events: EngineEvent[] } {
  const rng = mulberry32(initial.rngState);
  let state = initial;
  const events: EngineEvent[] = [];
  while (state.tick < untilTick) {
    const result = step(state, inputsByTick.get(state.tick + 1) ?? [], rng);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}
