import * as vscode from 'vscode';
import { presentLogsStatus } from './logsStatusPresentation';

export interface LogsStatusSource {
  getSelectedOrgLabel(): string | undefined;
  onDidChangeSelectedOrgLabel(listener: (label: string | undefined) => void): vscode.Disposable;
}

export interface LogsStatusBar extends vscode.Disposable {
  /** Shows the item once the workspace is known to hold a Salesforce project. */
  showForProject(): void;
}

/**
 * Reads only what `source` already knows, so it never lists orgs. Its click runs the focus command VS Code
 * registers for the Logs view.
 */
export function registerLogsStatusBar(source: LogsStatusSource, focusCommand: string): LogsStatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  item.command = focusCommand;
  const render = (label: string | undefined) => {
    const { text, tooltip } = presentLogsStatus(label);
    item.text = text;
    item.tooltip = tooltip;
  };
  const subscription = source.onDidChangeSelectedOrgLabel(render);
  render(source.getSelectedOrgLabel());
  return {
    showForProject() {
      item.show();
    },
    dispose() {
      subscription.dispose();
      item.dispose();
    }
  };
}
