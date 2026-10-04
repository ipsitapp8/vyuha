import {
  computePerceivedState,
  currentJamming,
  mulberry32,
  satcomUp,
  step,
  type EngineInput,
  type TruthState,
} from '@vyuha/engine';
import type { AarSnapshot, AarTruth } from '@vyuha/shared';

const KEYFRAME_EVERY = 60;
const YIELD_EVERY = 300;

/**
 * Deterministic re-run of a finished exercise from its log. One pass records a keyframe every minute of
 * exercise time; any tick is then at most 59 steps from a keyframe, so scrubbing stays instant.
 */
export class Replayer {
  private readonly frames = new Map<number, TruthState>();
  private building: Promise<void> | null = null;

  constructor(
    private readonly initial: TruthState,
    private readonly inputs: ReadonlyMap<number, readonly EngineInput[]>,
    readonly duration: number,
  ) {}

  private async build(): Promise<void> {
    let state = this.initial;
    this.frames.set(0, state);
    const rng = mulberry32(state.rngState);
    for (let t = 1; t <= this.duration; t++) {
      state = step(state, this.inputs.get(t) ?? [], rng).state;
      if (t % KEYFRAME_EVERY === 0) this.frames.set(t, state);
      // Keep the server responsive while a long exercise is being replayed.
      if (t % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Exact ground truth at `tick` (clamped to the exercise). */
  async at(tick: number): Promise<TruthState> {
    await (this.building ??= this.build());
    const target = Math.max(0, Math.min(this.duration, Math.floor(tick)));
    let state =
      this.frames.get(Math.floor(target / KEYFRAME_EVERY) * KEYFRAME_EVERY) ?? this.initial;
    if (state.tick < target) {
      const rng = mulberry32(state.rngState);
      while (state.tick < target) {
        state = step(state, this.inputs.get(state.tick + 1) ?? [], rng).state;
      }
    }
    return state;
  }

  async snapshot(tick: number, playerId: string | null): Promise<AarSnapshot> {
    const state = await this.at(tick);
    return {
      tick: state.tick,
      truth: truthDto(state),
      perceived:
        playerId && state.players.some((p) => p.id === playerId)
          ? computePerceivedState(state, playerId)
          : null,
    };
  }
}

export function truthDto(state: TruthState): AarTruth {
  return {
    tick: state.tick,
    units: state.units.map((u) => ({
      id: u.id,
      name: u.name,
      side: u.side,
      domain: u.domain,
      type: u.type,
      position: u.position,
      heading: u.heading,
      status: u.status,
      destination: u.destination,
    })),
    jamming: currentJamming(state),
    satcomUp: satcomUp(state),
  };
}
