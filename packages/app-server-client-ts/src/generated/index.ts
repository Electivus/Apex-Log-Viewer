export type InitializeParams = {
  client_name: string;
  client_version: string;
};

export type RuntimeCapabilities = {
  orgs: boolean;
  logs: boolean;
  search: boolean;
  tail: boolean;
  debug_flags: boolean;
  doctor: boolean;
};

export type InitializeResult = {
  runtime_version: string;
  cli_version: string;
  protocol_version: string;
  channel: string;
  platform: string;
  arch: string;
  capabilities: RuntimeCapabilities;
  state_dir: string;
  cache_dir: string;
};
