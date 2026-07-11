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
