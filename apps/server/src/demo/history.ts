import { Server as SocketServer } from 'socket.io';
import type { PublicUser } from '@vyuha/shared';
import type { GeoRepo } from '../geo/ingest';
import { ProgressService } from '../progress/service';
import type { ScenarioRepo } from '../repos';
import { LobbyService } from '../sessions/lobby';
import { SessionManager, type ManagerLogger, type Scheduler } from '../sessions/manager';
import type { SessionStore } from '../sessions/store';
import {
  CHECK_EVERY_TICKS,
  SKILL_BY_SESSION,
  botActions,
  botRng,
  newBotMemory,
  type BotMemory,
} from './bots';

/** Roles and units of the demo team, in the same order as the bot users. */
export const DEMO_TEAM = [
  { role: 'PL_CDR', unitId: 'b-pl' },
  { role: 'SECTION_CDR', unitId: 'b-sec1' },
  { role: 'ISR_OPERATOR', unitId: 'b-uav' },
] as const;

/** Exercise length: past the last scripted inject (05:00) so every event of the MSEL plays out. */
export const DEMO_TICKS = 360;

export interface DemoOptions {
  store: SessionStore;
  scenarios: ScenarioRepo;
  geo: GeoRepo;
  scenarioId: string;
  /** One bot user per entry of DEMO_TEAM. */
  bots: readonly PublicUser[];
  /** Number of sessions to play (each one uses the next skill level, up to 3). */
  sessions?: number;
  ticks?: number;
  log?: ManagerLogger;
  onProgress?: (message: string) => void;
}

export interface DemoSessionResult {
  sessionId: string;
  code: string;
}

/** Never fires by itself: the demo drives time explicitly, so a run takes seconds, not minutes. */
const steppedScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: () => 0,
  clearTimeout: () => undefined,
};

const silent: ManagerLogger = { error: () => undefined, warn: () => undefined };

/**
 * Plays real exercises through the same lobby, session manager, event log and metric recording that live
 * sessions use, with scripted bots at the controls. Nothing is typed in by hand: every number in the
 * progress charts comes out of the engine's scoring of what the bots did.
 */
export async function runDemoHistory(opts: DemoOptions): Promise<DemoSessionResult[]> {
  if (opts.bots.length !== DEMO_TEAM.length) {
    throw new Error(`The demo team needs exactly ${DEMO_TEAM.length} bot users`);
  }
  const count = Math.min(opts.sessions ?? 3, SKILL_BY_SESSION.length);
  const log = opts.log ?? silent;
  const lobby = new LobbyService(opts.store, opts.scenarios);
  const progress = new ProgressService(opts.store, log);
  const io = new SocketServer(); // not attached to a server: nobody is listening
  const manager = new SessionManager(
    opts.store,
    opts.scenarios,
    opts.geo,
    lobby,
    io,
    log,
    steppedScheduler,
    (id) => progress.recordSession(id),
  );

  const results: DemoSessionResult[] = [];
  try {
    for (let k = 0; k < count; k++) {
      opts.onProgress?.(`Session ${k + 1} of ${count}: setting up`);
      const created = await lobby.createSession(opts.scenarioId);
      const playerIds: string[] = [];
      for (const bot of opts.bots) {
        playerIds.push((await lobby.join(created.code, bot)).player.id);
      }
      const team = await lobby.createTeam(created, { name: 'Alpha' });
      for (const [i, member] of DEMO_TEAM.entries()) {
        await lobby.assignPlayer(created, playerIds[i] ?? '', {
          teamId: team.id,
          role: member.role,
          unitId: member.unitId,
        });
      }

      await manager.start(created.id);
      const skill = SKILL_BY_SESSION[k] ?? SKILL_BY_SESSION[SKILL_BY_SESSION.length - 1];
      if (!skill) throw new Error('no skill levels defined');
      const memory: BotMemory[] = playerIds.map(() => newBotMemory());
      const rngs = playerIds.map((_, i) => botRng(k, i));

      const ticks = opts.ticks ?? DEMO_TICKS;
      for (let t = 0; t < ticks; t++) {
        await manager.stepNow(created.id, 1);
        if (t % CHECK_EVERY_TICKS !== 0) continue;
        for (const [i, playerId] of playerIds.entries()) {
          const view = await manager.perceivedFor(created.id, playerId);
          const mem = memory[i];
          const rng = rngs[i];
          if (!view || !mem || !rng) continue;
          for (const action of botActions(view, mem, skill, i, rng)) {
            await manager.enqueue(created.id, playerId, action);
          }
        }
      }
      await manager.end(created.id);
      results.push({ sessionId: created.id, code: created.code });
      opts.onProgress?.(`Session ${k + 1} of ${count}: finished (${created.code})`);
    }
  } finally {
    manager.shutdown(); // the Socket.IO server was never attached to an HTTP server: nothing to close
  }
  return results;
}
