export interface DebugFlagUser {
  id: string;
  name: string;
  username: string;
  active: boolean;
}

export type TraceFlagTarget =
  | { type: 'user'; userId: string }
  | { type: 'automatedProcess' }
  | { type: 'platformIntegration' };

export interface TraceFlagTargetStatus {
  target: TraceFlagTarget;
  targetLabel: string;
  targetAvailable: boolean;
  unavailableReason?: string;
  traceFlagId?: string;
  debugLevelName?: string;
  startDate?: string;
  expirationDate?: string;
  isActive: boolean;
  resolvedTargetCount?: number;
  activeTargetCount?: number;
  debugLevelMixed?: boolean;
}

export interface ApplyTraceFlagTargetInput {
  target: TraceFlagTarget;
  debugLevelName: string;
  ttlMinutes: number;
}

export interface ApplyTraceFlagTargetResult {
  created: boolean;
  traceFlagId?: string;
  traceFlagIds: string[];
  createdCount: number;
  updatedCount: number;
  resolvedTargetCount: number;
}

export interface RemoveTraceFlagsResult {
  removedCount: number;
  resolvedTargetCount: number;
}

export function getTraceFlagTargetKey(target: TraceFlagTarget | undefined): string {
  if (!target) {
    return '';
  }
  if (target.type === 'user') {
    return `user:${target.userId}`;
  }
  return target.type;
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
