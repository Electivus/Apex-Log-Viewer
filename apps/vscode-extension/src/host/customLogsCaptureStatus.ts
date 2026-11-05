import { localize } from './utils/localize';
import type { CustomLogCaptureStateView } from '../shared/customLogsTypes';

export type CustomLogsCaptureStatus = { sourceLabel: string; capture: CustomLogCaptureStateView };

export type CustomLogsStatusBarPresentation = { visible: false } | { visible: true; text: string; tooltip: string };

const HIDDEN: CustomLogsStatusBarPresentation = { visible: false };

export function presentCaptureStatus(status: CustomLogsCaptureStatus | undefined): CustomLogsStatusBarPresentation {
  if (!status) {
    return HIDDEN;
  }
  const { sourceLabel, capture } = status;
  const item = (state: string, detail: string): CustomLogsStatusBarPresentation => ({
    visible: true,
    text: localize('customLogs.status.text', '$(broadcast) Custom Logs: {0} · {1}', sourceLabel, state),
    tooltip: `${detail}\n${localize('customLogs.status.action', 'Click to show the panel or stop the capture.')}`
  });
  switch (capture.state) {
    case 'connecting':
      return item(
        localize('customLogs.status.connecting', 'Connecting'),
        localize('customLogs.status.connecting.detail', 'Connecting to {0} to capture its events.', sourceLabel)
      );
    case 'standby':
      return item(
        localize('customLogs.status.standby', 'Standby'),
        localize(
          'customLogs.status.standby.detail',
          'Another VS Code window or sf command is capturing {0}; new events appear here.',
          sourceLabel
        )
      );
    case 'catchingUp':
      return item(
        localize('customLogs.status.catchingUp', 'Catching up'),
        localize(
          'customLogs.status.catchingUp.detail',
          'Loading events of {0} that were published earlier.',
          sourceLabel
        )
      );
    case 'live':
      return item(
        localize('customLogs.status.live', 'Live'),
        localize(
          'customLogs.status.live.detail',
          'Capturing {0}. Each new event counts against the org daily delivery allocation.',
          sourceLabel
        )
      );
    case 'reconnecting':
      return item(
        localize('customLogs.status.reconnecting', 'Reconnecting'),
        localize(
          'customLogs.status.reconnecting.detail',
          'Reconnecting to {0} (attempt {1}).',
          sourceLabel,
          capture.attempt
        )
      );
    case 'stopped':
    case 'failed':
      return HIDDEN;
  }
}
