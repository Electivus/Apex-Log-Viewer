import * as vscode from 'vscode';
import {
  SfLogsViewProvider,
  WEBVIEW_READY_TIMEOUT_MS,
  WEBVIEW_STABLE_VISIBILITY_DELAY_MS
} from './provider/SfLogsViewProvider';
import { SfLogTailViewProvider } from './provider/SfLogTailViewProvider';
import type { OrgItem } from './shared/types';
import * as path from 'path';
import { setApiVersion, getApiVersion, clearListCache } from './host/salesforce/http';
import {
  logInfo,
  logWarn,
  logError,
  showOutput,
  setTraceEnabled,
  disposeLogger,
  getRecentLogEntries
} from './host/utils/logger';
import { localize } from './host/utils/localize';
import { activateTelemetry, safeSendEvent, safeSendException, disposeTelemetry } from './shared/telemetry';
import { CacheManager } from './host/utils/cacheManager';
import { LogViewerPanel } from './panel/LogViewerPanel';
import { DebugFlagsPanel } from './panel/DebugFlagsPanel';
import { LogsEditorPanel } from './panel/LogsEditorPanel';
import { TailEditorPanel } from './panel/TailEditorPanel';
import { runtimeClient } from './runtime/runtimeClient';
import { getBooleanConfig, affectsConfiguration } from './host/utils/config';
import { getErrorMessage } from './host/utils/error';
import { findSalesforceProjectInfo, isApexLogDocument, getLogIdFromLogFilePath } from './host/utils/workspace';
import { ApexLogCodeLensProvider } from './provider/ApexLogCodeLensProvider';
import { getWebviewDiagnosticEvents } from './shared/webviewDiagnostics';
import { formatDiagnosticsPackageMarkdown, type DiagnosticsPackage } from './shared/diagnosticsPackage';

interface OrgQuickPick extends vscode.QuickPickItem {
  username: string;
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJSON = (context as any).extension?.packageJSON ?? (context as any).extensionPackageJSON;
  return typeof packageJSON?.version === 'string' ? packageJSON.version : 'unknown';
}

