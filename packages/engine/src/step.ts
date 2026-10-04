import {
  ADAPT_INTERVAL_TICKS,
  AUTH_DELAY_TICKS,
  BANDWIDTH_PER_TICK,
  BEACON_INTERVAL_TICKS,
  DRIFT_SAMPLE_INTERVAL_TICKS,
  ISR_TASK_TICKS,
  profileFor,
  RUNNER_ARRIVAL_M,
  RUNNER_SPEED_MPS,
  STATE_PRUNE_TICKS,
  SWITCH_EXTRA_DELAY_TICKS,
  SWITCH_PENALTY_TICKS,
} from './config';
import { adaptJamming, zeroUsage } from './ew';
import { bearingDeg, clamp, haversineM, stepToward } from './geometry';
import { computePictureDrift } from './metrics';
import { computePerceivedState } from './perceived';
import type { Rng } from './prng';
import { corruptPosition, corruptText, deliverMessage, elevationAt } from './radio';
import { isSensor, makeConflictingPair, senseTick } from './reports';
import {
  adversaryActive,
  cloneState,
  currentJamming,
  getPlayer,
  getTeam,
  getUnit,
  recipientsForUnit,
  satcomUp,
} from './state';
import type {
  Channel,
  DeliveredReport,
  EngineEvent,
  EngineInput,
  EngineUnit,
  Inject,
  InboxMessage,
  LatLon,
  Message,
  MessageKind,
  PlayerSpec,
  Report,
  StepResult,
  TeamState,
  TruthState,
} from './types';

interface Ctx {
  s: TruthState;
  rng: Rng;
  events: EngineEvent[];
  /** Messages already sent this tick per `team|channel`, for the bandwidth model. */
  tickUsage: Map<string, number>;
}

const INSTRUCTOR = 'instructor';
const ACTING_ACTIONS = new Set(['COMPLY_ORDER', 'WITHDRAW', 'REPOSITION', 'ENGAGE']);

function emit(ctx: Ctx, type: string, payload: Record<string, unknown>, visibleTo: string[]): void {
  ctx.events.push({ tick: ctx.s.tick, type, payload, visibleTo });
}

function reject(ctx: Ctx, playerId: string | null, input: string, reason: string): void {
  emit(
    ctx,
    'INPUT_REJECTED',
    { playerId, input, reason },
    playerId ? [playerId, INSTRUCTOR] : [INSTRUCTOR],
  );
}

const allPlayerIds = (s: TruthState): string[] => s.players.map((p) => p.id);
const teamPlayerIds = (s: TruthState, teamId: string): string[] =>
  s.players.filter((p) => p.teamId === teamId).map((p) => p.id);

/**
 * Advances the exercise by one tick (1 s of exercise time). Pure: returns a new state and the
 * events produced; all randomness comes from the supplied seeded `rng`.
 */
export function step(state: TruthState, inputs: readonly EngineInput[], rng: Rng): StepResult {
  const s = cloneState(state);
  s.tick = state.tick + 1;
  const ctx: Ctx = { s, rng, events: [], tickUsage: new Map() };
  const jamBefore = currentJamming(state);

  fireScheduledInjects(ctx);
  for (const input of inputs) applyInput(ctx, input);
  moveUnits(ctx);
  moveRunners(ctx);
  adaptEw(ctx);
  sense(ctx);
  sendBeacons(ctx);
  deliverDue(ctx);
  resolveAuthentications(ctx);
  sampleDrift(ctx);
  prune(ctx);

  const jamAfter = currentJamming(s);
  if (
    (Object.keys(jamAfter) as Channel[]).some((c) => Math.abs(jamAfter[c] - jamBefore[c]) > 0.005)
  ) {
    emit(ctx, 'JAMMING_CHANGED', { jamming: jamAfter, satcomUp: satcomUp(s) }, [INSTRUCTOR]);
  }

  s.rngState = rng.state();
  return { state: s, events: ctx.events };
}

// ---- Injects --------------------------------------------------------------------------

function fireScheduledInjects(ctx: Ctx): void {
  const { s } = ctx;
  for (const inject of s.msel) {
    if (inject.tick <= s.tick && !s.firedInjectIds.includes(inject.id)) {
      s.firedInjectIds.push(inject.id);
      applyInject(ctx, inject, 'MSEL');
    }
  }
}

