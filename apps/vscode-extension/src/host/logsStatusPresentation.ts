import { localize } from './utils/localize';

export type LogsStatusBarPresentation = { text: string; tooltip: string };

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
