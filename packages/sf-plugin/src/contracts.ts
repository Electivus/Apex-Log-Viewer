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
};

export type OrgAuth = {
  accessToken: string;
  instanceUrl: string;
  username?: string;
};

export type DoctorParams = {
  targetOrg?: string;
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
  Id: string;
  StartTime?: string;
  Operation?: string;
  Application?: string;
  DurationMilliseconds?: number;
  Status?: string;
  Request?: string;
  LogLength?: number;
  LogUser?: { Name?: string };
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
  target_org: string;
  safe_target_org: string;
  downloaded: number;
  cached: number;
  failed: number;
  checkpoint_advanced: boolean;
  state_file: string;
  last_synced_log_id?: string;
};

export type LogsStatusParams = {
  targetOrg?: string;
  workspaceRoot?: string;
};

export type LogsStatusResult = {
  target_org: string;
  safe_target_org: string;
  workspace_root: string;
  apexlogs_root: string;
  state_file: string;
  log_count: number;
  has_state: boolean;
  last_sync_started_at?: string;
  last_sync_completed_at?: string;
  last_synced_log_id?: string;
  last_synced_start_time?: string;
  downloaded_count: number;
  cached_count: number;
  last_error?: string;
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

export type SkillsInstallResult = {
  status: string;
  skill_name: string;
  skillName: string;
  codex_home: string;
  codexHome: string;
  source: string;
  destination_dir: string;
  destination: string;
  files: string[];
  fileCount: number;
  replaced: boolean;
  dry_run: boolean;
  dryRun: boolean;
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

export type ResolveCachedLogPathParams = {
  logId: string;
  username?: string;
  workspaceRoot?: string;
};

export type ResolveCachedLogPathResult = {
  path?: string;
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
  | { type: 'user'; userId: string }
  | { type: 'automatedProcess' }
  | { type: 'platformIntegration' };

export type TraceFlagStatusParams = {
  targetOrg?: string;
  target: TraceFlagTarget;
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

export type TraceFlagTargetStatus = {
  target: TraceFlagTarget;
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
};

export type TraceFlagApplyResult = {
  status: string;
  dryRun: boolean;
  created: boolean;
  createdCount: number;
  updatedCount: number;
  resolvedTargetCount: number;
  traceFlagIds?: string[];
};

export type TraceFlagRemoveResult = {
  status: string;
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

export type DebugLevelWriteParams = {
  targetOrg?: string;
  id?: string;
  record: RuntimeDebugLevelRecord;
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