function applyInject(ctx: Ctx, inject: Inject, source: 'MSEL' | 'LIVE'): void {
  const { s } = ctx;
  const fail = (reason: string): void =>
    emit(ctx, 'INJECT_FAILED', { injectId: inject.id, type: inject.type, reason }, [INSTRUCTOR]);
  emit(
    ctx,
    'INJECT_FIRED',
    { injectId: inject.id, type: inject.type, title: inject.title, source },
    [INSTRUCTOR],
  );

  switch (inject.type) {
    case 'JAM_CHANNEL':
      s.jamWindows.push({
        id: inject.id,
        channel: inject.channel,
        intensity: inject.intensity,
        untilTick: s.tick + inject.durationTicks,
      });
      return;
    case 'SATCOM_OUTAGE':
      s.satcomDownUntilTick = Math.max(s.satcomDownUntilTick, s.tick + inject.durationTicks);
      return;
    case 'WEATHER_CHANGE':
      s.weather = {
        visibilityM: inject.visibilityM,
        precipitationMm: inject.precipitationMm,
        windKph: inject.windKph,
      };
      emit(ctx, 'WEATHER_CHANGED', { ...s.weather }, [INSTRUCTOR, ...allPlayerIds(s)]);
      return;
    case 'ADVERSARY_MOVE': {
      const unit = getUnit(s, inject.unitId);
      if (!unit) return fail('unknown unit');
      if (unit.speed <= 0) return fail('unit cannot move');
      unit.destination = { ...inject.destination };
      return;
    }
    case 'CONFLICTING_REPORTS': {
      const subject = getUnit(s, inject.unitId);
      if (!subject) return fail('unknown unit');
      const pair = makeConflictingPair(s, ctx.rng, subject, inject.altPosition, inject.altType);
      if (pair.length === 0) return fail('no friendly sensor available');
      for (const report of pair) registerReport(ctx, report);
      return;
    }
    case 'SPOOF_ORDER': {
      const target = getUnit(s, inject.targetUnitId);
      if (!target) return fail('unknown unit');
      for (const player of recipientsForUnit(s, target.id)) {
        const team = getTeam(s, player.teamId);
        const message = newMessage(s, {
          kind: 'ORDER',
          fromUnitId: null,
          fromLabel: inject.purportedSender,
          toPlayerId: player.id,
          channel: team?.activeChannel ?? 'VHF',
          text: inject.orderText,
          position: null,
          reportId: null,
          subjectUnitId: null,
          spoof: true,
        });
        s.inFlight.push({ message, deliverAtTick: s.tick + 1, corrupted: false });
        emit(
          ctx,
          'SPOOF_INJECTED',
          {
            messageId: message.id,
            playerId: player.id,
            text: message.text,
            from: message.fromLabel,
          },
          [INSTRUCTOR],
        );
      }
      return;
    }
    case 'RUNNER_DISPATCH': {
      const from = getUnit(s, inject.fromUnitId);
      const to = getUnit(s, inject.toUnitId);
      if (!from || !to) return fail('unknown unit');
      const recipients = recipientsForUnit(s, to.id);
      spawnRunner(ctx, from, to.id, recipients, {
        kind: 'ORDER',
        fromUnitId: from.id,
        fromLabel: from.name,
        text: inject.messageText,
      });
      return;
    }
  }
}

// ---- Message transport ----------------------------------------------------------------

type NewMessage = Omit<Message, 'id' | 'sentTick'>;

function newMessage(s: TruthState, m: NewMessage): Message {
  s.counters.message += 1;
  return { ...m, id: `msg-${s.counters.message}`, sentTick: s.tick };
}

interface Outgoing {
  kind: MessageKind;
  fromUnit: EngineUnit;
  fromLabel: string;
  toPlayer: PlayerSpec;
  /** Team whose channel, bandwidth and adaptive-EW usage this traffic counts against. */
  team: TeamState;
  channel: Channel;
  text: string;
  position: LatLon | null;
  reportId: string | null;
  subjectUnitId: string | null;
}

