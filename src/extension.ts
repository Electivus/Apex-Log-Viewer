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
import { NewWindowLaunchService } from './services/NewWindowLaunchService';
import {
  getPendingLaunchMarkerPath,
  type NewWindowLaunchSourceView
} from './shared/newWindowLaunch';
import { getBooleanConfig, affectsConfiguration } from './utils/config';
import { getErrorMessage } from './utils/error';
import { listOrgs, getOrgAuth } from './salesforce/cli';
import {
  findSalesforceProjectInfo,
  getCurrentWorkspaceTarget,
  isApexLogDocument,
  getLogIdFromLogFilePath
} from './utils/workspace';
import { getLaunchMarkerDeadline, toWorkspaceScopedMarkerUri } from './utils/newWindowLaunchMarker';
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

function showOpenFolderWarning(): Promise<void> {
  return vscode.window.showWarningMessage(
    localize(
      'openInNewWindow.noWorkspace',
      'Electivus Apex Logs: Open a workspace folder before opening logs in a new window.'
    )
  ) as Promise<void>;
}

function showSalesforceWorkspaceWarning(): Promise<void> {
  return vscode.window.showWarningMessage(
    localize(
      'openLogInViewerInNewWindow.noSalesforceWorkspace',
      'Electivus Apex Logs: Open the log viewer in a Salesforce workspace before using this action.'
    )
  ) as Promise<void>;
}

function showSurfaceNewWindowSalesforceWorkspaceWarning(surfaceLabel: string): Promise<void> {
  return vscode.window.showWarningMessage(
    localize(
      'openInNewWindow.noSalesforceWorkspace',
      'Electivus Apex Logs: Open a Salesforce workspace before opening {0} in a new window.',
      surfaceLabel
    )
  ) as Promise<void>;
}

async function initializePersistentCache(context: vscode.ExtensionContext): Promise<void> {
  CacheManager.init(context.globalState);
  await CacheManager.clearExpired();
}

