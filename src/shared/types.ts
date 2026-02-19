// Shared types between extension and webview (type-only for webview)
export type ApexLogRow = {
  Id: string;
  StartTime: string;
  Operation: string;
  Application: string;
  DurationMilliseconds: number;
  Status: string;
  Request: string;
  LogLength: number;
  LogUser?: { Name?: string };
};

export type OrgItem = {
  username: string;
  alias?: string;
  isDefaultUsername?: boolean;
  isDefaultDevHubUsername?: boolean;
  isScratchOrg?: boolean;
  instanceUrl?: string;
};
