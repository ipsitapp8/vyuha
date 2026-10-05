import type { Server as SocketServer } from 'socket.io';
import {
  computePerceivedState,
  computePictureDrift,
  createTruthState,
  currentJamming,
  mulberry32,
  replay,
  satcomUp,
  step,
  type EngineEvent,
  type EngineInput,
  type Rng,
  type Roster,
  type TruthState,
  c2DriftM,
} from '@vyuha/engine';
import {
  SOCKET_EVENTS,
  paceDefaultsSchema,
  playerActionSchema,
  playerRoleSchema,
  scenarioDefinitionSchema,
  terrainGridSchema,
  instructorInputSchema,
  type InstructorInput,
  type PerceivedStateDto,
  type PlayerAction,
  type SessionStatus,
  type Speed,
  type TruthViewDto,
} from '@vyuha/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { GeoRepo } from '../geo/ingest';
import type { ScenarioRepo } from '../repos';
import type { LobbyService } from './lobby';
import { LiveMetrics } from './liveMetrics';
import type { DecisionRow, EventRow, GradeRow, SessionRow, SessionStore } from './store';

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface ManagerLogger {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const TICK_MS = 1000;
const MAX_LAG_MS = 5000;
const MAX_PENDING_INPUTS = 200;
const DEFAULT_WEATHER = { visibilityM: 10_000, precipitationMm: 0, windKph: 0 };

export const room = {
  session: (id: string): string => `session:${id}`,
  player: (id: string, playerId: string): string => `session:${id}:player:${playerId}`,
  instructor: (id: string): string => `session:${id}:instructor`,
};

export const startedPayloadSchema = z.object({
  scenario: scenarioDefinitionSchema,
  terrain: terrainGridSchema,
  weather: z.object({
    visibilityM: z.number(),
    precipitationMm: z.number(),
    windKph: z.number(),
  }),
  roster: z.object({
    teams: z.array(z.object({ id: z.string(), name: z.string(), pace: paceDefaultsSchema })),
    players: z.array(
      z.object({
        id: z.string(),
        teamId: z.string(),
        unitId: z.string(),
        role: playerRoleSchema,
      }),
    ),
  }),
  seed: z.number().int(),
  /** Baseline run with every degradation off. Absent in logs written before baselines existed. */
  clean: z.boolean().default(false),
});

const loggedInputSchema = z.union([
  z.object({ playerId: z.string(), action: z.unknown() }),
  z.object({ instructor: z.literal(true), input: z.unknown() }),
]);

const decisionPayloadSchema = z.object({
  playerId: z.string(),
  actionType: z.string(),
  confidence: z.number(),
  rationale: z.string(),
  targetContactId: z.string().nullable(),
  basedOnMessageId: z.string().nullable(),
  outcome: z.union([z.literal(0), z.literal(1)]).nullable(),
  latencyTicks: z.number().nullable(),
  spoofActed: z.boolean(),
  perceivedSnapshot: z.unknown(),
  truthSnapshot: z.unknown(),
});

const gradePayloadSchema = z.object({
  playerId: z.string(),
  reportId: z.string(),
  gradedReliability: z.string(),
  gradedCredibility: z.number(),
  trueReliability: z.string(),
  trueCredibility: z.number(),
});

/** A queued input: from a trainee or from the instructor. Logged exactly as applied, so replay is exact. */
type Pending =
  | { kind: 'player'; playerId: string; action: PlayerAction }
  | { kind: 'instructor'; input: InstructorInput };

export function pendingToEngine(p: Pending): EngineInput {
  if (p.kind === 'player') return toEngineInput(p.playerId, p.action);
  const i = p.input;
  switch (i.type) {
    case 'INJECT_NOW':
      return { type: 'INJECT', inject: i.inject };
    case 'SET_JAMMING':
      return { type: 'SET_JAMMING', channel: i.channel, intensity: i.intensity };
    case 'MSEL_ADD':
      return { type: 'MSEL_ADD', inject: i.inject };
    case 'MSEL_UPDATE':
      return { type: 'MSEL_UPDATE', inject: i.inject };
    case 'MSEL_REMOVE':
      return { type: 'MSEL_REMOVE', injectId: i.injectId };
    case 'PROBE_START':
      return { type: 'PROBE_START', probeId: i.probeId };
    case 'PROBE_CLOSE':
      return { type: 'PROBE_CLOSE' };
  }
}

const inputPayload = (p: Pending): Record<string, unknown> =>
  p.kind === 'player'
    ? { playerId: p.playerId, action: p.action }
    : { instructor: true, input: p.input };

interface Runtime {
  sessionId: string;
  state: TruthState;
  rng: Rng;
  status: SessionStatus;
  speed: Speed;
  pending: Pending[];
  metrics: LiveMetrics;
  timer: unknown;
  nextDue: number;
  queue: Promise<unknown>;
}

export function toEngineInput(playerId: string, a: PlayerAction): EngineInput {
  switch (a.type) {
    case 'SEND_MESSAGE':
      return {
        type: 'SEND_MESSAGE',
        playerId,
        toPlayerId: a.toPlayerId,
        channel: a.channel,
        text: a.text,
        ...(a.position ? { position: a.position } : {}),
      };
    case 'MOVE_UNIT':
      return { type: 'MOVE_UNIT', playerId, unitId: a.unitId, destination: a.destination };
    case 'REQUEST_ISR':
      return { type: 'REQUEST_ISR', playerId, target: a.target };
    case 'GRADE_REPORT':
      return {
        type: 'GRADE_REPORT',
        playerId,
        reportId: a.reportId,
        reliability: a.reliability,
        credibility: a.credibility,
      };
    case 'AUTHENTICATE':
      return { type: 'AUTHENTICATE', playerId, messageId: a.messageId };
    case 'SWITCH_CHANNEL':
      return { type: 'SWITCH_CHANNEL', playerId, channel: a.channel };
    case 'DECISION':
      return {
        type: 'DECISION',
        playerId,
        actionType: a.actionType,
        confidence: a.confidence,
        rationale: a.rationale,
        ...(a.targetContactId ? { targetContactId: a.targetContactId } : {}),
        ...(a.basedOnMessageId ? { basedOnMessageId: a.basedOnMessageId } : {}),
      };
    case 'PROBE_ANSWER':
      return {
        type: 'PROBE_ANSWER',
        playerId,
        probeId: a.probeId,
        contacts: a.contacts,
        teammates: a.teammates,
        jammedChannel: a.jammedChannel,
      };
  }
}

function openProbeView(state: TruthState): TruthViewDto['probe'] {
  const probe = state.probes.at(-1);
  return probe
    ? {
        id: probe.id,
        tick: probe.tick,
        expiresAtTick: probe.expiresAtTick,
        pending: [...probe.pending],
      }
    : null;
}

export function buildTruthView(state: TruthState, metrics: LiveMetrics): TruthViewDto {
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
    weather: state.weather,
    manualJamming: state.manualJam,
    msel: state.msel.map((inject) => ({ inject, fired: state.firedInjectIds.includes(inject.id) })),
    probe: openProbeView(state),
    effects: {
      gpsSpoofs: state.gpsSpoofs.map((g) => ({
        unitId: g.unitId,
        offsetM: Math.round(Math.hypot(g.eastM, g.northM)),
        untilTick: g.untilTick,
      })),
      c2Compromises: state.c2Compromises.map((c) => ({
        playerId: c.playerId,
        sinceTick: c.sinceTick,
        untilTick: c.untilTick,
        channel: c.channel,
        driftM: Math.round(c2DriftM(state, c.playerId)),
      })),
    },
    players: metrics.view(state.players.map((p) => p.id)),
    drift: Object.fromEntries(state.players.map((p) => [p.id, computePictureDrift(state, p.id)])),
  };
}

