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
} from '@vyuha/engine';
import {
  SOCKET_EVENTS,
  paceDefaultsSchema,
  playerActionSchema,
  playerRoleSchema,
  scenarioDefinitionSchema,
  terrainGridSchema,
  type PerceivedStateDto,
  type PlayerAction,
  type SessionStatus,
  type Speed,
  type TruthViewDto,
} from '@vyuha/shared';
import { z } from 'zod';
import { HttpError } from '../errors';
import type { GeoRepo } from '../geo/ingest';
import type { ScenarioRepo } from '../repos';
import type { LobbyService } from './lobby';
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

const startedPayloadSchema = z.object({
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
});

const loggedInputSchema = z.object({
  playerId: z.string(),
  action: z.unknown(),
});

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

interface Runtime {
  sessionId: string;
  state: TruthState;
  rng: Rng;
  status: SessionStatus;
  speed: Speed;
  pending: { playerId: string; action: PlayerAction }[];
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
  }
}

export function buildTruthView(state: TruthState): TruthViewDto {
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

    const state = createTruthState(scenario, terrain, weather, scenario.seed, roster);
    const startedPayload = { scenario, terrain, weather, roster, seed: scenario.seed };
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
      this.stopLoop(rt);
      rt.status = 'ENDED';
      const row = await this.store.updateSession(sessionId, {
        status: 'ENDED',
        endedAt: new Date(this.sched.now()),
      });
      await this.logLifecycle(rt, 'SESSION_ENDED');
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
    if (!rt || rt.status !== 'RUNNING') {
      throw new HttpError(409, 'SESSION_STATE', 'The exercise is not running');
    }
    if (!rt.state.players.some((p) => p.id === playerId)) {
      throw new HttpError(403, 'NOT_IN_SESSION', 'You are not a player in this exercise');
    }
    if (rt.pending.length >= MAX_PENDING_INPUTS) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many pending actions');
    }
    rt.pending.push({ playerId, action });
  }

  // ---- views ----------------------------------------------------------------------------

  async perceivedFor(sessionId: string, playerId: string): Promise<PerceivedStateDto | null> {
    const rt = await this.ensureRuntime(sessionId);
    if (!rt || !rt.state.players.some((p) => p.id === playerId)) return null;
    return computePerceivedState(rt.state, playerId);
  }

  async truthFor(sessionId: string): Promise<TruthViewDto | null> {
    const rt = await this.ensureRuntime(sessionId);
    return rt ? buildTruthView(rt.state) : null;
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
    const initial = createTruthState(p.scenario, p.terrain, p.weather, p.seed, p.roster as Roster);

    const inputsByTick = new Map<number, EngineInput[]>();
    for (const e of logged) {
      if (e.type !== 'INPUT') continue;
      const li = loggedInputSchema.parse(e.payload);
      const action = actionFromLog(li.action);
      const list = inputsByTick.get(e.tick) ?? [];
      list.push(toEngineInput(li.playerId, action));
      inputsByTick.set(e.tick, list);
    }
    const { state } = replay(initial, inputsByTick, session.currentTick);
    const rt = this.makeRuntime(session, state);
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
    const before = rt.state;
    const inputs = rt.pending.splice(0);
    const events: EngineEvent[] = [];
    let state = before;
    for (let i = 0; i < rt.speed; i++) {
      const tickInputs = i === 0 ? inputs : [];
      for (const inp of tickInputs) {
        events.push({
          tick: state.tick + 1,
          type: 'INPUT',
          payload: { playerId: inp.playerId, action: inp.action },
          visibleTo: ['instructor'],
        });
      }
      const result = step(
        state,
        tickInputs.map((x) => toEngineInput(x.playerId, x.action)),
        rt.rng,
      );
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
      return;
    }
    rt.state = state;
    this.emitBatch(rt, events);
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
    instructor.emit(SOCKET_EVENTS.truth, buildTruthView(state));
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

/** A logged action was validated when accepted; re-validate it on replay. */
function actionFromLog(raw: unknown): PlayerAction {
  return playerActionSchema.parse(raw);
}
