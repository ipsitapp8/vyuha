import { CHANNELS, CONTACT_TTL_TICKS, SWITCH_PENALTY_TICKS } from './config';
import {
  believedFriendlyPosition,
  currentJamming,
  getPlayer,
  getTeam,
  getUnit,
  reportedPosition,
  satcomUp,
} from './state';
import { linkQuality } from './radio';
import { profileFor } from './config';
import type {
  Channel,
  PerceivedContact,
  PerceivedFriendly,
  PerceivedMessage,
  PerceivedState,
  TruthState,
} from './types';

/**
 * The trainee-safe view of the world. Built field-by-field from what the player has actually
 * received (own sensors, delivered relays, beacons, inbox). Never copies truth objects wholesale:
 * no hidden units, report reliability, ghost flags, spoof flags or jamming levels are exposed.
 */
export function computePerceivedState(truth: TruthState, playerId: string): PerceivedState {
  const player = getPlayer(truth, playerId);
  if (!player) throw new RangeError(`Unknown player ${playerId}`);
  const team = getTeam(truth, player.teamId);
  const unit = getUnit(truth, player.unitId);
  const knowledge = truth.knowledge[playerId];
  if (!team || !unit || !knowledge) throw new RangeError(`Player ${playerId} is not fully set up`);

  const friendlies: PerceivedFriendly[] = Object.entries(knowledge.friendlies)
    .map(([unitId, fix]) => {
      const u = getUnit(truth, unitId);
      return {
        unitId,
        name: u?.name ?? unitId,
        type: u?.type ?? 'UNKNOWN',
        position: believedFriendlyPosition(truth, playerId, unitId, fix),
        observedTick: fix.observedTick,
        ageTicks: truth.tick - fix.observedTick,
      };
    })
    .sort((a, b) => a.unitId.localeCompare(b.unitId));

  const contacts: PerceivedContact[] = knowledge.reports
    .filter((r) => truth.tick - r.observedTick <= CONTACT_TTL_TICKS)
    .map((r) => {
      const source = truth.reports.find((x) => x.id === r.reportId);
      const sensor = source ? getUnit(truth, source.sensorUnitId) : undefined;
      const grade = knowledge.grades[r.reportId];
      return {
        id: r.reportId,
        position: { ...r.position },
        type: r.type,
        observedTick: r.observedTick,
        receivedTick: r.receivedTick,
        ageTicks: truth.tick - r.observedTick,
        source: sensor ? (sensor.id === unit.id ? 'Own sensor' : sensor.name) : 'Unknown source',
        via: r.via,
        grade: grade ? { reliability: grade.reliability, credibility: grade.credibility } : null,
      };
    })
    .sort((a, b) => b.observedTick - a.observedTick || a.id.localeCompare(b.id));

  const inbox: PerceivedMessage[] = knowledge.inbox
    .map((m) => ({
      id: m.id,
      kind: m.kind,
      from: m.fromLabel,
      channel: m.channel,
      sentTick: m.sentTick,
      receivedTick: m.receivedTick,
      text: m.text,
      position: m.position ? { ...m.position } : null,
      requiresAuth: m.kind === 'ORDER',
      authState: m.authState,
      authResolvesAtTick: knowledge.auth.find((a) => a.messageId === m.id)?.resolveAtTick ?? null,
    }))
    .sort((a, b) => a.receivedTick - b.receivedTick || a.id.localeCompare(b.id));

  return {
    tick: truth.tick,
    playerId,
    teamId: team.id,
    role: player.role,
    self: {
      unitId: unit.id,
      name: unit.name,
      type: unit.type,
      // what the unit's own navigation says: shifted while its GPS is being spoofed
      position: reportedPosition(truth, unit),
      heading: unit.heading,
      speed: unit.speed,
      strength: unit.strength,
      status: unit.status,
      destination: unit.destination ? { ...unit.destination } : null,
    },
    friendlies,
    contacts,
    inbox,
    comms: {
      activeChannel: team.activeChannel,
      pace: { ...team.pace },
      switchPenaltyActive:
        team.switchedAtTick !== null && truth.tick - team.switchedAtTick < SWITCH_PENALTY_TICKS,
      signal: measureSignal(truth, playerId),
    },
    weather: { ...truth.weather },
    probe: openProbeFor(truth, playerId),
  };
}

function openProbeFor(truth: TruthState, playerId: string): PerceivedState['probe'] {
  const probe = truth.probes.find((p) => p.pending.includes(playerId));
  return probe ? { id: probe.id, tick: probe.tick, expiresAtTick: probe.expiresAtTick } : null;
}

/** What the player's radios would show: link quality towards the team lead (or a teammate). */
function measureSignal(truth: TruthState, playerId: string): Record<Channel, number | null> {
  const out = { VHF: null, HF: null, SATCOM: null, DATALINK: null, RUNNER: null } as Record<
    Channel,
    number | null
  >;
  const me = getPlayer(truth, playerId);
  if (!me) return out;
  const mates = truth.players.filter((p) => p.teamId === me.teamId && p.id !== me.id);
  const peer = mates.find((p) => p.role === 'PL_CDR') ?? mates[0];
  const from = getUnit(truth, me.unitId);
  const to = peer ? getUnit(truth, peer.unitId) : undefined;
  if (!from || !to) return out;
  const env = {
    terrain: truth.terrain,
    weather: truth.weather,
    jamming: currentJamming(truth),
    satcomUp: satcomUp(truth),
  };
  for (const channel of CHANNELS) {
    if (channel === 'RUNNER') continue;
    const { quality } = linkQuality(
      {
        channel,
        from: from.position,
        to: to.position,
        fromHeightM: profileFor(from.type).antennaM,
        toHeightM: profileFor(to.type).antennaM,
      },
      env,
    );
    out[channel] = Math.round(quality * 100) / 100;
  }
  return out;
}
