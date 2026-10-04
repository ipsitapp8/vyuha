import type { Channel } from '@vyuha/shared';

export const CHANNELS: readonly Channel[] = ['VHF', 'HF', 'SATCOM', 'DATALINK', 'RUNNER'];
/** RUNNER is physical and can never be jammed. */
export const JAMMABLE_CHANNELS: readonly Channel[] = ['VHF', 'HF', 'SATCOM', 'DATALINK'];

export const BASE_QUALITY: Record<Channel, number> = {
  VHF: 0.95,
  HF: 0.8,
  SATCOM: 0.9,
  DATALINK: 0.95,
  RUNNER: 1,
};

/** Nominal useful range (m); quality falls off quadratically towards it. */
export const RANGE_M: Record<Channel, number> = {
  VHF: 25_000,
  HF: 150_000,
  SATCOM: Number.POSITIVE_INFINITY,
  DATALINK: 40_000,
  RUNNER: Number.POSITIVE_INFINITY,
};

/** Minimum one-way latency in ticks (1 tick = 1 s of exercise time). */
export const BASE_LATENCY_TICKS: Record<Channel, number> = {
  VHF: 1,
  HF: 3,
  SATCOM: 8,
  DATALINK: 1,
  RUNNER: 1,
};

/** Messages per team per tick a channel carries before queueing delay applies. */
export const BANDWIDTH_PER_TICK: Record<Channel, number> = {
  VHF: 4,
  HF: 1,
  SATCOM: 2,
  DATALINK: 6,
  RUNNER: 99,
};

export const RUNNER_SPEED_MPS = 4;
export const RUNNER_ARRIVAL_M = 50;

export const ADAPT_INTERVAL_TICKS = 30;
export const ADAPT_RATE = 0.08;
export const ADAPT_DECAY = 0.03;
export const ADAPT_MAX = 0.9;

export const AUTH_DELAY_TICKS = 15;
export const BEACON_INTERVAL_TICKS = 15;
export const CONTACT_TTL_TICKS = 600;
export const SENSOR_COOLDOWN_TICKS = 20;
export const SWITCH_PENALTY_TICKS = 10;
export const SWITCH_EXTRA_DELAY_TICKS = 5;
export const DRIFT_SAMPLE_INTERVAL_TICKS = 10;
export const STATE_PRUNE_TICKS = 900;
export const ISR_TASK_TICKS = 120;
export const ISR_ARRIVAL_M = 1500;

export const RELIABILITY_GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
/** Position noise sigma (m), wrong-type probability and ghost rate per tick, per reliability A..F. */
export const POSITION_SIGMA_M = [20, 60, 150, 350, 800, 2000] as const;
export const WRONG_TYPE_PROB = [0, 0.02, 0.08, 0.2, 0.4, 0.6] as const;
export const GHOST_RATE_PER_TICK = [0, 0.0002, 0.0008, 0.002, 0.005, 0.01] as const;

export const HOSTILE_TYPES: readonly string[] = [
  'RECCE',
  'MECH_INFANTRY_COMPANY',
  'MECH_INFANTRY_SECTION',
  'EW_JAMMER',
  'DRONE',
  'INFANTRY_SECTION',
];

export interface UnitProfile {
  /** Sensor detection range in clear weather (m); 0 = no sensor. */
  sensorRangeM: number;
  /** Antenna / sensor height above ground (m). */
  antennaM: number;
  /** Base source reliability of this unit's sensor (index into RELIABILITY_GRADES). */
  reliabilityIndex: number;
}

const DEFAULT_PROFILE: UnitProfile = { sensorRangeM: 2500, antennaM: 3, reliabilityIndex: 2 };

export const UNIT_PROFILES: Record<string, UnitProfile> = {
  HQ: { sensorRangeM: 1500, antennaM: 10, reliabilityIndex: 2 },
  INFANTRY_PLATOON: { sensorRangeM: 3500, antennaM: 3, reliabilityIndex: 1 },
  INFANTRY_SECTION: { sensorRangeM: 3000, antennaM: 2, reliabilityIndex: 2 },
  DRONE: { sensorRangeM: 7000, antennaM: 300, reliabilityIndex: 1 },
  EW_DETACHMENT: { sensorRangeM: 0, antennaM: 8, reliabilityIndex: 3 },
  CYBER_CELL: { sensorRangeM: 0, antennaM: 5, reliabilityIndex: 3 },
  RUNNER: { sensorRangeM: 1500, antennaM: 2, reliabilityIndex: 3 },
  RECCE: { sensorRangeM: 4000, antennaM: 2, reliabilityIndex: 1 },
  MECH_INFANTRY_COMPANY: { sensorRangeM: 3500, antennaM: 4, reliabilityIndex: 2 },
  EW_JAMMER: { sensorRangeM: 0, antennaM: 12, reliabilityIndex: 3 },
  CYBER_TEAM: { sensorRangeM: 0, antennaM: 5, reliabilityIndex: 3 },
  CIVILIAN_CONVOY: { sensorRangeM: 0, antennaM: 3, reliabilityIndex: 4 },
};

export function profileFor(type: string): UnitProfile {
  return UNIT_PROFILES[type] ?? DEFAULT_PROFILE;
}
