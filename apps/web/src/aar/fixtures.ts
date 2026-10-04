import type { AarDecisionDetail, AarSnapshot, AarSummary } from '@vyuha/shared';
import { perceived } from '@/test/fixtures';

const zero = { VHF: 0, HF: 0, SATCOM: 0, DATALINK: 0, RUNNER: 0 };

export function aarSummary(): AarSummary {
  return {
    meta: {
      sessionId: 's1',
      code: 'ABC234',
      scenarioTitle: 'Op Silent Ridge',
      status: 'ENDED',
      startedAt: '2026-01-01T10:00:00.000Z',
      endedAt: '2026-01-01T10:10:00.000Z',
      durationTicks: 600,
      teams: [{ id: 't1', name: 'Alpha', primary: 'VHF' }],
      players: [
        { id: 'p1', name: 'Asha', role: 'PL_CDR', teamId: 't1', unitId: 'b-pl' },
        { id: 'p2', name: 'Bilal', role: 'SECTION_CDR', teamId: 't1', unitId: 'b-sec' },
      ],
      areaBounds: { south: 34, west: 77, north: 35, east: 78 },
    },
    decisions: [
      {
        id: 'd1',
        playerId: 'p1',
        tick: 120,
        actionType: 'ENGAGE',
        confidence: 90,
        rationale: 'Clear sighting',
        targetContactId: 'rpt-1',
        basedOnMessageId: null,
        outcome: 1,
        latencyTicks: 12,
        spoofActed: false,
      },
      {
        id: 'd2',
        playerId: 'p2',
        tick: 300,
        actionType: 'COMPLY_ORDER',
        confidence: 95,
        rationale: 'It came from HQ',
        targetContactId: null,
        basedOnMessageId: 'msg-4',
        outcome: 0,
        latencyTicks: 40,
        spoofActed: true,
      },
      {
        id: 'd3',
        playerId: 'p2',
        tick: 400,
        actionType: 'HOLD',
        confidence: 50,
        rationale: 'Waiting for more',
        targetContactId: null,
        basedOnMessageId: null,
        outcome: null,
        latencyTicks: null,
        spoofActed: false,
      },
    ],
    analysis: {
      players: [
        {
          playerId: 'p1',
          name: 'Asha',
          role: 'PL_CDR',
          teamId: 't1',
          decisionCount: 1,
          scoredDecisionCount: 1,
          avgLatencyTicks: 12,
          brierScore: 0.01,
          gradeCount: 2,
          gradingAccuracy: 0.9,
          channelSwitchCount: 1,
          spoofActedCount: 0,
          meanConfidence: 90,
          accuracy: 100,
          drift: {
            samples: 3,
            meanMissed: 1,
            meanGhost: 0,
            meanPositionErrorM: 250,
            maxPositionErrorM: 400,
          },
        },
        {
          playerId: 'p2',
          name: 'Bilal',
          role: 'SECTION_CDR',
          teamId: 't1',
          decisionCount: 2,
          scoredDecisionCount: 1,
          avgLatencyTicks: 40,
          brierScore: 0.9,
          gradeCount: 0,
          gradingAccuracy: null,
          channelSwitchCount: 0,
          spoofActedCount: 1,
          meanConfidence: 95,
          accuracy: 0,
          drift: null,
        },
      ],
      drift: {
        p1: [
          { tick: 10, missed: 2, ghost: 0, avgPositionErrorM: 300, friendlyAvgErrorM: 10 },
          { tick: 20, missed: 1, ghost: 1, avgPositionErrorM: 200, friendlyAvgErrorM: 20 },
        ],
        p2: [{ tick: 10, missed: 3, ghost: 0, avgPositionErrorM: 900, friendlyAvgErrorM: 0 }],
      },
      calibration: {
        overall: [
          { from: 80, to: 100, count: 2, meanConfidence: 92.5, accuracy: 50 },
          { from: 40, to: 60, count: 1, meanConfidence: 50, accuracy: 100 },
        ],
        byPlayer: {},
      },
      channels: [
        { tick: 0, usage: { ...zero, VHF: 4 }, jamming: zero, satcomUp: true },
        {
          tick: 10,
          usage: { ...zero, VHF: 2, HF: 1 },
          jamming: { ...zero, VHF: 0.8 },
          satcomUp: true,
        },
        { tick: 20, usage: { ...zero, HF: 3 }, jamming: { ...zero, VHF: 0.8 }, satcomUp: false },
      ],
      flow: [
        {
          from: 'p1',
          to: 'p2',
          kind: 'TEXT',
          channel: 'VHF',
          total: 4,
          outcomes: { DELIVERED: 2, DELAYED: 0, DROPPED: 1, CORRUPTED: 1 },
        },
        {
          from: 'p2',
          to: 'p1',
          kind: 'TEXT',
          channel: 'HF',
          total: 2,
          outcomes: { DELIVERED: 2, DELAYED: 0, DROPPED: 0, CORRUPTED: 0 },
        },
        {
          from: 'b-hq',
          to: 'p1',
          kind: 'REPORT',
          channel: 'VHF',
          total: 6,
          outcomes: { DELIVERED: 5, DELAYED: 1, DROPPED: 0, CORRUPTED: 0 },
        },
      ],
      timeline: [
        {
          tick: 60,
          kind: 'INJECT',
          playerId: null,
          params: { title: 'Light VHF jamming begins', source: 'MSEL' },
        },
        { tick: 240, kind: 'SPOOF', playerId: 'p2', params: { text: 'Withdraw now' } },
        { tick: 255, kind: 'AUTH', playerId: 'p2', params: { result: 'FAILED' } },
        { tick: 280, kind: 'CHANNEL_SWITCH', playerId: 'p1', params: { from: 'VHF', to: 'HF' } },
        {
          tick: 300,
          kind: 'DECISION',
          playerId: 'p2',
          params: { action: 'COMPLY_ORDER', confidence: 95, outcome: 'wrong' },
        },
        { tick: 360, kind: 'JAMMING', playerId: null, params: { channel: 'VHF', level: 80 } },
      ],
      learning: [
        {
          rule: 'ACTED_ON_SPOOF',
          severity: 'warn',
          playerId: 'p2',
          teamId: 't1',
          params: { count: 1 },
        },
        {
          rule: 'NO_SWITCH_WHILE_JAMMED',
          severity: 'warn',
          playerId: null,
          teamId: 't1',
          params: { team: 'Alpha', channel: 'VHF', seconds: 200 },
        },
        {
          rule: 'GRADING_GOOD',
          severity: 'good',
          playerId: 'p1',
          teamId: 't1',
          params: { accuracy: 90, grades: 2 },
        },
      ],
    },
  };
}

