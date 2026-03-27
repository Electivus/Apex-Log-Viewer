import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { SfLogsViewProvider } from './provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from './provider/SfLogTailViewProvider';
import type { OrgItem } from './shared/types';
import * as path from 'path';
import { setApiVersion, getApiVersion, clearListCache } from './salesforce/http';
import { logInfo, logWarn, logError, showOutput, setTraceEnabled, disposeLogger } from './utils/logger';
import { localize } from './utils/localize';
import { activateTelemetry, safeSendEvent, safeSendException, disposeTelemetry } from './shared/telemetry';
import { CacheManager } from './utils/cacheManager';
import { LogViewerPanel } from './panel/LogViewerPanel';
import { DebugFlagsPanel } from './panel/DebugFlagsPanel';
import { LogsEditorPanel } from './panel/LogsEditorPanel';
import { TailEditorPanel } from './panel/TailEditorPanel';
import { getBooleanConfig, affectsConfiguration } from './utils/config';
import { getErrorMessage } from './utils/error';
import { listOrgs, getOrgAuth } from './salesforce/cli';
import { findSalesforceProjectInfo, isApexLogDocument, getLogIdFromLogFilePath } from './utils/workspace';
import { ApexLogCodeLensProvider } from './provider/ApexLogCodeLensProvider';
import {
  buildRemoteWebviewTroubleshootingMessage,
  buildWebviewTroubleshootingMessage,
  getLocalUiWebviewCachePaths,
  getRemoteEnvironmentLabel,
  getWebviewServiceWorkerPath
} from './utils/webviewTroubleshooting';

interface OrgQuickPick extends vscode.QuickPickItem {
  username: string;
}

async function initializePersistentCache(context: vscode.ExtensionContext): Promise<void> {
  CacheManager.init(context.globalState);
  await CacheManager.clearExpired();
}

