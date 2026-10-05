import type {
  Channel,
  Inject,
  LatLon,
  PaceDefaults,
  ScenarioDefinition,
  ScenarioUnit,
} from '@vyuha/shared';
import type { TerrainGridData } from './terrain';

export type { Channel, Inject, LatLon, PaceDefaults, ScenarioDefinition, ScenarioUnit };

export type ReliabilityGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type CredibilityGrade = 1 | 2 | 3 | 4 | 5 | 6;
export type PlayerRoleName = 'PL_CDR' | 'SECTION_CDR' | 'EW_OFFICER' | 'ISR_OPERATOR';
export type DeliveryOutcome = 'DELIVERED' | 'DELAYED' | 'DROPPED' | 'CORRUPTED';
export type AuthState = 'NONE' | 'PENDING' | 'VERIFIED' | 'FAILED';
export type MessageKind = 'TEXT' | 'REPORT' | 'POSITION' | 'ORDER';

export interface Weather {
  visibilityM: number;
  precipitationMm: number;
  windKph: number;
}

export interface EngineUnit extends ScenarioUnit {
  destination: LatLon | null;
  /** While tick < isrUntilTick this (air) unit senses with a boosted rate and range. */
  isrUntilTick: number;
}

export interface TeamSpec {
  id: string;
  name: string;
  pace: PaceDefaults;
}

export interface PlayerSpec {
  id: string;
  teamId: string;
  unitId: string;
  role: PlayerRoleName;
}

export interface Roster {
  teams: TeamSpec[];
  players: PlayerSpec[];
}

export interface TeamState extends TeamSpec {
  activeChannel: Channel;
  switchedAtTick: number | null;
  /** Messages sent per channel since the last adaptive-EW window. */
  usage: Record<Channel, number>;
}

/** A sensor report. The truth fields (reliability, credibility, ghost, subject) never reach trainees. */
export interface Report {
  id: string;
  tick: number;
  sensorUnitId: string;
  /** Null for a fabricated ghost contact. */
  subjectUnitId: string | null;
  position: LatLon;
  type: string;
  trueReliability: ReliabilityGrade;
  trueCredibility: CredibilityGrade;
  ghost: boolean;
  conflictGroup: string | null;
}

export interface DeliveredReport {
  reportId: string;
  observedTick: number;
  receivedTick: number;
  /** As received (possibly corrupted in transit). */
  position: LatLon;
  type: string;
  via: Channel | 'DIRECT';
  corrupted: boolean;
}

export interface Message {
  id: string;
  kind: MessageKind;
  fromUnitId: string | null;
  fromLabel: string;
  toPlayerId: string;
  channel: Channel;
  sentTick: number;
  text: string;
  position: LatLon | null;
  /** REPORT: the report being relayed. POSITION: the unit being reported. */
  reportId: string | null;
  subjectUnitId: string | null;
  /** Truth-only: this order was injected by the adversary. */
  spoof: boolean;
}

export interface InFlight {
  message: Message;
  deliverAtTick: number;
  corrupted: boolean;
}

export interface Runner {
  id: string;
  message: Message;
  /** Unit the runner is homing on (its live position is tracked). */
  targetUnitId: string;
  recipients: string[];
  position: LatLon;
}

export interface InboxMessage {
  id: string;
  kind: MessageKind;
  fromLabel: string;
  channel: Channel;
  sentTick: number;
  receivedTick: number;
  text: string;
  position: LatLon | null;
  spoof: boolean;
  authState: AuthState;
}

export interface FriendlyFix {
  position: LatLon;
  observedTick: number;
  receivedTick: number;
}

export interface PlayerGrade {
  reliability: ReliabilityGrade;
  credibility: CredibilityGrade;
  tick: number;
}

export interface AuthChallenge {
  messageId: string;
  resolveAtTick: number;
}

export interface PlayerKnowledge {
  reports: DeliveredReport[];
  inbox: InboxMessage[];
  friendlies: Record<string, FriendlyFix>;
  grades: Record<string, PlayerGrade>;
  auth: AuthChallenge[];
}

export interface JamWindow {
  id: string;
  channel: Channel;
  intensity: number;
  untilTick: number;
}

export interface TruthState {
  tick: number;
  seed: number;
  rngState: number;
  terrain: TerrainGridData;
  weather: Weather;
  units: EngineUnit[];
  teams: TeamState[];
  players: PlayerSpec[];
  msel: Inject[];
  firedInjectIds: string[];
  jamWindows: JamWindow[];
  manualJam: Record<Channel, number>;
  adaptiveJam: Record<Channel, number>;
  satcomDownUntilTick: number;
  reports: Report[];
  lastDetectionTick: Record<string, number>;
  inFlight: InFlight[];
  runners: Runner[];
  knowledge: Record<string, PlayerKnowledge>;
  counters: { message: number; report: number; runner: number; group: number; liveInject: number };
}