/**
 * Owns every live exercise: one deterministic engine loop per RUNNING session, persistence of all
 * events/inputs (event sourcing), per-player fan-out of perceived state, and restart recovery.
 */
export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly store: SessionStore,
    private readonly scenarios: ScenarioRepo,
    private readonly geo: GeoRepo,
    private readonly lobby: LobbyService,
    private readonly io: SocketServer,
    private readonly log: ManagerLogger,
    private readonly sched: Scheduler = realScheduler,
    /** Runs after a started session has ended and its last events are stored (progress metrics). */
    private readonly onEnded: (sessionId: string) => Promise<void> = async () => undefined,
  ) {}

  // ---- lifecycle ------------------------------------------------------------------------

  async start(sessionId: string): Promise<SessionRow> {
    const session = await this.lobby.requireSession(sessionId);
    if (session.status !== 'LOBBY')
      throw new HttpError(409, 'SESSION_STATE', 'Session already started');
    const roster = await this.lobby.buildRoster(session);
    const scenario = await this.lobby.requireDefinition(session.scenarioId);
    const terrain = await this.geo.getTerrain(session.scenarioId);
    if (!terrain) {
      throw new HttpError(
        409,
        'GEO_UNAVAILABLE',
        'Ingest terrain for this scenario before starting.',
      );
    }
    const w = await this.geo.getWeather(session.scenarioId);
    const weather = w
      ? { visibilityM: w.visibilityM, precipitationMm: w.precipitationMm, windKph: w.windKph }
      : DEFAULT_WEATHER;

    const state = createTruthState(scenario, terrain, weather, scenario.seed, roster, {
      clean: session.clean,
    });
    const startedPayload = {
      scenario,
      terrain,
      weather,
      roster,
      seed: scenario.seed,
      clean: session.clean,
    };
    await this.store.commitBatch({
      sessionId,
      currentTick: 0,
      events: [
        { tick: 0, type: 'SESSION_STARTED', payload: startedPayload, visibleTo: ['instructor'] },
      ],
      decisions: [],
      grades: [],
    });
    const updated = await this.store.updateSession(sessionId, {
      status: 'RUNNING',
      startedAt: new Date(this.sched.now()),
    });
    const rt = this.makeRuntime(updated, state);
    this.runtimes.set(sessionId, rt);
    this.startLoop(rt);
    this.emitStatus(rt);
    this.emitAll(rt);
    return updated;
  }

  async pause(sessionId: string): Promise<SessionRow> {
    const rt = await this.requireRuntime(sessionId);
    return this.exclusive(rt, async () => {
      if (rt.status !== 'RUNNING')
        throw new HttpError(409, 'SESSION_STATE', 'Session is not running');
      this.stopLoop(rt);
      rt.status = 'PAUSED';
      const row = await this.store.updateSession(sessionId, { status: 'PAUSED' });
      await this.logLifecycle(rt, 'SESSION_PAUSED');
      this.emitStatus(rt);
      return row;
    });
  }

  /**
   * Freeze and probe (SAGAT): opens a situation-awareness probe on one last tick, then pauses the
   * exercise so every trainee can answer. The probe start is a logged input, so it replays exactly.
   */
  async probe(sessionId: string): Promise<SessionRow> {
    const rt = await this.requireRuntime(sessionId);
    return this.exclusive(rt, async () => {
      if (rt.status !== 'RUNNING')
        throw new HttpError(409, 'SESSION_STATE', 'Session is not running');
      if (rt.state.players.length === 0)
        throw new HttpError(409, 'SESSION_STATE', 'There are no trainees to probe');
      this.stopLoop(rt);
      rt.pending.push({
        kind: 'instructor',
        input: this.prepareInstructorInput(rt, { type: 'PROBE_START', probeId: 'pending' }),
      });
      if (!(await this.runTicks(rt, 1))) {
        // Nothing was stored: take the probe back out of the queue and carry on as before.
        rt.pending = rt.pending.filter(
          (q) => !(q.kind === 'instructor' && q.input.type === 'PROBE_START'),
        );
        this.startLoop(rt);
        throw new HttpError(500, 'INTERNAL_ERROR', 'Could not start the probe. Try again.');
      }
      rt.status = 'PAUSED';
      const row = await this.store.updateSession(sessionId, { status: 'PAUSED' });
      await this.logLifecycle(rt, 'SESSION_PAUSED');
      this.emitStatus(rt);
      return row;
    });
  }

  async resume(sessionId: string): Promise<SessionRow> {
    const rt = await this.requireRuntime(sessionId);
    return this.exclusive(rt, async () => {
      if (rt.status !== 'PAUSED')
        throw new HttpError(409, 'SESSION_STATE', 'Session is not paused');
      rt.status = 'RUNNING';
      const row = await this.store.updateSession(sessionId, { status: 'RUNNING' });
      await this.logLifecycle(rt, 'SESSION_RESUMED');
      this.startLoop(rt);
      this.emitStatus(rt);
      return row;
    });
  }

  async end(sessionId: string): Promise<SessionRow> {
    const session = await this.lobby.requireSession(sessionId);
    if (session.status === 'ENDED')
      throw new HttpError(409, 'SESSION_STATE', 'Session already ended');
    if (session.status === 'LOBBY') {
      const row = await this.store.updateSession(sessionId, {
        status: 'ENDED',
        endedAt: new Date(this.sched.now()),
      });
      this.io.to(room.session(sessionId)).emit(SOCKET_EVENTS.status, {
        status: 'ENDED',
        tick: 0,
        speed: row.speed,
      });
      return row;
    }
    const rt = await this.requireRuntime(sessionId);
    return this.exclusive(rt, async () => {
      const wasRunning = rt.status === 'RUNNING';
      this.stopLoop(rt);
      // Actions already acknowledged to a trainee must not be lost: apply what is still queued in one
      // last tick, and store its events, before the exercise is closed.
      // A probe still open is closed in that same tick, after any answers queued before it.
      const closing = rt.state.probes.length > 0;
      if (closing) rt.pending.push({ kind: 'instructor', input: { type: 'PROBE_CLOSE' } });
      if (rt.pending.length > 0 && !(await this.runTicks(rt, 1))) {
        if (closing)
          rt.pending = rt.pending.filter(
            (q) => !(q.kind === 'instructor' && q.input.type === 'PROBE_CLOSE'),
          );
        if (wasRunning) this.startLoop(rt);
        throw new HttpError(
          500,
          'INTERNAL_ERROR',
          'Could not store the last actions; the exercise was not ended. Try again.',
        );
      }
      rt.status = 'ENDED';
      const row = await this.store.updateSession(sessionId, {
        status: 'ENDED',
        endedAt: new Date(this.sched.now()),
      });
      await this.logLifecycle(rt, 'SESSION_ENDED');
      await this.onEnded(sessionId);
      this.emitStatus(rt);
      this.runtimes.delete(sessionId);
      return row;
    });
  }

  async setSpeed(sessionId: string, speed: Speed): Promise<SessionRow> {
    const session = await this.lobby.requireSession(sessionId);
    if (session.status === 'ENDED')
      throw new HttpError(409, 'SESSION_STATE', 'Session already ended');
    const row = await this.store.updateSession(sessionId, { speed });
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.speed = speed;
      this.emitStatus(rt);
    } else {
      this.io.to(room.session(sessionId)).emit(SOCKET_EVENTS.status, {
        status: row.status,
        tick: row.currentTick,
        speed,
      });
    }
    return row;
  }

  /** Queues a validated trainee action; it is applied (and logged) on the next tick. */
  async enqueue(sessionId: string, playerId: string, action: PlayerAction): Promise<void> {
    const rt = await this.ensureRuntime(sessionId);
    // A probe freezes the exercise, so its answers are the one action taken while it is paused. They
    // wait in the queue and are scored on the first tick after the instructor resumes (or ends).
    const frozenAnswer = action.type === 'PROBE_ANSWER' && rt?.status === 'PAUSED';
    if (!rt || (rt.status !== 'RUNNING' && !frozenAnswer)) {
      throw new HttpError(409, 'SESSION_STATE', 'The exercise is not running');
    }
    if (action.type === 'PROBE_ANSWER') {
      const open = rt.state.probes.find((p) => p.id === action.probeId);
      const queued = rt.pending.some(
        (q) =>
          q.kind === 'player' &&
          q.playerId === playerId &&
          q.action.type === 'PROBE_ANSWER' &&
          q.action.probeId === action.probeId,
      );
      if (!open || !open.pending.includes(playerId) || queued) {
        throw new HttpError(409, 'SESSION_STATE', 'That probe is closed or already answered');
      }
    }
    if (!rt.state.players.some((p) => p.id === playerId)) {
      throw new HttpError(403, 'NOT_IN_SESSION', 'You are not a player in this exercise');
    }
    if (rt.pending.length >= MAX_PENDING_INPUTS) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many pending actions');
    }
    rt.pending.push({ kind: 'player', playerId, action });
  }

  /** Queues an instructor action (live inject, jamming level, MSEL edit) for the next tick. */
  async enqueueInstructor(sessionId: string, input: InstructorInput): Promise<void> {
    const rt = await this.ensureRuntime(sessionId);
    if (!rt || rt.status !== 'RUNNING') {
      throw new HttpError(409, 'SESSION_STATE', 'The exercise is not running');
    }
    if (rt.pending.length >= MAX_PENDING_INPUTS) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many pending actions');
    }
    rt.pending.push({ kind: 'instructor', input: this.prepareInstructorInput(rt, input) });
  }

  /** Server-assigned ids and times, fixed here so the logged input replays identically. */
  private prepareInstructorInput(rt: Runtime, input: InstructorInput): InstructorInput {
    const parsed = instructorInputSchema.parse(input);
    if (parsed.type === 'INJECT_NOW') {
      return {
        type: 'INJECT_NOW',
        inject: {
          ...parsed.inject,
          id: `live-${randomUUID().slice(0, 8)}`,
          tick: rt.state.tick + 1,
        },
      };
    }
    if (parsed.type === 'PROBE_START') {
      return { type: 'PROBE_START', probeId: `probe-${randomUUID().slice(0, 8)}` };
    }
    if (parsed.type === 'MSEL_ADD') {
      return {
        type: 'MSEL_ADD',
        inject: { ...parsed.inject, id: `msel-${randomUUID().slice(0, 8)}` },
      };
    }
    return parsed;
  }

  // ---- views ----------------------------------------------------------------------------

  async perceivedFor(sessionId: string, playerId: string): Promise<PerceivedStateDto | null> {
    const rt = await this.ensureRuntime(sessionId);
    if (!rt || !rt.state.players.some((p) => p.id === playerId)) return null;
    return computePerceivedState(rt.state, playerId);
  }

  async truthFor(sessionId: string): Promise<TruthViewDto | null> {
    const rt = await this.ensureRuntime(sessionId);
    return rt ? buildTruthView(rt.state, rt.metrics) : null;
  }

  async broadcastLobby(sessionId: string): Promise<void> {
    try {
      const session = await this.lobby.requireSession(sessionId);
      this.io
        .to(room.session(sessionId))
        .emit(SOCKET_EVENTS.lobbyUpdate, await this.lobby.view(session));
    } catch (err) {
      this.log.error({ err, sessionId }, 'lobby broadcast failed');
    }
  }

  // ---- recovery -------------------------------------------------------------------------

  /** After a server restart: rebuild every RUNNING session by replaying its event log and continue. */
  async resumeAll(): Promise<void> {
    for (const session of await this.store.listRunnable()) {
      try {
        const rt = await this.ensureRuntime(session.id);
        if (rt && rt.status === 'RUNNING') this.startLoop(rt);
      } catch (err) {
        this.log.error({ err, sessionId: session.id }, 'could not resume session');
      }
    }
  }

  /** Rebuilds a session's runtime from SESSION_STARTED + logged inputs (deterministic replay). */
  async ensureRuntime(sessionId: string): Promise<Runtime | null> {
    const existing = this.runtimes.get(sessionId);
    if (existing) return existing;
    const session = await this.store.getSession(sessionId);
    if (!session || (session.status !== 'RUNNING' && session.status !== 'PAUSED')) return null;
    // Re-check after the awaits: another caller may have rebuilt it meanwhile.
    const raced = this.runtimes.get(sessionId);
    if (raced) return raced;

    const logged = await this.store.loadEvents(sessionId, ['SESSION_STARTED', 'INPUT']);
    const started = logged.find((e) => e.type === 'SESSION_STARTED');
    if (!started) throw new Error(`Session ${sessionId} has no SESSION_STARTED event`);
    const p = startedPayloadSchema.parse(started.payload);
    const initial = createTruthState(p.scenario, p.terrain, p.weather, p.seed, p.roster as Roster, {
      clean: p.clean,
    });

    const inputsByTick = inputsFromLog(logged);
    const { state, events: replayed } = replay(initial, inputsByTick, session.currentTick);
    const rt = this.makeRuntime(session, state);
    rt.metrics.ingest(replayed);
    this.runtimes.set(sessionId, rt);
    return rt;
  }

  shutdown(): void {
    for (const rt of this.runtimes.values()) this.stopLoop(rt);
  }

  /** Test/ops hook: run `batches` loop iterations right now (each is `speed` ticks). */
  async stepNow(sessionId: string, batches = 1): Promise<void> {
    const rt = await this.requireRuntime(sessionId);
    for (let i = 0; i < batches; i++) {
      await this.exclusive(rt, () => this.tickBatch(rt));
    }
  }

  // ---- internals ------------------------------------------------------------------------

  private makeRuntime(session: SessionRow, state: TruthState): Runtime {
    return {
      sessionId: session.id,
      state,
      rng: mulberry32(state.rngState),
      status: session.status,
      speed: session.speed,
      pending: [],
      metrics: new LiveMetrics(),
      timer: null,
      nextDue: 0,
      queue: Promise.resolve(),
    };
  }

  private async requireRuntime(sessionId: string): Promise<Runtime> {
    const rt = await this.ensureRuntime(sessionId);
    if (!rt) throw new HttpError(409, 'SESSION_STATE', 'Session is not running');
    return rt;
  }

  /** Serialises everything that touches a runtime's state. */
  private exclusive<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    const run = rt.queue.then(fn, fn);
    rt.queue = run.catch(() => undefined);
    return run;
  }

  private startLoop(rt: Runtime): void {
    this.stopLoop(rt);
    rt.nextDue = this.sched.now() + TICK_MS;
    this.schedule(rt);
  }

  private stopLoop(rt: Runtime): void {
    if (rt.timer !== null) this.sched.clearTimeout(rt.timer);
    rt.timer = null;
  }

  /** Drift-corrected: each tick is due at a fixed offset, not "1 s after the previous one finished". */
  private schedule(rt: Runtime): void {
    const delay = Math.max(0, rt.nextDue - this.sched.now());
    rt.timer = this.sched.setTimeout(() => void this.onTimer(rt), delay);
  }

  private async onTimer(rt: Runtime): Promise<void> {
    rt.timer = null;
    if (rt.status !== 'RUNNING') return;
    try {
      await this.exclusive(rt, () => this.tickBatch(rt));
    } catch (err) {
      this.log.error({ err, sessionId: rt.sessionId }, 'tick batch failed');
    }
    if (rt.status !== 'RUNNING') return;
    rt.nextDue += TICK_MS;
    const now = this.sched.now();
    if (rt.nextDue < now - MAX_LAG_MS) rt.nextDue = now; // fell far behind: do not burst to catch up
    this.schedule(rt);
  }

  /** Runs `speed` ticks, persists them atomically, then fans the results out. */
  private async tickBatch(rt: Runtime): Promise<void> {
    if (rt.status !== 'RUNNING') return;
    await this.runTicks(rt, rt.speed);
  }

  /** Steps the engine `ticks` times with the queued inputs. False when nothing could be persisted. */
  private async runTicks(rt: Runtime, ticks: number): Promise<boolean> {
    const before = rt.state;
    const inputs = rt.pending.splice(0);
    const events: EngineEvent[] = [];
    let state = before;
    for (let i = 0; i < ticks; i++) {
      const tickInputs = i === 0 ? inputs : [];
      for (const inp of tickInputs) {
        events.push({
          tick: state.tick + 1,
          type: 'INPUT',
          payload: inputPayload(inp),
          visibleTo: ['instructor'],
        });
      }
      const result = step(state, tickInputs.map(pendingToEngine), rt.rng);
      state = result.state;
      events.push(...result.events);
    }

    try {
      await this.store.commitBatch({
        sessionId: rt.sessionId,
        currentTick: state.tick,
        events: events.map(toRow),
        decisions: events.flatMap(decisionRows),
        grades: events.flatMap(gradeRows),
      });
    } catch (err) {
      // Nothing was persisted: roll the in-memory run back so memory and the log never diverge.
      this.log.error({ err, sessionId: rt.sessionId }, 'persisting tick batch failed; will retry');
      rt.state = before;
      rt.rng = mulberry32(before.rngState);
      rt.pending.unshift(...inputs);
      return false;
    }
    rt.state = state;
    rt.metrics.ingest(events);
    this.emitBatch(rt, events);
    return true;
  }

  private async logLifecycle(rt: Runtime, type: string): Promise<void> {
    await this.store.commitBatch({
      sessionId: rt.sessionId,
      currentTick: rt.state.tick,
      events: [{ tick: rt.state.tick, type, payload: {}, visibleTo: ['instructor'] }],
      decisions: [],
      grades: [],
    });
  }

  private emitStatus(rt: Runtime): void {
    this.io.to(room.session(rt.sessionId)).emit(SOCKET_EVENTS.status, {
      status: rt.status,
      tick: rt.state.tick,
      speed: rt.speed,
    });
  }

  /** Sends everyone their current picture (used on start). */
  private emitAll(rt: Runtime): void {
    this.emitBatch(rt, []);
  }

  private emitBatch(rt: Runtime, events: EngineEvent[]): void {
    const { sessionId, state } = rt;
    for (const player of state.players) {
      const target = this.io.to(room.player(sessionId, player.id));
      const perceived: PerceivedStateDto = computePerceivedState(state, player.id);
      target.emit(SOCKET_EVENTS.perceived, perceived);
      const mine = events
        .filter((e) => e.visibleTo.includes(player.id))
        .map((e) => ({ tick: e.tick, type: e.type, payload: e.payload }));
      if (mine.length > 0) target.emit(SOCKET_EVENTS.playerEvents, mine);
    }
    const instructor = this.io.to(room.instructor(sessionId));
    instructor.emit(SOCKET_EVENTS.truth, buildTruthView(state, rt.metrics));
    if (events.length > 0) instructor.emit(SOCKET_EVENTS.truthEvents, events);
    this.emitStatus(rt);
  }
}

