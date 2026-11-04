import { DEFAULT_TRACE_FLAG_LOG_TYPE, TRACE_FLAG_LOG_TYPES } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';

export const targetOrgFlag = Flags.string({
  char: 'o',
  summary: 'Username or alias of the target Salesforce org.'
});

export const workspaceRootFlag = Flags.directory({
  summary: 'Workspace containing the apexlogs directory.'
});

export const dryRunFlag = Flags.boolean({
  default: false,
  summary: 'Preview the operation without changing Salesforce or local files.'
});

export const yesFlag = Flags.boolean({
  char: 'y',
  default: false,
  summary: 'Confirm a destructive operation.'
});

export const idFlag = Flags.string({ summary: 'Salesforce record id.' });

export const developerNameFlag = Flags.string({ summary: 'Debug level developer name.' });

export const traceFlagLogTypeFlag = Flags.option({
  options: TRACE_FLAG_LOG_TYPES,
  default: DEFAULT_TRACE_FLAG_LOG_TYPE,
  summary:
    'Trace flag log type. DEVELOPER_LOG, the default, is the type Apex checkpoints need. USER_DEBUG is the type Setup > Debug Logs creates. When a user has both active, the DEVELOPER_LOG debug level applies.'
})();
