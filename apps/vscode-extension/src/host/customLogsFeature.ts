import * as vscode from 'vscode';
import { affectsConfiguration, getBooleanConfig } from './utils/config';
import { CUSTOM_LOG_DOCUMENT_SCHEME, registerCustomLogDocuments } from './utils/customLogDocuments';
import { registerCaptureStatusBar } from './customLogsStatusBar';
import { openCustomLogsConfig } from './utils/customLogsConfig';
import { getErrorMessage } from './utils/error';
import { logWarn } from './utils/logger';
import { CustomLogsEditorPanel } from '../panel/CustomLogsEditorPanel';
import { CustomLogViewerPanel } from '../panel/CustomLogViewerPanel';
import { CustomLogsViewProvider } from '../provider/CustomLogsViewProvider';
import { safeSendEvent } from '../shared/telemetry';
import type { WebviewProviderDiagnosticState } from '../shared/webviewDiagnostics';

export const CUSTOM_LOGS_ENABLED_SETTING = 'electivus.apexLogViewer.customLogs.enabled';

/** VS Code 1.145.2 adds this to the view type of a webview tab, though the API says it maps to the panel's. */
const REPORTED_WEBVIEW_TAB_PREFIX = /^mainThreadWebview-/;

/** Scans the tab groups because a tab can outlive the extension host whose panel tracked it. */
function closeCustomLogTabs(): void {
  const webviewViewTypes = new Set([CustomLogsEditorPanel.viewType, CustomLogViewerPanel.viewType]);
  const tabs = vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .filter(
      ({ input }) =>
        (input instanceof vscode.TabInputText && input.uri.scheme === CUSTOM_LOG_DOCUMENT_SCHEME) ||
        (input instanceof vscode.TabInputWebview &&
          webviewViewTypes.has(input.viewType.replace(REPORTED_WEBVIEW_TAB_PREFIX, '')))
    );
  void vscode.window.tabGroups.close(tabs);
}

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
    const revealPanel = async () => {
      await vscode.commands.executeCommand(`${CustomLogsViewProvider.viewType}.focus`);
    };
    const statusBar = registerCaptureStatusBar();
    CustomLogsEditorPanel.initialize(context, tab => statusBar.track(tab, () => CustomLogsEditorPanel.show()));
    CustomLogViewerPanel.initialize(context);
    const provider = new CustomLogsViewProvider(context, { trackCapture: view => statusBar.track(view, revealPanel) });
    running = {
      provider,
      registrations: vscode.Disposable.from(
        registerCustomLogDocuments(),
        provider,
        statusBar,
        vscode.window.registerWebviewViewProvider(CustomLogsViewProvider.viewType, provider, {
          webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('electivus.apexLogViewer.customLogs.refresh', async () => {
          safeSendEvent('command.customLogs.refresh', { outcome: 'invoked' });
          const viewAlreadyResolved = provider.hasResolvedView();
          try {
            await revealPanel();
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

  const sync = () => {
    if (getBooleanConfig(CUSTOM_LOGS_ENABLED_SETTING, false)) {
      start();
      return;
    }
    stop();
    // Not in stop(): at deactivation VS Code rejects the close, so a tab can outlive its extension host.
    closeCustomLogTabs();
  };
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