export async function activate(context: vscode.ExtensionContext) {
  const activationStart = Date.now();
  LogViewerPanel.initialize(context);
  DebugFlagsPanel.initialize(context);
  LogsEditorPanel.initialize(context);
  TailEditorPanel.initialize(context);
  const salesforceProject = await findSalesforceProjectInfo();
  const hasSalesforceProject = !!salesforceProject;
  // Init TTL cache (best-effort; no-op if unavailable)
  try {
    await initializePersistentCache(context);
  } catch {}
  try {
    clearListCache();
  } catch {}
  // Initialize telemetry (no-op if no key/conn configured)
  try {
    activateTelemetry(context);
  } catch {
    // ignore telemetry init errors
  }
  // Keep Salesforce SDKs and CLI helpers from attempting on-disk log files inside the VS Code host.
  try {
    if (!process.env.SF_DISABLE_LOG_FILE) process.env.SF_DISABLE_LOG_FILE = 'true';
    if (!process.env.SFDX_DISABLE_LOG_FILE) process.env.SFDX_DISABLE_LOG_FILE = 'true';
  } catch (e) {
    const msg = getErrorMessage(e);
    logWarn('Failed to set disable log file env vars ->', msg);
  }
  logInfo('Activating Electivus Apex Log Viewer extension…');
  // Configure trace logging from settings
  try {
    const trace = getBooleanConfig('sfLogs.trace', false);
    setTraceEnabled(trace);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'sfLogs.trace')) {
          const next = getBooleanConfig('sfLogs.trace', false);
          setTraceEnabled(next);
        }
      })
    );
  } catch (e) {
    const msg = getErrorMessage(e);
    logWarn('Failed to configure trace logging ->', msg);
  }
  if (salesforceProject?.sourceApiVersion) {
    setApiVersion(salesforceProject.sourceApiVersion);
    logInfo('Detected sourceApiVersion from sfdx-project.json:', salesforceProject.sourceApiVersion);
  } else if (hasSalesforceProject) {
    logInfo('Detected Salesforce project workspace at', salesforceProject.workspaceRoot);
  }
  const provider = new SfLogsViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(SfLogsViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Register Tail view provider
  const tailProvider = new SfLogTailViewProvider(context);
  context.subscriptions.push(
    tailProvider,
    vscode.window.registerWebviewViewProvider(SfLogTailViewProvider.viewType, tailProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.refresh', async () => {
      safeSendEvent('command.refresh', { outcome: 'invoked' });
      const viewAlreadyResolved = provider.hasResolvedView();
      try {
        await vscode.commands.executeCommand('workbench.view.extension.salesforceLogsPanel');
        try {
          await vscode.commands.executeCommand('workbench.viewsService.openView', 'sfLogViewer');
        } catch {
          await vscode.commands.executeCommand('workbench.action.openView', 'sfLogViewer');
        }
      } catch (e) {
        logWarn('Command sfLogs.refresh: failed to open logs view ->', getErrorMessage(e));
      }
      // The logs webview runs an initial refresh when it posts the "ready" message.
      // Avoid triggering a second refresh (and duplicate notifications) on the first open.
      if (viewAlreadyResolved) {
        return provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.selectOrg', async () => {
      logInfo('Command sfLogs.selectOrg invoked. Listing orgs…');
      try {
        const orgs: OrgItem[] = await listOrgs(true);
        const items: OrgQuickPick[] = orgs.map(o => ({
          label: o.alias ?? o.username,
          detail: o.instanceUrl || undefined,
          username: o.username
        }));
        const picked = await vscode.window.showQuickPick<OrgQuickPick>(items, {
          placeHolder: localize('selectOrgPlaceholder', 'Select an authenticated org')
        });
        if (!picked) {
          logInfo('Select org cancelled.');
          safeSendEvent('command.selectOrg', { outcome: 'cancel' });
          return;
        }
        const username = picked.username;
        provider.setSelectedOrg(username);
        logInfo('Selected org:', username);
        const count = orgs.length;
        const bucket = count === 0 ? '0' : count === 1 ? '1' : count <= 5 ? '2-5' : count <= 10 ? '6-10' : '10+';
        const hasDefault = String(orgs.some(o => o.isDefaultUsername));
        safeSendEvent('command.selectOrg', { outcome: 'picked', orgs: bucket, hasDefault });
        await provider.sendOrgs();
        await provider.refresh();
      } catch (e) {
        const msg = getErrorMessage(e);
        logError('Failed listing orgs ->', msg);
        vscode.window.showErrorMessage(localize('selectOrgError', 'Electivus Apex Logs: Failed to list orgs'));
        // Do not send raw error messages to telemetry; use a coarse code instead
        safeSendException('command.selectOrg', { code: 'LIST_ORGS_FAILED' });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.tail', async () => {
      logInfo('Command sfLogs.tail invoked. Opening Tail view and starting…');
      safeSendEvent('command.tail', { outcome: 'invoked' });
      try {
        await tailProvider.syncSelectedOrg(provider.getSelectedOrg());
        await provider.tailLogs();
        await tailProvider.refreshViewState();
      } catch (e) {
        logWarn('Command sfLogs.tail: failed to open tail view ->', getErrorMessage(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openLogsEditor', async () => {
      safeSendEvent('command.openLogsEditor', { outcome: 'invoked' });
      try {
        await LogsEditorPanel.show({ selectedOrg: provider.getSelectedOrg() });
      } catch (e) {
        logWarn('Command sfLogs.openLogsEditor failed ->', getErrorMessage(e));
        safeSendEvent('command.openLogsEditor', { outcome: 'error' });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openTailEditor', async () => {
      safeSendEvent('command.openTailEditor', { outcome: 'invoked' });
      try {
        await TailEditorPanel.show({ selectedOrg: tailProvider.getSelectedOrg() ?? provider.getSelectedOrg() });
      } catch (e) {
        logWarn('Command sfLogs.openTailEditor failed ->', getErrorMessage(e));
        safeSendEvent('command.openTailEditor', { outcome: 'error' });
      }
    })
  );

  const codeLensProvider = new ApexLogCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file', language: 'apexlog' }, codeLensProvider),
    codeLensProvider
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openLogInViewer', async (uri?: vscode.Uri) => {
      safeSendEvent('command.openLogInViewer', { outcome: 'invoked' });
      try {
        const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
        if (!doc || doc.isClosed) {
          void vscode.window.showWarningMessage(
            localize('openLogInViewer.noDocument', 'Electivus Apex Logs: No Apex log is active.')
          );
          return;
        }
        if (doc.uri.scheme !== 'file' || !doc.uri.fsPath) {
          void vscode.window.showWarningMessage(
            localize(
              'openLogInViewer.unsupportedScheme',
              'Electivus Apex Logs: Unable to open Apex logs from this location.'
            )
          );
          return;
        }
        if (!isApexLogDocument(doc)) {
          void vscode.window.showWarningMessage(
            localize(
              'openLogInViewer.notApex',
              'Electivus Apex Logs: The active document is not recognized as a Salesforce Apex log.'
            )
          );
          return;
        }
        const filePath = doc.uri.fsPath;
        const logId = getLogIdFromLogFilePath(filePath) ?? path.parse(filePath).name;
        await LogViewerPanel.show({ logId, filePath });
        logInfo('Command sfLogs.openLogInViewer opened log viewer for', logId);
      } catch (e) {
        const msg = getErrorMessage(e);
        logWarn('Command sfLogs.openLogInViewer failed ->', msg);
        void vscode.window.showErrorMessage(localize('openLogInViewer.failed', 'Failed to open Apex log: {0}', msg));
      }
    })
  );

  // Diagram and Call Tree features removed.

  // Convenience: command to show the output channel
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.showOutput', () => {
      safeSendEvent('command.showOutput', { outcome: 'invoked' });
      showOutput(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.troubleshootWebview', async () => {
      safeSendEvent('command.troubleshootWebview', { outcome: 'invoked' });
      const appName = vscode.env.appName || 'VS Code';
      const remoteName = vscode.env.remoteName;
      const showOutputLabel = localize('webviewTroubleshooting.showOutput', 'Show Extension Output');

      if (remoteName) {
        const cachePaths = getLocalUiWebviewCachePaths(appName);
        const remoteLabel = getRemoteEnvironmentLabel(remoteName);
        const message = localize(
          'webviewTroubleshooting.remoteMessage',
          buildRemoteWebviewTroubleshootingMessage(appName, remoteLabel, cachePaths),
          appName,
          remoteLabel,
          cachePaths.windows,
          cachePaths.macos,
          cachePaths.linux
        );
        const copyStepsLabel = localize('webviewTroubleshooting.copySteps', 'Copy Recovery Steps');
        const choice = await vscode.window.showWarningMessage(
          message,
          { modal: true },
          copyStepsLabel,
          showOutputLabel
        );

        if (choice === copyStepsLabel) {
          await vscode.env.clipboard.writeText(message);
          void vscode.window.showInformationMessage(
            localize('webviewTroubleshooting.remoteCopied', 'Copied webview recovery steps.')
          );
          return;
        }

        if (choice === showOutputLabel) {
          showOutput(true);
        }
        return;
      }

      const serviceWorkerPath = getWebviewServiceWorkerPath({ appName });
      const message = localize(
        'webviewTroubleshooting.message',
        buildWebviewTroubleshootingMessage(appName, serviceWorkerPath),
        appName,
        serviceWorkerPath
      );
      const openFolderLabel = localize('webviewTroubleshooting.openFolder', 'Open Cache Folder');
      const copyPathLabel = localize('webviewTroubleshooting.copyPath', 'Copy Cache Path');
      const choice = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        openFolderLabel,
        copyPathLabel,
        showOutputLabel
      );

      if (choice === openFolderLabel) {
        const target = fs.existsSync(serviceWorkerPath) ? serviceWorkerPath : path.dirname(serviceWorkerPath);
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        return;
      }

      if (choice === copyPathLabel) {
        await vscode.env.clipboard.writeText(serviceWorkerPath);
        void vscode.window.showInformationMessage(
          localize('webviewTroubleshooting.copied', 'Copied webview cache path: {0}', serviceWorkerPath)
        );
        return;
      }

      if (choice === showOutputLabel) {
        showOutput(true);
      }
    })
  );

  // Reset CLI cache command
  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.resetCliCache', async () => {
      try {
        await CacheManager.delete('cli');
        logInfo('CLI cache cleared.');
        vscode.window.showInformationMessage('Electivus Apex Logs: CLI cache cleared');
        safeSendEvent('command.resetCliCache', { outcome: 'ok' });
      } catch (e) {
        const msg = getErrorMessage(e);
        logWarn('Failed clearing CLI cache ->', msg);
        vscode.window.showErrorMessage('Electivus Apex Logs: Failed to clear CLI cache');
        safeSendEvent('command.resetCliCache', { outcome: 'error' });
      }
    })
  );

  // Removed legacy openTailPanel command to avoid focus changes

  // Preload CLI caches (org list and default org auth) in background
  try {
    const enabled = getBooleanConfig('sfLogs.cliCache.enabled', true);
    // Heuristic: skip when running inside VS Code test harness to avoid interfering with unit tests
    const isVsCodeTestHost = /\.vscode-test\b/i.test(String((vscode.env as any)?.appRoot || ''));
    if (enabled && hasSalesforceProject && !isVsCodeTestHost) {
      setTimeout(() => {
        void (async () => {
          try {
            logInfo('Preloading CLI caches (org list, default auth)…');
            const orgs = await listOrgs(false);
            const def = orgs.find(o => o.isDefaultUsername) || orgs[0];
            if (def) {
              try {
                await getOrgAuth(def.username);
              } catch {}
            } else {
              // If no orgs, attempt default auth anyway (may fill cache if CLI has default)
              try {
                await getOrgAuth(undefined);
              } catch {}
            }
            logInfo('Preloading CLI caches done.');
          } catch (e) {
            // Best-effort; ignore errors
            logWarn('Preloading CLI caches failed ->', getErrorMessage(e));
          }
        })();
      }, 0);
    } else if (enabled && !hasSalesforceProject) {
      logInfo('Skipping CLI cache preload because no sfdx-project.json was found in the workspace.');
    }
  } catch (e) {
    logWarn('Failed to schedule CLI cache preload ->', getErrorMessage(e));
  }

  // Return exports for tests and programmatic use
  try {
    safeSendEvent(
      'extension.activate',
      {
        outcome: 'ok',
        hasWorkspace: String(!!vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0),
        hasSalesforceProject: String(hasSalesforceProject)
      },
      { durationMs: Date.now() - activationStart }
    );
  } catch {}
  return {
    getApiVersion
  };
}

export function deactivate() {
  disposeLogger();
  try {
    disposeTelemetry();
  } catch {
    // ignore
  }
}

export const __test__ = {
  initializePersistentCache
};
