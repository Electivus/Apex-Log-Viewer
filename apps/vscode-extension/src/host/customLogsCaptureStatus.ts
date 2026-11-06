import { localize } from './utils/localize';
import type { CustomLogCaptureStateView } from '../shared/customLogsTypes';

export type CustomLogsCaptureStatus = { sourceLabel: string; capture: CustomLogCaptureStateView };

export type CustomLogsStatusBarPresentation = { visible: false } | { visible: true; text: string; tooltip: string };

const HIDDEN: CustomLogsStatusBarPresentation = { visible: false };

type Described = { sourceLabel: string; state: string; detail: string };

function describe({ sourceLabel, capture }: CustomLogsCaptureStatus): Described | undefined {
  const described = (state: string, detail: string): Described => ({ sourceLabel, state, detail });
  switch (capture.state) {
    case 'connecting':
      return described(
        localize('customLogs.status.connecting', 'Connecting'),
        localize('customLogs.status.connecting.detail', 'Connecting to {0} to capture its events.', sourceLabel)
      );
    case 'standby':
      return described(
        localize('customLogs.status.standby', 'Standby'),
        localize(
          'customLogs.status.standby.detail',
          'Another VS Code window or sf command is capturing {0}; new events appear here.',
          sourceLabel
        )
      );
    case 'catchingUp':
      return described(
        localize('customLogs.status.catchingUp', 'Catching up'),
        localize(
          'customLogs.status.catchingUp.detail',
          'Loading events of {0} that were published earlier.',
          sourceLabel
        )
      );
    case 'live':
      return described(
        localize('customLogs.status.live', 'Live'),
        localize(
          'customLogs.status.live.detail',
          'Capturing {0}. Each new event counts against the org daily delivery allocation.',
          sourceLabel
        )
      );
    case 'reconnecting':
      return described(
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
      return undefined;
  }
}

/**
 * One item for every capture of the window. The view and its editor tab watching one source show the same
 * source and state, so they read as one capture; different ones read as a count, each named in the tooltip.
 */
export function presentCaptureStatus(statuses: readonly CustomLogsCaptureStatus[]): CustomLogsStatusBarPresentation {
  const running = new Map<string, Described>();
  for (const status of statuses) {
    const described = describe(status);
    if (described) {
      running.set(JSON.stringify([described.sourceLabel, described.state]), described);
    }
  }
  const all = [...running.values()];
  const [only] = all;
  if (!only) {
    return HIDDEN;
  }
  if (all.length === 1) {
    return {
      visible: true,
      text: localize('customLogs.status.text', '$(broadcast) Custom Logs: {0} · {1}', only.sourceLabel, only.state),
      tooltip: `${only.detail}\n${localize('customLogs.status.action', 'Click to show the panel or stop the capture.')}`
    };
  }
  return {
    visible: true,
    text: localize('customLogs.status.many', '$(broadcast) Custom Logs: {0} captures', all.length),
    tooltip: [
      ...all.map(({ sourceLabel, state }) => `${sourceLabel} · ${state}`),
      localize('customLogs.status.many.action', 'Click to show the panel or stop every capture of this window.')
    ].join('\n')
  };
}