/** Sends one message over a radio channel: link quality, seeded outcome, corruption, queueing. */
function transmit(ctx: Ctx, out: Outgoing): void {
  const { s, rng } = ctx;
  const toUnit = getUnit(s, out.toPlayer.unitId);
  if (!toUnit) return;
  out.team.usage[out.channel] += 1;

  const key = `${out.team.id}|${out.channel}`;
  const already = ctx.tickUsage.get(key) ?? 0;
  ctx.tickUsage.set(key, already + 1);
  const queueDelay = Math.floor(already / BANDWIDTH_PER_TICK[out.channel]);
  const switchDelay =
    out.team.switchedAtTick !== null && s.tick - out.team.switchedAtTick < SWITCH_PENALTY_TICKS
      ? SWITCH_EXTRA_DELAY_TICKS
      : 0;

  const result = deliverMessage(
    rng,
    {
      channel: out.channel,
      from: out.fromUnit.position,
      to: toUnit.position,
      fromHeightM: profileFor(out.fromUnit.type).antennaM,
      toHeightM: profileFor(toUnit.type).antennaM,
    },
    { terrain: s.terrain, weather: s.weather, jamming: currentJamming(s), satcomUp: satcomUp(s) },
  );

  let text = out.text;
  let position = out.position;
  const corrupted = result.outcome === 'CORRUPTED';
  if (corrupted) {
    text = corruptText(rng, out.text);
    if (position) position = corruptPosition(rng, position);
  }

  const message = newMessage(s, {
    kind: out.kind,
    fromUnitId: out.fromUnit.id,
    fromLabel: out.fromLabel,
    toPlayerId: out.toPlayer.id,
    channel: out.channel,
    text,
    position,
    reportId: out.reportId,
    subjectUnitId: out.subjectUnitId,
    spoof: false,
  });

  emit(
    ctx,
    'MESSAGE_OUTCOME',
    {
      messageId: message.id,
      kind: out.kind,
      fromUnitId: out.fromUnit.id,
      toPlayerId: out.toPlayer.id,
      channel: out.channel,
      outcome: result.outcome,
      quality: result.quality,
      los: result.los,
      distanceM: result.distanceM,
      jamming: result.jamming,
      delayTicks: result.delayTicks,
      queueDelayTicks: queueDelay,
      switchDelayTicks: switchDelay,
      originalText: out.text,
      deliveredText: text,
    },
    [INSTRUCTOR],
  );
  if (out.kind === 'TEXT') {
    const sender = s.players.find((p) => p.unitId === out.fromUnit.id);
    emit(
      ctx,
      'MESSAGE_SENT',
      { messageId: message.id, toPlayerId: out.toPlayer.id, channel: out.channel, text: out.text },
      sender ? [sender.id, INSTRUCTOR] : [INSTRUCTOR],
    );
  }

  if (result.outcome === 'DROPPED' || result.delayTicks === null) return;
  s.inFlight.push({
    message,
    deliverAtTick: s.tick + result.delayTicks + queueDelay + switchDelay,
    corrupted,
  });
}

function spawnRunner(
  ctx: Ctx,
  from: EngineUnit,
  targetUnitId: string,
  recipients: PlayerSpec[],
  m: Pick<Message, 'kind' | 'fromUnitId' | 'fromLabel' | 'text'>,
): void {
  const { s } = ctx;
  s.counters.runner += 1;
  const message = newMessage(s, {
    kind: m.kind,
    fromUnitId: m.fromUnitId,
    fromLabel: m.fromLabel,
    toPlayerId: recipients[0]?.id ?? '',
    channel: 'RUNNER',
    text: m.text,
    position: null,
    reportId: null,
    subjectUnitId: null,
    spoof: false,
  });
  s.runners.push({
    id: `run-${s.counters.runner}`,
    message,
    targetUnitId,
    recipients: recipients.map((p) => p.id),
    position: { ...from.position },
  });
  emit(
    ctx,
    'RUNNER_DISPATCHED',
    {
      messageId: message.id,
      fromUnitId: from.id,
      targetUnitId,
      recipients: recipients.map((p) => p.id),
    },
    [INSTRUCTOR, ...recipients.map((p) => p.id)],
  );
}

