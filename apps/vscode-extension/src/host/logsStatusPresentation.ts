import { localize } from './utils/localize';
import type { OrgItem } from '../shared/types';

export type LogsStatusBarPresentation = { text: string; tooltip: string };

/** The label the status bar shows for `selected`, an org username: its alias, else the username. */
export function selectedOrgLabel(orgs: readonly OrgItem[], selected: string | undefined): string | undefined {
  if (!selected) {
    return undefined;
  }
  return orgs.find(org => org.username === selected)?.alias || selected;
}

export function presentLogsStatus(orgLabel: string | undefined): LogsStatusBarPresentation {
  if (!orgLabel) {
    return {
      text: '$(output) Apex Logs',
      tooltip: localize('logsStatus.tooltip', 'Open the Apex Logs panel to browse, search and debug Apex logs.')
    };
  }
  return {
    text: `$(output) Apex Logs: ${orgLabel}`,
    tooltip: localize(
      'logsStatus.tooltip.org',
      'Open the Apex Logs panel to browse, search and debug the Apex logs of {0}.',
      orgLabel
    )
  };
}