export type DecisionAction =
  | 'ENGAGE'
  | 'HOLD'
  | 'WITHDRAW'
  | 'REPOSITION'
  | 'REPORT_UP'
  | 'COMPLY_ORDER'
  | 'IGNORE_ORDER'
  | 'REQUEST_SUPPORT';

export type EngineInput =
  | {
      type: 'SEND_MESSAGE';
      playerId: string;
      toPlayerId: string;
      channel: Channel;
      text: string;
      position?: LatLon;
    }
  | { type: 'MOVE_UNIT'; playerId: string; unitId: string; destination: LatLon }
  | { type: 'REQUEST_ISR'; playerId: string; target: LatLon }
  | {
      type: 'GRADE_REPORT';
      playerId: string;
      reportId: string;
      reliability: ReliabilityGrade;
      credibility: CredibilityGrade;
    }
  | { type: 'AUTHENTICATE'; playerId: string; messageId: string }
  | { type: 'SWITCH_CHANNEL'; playerId: string; channel: Channel }
  | {
      type: 'DECISION';
      playerId: string;
      actionType: DecisionAction;
      confidence: number;
      rationale: string;
      targetContactId?: string;
      basedOnMessageId?: string;
    }
  | ({ type: 'PROBE_ANSWER'; playerId: string; probeId: string } & ProbeAnswer)
  | { type: 'PROBE_START'; probeId: string }
  | { type: 'PROBE_CLOSE' }
  | { type: 'INJECT'; inject: Inject }
  | { type: 'SET_JAMMING'; channel: Channel; intensity: number }
  | { type: 'MSEL_ADD'; inject: Inject }
  | { type: 'MSEL_UPDATE'; inject: Inject }
  | { type: 'MSEL_REMOVE'; injectId: string };

export interface EngineEvent {
  tick: number;
  type: string;
  payload: Record<string, unknown>;
  /** 'instructor' and/or player ids that may see the event. */
  visibleTo: string[];
}

export interface StepResult {
  state: TruthState;
  events: EngineEvent[];
}

// ---- Perceived (trainee-safe) view -------------------------------------------------------

export interface PerceivedContact {
  id: string;
  position: LatLon;
  type: string;
  observedTick: number;
  receivedTick: number;
  ageTicks: number;
  source: string;
  via: Channel | 'DIRECT';
  grade: { reliability: ReliabilityGrade; credibility: CredibilityGrade } | null;
}

export interface PerceivedFriendly {
  unitId: string;
  name: string;
  type: string;
  position: LatLon;
  observedTick: number;
  ageTicks: number;
}

export interface PerceivedMessage {
  id: string;
  kind: MessageKind;
  from: string;
  channel: Channel;
  sentTick: number;
  receivedTick: number;
  text: string;
  position: LatLon | null;
  requiresAuth: boolean;
  authState: AuthState;
  /** While PENDING: the tick at which the authentication result arrives. */
  authResolvesAtTick: number | null;
}

export interface PerceivedState {
  tick: number;
  playerId: string;
  teamId: string;
  role: PlayerRoleName;
  self: {
    unitId: string;
    name: string;
    type: string;
    position: LatLon;
    heading: number;
    speed: number;
    strength: number;
    status: ScenarioUnit['status'];
    destination: LatLon | null;
  };
  friendlies: PerceivedFriendly[];
  contacts: PerceivedContact[];
  inbox: PerceivedMessage[];
  comms: {
    activeChannel: Channel;
    pace: PaceDefaults;
    switchPenaltyActive: boolean;
    /** Measured link quality (0..1) to the team lead; null when not measurable. */
    signal: Record<Channel, number | null>;
  };
  weather: Weather;
  /** A situation-awareness probe this player has still to answer (no truth, only its id and times). */
  probe: { id: string; tick: number; expiresAtTick: number } | null;
}

export interface PictureDrift {
  missed: number;
  ghost: number;
  avgPositionErrorM: number;
  friendlyAvgErrorM: number;
}

export interface DecisionRecord {
  playerId: string;
  tick: number;
  actionType: string;
  confidence: number;
  /** 1 correct, 0 incorrect, null when the decision is not scorable. */
  outcome: 0 | 1 | null;
  latencyTicks: number | null;
}