function buildDiagnosticsPackage(
  context: vscode.ExtensionContext,
  provider: SfLogsViewProvider,
  tailProvider: SfLogTailViewProvider,
  salesforceProject: Awaited<ReturnType<typeof findSalesforceProjectInfo>>,
  generatedAt = new Date().toISOString()
): DiagnosticsPackage {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const providerStates = [provider.getWebviewDiagnosticState(), tailProvider.getWebviewDiagnosticState()];
  const logsEditorState = LogsEditorPanel.getDiagnosticState();
  const tailEditorState = TailEditorPanel.getDiagnosticState();
  if (logsEditorState) {
    providerStates.push(logsEditorState);
  }
  if (tailEditorState) {
    providerStates.push(tailEditorState);
  }
  return {
    generatedAt,
    extension: {
      name: 'Electivus Apex Log Viewer',
      version: getExtensionVersion(context)
    },
    vscode: {
      version: vscode.version,
      appName: vscode.env.appName,
      appHost: (vscode.env as any).appHost,
      appRoot: (vscode.env as any).appRoot,
      language: vscode.env.language,
      remoteName: vscode.env.remoteName,
      uiKind: vscode.env.uiKind
    },
    process: {
      platform: process.platform,
      arch: process.arch,
      versions: {
        node: process.versions.node,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        v8: process.versions.v8
      }
    },
    workspace: {
      hasWorkspace: workspaceFolders.length > 0,
      workspaceFolderCount: workspaceFolders.length,
      workspaceFolders: workspaceFolders.map(folder => folder.uri.fsPath),
      hasSalesforceProject: !!salesforceProject,
      salesforceProjectRoot: salesforceProject?.workspaceRoot,
      salesforceProjectFile: salesforceProject?.projectFilePath,
      sourceApiVersion: salesforceProject?.sourceApiVersion
    },
    webview: {
      retainContextWhenHidden: true,
      stableVisibilityDelayMs: WEBVIEW_STABLE_VISIBILITY_DELAY_MS,
      readyTimeoutMs: WEBVIEW_READY_TIMEOUT_MS,
      providers: providerStates,
      events: getWebviewDiagnosticEvents()
    },
    recentLogs: getRecentLogEntries()
  };
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
    const trace = getBooleanConfig('electivus.apexLogViewer.logging.trace', false);
    setTraceEnabled(trace);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'electivus.apexLogViewer.logging.trace')) {
          const next = getBooleanConfig('electivus.apexLogViewer.logging.trace', false);
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
    vscode.commands.registerCommand('electivus.apexLogViewer.logs.refresh', async () => {
      const t0 = Date.now();
      const viewAlreadyResolved = provider.hasResolvedView();
      try {
        await vscode.commands.executeCommand('workbench.view.extension.electivus-apex-log-viewer-logs');
        try {
          await vscode.commands.executeCommand('workbench.viewsService.openView', 'electivus.apexLogViewer.logsView');
        } catch {
          await vscode.commands.executeCommand('workbench.action.openView', 'electivus.apexLogViewer.logsView');
        }
      } catch (e) {
        logWarn('Command electivus.apexLogViewer.logs.refresh: failed to open logs view ->', getErrorMessage(e));
      }
      // The logs webview runs an initial refresh when it posts the "ready" message.
      // Avoid triggering a second refresh (and duplicate notifications) on the first open.
      try {
        if (viewAlreadyResolved) {
          await provider.refresh();
        }
      } finally {
        try {
          safeSendEvent('command.refresh', { outcome: 'invoked' }, { durationMs: Date.now() - t0 });
        } catch {}
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('electivus.apexLogViewer.org.select', async () => {
      logInfo('Command electivus.apexLogViewer.org.select invoked. Listing orgs…');
      try {
        const orgs: OrgItem[] = await runtimeClient.orgList({ forceRefresh: true });
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
    vscode.commands.registerCommand('electivus.apexLogViewer.tail.start', async () => {
      logInfo('Command electivus.apexLogViewer.tail.start invoked. Opening Tail view and starting…');
      safeSendEvent('command.tail', { outcome: 'invoked' });
      try {
        await tailProvider.syncSelectedOrg(provider.getSelectedOrg());
        await provider.tailLogs();
        await tailProvider.refreshViewState();
      } catch (e) {
        logWarn('Command electivus.apexLogViewer.tail.start: failed to open tail view ->', getErrorMessage(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('electivus.apexLogViewer.logs.openEditor', async () => {
      safeSendEvent('command.openLogsEditor', { outcome: 'invoked' });
      try {
        await LogsEditorPanel.show({ selectedOrg: provider.getSelectedOrg() });
      } catch (e) {
        logWarn('Command electivus.apexLogViewer.logs.openEditor failed ->', getErrorMessage(e));
        safeSendEvent('command.openLogsEditor', { outcome: 'error' });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('electivus.apexLogViewer.tail.openEditor', async () => {
      safeSendEvent('command.openTailEditor', { outcome: 'invoked' });
      try {
        await TailEditorPanel.show({ selectedOrg: tailProvider.getSelectedOrg() ?? provider.getSelectedOrg() });
      } catch (e) {
        logWarn('Command electivus.apexLogViewer.tail.openEditor failed ->', getErrorMessage(e));
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
    vscode.commands.registerCommand('electivus.apexLogViewer.log.openViewer', async (uri?: vscode.Uri) => {
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
        logInfo('Command electivus.apexLogViewer.log.openViewer opened log viewer for', logId);
      } catch (e) {
        const msg = getErrorMessage(e);
        logWarn('Command electivus.apexLogViewer.log.openViewer failed ->', msg);
        void vscode.window.showErrorMessage(localize('openLogInViewer.failed', 'Failed to open Apex log: {0}', msg));
      }
    })
  );

  // Diagram and Call Tree features removed.

  // Convenience: command to show the output channel
  context.subscriptions.push(
    vscode.commands.registerCommand('electivus.apexLogViewer.output.show', () => {
      safeSendEvent('command.showOutput', { outcome: 'invoked' });
      showOutput(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('electivus.apexLogViewer.diagnostics.copy', async () => {
      try {
        const diagnostics = buildDiagnosticsPackage(context, provider, tailProvider, salesforceProject);
        const markdown = formatDiagnosticsPackageMarkdown(diagnostics);
        await vscode.env.clipboard.writeText(markdown);
        logInfo(
          'Diagnostics package copied to clipboard with',
          diagnostics.webview.events.length,
          'webview event(s) and',
          diagnostics.recentLogs.length,
          'log line(s).'
        );
        vscode.window.showInformationMessage(
          localize('diagnostics.copied', 'Electivus Apex Logs: diagnostics package copied to clipboard.')
        );
        safeSendEvent('command.copyDiagnostics', { outcome: 'ok' });
      } catch (e) {
        const msg = getErrorMessage(e);
        logWarn('Command electivus.apexLogViewer.diagnostics.copy failed ->', msg);
        vscode.window.showErrorMessage(
          localize('diagnostics.copyFailed', 'Electivus Apex Logs: failed to copy diagnostics: {0}', msg)
        );
        safeSendEvent('command.copyDiagnostics', { outcome: 'error' });
      }
    })
  );


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
