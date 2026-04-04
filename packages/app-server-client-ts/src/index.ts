export * from './daemonProcess';
export * from './generated/index';
export * from './jsonlRpc';

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
};

export type SearchSnippet = {
  text: string;
  ranges: [number, number][];
};

export type SearchQueryParams = {
  username?: string;
  query: string;
  logIds?: string[];
  workspaceRoot?: string;
};

export type SearchQueryResult = {
  logIds: string[];
  snippets?: Record<string, SearchSnippet>;
  pendingLogIds?: string[];
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
  workspaceRoot?: string;
};

export type LogsTriageEntry = {
  logId: string;
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

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
};

export type JsonRpcSuccessResponse<TResult> = {
  jsonrpc: '2.0';
  id: string;
  result: TResult;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
};

export type JsonRpcErrorResponse = {
  jsonrpc: '2.0';
  id?: string;
  error: JsonRpcErrorObject;
};