function addInbox(ctx: Ctx, playerId: string, m: Message): void {
  const k = ctx.s.knowledge[playerId];
  if (!k || k.inbox.some((x) => x.id === m.id)) return;
  const entry: InboxMessage = {
    id: m.id,
    kind: m.kind,
    fromLabel: m.fromLabel,
    channel: m.channel,
    sentTick: m.sentTick,
    receivedTick: ctx.s.tick,
    text: m.text,
    position: m.position,
    spoof: m.spoof,
    authState: 'NONE',
  };
  k.inbox.push(entry);
  emit(
    ctx,
    'MESSAGE_RECEIVED',
    {
      playerId,
      messageId: m.id,
      kind: m.kind,
      from: m.fromLabel,
      channel: m.channel,
      sentTick: m.sentTick,
      text: m.text,
      position: m.position,
    },
    [playerId, INSTRUCTOR],
  );
}

function giveReport(ctx: Ctx, playerId: string, d: DeliveredReport): void {
  const k = ctx.s.knowledge[playerId];
  if (!k || k.reports.some((r) => r.reportId === d.reportId)) return;
  k.reports.push(d);
  emit(
    ctx,
    'REPORT_RECEIVED',
    {
      playerId,
      contactId: d.reportId,
      position: d.position,
      type: d.type,
      observedTick: d.observedTick,
      via: d.via,
    },
    [playerId, INSTRUCTOR],
  );
}

function deliverDue(ctx: Ctx): void {
  const { s } = ctx;
  const due = s.inFlight.filter((f) => f.deliverAtTick <= s.tick);
  s.inFlight = s.inFlight.filter((f) => f.deliverAtTick > s.tick);
  for (const f of due) {
    const m = f.message;
    const k = s.knowledge[m.toPlayerId];
    if (!k) continue;
    if (m.kind === 'REPORT') {
      const report = s.reports.find((r) => r.id === m.reportId);
      if (!report || !m.position) continue;
      giveReport(ctx, m.toPlayerId, {
        reportId: report.id,
        observedTick: report.tick,
        receivedTick: s.tick,
        position: m.position,
        type: report.type,
        via: m.channel,
        corrupted: f.corrupted,
      });
    } else if (m.kind === 'POSITION') {
      if (!m.subjectUnitId || !m.position) continue;
      const prev = k.friendlies[m.subjectUnitId];
      if (!prev || prev.observedTick <= m.sentTick) {
        k.friendlies[m.subjectUnitId] = {
          position: m.position,
          observedTick: m.sentTick,
          receivedTick: s.tick,
        };
      }
    } else {
      addInbox(ctx, m.toPlayerId, m);
    }
  }
}

// ---- Sensing and reports --------------------------------------------------------------

function registerReport(ctx: Ctx, report: Report): void {
  const { s } = ctx;
  s.reports.push(report);
  emit(
    ctx,
    'REPORT_GENERATED',
    {
      reportId: report.id,
      sensorUnitId: report.sensorUnitId,
      subjectUnitId: report.subjectUnitId,
      ghost: report.ghost,
      trueReliability: report.trueReliability,
      trueCredibility: report.trueCredibility,
      conflictGroup: report.conflictGroup,
      position: report.position,
      type: report.type,
    },
    [INSTRUCTOR],
  );

  const sensor = getUnit(s, report.sensorUnitId);
  if (!sensor) return;
  const owner = s.players.find((p) => p.unitId === sensor.id);
  const relay = (to: PlayerSpec): void => {
    const team = getTeam(s, to.teamId);
    if (!team) return;
    transmit(ctx, {
      kind: 'REPORT',
      fromUnit: sensor,
      fromLabel: sensor.name,
      toPlayer: to,
      team,
      channel: team.activeChannel,
      text: `Contact report ${report.id}`,
      position: report.position,
      reportId: report.id,
      subjectUnitId: null,
    });
  };

  if (owner) {
    giveReport(ctx, owner.id, {
      reportId: report.id,
      observedTick: report.tick,
      receivedTick: s.tick,
      position: { ...report.position },
      type: report.type,
      via: 'DIRECT',
      corrupted: false,
    });
    for (const mate of s.players)
      if (mate.teamId === owner.teamId && mate.id !== owner.id) relay(mate);
  } else {
    // Unmanned friendly sensor (e.g. HQ): its reports reach every platoon commander over their net.
    for (const pl of s.players.filter((p) => p.role === 'PL_CDR')) relay(pl);
  }
}