export function aarSnapshot(tick: number, playerId: string | null): AarSnapshot {
  return {
    tick,
    truth: {
      tick,
      units: [
        {
          id: 'b-pl',
          name: 'Alpha Platoon',
          side: 'BLUE',
          domain: 'LAND',
          type: 'INFANTRY_PLATOON',
          position: { lat: 34.1, lon: 77.1 },
          heading: 0,
          status: 'ACTIVE',
          destination: null,
        },
        {
          id: 'r-recce',
          name: 'Hostile Recce',
          side: 'RED',
          domain: 'LAND',
          type: 'RECCE',
          position: { lat: 34.2, lon: 77.2 },
          heading: 0,
          status: 'ACTIVE',
          destination: null,
        },
      ],
      jamming: { ...zero, VHF: tick >= 300 ? 0.8 : 0 },
      satcomUp: true,
    },
    perceived: playerId ? perceived({ playerId, tick }) : null,
  };
}

export function aarDecisionDetail(id: string): AarDecisionDetail {
  const decision =
    aarSummary().decisions.find((d) => d.id === id) ??
    (aarSummary().decisions[0] as AarSummary['decisions'][number]);
  return {
    decision,
    perceived: perceived({
      tick: decision.tick,
      contacts: [
        {
          id: 'rpt-1',
          position: { lat: 34.21, lon: 77.21 },
          type: 'RECCE',
          observedTick: 100,
          receivedTick: 101,
          ageTicks: 20,
          source: 'Own sensor',
          via: 'DIRECT',
          grade: null,
        },
      ],
    }),
    truth: {
      tick: decision.tick,
      units: [
        {
          id: 'r-recce',
          side: 'RED',
          type: 'RECCE',
          position: { lat: 34.2, lon: 77.2 },
          status: 'ACTIVE',
        },
        {
          id: 'b-pl',
          side: 'BLUE',
          type: 'INFANTRY_PLATOON',
          position: { lat: 34.1, lon: 77.1 },
          status: 'ACTIVE',
        },
      ],
      jamming: zero,
      satcomUp: true,
    },
  };
}
