export type OrgListParams = {
  forceRefresh?: boolean;
};

export type OrgListItem = {
  username: string;
  alias?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  isScratchOrg?: boolean;
  instanceUrl?: string;
};

export type OrgAuthParams = {
  username?: string;
  refresh?: boolean;
};

export type OrgAuth = {
  accessToken: string;
  instanceUrl: string;
  username?: string;
};

export type DoctorParams = {
  targetOrg?: string;
  /** Defaults to the current directory. */
  workspaceRoot?: string;
};

export type DoctorCheck = {
  ok: boolean;
  message: string;
};

export type DoctorResult = {
  status: string;
  runtimeVersion: string;
  platform: string;
  arch: string;
  workspaceRoot: string;
  apexlogsRoot: string;
  sf: DoctorCheck;
  cacheLayout: DoctorCheck;
  writableApexlogs: DoctorCheck;
  orgAuth?: DoctorCheck;
};

export type OrgResolveParams = {
  targetOrg?: string;
};

export type OrgResolveResult = {
  requested: string;
  username: string;
  alias?: string;
  instanceUrl?: string;
  source: string;
};

export type RuntimeLogRow = {
  id: string;
  startTime?: string;
  operation?: string;
  application?: string;
  durationMilliseconds?: number;
  status?: string;
  request?: string;
  logLength?: number;
  logUser?: { name?: string };
};

export type LogsListCursor = {
  beforeStartTime: string;
  beforeId: string;
};

export type LogsListParams = {
  username?: string;
  limit?: number;
  cursor?: LogsListCursor;
  offset?: number;
};

export type LogsSyncParams = {
  targetOrg?: string;
  workspaceRoot?: string;
  forceFull?: boolean;
  concurrency?: number;
};

export type LogsSyncResult = {
  status: string;
  targetOrg: string;
  safeTargetOrg: string;
  apexlogsRoot: string;
  orgLogsRoot: string;
  downloaded: number;
  cached: number;
  failed: number;
  failures: { logId: string; code: string }[];
  checkpointAdvanced: boolean;
  stateFile: string;
  lastSyncedLogId?: string;
};

export type LogsStatusParams = {
  targetOrg?: string;
  workspaceRoot?: string;
};

export type LogsStatusResult = {
  targetOrg: string;
  safeTargetOrg: string;
  workspaceRoot: string;
  apexlogsRoot: string;
  orgLogsRoot?: string;
  stateFile: string;
  logCount: number;
  hasState: boolean;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastSyncedLogId?: string;
  lastSyncedStartTime?: string;
  downloadedCount: number;
  cachedCount: number;
  failedCount: number;
  lastError?: string;
};

export type LogsReadParams = {
  logId: string;
  targetOrg?: string;
  workspaceRoot?: string;
  maxBytes?: number;
};

export type LogsReadResult = {
  logId: string;
  path: string;
  body: string;
  sizeBytes: number;
  truncated: boolean;
};

export type LogsResolveParams = {
  logId: string;
  targetOrg?: string;
  workspaceRoot?: string;
};

export type LogsResolveResult = {
  logId: string;
  path?: string;
  cached: boolean;
};

export type LogsDeleteParams = {
  targetOrg?: string;
  workspaceRoot?: string;
  scope?: 'mine' | 'all';
  ids?: string[];
  limit?: number;
  dryRun?: boolean;
  confirmed?: boolean;
};

export type LogsDeleteResult = {
  status: string;
  targetOrg: string;
  scope: string;
  dryRun: boolean;
  listed: number;
  total: number;
  deleted: number;
  failed: number;
  cancelled: number;
  logIds?: string[];
  failedLogIds?: string[];
};

export type RuntimeLogDiagnostic = {
  code: string;
  severity: string;
  summary: string;
  line?: number;
  eventType?: string;
};

export type RuntimeLogTriageSummary = {
  hasErrors: boolean;
  primaryReason?: string;
  reasons: RuntimeLogDiagnostic[];
};

export type LogsTriageParams = {
  username?: string;
  logIds: string[];
  logStartTimes?: Record<string, string>;
  workspaceRoot?: string;
};

export type LogsTriageEntry = {
  logId: string;
  codeUnitStarted?: string;
  summary: RuntimeLogTriageSummary;
};