function sense(ctx: Ctx): void {
  for (const report of senseTick(ctx.s, ctx.rng)) registerReport(ctx, report);
}

function sendBeacons(ctx: Ctx): void {
  const { s } = ctx;
  s.players.forEach((player, idx) => {
    if ((s.tick + idx) % BEACON_INTERVAL_TICKS !== 0) return;
    const unit = getUnit(s, player.unitId);
    const team = getTeam(s, player.teamId);
    if (!unit || !team || unit.status === 'DESTROYED' || unit.status === 'OFFLINE') return;
    for (const mate of s.players) {
      if (mate.teamId !== player.teamId || mate.id === player.id) continue;
      transmit(ctx, {
        kind: 'POSITION',
        fromUnit: unit,
        fromLabel: unit.name,
        toPlayer: mate,
        team,
        channel: team.activeChannel,
        text: 'Position beacon',
        position: { ...unit.position },
        reportId: null,
        subjectUnitId: unit.id,
      });
    }
  });
}

// ---- Movement -------------------------------------------------------------------------

function moveUnits(ctx: Ctx): void {
  const { s } = ctx;
  for (const unit of s.units) {
    if (!unit.destination || unit.status === 'DESTROYED' || unit.status === 'OFFLINE') continue;
    let perTick = unit.speed;
    if (unit.domain === 'LAND' && perTick > 0) {
      // Slope slows ground movement: speed / (1 + 4 * |grade|), never below 20 %.
      const probe = stepToward(unit.position, unit.destination, Math.max(perTick, 1));
      const run = Math.max(haversineM(unit.position, probe.position), 1);
      const grade =
        Math.abs(elevationAt(s.terrain, probe.position) - elevationAt(s.terrain, unit.position)) /
        run;
      perTick *= clamp(1 / (1 + 4 * grade), 0.2, 1);
    }
    unit.heading = bearingDeg(unit.position, unit.destination);
    const moved = stepToward(unit.position, unit.destination, perTick);
    unit.position = moved.position;
    if (moved.arrived) {
      unit.destination = null;
      const owner = s.players.find((p) => p.unitId === unit.id);
      emit(ctx, 'UNIT_ARRIVED', { unitId: unit.id }, owner ? [owner.id, INSTRUCTOR] : [INSTRUCTOR]);
    }
  }
}

function moveRunners(ctx: Ctx): void {
  const { s } = ctx;
  const remaining: typeof s.runners = [];
  for (const runner of s.runners) {
    const target = getUnit(s, runner.targetUnitId);
    if (!target) continue;
    const moved = stepToward(runner.position, target.position, RUNNER_SPEED_MPS);
    runner.position = moved.position;
    if (haversineM(runner.position, target.position) <= RUNNER_ARRIVAL_M) {
      for (const pid of runner.recipients) addInbox(ctx, pid, runner.message);
      emit(
        ctx,
        'RUNNER_ARRIVED',
        { runnerId: runner.id, messageId: runner.message.id, recipients: runner.recipients },
        [INSTRUCTOR],
      );
    } else {
      remaining.push(runner);
    }
  }
  s.runners = remaining;
}

// ---- Adaptive EW, authentication, drift, housekeeping ----------------------------------

function adaptEw(ctx: Ctx): void {
  const { s } = ctx;
  if (s.tick % ADAPT_INTERVAL_TICKS !== 0) return;
  if (adversaryActive(s)) {
    s.adaptiveJam = adaptJamming(s.adaptiveJam, s.teams);
    emit(
      ctx,
      'EW_ADAPTED',
      {
        adaptive: s.adaptiveJam,
        usage: Object.fromEntries(s.teams.map((t) => [t.id, t.usage])),
      },
      [INSTRUCTOR],
    );
  }
  for (const team of s.teams) team.usage = zeroUsage();
}

function resolveAuthentications(ctx: Ctx): void {
  const { s } = ctx;
  for (const [playerId, k] of Object.entries(s.knowledge)) {
    const dueNow = k.auth.filter((a) => a.resolveAtTick <= s.tick);
    k.auth = k.auth.filter((a) => a.resolveAtTick > s.tick);
    for (const a of dueNow) {
      const msg = k.inbox.find((m) => m.id === a.messageId);
      if (!msg) continue;
      msg.authState = msg.spoof ? 'FAILED' : 'VERIFIED';
      emit(ctx, 'AUTH_RESOLVED', { playerId, messageId: msg.id, result: msg.authState }, [
        playerId,
        INSTRUCTOR,
      ]);
    }
  }
}

