import * as vscode from 'vscode';
import { presentCaptureStatus, type CustomLogsCaptureStatus } from './customLogsCaptureStatus';
import { localize } from './utils/localize';

export const CAPTURE_STATUS_COMMAND = 'electivus.apexLogViewer.customLogs.captureStatus';

export interface CaptureStatusSource {
  onDidChangeCaptureStatus(listener: (status: CustomLogsCaptureStatus | undefined) => void): vscode.Disposable;
  stopByUser(): void;
}

export interface CaptureStatusBar extends vscode.Disposable {
  /**
   * Shows the captures of `source`, a Custom Logs surface of this window, until the returned disposable runs.
   * `reveal` brings that surface forward.
   */
  track(source: CaptureStatusSource, reveal: () => Thenable<void> | void): vscode.Disposable;
}

type Tracked = { source: CaptureStatusSource; reveal: () => Thenable<void> | void; status?: CustomLogsCaptureStatus };

/**
 * The window's one capture status item, over every Custom Logs surface: the view and its editor tab each run
 * their own watcher, and core ends a shared run only when its last watcher leaves, so Stop stops them all.
 */
export function registerCaptureStatusBar(): CaptureStatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.command = CAPTURE_STATUS_COMMAND;
  const surfaces = new Set<Tracked>();
  let disposed = false;
  const capturing = () => [...surfaces].filter(surface => surface.status);
  const render = () => {
    if (disposed) {
      return;
    }
    const view = presentCaptureStatus(capturing().flatMap(surface => surface.status ?? []));
    if (!view.visible) {
      item.hide();
      return;
    }
    item.text = view.text;
    item.tooltip = view.tooltip;
    item.show();
  };
  const command = vscode.commands.registerCommand(CAPTURE_STATUS_COMMAND, async () => {
    const showPanel = localize('customLogs.status.reveal', 'Show Custom Logs');
    const stop = localize('customLogs.status.stop', 'Stop capture');
    const choice = await vscode.window.showQuickPick([showPanel, stop]);
    if (choice === showPanel) {
      const [surface = [...surfaces][0]] = capturing();
      await surface?.reveal();
    } else if (choice === stop) {
      for (const surface of capturing()) {
        surface.source.stopByUser();
      }
    }
  });
  return {
    track(source, reveal) {
      const surface: Tracked = { source, reveal };
      surfaces.add(surface);
      const subscription = source.onDidChangeCaptureStatus(status => {
        surface.status = status;
        render();
      });
      return {
        dispose: () => {
          subscription.dispose();
          surfaces.delete(surface);
          render();
        }
      };
    },
    dispose() {
      disposed = true;
      surfaces.clear();
      item.dispose();
      command.dispose();
    }
  };
}
