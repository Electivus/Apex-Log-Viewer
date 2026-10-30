import * as vscode from 'vscode';
import { affectsConfiguration, getBooleanConfig } from './utils/config';
import { registerCustomLogDocuments } from './utils/customLogDocuments';
import { openCustomLogsConfig } from './utils/customLogsConfig';
import { getErrorMessage } from './utils/error';
import { logWarn } from './utils/logger';
import { CustomLogsEditorPanel } from '../panel/CustomLogsEditorPanel';
import { CustomLogViewerPanel } from '../panel/CustomLogViewerPanel';
import { CustomLogsViewProvider } from '../provider/CustomLogsViewProvider';
import { safeSendEvent } from '../shared/telemetry';
import type { WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';

export const CUSTOM_LOGS_ENABLED_SETTING = 'electivus.apexLogViewer.customLogs.enabled';

export interface CustomLogsFeature extends vscode.Disposable {
  /** The Custom Logs webviews that exist right now: none while the setting is off. */
  getWebviewDiagnosticStates(): WebviewProviderDiagnosticState[];
}

/**
 * Custom Logs is experimental and off by default. While `electivus.apexLogViewer.customLogs.enabled` is false
 * nothing of it exists in the extension host: no view provider, no `sfdx-project.json` watcher, no commands, so
 * no core call and no telemetry event. The manifest hides the panel tab and the palette entries on the same key.
 * Turning the setting on or off starts or stops all of it without a reload.
 */
export function registerCustomLogsFeature(
  context: vscode.ExtensionContext,
  logsSelectedOrg: () => string | undefined
): CustomLogsFeature {
  let running: { provider: CustomLogsViewProvider; registrations: vscode.Disposable } | undefined;

  const start = () => {
    if (running) {
      return;
    }
    CustomLogsEditorPanel.initialize(context);
    CustomLogViewerPanel.initialize(context);
    const provider = new CustomLogsViewProvider(context);
    running = {
      provider,
      registrations: vscode.Disposable.from(
        registerCustomLogDocuments(),
        provider,
        vscode.window.registerWebviewViewProvider(CustomLogsViewProvider.viewType, provider, {
          webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('electivus.apexLogViewer.customLogs.refresh', async () => {
          safeSendEvent('command.customLogs.refresh', { outcome: 'invoked' });
          const viewAlreadyResolved = provider.hasResolvedView();
          try {
            await vscode.commands.executeCommand('workbench.view.extension.electivus-apex-log-viewer-custom-logs');
            try {
              await vscode.commands.executeCommand('workbench.viewsService.openView', CustomLogsViewProvider.viewType);
            } catch {
              await vscode.commands.executeCommand('workbench.action.openView', CustomLogsViewProvider.viewType);
            }
            if (!provider.getSelectedOrg()) {
              await provider.syncSelectedOrg(logsSelectedOrg());
            }
            // A freshly resolved view loads when its webview posts "ready"; only an open one needs the refresh.
            if (viewAlreadyResolved) {
              await provider.refresh();
            }
          } catch (e) {
            logWarn('Command electivus.apexLogViewer.customLogs.refresh failed ->', getErrorMessage(e));
          }
        }),
        vscode.commands.registerCommand('electivus.apexLogViewer.customLogs.openEditor', async () => {
          safeSendEvent('command.customLogs.openEditor', { outcome: 'invoked' });
          try {
            await CustomLogsEditorPanel.show({ selectedOrg: provider.getSelectedOrg() ?? logsSelectedOrg() });
          } catch (e) {
            logWarn('Command electivus.apexLogViewer.customLogs.openEditor failed ->', getErrorMessage(e));
            safeSendEvent('command.customLogs.openEditor', { outcome: 'error' });
          }
        }),
        vscode.commands.registerCommand('electivus.apexLogViewer.customLogs.configure', async () => {
          safeSendEvent('command.customLogs.configure', { outcome: 'invoked' });
          try {
            await openCustomLogsConfig();
          } catch (e) {
            logWarn('Command electivus.apexLogViewer.customLogs.configure failed ->', getErrorMessage(e));
            safeSendEvent('command.customLogs.configure', { outcome: 'error' });
          }
        })
      )
    };
  };

  const stop = () => {
    if (!running) {
      return;
    }
    running.registrations.dispose();
    running = undefined;
    CustomLogsEditorPanel.close();
    CustomLogViewerPanel.closeAll();
  };

  const sync = () => (getBooleanConfig(CUSTOM_LOGS_ENABLED_SETTING, false) ? start() : stop());
  const configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (affectsConfiguration(event, CUSTOM_LOGS_ENABLED_SETTING)) {
      sync();
    }
  });
  sync();

  return {
    getWebviewDiagnosticStates: () =>
      [running?.provider.getWebviewDiagnosticState(), CustomLogsEditorPanel.getDiagnosticState()].flatMap(
        state => state ?? []
      ),
    dispose: () => {
      configurationListener.dispose();
      stop();
    }
  };
}
