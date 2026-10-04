import type { PerceivedStateDto } from '@vyuha/shared';

type Contact = PerceivedStateDto['contacts'][number];
type Message = PerceivedStateDto['inbox'][number];

export function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: 'rpt-1',
    position: { lat: 34.2, lon: 77.6 },
    type: 'RECCE',
    observedTick: 90,
    receivedTick: 92,
    ageTicks: 10,
    source: 'Falcon UAV',
    via: 'VHF',
    grade: null,
    ...over,
  };
}

export function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    kind: 'ORDER',
    from: 'Battalion HQ',
    channel: 'VHF',
    sentTick: 95,
    receivedTick: 96,
    text: 'Withdraw to grid 1234 5678',
    position: null,
    requiresAuth: true,
    authState: 'NONE',
    authResolvesAtTick: null,
    ...over,
  };
}

export function perceived(over: Partial<PerceivedStateDto> = {}): PerceivedStateDto {
  return {
    tick: 100,
    playerId: 'p1',
    teamId: 't1',
    role: 'PL_CDR',
    self: {
      unitId: 'b-pl',
      name: 'Alpha Platoon',
      type: 'INFANTRY_PLATOON',
      position: { lat: 34.175, lon: 77.59 },
      heading: 0,
      speed: 1.2,
      strength: 100,
      status: 'ACTIVE',
      destination: null,
    },
    friendlies: [],
    contacts: [],
    inbox: [],
    comms: {
      activeChannel: 'VHF',
      pace: { primary: 'VHF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' },
      switchPenaltyActive: false,
      signal: { VHF: 0.9, HF: 0.7, SATCOM: 0.9, DATALINK: 0.8, RUNNER: null },
    },
    weather: { visibilityM: 10000, precipitationMm: 0, windKph: 5 },
    ...over,
  };
}
