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