export type UserSearchParams = {
  targetOrg?: string;
  query?: string;
  limit?: number;
};

export type UserRecord = {
  id: string;
  name: string;
  username: string;
  active: boolean;
};

export type UserSearchResult = {
  users: UserRecord[];
};

export type TraceFlagTarget =
  { type: 'user'; userId: string } | { type: 'automatedProcess' } | { type: 'platformIntegration' };

/** Salesforce `TraceFlag.LogType` values. Apex checkpoints need `DEVELOPER_LOG`. */
export const TRACE_FLAG_LOG_TYPES = ['DEVELOPER_LOG', 'USER_DEBUG'] as const;
export type TraceFlagLogType = (typeof TRACE_FLAG_LOG_TYPES)[number];
export const DEFAULT_TRACE_FLAG_LOG_TYPE: TraceFlagLogType = 'DEVELOPER_LOG';

export type TraceFlagStatusParams = {
  targetOrg?: string;
  target: TraceFlagTarget;
  /** Omitted means `DEFAULT_TRACE_FLAG_LOG_TYPE`. */
  logType?: TraceFlagLogType;
};

export type TraceFlagApplyParams = TraceFlagStatusParams & {
  debugLevelName: string;
  ttlMinutes?: number;
  dryRun?: boolean;
  confirmed?: boolean;
};

export type TraceFlagRemoveParams = TraceFlagStatusParams & {
  dryRun?: boolean;
  confirmed?: boolean;
};

/** The other log type's flags on the same target, read with the status. */
export type TraceFlagOtherLogTypeStatus = {
  logType: TraceFlagLogType;
  isActive: boolean;
  activeTargetCount: number;
  /** Latest ExpirationDate among the active flags of this type; absent when none is active. */
  expirationDate?: string;
};

export type TraceFlagTargetStatus = {
  target: TraceFlagTarget;
  logType: TraceFlagLogType;
  targetLabel: string;
  targetAvailable: boolean;
  isActive: boolean;
  traceFlagId?: string;
  traceFlagIds?: string[];
  debugLevelName?: string;
  debugLevelMixed?: boolean;
  resolvedTargetCount?: number;
  activeTargetCount?: number;
  startDate?: string;
  expirationDate?: string;
  /** Set whenever the target is available. */
  otherLogType?: TraceFlagOtherLogTypeStatus;
};

export type TraceFlagApplyResult = {
  status: string;
  logType: TraceFlagLogType;
  dryRun: boolean;
  created: boolean;
  createdCount: number;
  updatedCount: number;
  resolvedTargetCount: number;
  traceFlagIds?: string[];
};

export type TraceFlagRemoveResult = {
  status: string;
  logType: TraceFlagLogType;
  dryRun: boolean;
  removedCount: number;
  resolvedTargetCount: number;
  traceFlagIds?: string[];
};

export type RuntimeDebugLevelRecord = {
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
};

export type DebugLevelListParams = {
  targetOrg?: string;
};

export type DebugLevelGetParams = {
  targetOrg?: string;
  id?: string;
  developerName?: string;
};

export type DebugLevelFields = Omit<RuntimeDebugLevelRecord, 'id'>;

export type DebugLevelCreateParams = {
  targetOrg?: string;
  record: Partial<DebugLevelFields> & Pick<DebugLevelFields, 'developerName'>;
  dryRun?: boolean;
  confirmed?: boolean;
};

export type DebugLevelUpdateParams = {
  targetOrg?: string;
  id: string;
  changes: Partial<DebugLevelFields>;
  dryRun?: boolean;
  confirmed?: boolean;
};

export type DebugLevelDeleteParams = {
  targetOrg?: string;
  id: string;
  dryRun?: boolean;
  confirmed?: boolean;
};

export type DebugLevelWriteResult = {
  status: string;
  dryRun: boolean;
  id?: string;
  record?: RuntimeDebugLevelRecord;
};

export type ToolingQueryParams = {
  targetOrg?: string;
  soql: string;
};

export type ToolingQueryResult = {
  records?: unknown[];
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
};

export type ToolingRequestGetParams = {
  targetOrg?: string;
  path: string;
};

export * from './customLogs/contracts.js';
