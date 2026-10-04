import type { PublicUser, Role, ScenarioSummary } from '@vyuha/shared';

export interface UserRecord extends PublicUser {
  passwordHash: string;
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
}

export interface ScenarioRepo {
  listSummaries(): Promise<ScenarioSummary[]>;
}

export interface DbProbe {
  ping(): Promise<boolean>;
}

export interface Deps {
  db: DbProbe;
  users: UserRepo;
  scenarios: ScenarioRepo;
}