const toRow = (e: EngineEvent): EventRow => ({
  tick: e.tick,
  type: e.type,
  payload: e.payload,
  visibleTo: e.visibleTo,
});

function decisionRows(e: EngineEvent): DecisionRow[] {
  if (e.type !== 'DECISION_MADE') return [];
  const p = decisionPayloadSchema.parse(e.payload);
  return [
    {
      playerId: p.playerId,
      tick: e.tick,
      actionType: p.actionType,
      payload: {
        targetContactId: p.targetContactId,
        basedOnMessageId: p.basedOnMessageId,
        outcome: p.outcome,
        latencyTicks: p.latencyTicks,
        spoofActed: p.spoofActed,
      },
      confidence: p.confidence,
      rationale: p.rationale,
      perceivedSnapshot: p.perceivedSnapshot,
      truthSnapshot: p.truthSnapshot,
      latencyMs: Math.round((p.latencyTicks ?? 0) * TICK_MS),
    },
  ];
}

function gradeRows(e: EngineEvent): GradeRow[] {
  if (e.type !== 'REPORT_GRADED') return [];
  return [gradePayloadSchema.parse(e.payload)];
}

/** Rebuilds the engine inputs of a session from its logged INPUT events, grouped by the tick they were applied on. */
export function inputsFromLog(logged: readonly EventRow[]): Map<number, EngineInput[]> {
  const inputsByTick = new Map<number, EngineInput[]>();
  for (const e of logged) {
    if (e.type !== 'INPUT') continue;
    const li = loggedInputSchema.parse(e.payload);
    const pending: Pending =
      'instructor' in li
        ? { kind: 'instructor', input: instructorInputSchema.parse(li.input) }
        : { kind: 'player', playerId: li.playerId, action: actionFromLog(li.action) };
    const list = inputsByTick.get(e.tick) ?? [];
    list.push(pendingToEngine(pending));
    inputsByTick.set(e.tick, list);
  }
  return inputsByTick;
}

/** A logged action was validated when accepted; re-validate it on replay. */
function actionFromLog(raw: unknown): PlayerAction {
  return playerActionSchema.parse(raw);
}
