export interface DebugFlagUser {
  id: string;
  name: string;
  username: string;
  active: boolean;
}

export interface UserTraceFlagStatus {
  traceFlagId: string;
  debugLevelName: string;
  startDate?: string;
  expirationDate?: string;
  isActive: boolean;
}

export interface ApplyUserTraceFlagInput {
  userId: string;
  debugLevelName: string;
  ttlMinutes: number;
}

export interface DebugLevelRecord {
  id?: string;
  developerName: string;
  masterLabel: string;
  language: string;
  workflow: string;
  validation: string;
  callout: string;
  apexCode: string;
  apexProfiling: string;
  visualforce: string;
  system: string;
  database: string;
  wave: string;
  nba: string;
  dataAccess: string;
}

export interface DebugLevelPreset {
  id: string;
  label: string;
  description: string;
  record: DebugLevelRecord;
}