function sampleDrift(ctx: Ctx): void {
  const { s } = ctx;
  if (s.tick % DRIFT_SAMPLE_INTERVAL_TICKS !== 0) return;
  for (const player of s.players) {
    emit(ctx, 'DRIFT_SAMPLE', { playerId: player.id, ...computePictureDrift(s, player.id) }, [
      INSTRUCTOR,
    ]);
  }
}

function prune(ctx: Ctx): void {
  const { s } = ctx;
  s.reports = s.reports.filter((r) => s.tick - r.tick <= STATE_PRUNE_TICKS);
  for (const k of Object.values(s.knowledge)) {
    k.reports = k.reports.filter((r) => s.tick - r.observedTick <= STATE_PRUNE_TICKS);
  }
  s.jamWindows = s.jamWindows.filter((w) => w.untilTick > s.tick);
}

// ---- Player / instructor inputs ---------------------------------------------------------

/** Live MSEL editing: only injects that have not fired yet can be added, changed or removed. */
function editMsel(
  ctx: Ctx,
  input: Extract<EngineInput, { type: 'MSEL_ADD' | 'MSEL_UPDATE' | 'MSEL_REMOVE' }>,
): void {
  const { s } = ctx;
  const id = input.type === 'MSEL_REMOVE' ? input.injectId : input.inject.id;
  const existing = s.msel.findIndex((i) => i.id === id);
  const fired = s.firedInjectIds.includes(id);

  if (input.type === 'MSEL_ADD') {
    if (existing >= 0 || fired) return reject(ctx, null, input.type, 'duplicate inject id');
    if (input.inject.tick < s.tick)
      return reject(ctx, null, input.type, 'inject time is in the past');
    s.msel.push(input.inject);
  } else {
    if (existing < 0) return reject(ctx, null, input.type, 'unknown inject');
    if (fired) return reject(ctx, null, input.type, 'inject has already fired');
    if (input.type === 'MSEL_REMOVE') {
      s.msel.splice(existing, 1);
    } else {
      if (input.inject.tick < s.tick)
        return reject(ctx, null, input.type, 'inject time is in the past');
      s.msel[existing] = input.inject;
    }
  }
  s.msel.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
  emit(ctx, 'MSEL_CHANGED', { change: input.type, injectId: id }, [INSTRUCTOR]);
}