export async function activate(context: vscode.ExtensionContext) {
  const activationStart = Date.now();
  const logViewerNewWindowContextKey = 'sfLogs.canOpenLogViewerInNewWindow';
  LogViewerPanel.initialize(context);
  DebugFlagsPanel.initialize(context);
  const initialSalesforceProject = await findSalesforceProjectInfo();
  let currentSalesforceProject = initialSalesforceProject;
  const hasSalesforceProject = () => Boolean(currentSalesforceProject);
  const updateLogViewerNewWindowContext = async (enabled: boolean) => {
    try {
      await vscode.commands.executeCommand('setContext', logViewerNewWindowContextKey, enabled);
    } catch (e) {
      logWarn('Failed to update log viewer new-window context key ->', getErrorMessage(e));
    }
  };
  const refreshSalesforceWorkspaceState = async () => {
    currentSalesforceProject = await findSalesforceProjectInfo();
    if (currentSalesforceProject?.sourceApiVersion) {
      setApiVersion(currentSalesforceProject.sourceApiVersion);
    }
    await updateLogViewerNewWindowContext(hasSalesforceProject());
  };
  const refreshSalesforceWorkspaceStateSafely = () => {
    void refreshSalesforceWorkspaceState().catch(error => {
      logWarn('Failed to refresh Salesforce workspace state ->', getErrorMessage(error));
    });
  };
  await updateLogViewerNewWindowContext(hasSalesforceProject());
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
  if (initialSalesforceProject?.sourceApiVersion) {
    setApiVersion(initialSalesforceProject.sourceApiVersion);
    logInfo('Detected sourceApiVersion from sfdx-project.json:', initialSalesforceProject.sourceApiVersion);
  } else if (initialSalesforceProject) {
    logInfo('Detected Salesforce project workspace at', initialSalesforceProject.workspaceRoot);
  }

  let salesforceProjectWatchers: vscode.FileSystemWatcher[] = [];
  const disposeSalesforceProjectWatchers = () => {
    for (const watcher of salesforceProjectWatchers) {
      watcher.dispose();
    }
    salesforceProjectWatchers = [];
  };
  const recreateSalesforceProjectWatchers = () => {
    disposeSalesforceProjectWatchers();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, 'sfdx-project.json'));
      watcher.onDidCreate(refreshSalesforceWorkspaceStateSafely);
      watcher.onDidChange(refreshSalesforceWorkspaceStateSafely);
      watcher.onDidDelete(refreshSalesforceWorkspaceStateSafely);
      salesforceProjectWatchers.push(watcher);
    }
  };
  recreateSalesforceProjectWatchers();
  context.subscriptions.push({
    dispose: disposeSalesforceProjectWatchers
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      recreateSalesforceProjectWatchers();
      refreshSalesforceWorkspaceStateSafely();
    })
  );
  const provider = new SfLogsViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SfLogsViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(SfLogsViewProvider.editorPanelViewType, {
      deserializeWebviewPanel: async (webviewPanel, state) => {
        await provider.restoreEditorPanel(webviewPanel, state);
      }
    })
  );

  // Register Tail view provider
  const tailProvider = new SfLogTailViewProvider(context);
  context.subscriptions.push(
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
        await provider.tailLogs();
      } catch (e) {
        logWarn('Command sfLogs.tail: failed to open tail view ->', getErrorMessage(e));
      }
    })
  );

  const openLogsView = async (): Promise<void> => {
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

    if (viewAlreadyResolved) {
      await provider.refresh();
    }
  };

  const newWindowLaunchService = new NewWindowLaunchService({
    globalState: context.globalState,
    openFolder: async (workspaceTarget, options) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(workspaceTarget.uri), {
        forceNewWindow: true,
        filesToOpen: options?.filesToOpen?.map(filePath => toWorkspaceScopedMarkerUri(workspaceTarget, filePath))
      });
    },
    waitForLaunchMarker: async ({ nonce, createdAt }) => {
      const currentWorkspaceTarget = getCurrentWorkspaceTarget();
      const markerPath = path.resolve(getPendingLaunchMarkerPath(nonce));
      const markerUri = currentWorkspaceTarget ? toWorkspaceScopedMarkerUri(currentWorkspaceTarget, markerPath) : undefined;
      const deadline = getLaunchMarkerDeadline(createdAt);
      while (Date.now() <= deadline) {
        const openDocuments = [
          ...vscode.workspace.textDocuments,
          ...(vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document] : [])
        ];
        if (
          openDocuments.some(
            document => document.uri.toString() === markerUri?.toString()
          )
        ) {
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    },
    clearLaunchMarker: async nonce => {
      const markerPath = path.resolve(getPendingLaunchMarkerPath(nonce));
      const currentWorkspaceTarget = getCurrentWorkspaceTarget();
      const markerUri = currentWorkspaceTarget ? toWorkspaceScopedMarkerUri(currentWorkspaceTarget, markerPath) : undefined;
      const activeDocument = vscode.window.activeTextEditor?.document;
      if (activeDocument?.uri.toString() === markerUri?.toString()) {
        try {
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        } catch (error) {
          logWarn('Failed to close pending launch marker editor ->', getErrorMessage(error));
        }
      }
      try {
        await fs.promises.unlink(markerPath);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          logWarn('Failed to remove pending launch marker ->', getErrorMessage(error));
        }
      }
    }
  });

  const getWorkspaceTargetOrWarn = async () => {
    const workspaceTarget = getCurrentWorkspaceTarget();
    if (!workspaceTarget) {
      await showOpenFolderWarning();
      return undefined;
    }
    return workspaceTarget;
  };

  const launchInNewWindow = async (
    request:
      | {
          kind: 'logs' | 'tail' | 'debugFlags';
          selectedOrg?: string;
          sourceView?: NewWindowLaunchSourceView;
        }
      | {
          kind: 'logViewer';
          selectedOrg?: string;
          logId: string;
          filePath: string;
        }
  ) => {
    const workspaceTarget = await getWorkspaceTargetOrWarn();
    if (!workspaceTarget) {
      return;
    }

    await newWindowLaunchService.launchInNewWindow({
      ...request,
      workspaceTarget
    });
  };

  const getPreferredSelectedOrg = (): string | undefined => tailProvider.getSelectedOrg() || provider.getSelectedOrg();
  const getLogsViewSelectedOrg = (): string | undefined => provider.getSelectedOrg() || tailProvider.getSelectedOrg();

  const getPreferredDebugFlagsLaunch = (): { selectedOrg?: string; sourceView: NewWindowLaunchSourceView } => {
    const tailSelectedOrg = tailProvider.getSelectedOrg();
    if (tailSelectedOrg) {
      return { selectedOrg: tailSelectedOrg, sourceView: 'tail' };
    }

    const logsSelectedOrg = provider.getSelectedOrg();
    if (logsSelectedOrg) {
      return { selectedOrg: logsSelectedOrg, sourceView: 'logs' };
    }

    return { selectedOrg: undefined, sourceView: 'logs' };
  };

  const openLogsInNewWindow = async (selectedOrg: string | undefined, commandName: string) => {
    try {
      const previousSelectedOrg = provider.getSelectedOrg();
      const logsViewResolved = provider.hasResolvedView();
      const selectedOrgChanged = Boolean(selectedOrg) && selectedOrg !== previousSelectedOrg;
      if (selectedOrgChanged) {
        provider.setSelectedOrg(selectedOrg);
        if (logsViewResolved) {
          await provider.sendOrgs();
          await provider.refresh();
        }
      }
      await provider.showEditor({ refreshOnReveal: selectedOrgChanged && !logsViewResolved });
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch (error) {
      const msg = getErrorMessage(error);
      logWarn(`Command ${commandName} failed ->`, msg);
      throw error;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openLogsInNewWindow', async () =>
      openLogsInNewWindow(getPreferredSelectedOrg(), 'sfLogs.openLogsInNewWindow')
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openLogsInNewWindowFromLogsView', async () =>
      openLogsInNewWindow(getLogsViewSelectedOrg(), 'sfLogs.openLogsInNewWindowFromLogsView')
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openTailInNewWindow', async () => {
      try {
        if (!hasSalesforceProject()) {
          await showSurfaceNewWindowSalesforceWorkspaceWarning('Tail');
          return;
        }
        await launchInNewWindow({
          kind: 'tail',
          sourceView: 'tail',
          selectedOrg: tailProvider.getSelectedOrg() || provider.getSelectedOrg()
        });
      } catch (error) {
        const msg = getErrorMessage(error);
        logWarn('Command sfLogs.openTailInNewWindow failed ->', msg);
        throw error;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openDebugFlagsInNewWindow', async () => {
      try {
        if (!hasSalesforceProject()) {
          await showSurfaceNewWindowSalesforceWorkspaceWarning('Debug Flags');
          return;
        }
        const { selectedOrg, sourceView } = getPreferredDebugFlagsLaunch();
        await launchInNewWindow({
          kind: 'debugFlags',
          selectedOrg,
          sourceView
        });
      } catch (error) {
        const msg = getErrorMessage(error);
        logWarn('Command sfLogs.openDebugFlagsInNewWindow failed ->', msg);
        throw error;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sfLogs.openLogInViewerInNewWindow', async (uri?: vscode.Uri) => {
      let doc: vscode.TextDocument | undefined;
      try {
        doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      } catch {
        doc = undefined;
      }

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
      if (!hasSalesforceProject()) {
        await showSalesforceWorkspaceWarning();
        return;
      }
      try {
        await launchInNewWindow({
          kind: 'logViewer',
          selectedOrg: getPreferredSelectedOrg(),
          logId,
          filePath
        });
      } catch (error) {
        const msg = getErrorMessage(error);
        logWarn('Command sfLogs.openLogInViewerInNewWindow failed ->', msg);
        throw error;
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

  try {
    await newWindowLaunchService.consumePendingLaunch({
      restoreWindowContext: async ({ selectedOrg }: { selectedOrg?: string }) => {
        provider.setSelectedOrg(selectedOrg);
        await tailProvider.restoreSelectedOrg(selectedOrg);
      },
      openLogs: async ({ selectedOrg }: { selectedOrg?: string }) => {
        if (typeof selectedOrg === 'string') {
          provider.setSelectedOrg(selectedOrg);
        }
        await openLogsView();
      },
      openTail: async () => {
        await provider.tailLogs();
      },
      openDebugFlags: async ({ selectedOrg, sourceView }: { selectedOrg?: string; sourceView?: 'logs' | 'tail' }) => {
        await DebugFlagsPanel.show({
          selectedOrg,
          sourceView: sourceView ?? 'logs'
        });
      },
      openLogViewer: async ({
        logId,
        filePath,
        selectedOrg
      }: {
        selectedOrg?: string;
        logId: string;
        filePath: string;
      }) => {
        if (typeof selectedOrg === 'string') {
          provider.setSelectedOrg(selectedOrg);
        }
        if (!fs.existsSync(filePath)) {
          void vscode.window.showErrorMessage(
            localize(
              'openLogViewer.fileMissing',
              'Failed to restore Apex log viewer: {0} is no longer available.',
              filePath
            )
          );
          return;
        }
        await LogViewerPanel.show({ logId, filePath });
      }
    });
  } catch (error) {
    logWarn('Pending new-window launch restore failed ->', getErrorMessage(error));
  }

  // Removed legacy openTailPanel command to avoid focus changes

  // Preload CLI caches (org list and default org auth) in background
  try {
    const enabled = getBooleanConfig('sfLogs.cliCache.enabled', true);
    // Heuristic: skip when running inside VS Code test harness to avoid interfering with unit tests
    const isVsCodeTestHost = /\.vscode-test\b/i.test(String((vscode.env as any)?.appRoot || ''));
    if (enabled && hasSalesforceProject() && !isVsCodeTestHost) {
      setTimeout(async () => {
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
      }, 0);
    } else if (enabled && !hasSalesforceProject()) {
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
        hasSalesforceProject: String(hasSalesforceProject())
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
