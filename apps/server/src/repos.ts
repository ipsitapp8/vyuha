import type { BundledGeo, GeoRepo } from './geo/ingest';
import type { SessionStore } from './sessions/store';
import type { GeoNetwork } from './geo/openMeteo';
import type { Inject, PublicUser, Role, ScenarioDefinition, ScenarioSummary } from '@vyuha/shared';

export interface UserRecord extends PublicUser {
  passwordHash: string;
  /** Scripted demo trainee; never signs in. */
  isDemoBot?: boolean;
  /** Sign-in tokens carry this; a token with an older value is revoked. Missing = 0 (test fixtures). */
  tokenVersion?: number;
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailTakenError';
  }
}

export interface UserRepo {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: {
    name: string;
    email: string;
    passwordHash: string;
    role: Role;
  }): Promise<UserRecord>;
  /** Revokes every sign-in token issued to the user so far (increments `tokenVersion`). */
  revokeTokens(id: string): Promise<void>;
}

export interface ScenarioRepo {
  listSummaries(): Promise<ScenarioSummary[]>;
  getDefinition(id: string): Promise<ScenarioDefinition | null>;
  /** Replaces the scenario MSEL; false when the scenario does not exist. */
  updateMsel(id: string, msel: Inject[]): Promise<boolean>;
}

export interface DbProbe {
  ping(): Promise<boolean>;
}

export interface Deps {
  db: DbProbe;
  users: UserRepo;
  scenarios: ScenarioRepo;
  geo: GeoRepo;
  geoNetwork: GeoNetwork;
  bundledGeo: (scenarioId: string) => BundledGeo | null;
  sessions: SessionStore;
}