function applyInput(ctx: Ctx, input: EngineInput): void {
  const { s } = ctx;
  if (input.type === 'INJECT') {
    if (s.firedInjectIds.includes(input.inject.id))
      return reject(ctx, null, input.type, 'duplicate inject id');
    s.firedInjectIds.push(input.inject.id);
    return applyInject(ctx, input.inject, 'LIVE');
  }
  if (input.type === 'SET_JAMMING') {
    if (input.channel === 'RUNNER') return reject(ctx, null, input.type, 'RUNNER cannot be jammed');
    s.manualJam[input.channel] = clamp(input.intensity, 0, 1);
    emit(ctx, 'JAMMING_SET', { channel: input.channel, intensity: s.manualJam[input.channel] }, [
      INSTRUCTOR,
    ]);
    return;
  }

  if (input.type === 'MSEL_ADD' || input.type === 'MSEL_UPDATE' || input.type === 'MSEL_REMOVE') {
    return editMsel(ctx, input);
  }

  const player = getPlayer(s, input.playerId);
  const team = player ? getTeam(s, player.teamId) : undefined;
  const unit = player ? getUnit(s, player.unitId) : undefined;
  if (!player || !team || !unit) return reject(ctx, null, input.type, 'unknown player');
  const k = s.knowledge[player.id];
  if (!k) return reject(ctx, player.id, input.type, 'unknown player');
  if (unit.status === 'DESTROYED' || unit.status === 'OFFLINE') {
    return reject(ctx, player.id, input.type, 'your unit is out of action');
  }

  switch (input.type) {
    case 'SEND_MESSAGE': {
      const to = getPlayer(s, input.toPlayerId);
      const text = input.text.trim();
      if (!to || to.id === player.id)
        return reject(ctx, player.id, input.type, 'invalid recipient');
      if (text.length === 0 || text.length > 500)
        return reject(ctx, player.id, input.type, 'message must be 1-500 characters');
      if (input.channel === 'RUNNER') {
        team.usage.RUNNER += 1;
        spawnRunner(ctx, unit, to.unitId, [to], {
          kind: 'TEXT',
          fromUnitId: unit.id,
          fromLabel: unit.name,
          text,
        });
        return;
      }
      transmit(ctx, {
        kind: 'TEXT',
        fromUnit: unit,
        fromLabel: unit.name,
        toPlayer: to,
        team,
        channel: input.channel,
        text,
        position: input.position ? { ...input.position } : null,
        reportId: null,
        subjectUnitId: null,
      });
      return;
    }
    case 'MOVE_UNIT': {
      const target = getUnit(s, input.unitId);
      const owner = s.players.find((p) => p.unitId === input.unitId);
      const allowed =
        !!target &&
        (input.unitId === unit.id ||
          (player.role === 'PL_CDR' && owner !== undefined && owner.teamId === player.teamId));
      if (!target || !allowed)
        return reject(ctx, player.id, input.type, 'you cannot command that unit');
      const b = s.terrain.bbox;
      const d = input.destination;
      if (d.lat < b.south || d.lat > b.north || d.lon < b.west || d.lon > b.east) {
        return reject(ctx, player.id, input.type, 'destination outside the exercise area');
      }
      if (target.speed <= 0 || target.status === 'DESTROYED' || target.status === 'OFFLINE') {
        return reject(ctx, player.id, input.type, 'unit cannot move');
      }
      target.destination = { ...d };
      emit(ctx, 'UNIT_MOVE_ORDERED', { playerId: player.id, unitId: target.id, destination: d }, [
        player.id,
        INSTRUCTOR,
      ]);
      return;
    }
    case 'REQUEST_ISR': {
      const asset = s.players
        .filter((p) => p.teamId === player.teamId)
        .map((p) => getUnit(s, p.unitId))
        .find((u): u is EngineUnit => !!u && u.domain === 'AIR' && u.speed > 0 && isSensor(u));
      if (!asset) return reject(ctx, player.id, input.type, 'no ISR asset on your team');
      asset.destination = { ...input.target };
      asset.isrUntilTick = s.tick + ISR_TASK_TICKS;
      emit(ctx, 'ISR_REQUESTED', { playerId: player.id, unitId: asset.id, target: input.target }, [
        ...teamPlayerIds(s, player.teamId),
        INSTRUCTOR,
      ]);
      return;
    }
    case 'GRADE_REPORT': {
      const delivered = k.reports.find((r) => r.reportId === input.reportId);
      const truth = s.reports.find((r) => r.id === input.reportId);
      if (!delivered || !truth) return reject(ctx, player.id, input.type, 'unknown contact');
      k.grades[input.reportId] = {
        reliability: input.reliability,
        credibility: input.credibility,
        tick: s.tick,
      };
      emit(
        ctx,
        'REPORT_GRADED',
        {
          playerId: player.id,
          reportId: input.reportId,
          gradedReliability: input.reliability,
          gradedCredibility: input.credibility,
          trueReliability: truth.trueReliability,
          trueCredibility: truth.trueCredibility,
        },
        [INSTRUCTOR],
      );
      emit(
        ctx,
        'REPORT_GRADE_RECORDED',
        {
          playerId: player.id,
          reportId: input.reportId,
          reliability: input.reliability,
          credibility: input.credibility,
        },
        [player.id],
      );
      return;
    }
    case 'AUTHENTICATE': {
      const msg = k.inbox.find((m) => m.id === input.messageId);
      if (!msg || msg.kind !== 'ORDER') return reject(ctx, player.id, input.type, 'no such order');
      if (msg.authState !== 'NONE')
        return reject(ctx, player.id, input.type, 'already authenticated or pending');
      msg.authState = 'PENDING';
      k.auth.push({ messageId: msg.id, resolveAtTick: s.tick + AUTH_DELAY_TICKS });
      emit(
        ctx,
        'AUTH_STARTED',
        { playerId: player.id, messageId: msg.id, resolveAtTick: s.tick + AUTH_DELAY_TICKS },
        [player.id, INSTRUCTOR],
      );
      return;
    }
    case 'SWITCH_CHANNEL': {
      if (input.channel === team.activeChannel)
        return reject(ctx, player.id, input.type, 'already on that channel');
      const from = team.activeChannel;
      team.activeChannel = input.channel;
      team.switchedAtTick = s.tick;
      emit(
        ctx,
        'CHANNEL_SWITCHED',
        { playerId: player.id, teamId: team.id, from, to: input.channel },
        [...teamPlayerIds(s, team.id), INSTRUCTOR],
      );
      return;
    }
    case 'DECISION':
      return applyDecision(ctx, player, input);
  }
}

