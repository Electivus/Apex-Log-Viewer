export interface DebugFlagUser {
  id: string;
  name: string;
  username: string;
  active: boolean;
}

export type TraceFlagTarget =
  { type: 'user'; userId: string } | { type: 'automatedProcess' } | { type: 'platformIntegration' };

/** Salesforce `TraceFlag.LogType` values. Apex checkpoints need `DEVELOPER_LOG`. */
export const TRACE_FLAG_LOG_TYPES = ['DEVELOPER_LOG', 'USER_DEBUG'] as const;
export type TraceFlagLogType = (typeof TRACE_FLAG_LOG_TYPES)[number];
export const DEFAULT_TRACE_FLAG_LOG_TYPE: TraceFlagLogType = 'DEVELOPER_LOG';

/** The other log type's flags on the same target, read with the status. */
export interface TraceFlagOtherLogTypeStatus {
  logType: TraceFlagLogType;
  isActive: boolean;
  activeTargetCount: number;
  /** Latest ExpirationDate among the active flags of this type; absent when none is active. */
  expirationDate?: string;
}

export interface TraceFlagTargetStatus {
  target: TraceFlagTarget;
  logType: TraceFlagLogType;
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
  /** Set whenever the target is available. */
  otherLogType?: TraceFlagOtherLogTypeStatus;
}

export interface ApplyTraceFlagTargetInput {
  target: TraceFlagTarget;
  logType: TraceFlagLogType;
  debugLevelName: string;
  ttlMinutes: number;
}

export interface ApplyTraceFlagTargetResult {
  logType: TraceFlagLogType;
  created: boolean;
  traceFlagId?: string;
  traceFlagIds: string[];
  createdCount: number;
  updatedCount: number;
  resolvedTargetCount: number;
}

export interface RemoveTraceFlagsResult {
  logType: TraceFlagLogType;
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
