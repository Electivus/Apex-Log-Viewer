import * as vscode from 'vscode';
import { presentCaptureStatus, type CustomLogsCaptureStatus } from './customLogsCaptureStatus';
import { localize } from './utils/localize';

export const CAPTURE_STATUS_COMMAND = 'electivus.apexLogViewer.customLogs.captureStatus';

export interface CaptureStatusSource {
  onDidChangeCaptureStatus(listener: (status: CustomLogsCaptureStatus | undefined) => void): vscode.Disposable;
  stopByUser(): void;
}

/**
 * One click command serves both actions, so a quick pick offers them: a click on a status item that stops
 * a capture by itself would be too easy to hit, and one that only reveals would leave no way to stop it.
 */
export function registerCaptureStatusBar(source: CaptureStatusSource, reveal: () => Promise<void>): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.command = CAPTURE_STATUS_COMMAND;
  const render = (status: CustomLogsCaptureStatus | undefined) => {
    const view = presentCaptureStatus(status);
    if (!view.visible) {
      item.hide();
      return;
    }
    item.text = view.text;
    item.tooltip = view.tooltip;
    item.show();
  };
  return vscode.Disposable.from(
    item,
    source.onDidChangeCaptureStatus(render),
    vscode.commands.registerCommand(CAPTURE_STATUS_COMMAND, async () => {
      const showPanel = localize('customLogs.status.reveal', 'Show Custom Logs');
      const stop = localize('customLogs.status.stop', 'Stop capture');
      const choice = await vscode.window.showQuickPick([showPanel, stop]);
      if (choice === showPanel) {
        await reveal();
      } else if (choice === stop) {
        source.stopByUser();
      }
    })
  );
}