function applyDecision(
  ctx: Ctx,
  player: PlayerSpec,
  input: Extract<EngineInput, { type: 'DECISION' }>,
): void {
  const { s } = ctx;
  const k = s.knowledge[player.id];
  if (!k) return;
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 100) {
    return reject(ctx, player.id, input.type, 'confidence must be 0-100');
  }
  if (input.rationale.trim().length < 10) {
    return reject(ctx, player.id, input.type, 'rationale must be at least 10 characters');
  }
  const contact = input.targetContactId
    ? k.reports.find((r) => r.reportId === input.targetContactId)
    : undefined;
  const order = input.basedOnMessageId
    ? k.inbox.find((m) => m.id === input.basedOnMessageId)
    : undefined;
  if (input.targetContactId && !contact)
    return reject(ctx, player.id, input.type, 'unknown contact');
  if (input.basedOnMessageId && !order)
    return reject(ctx, player.id, input.type, 'unknown message');

  // Latency: time since the earliest relevant information reached this player.
  const arrivals = [contact?.receivedTick, order?.receivedTick].filter(
    (t): t is number => t !== undefined,
  );
  const latencyTicks = arrivals.length ? s.tick - Math.min(...arrivals) : null;

  let outcome: 0 | 1 | null = null;
  if (order && (input.actionType === 'COMPLY_ORDER' || input.actionType === 'IGNORE_ORDER')) {
    const comply = input.actionType === 'COMPLY_ORDER';
    outcome = comply === !order.spoof ? 1 : 0;
  } else if (contact && (input.actionType === 'ENGAGE' || input.actionType === 'REPORT_UP')) {
    const report = s.reports.find((r) => r.id === contact.reportId);
    const subject = report?.subjectUnitId ? getUnit(s, report.subjectUnitId) : undefined;
    const real = !!report && !report.ghost && !!subject && subject.side === 'RED';
    outcome = real && haversineM(contact.position, subject.position) <= 500 ? 1 : 0;
  }

  const spoofActed =
    !!order && order.spoof && order.authState !== 'FAILED' && ACTING_ACTIONS.has(input.actionType);
  const perceived = computePerceivedState(s, player.id);

  emit(
    ctx,
    'DECISION_MADE',
    {
      playerId: player.id,
      actionType: input.actionType,
      confidence: Math.round(input.confidence),
      rationale: input.rationale.trim(),
      targetContactId: input.targetContactId ?? null,
      basedOnMessageId: input.basedOnMessageId ?? null,
      outcome,
      latencyTicks,
      spoofActed,
      perceivedSnapshot: perceived,
      truthSnapshot: {
        tick: s.tick,
        units: s.units.map((u) => ({
          id: u.id,
          side: u.side,
          type: u.type,
          position: u.position,
          status: u.status,
        })),
        jamming: currentJamming(s),
        satcomUp: satcomUp(s),
        weather: s.weather,
      },
    },
    [INSTRUCTOR],
  );
  emit(
    ctx,
    'DECISION_RECORDED',
    { playerId: player.id, actionType: input.actionType, confidence: Math.round(input.confidence) },
    [player.id],
  );
  if (spoofActed) {
    emit(
      ctx,
      'SPOOF_ACTED',
      { playerId: player.id, messageId: order?.id ?? null, authState: order?.authState ?? 'NONE' },
      [INSTRUCTOR],
    );
  }
}
