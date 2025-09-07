import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { localize } from '../utils/localize';
import { createLimiter, type Limiter } from '../utils/limiter';
import { getOrgAuth, listOrgs } from '../salesforce/cli';
import {
  fetchApexLogs,
  fetchApexLogBody,
  fetchApexLogHead,
  extractCodeUnitStartedFromLines,
  clearListCache
} from '../salesforce/http';
import type { ApexLogRow, OrgItem } from '../shared/types';
import type { OrgAuth } from '../salesforce/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { logInfo, logWarn, logError } from '../utils/logger';
import { warmUpReplayDebugger, ensureReplayDebuggerAvailable } from '../utils/warmup';
import { buildWebviewHtml } from '../utils/webviewHtml';
import {
  getWorkspaceRoot as utilGetWorkspaceRoot,
  ensureApexLogsDir as utilEnsureApexLogsDir,
  getLogFilePathWithUsername as utilGetLogFilePathWithUsername,
  findExistingLogFile as utilFindExistingLogFile
} from '../utils/workspace';
import { persistSelectedOrg, restoreSelectedOrg, pickSelectedOrg } from '../utils/orgs';
import { getNumberConfig, affectsConfiguration } from '../utils/config';

export class SfLogsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sfLogViewer';
  private view?: vscode.WebviewView;
  private pageLimit = 100;
  private currentOffset = 0;
  private selectedOrg: string | undefined;
  private headLimiter: Limiter;
  private headConcurrency: number = 5;
  private disposed = false;
  private refreshToken = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.headLimiter = createLimiter(this.headConcurrency);
    // Restore last selected org from persisted state
    const persisted = restoreSelectedOrg(this.context);
    if (persisted) {
      this.selectedOrg = persisted;
      logInfo('Logs: restored selected org from globalState:', this.selectedOrg || '(default)');
    }
    // React to settings changes live (no manual refresh required)
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsConfiguration(e, 'sfLogs.headConcurrency')) {
          const nextConc = getNumberConfig('sfLogs.headConcurrency', this.headConcurrency, 1, Number.MAX_SAFE_INTEGER);
          if (nextConc !== this.headConcurrency) {
            this.headConcurrency = nextConc;
            this.headLimiter = createLimiter(this.headConcurrency);
          }
        }
      })
    );
  }

  private getWorkspaceRoot(): string | undefined {
    return utilGetWorkspaceRoot();
  }

  private async ensureApexLogsDir(): Promise<string> {
    return utilEnsureApexLogsDir();
  }

  private async findExistingLogFile(logId: string): Promise<string | undefined> {
    return utilFindExistingLogFile(logId);
  }

  private async getLogFilePathWithUsername(
    username: string | undefined,
    logId: string
  ): Promise<{ dir: string; filePath: string }> {
    return utilGetLogFilePathWithUsername(username, logId);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    this.disposed = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    logInfo('Logs webview resolved.');
    // Fire-and-forget warm-up of Replay Debugger when the view opens
    try {
      setTimeout(() => void warmUpReplayDebugger(), 0);
    } catch (e) {
      logWarn('Logs: warm-up of Apex Replay Debugger failed ->', e instanceof Error ? e.message : String(e));
    }
    // Dispose handling: stop posting and bump token to invalidate in-flight work
    this.context.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        this.refreshToken++;
        this.headLimiter = createLimiter(this.headConcurrency);
        logInfo('Logs webview disposed.');
      })
    );

    webviewView.webview.onDidReceiveMessage(async (message: WebviewToExtensionMessage) => {
      if (message?.type === 'ready') {
        logInfo('Logs: message ready');
        // Show loading while fetching orgs and initial logs
        this.post({ type: 'loading', value: true });
        await this.sendOrgs();
        await this.refresh();
        return;
      }
      if (message?.type === 'refresh') {
        logInfo('Logs: message refresh');
        await this.refresh();
      } else if (message?.type === 'getOrgs') {
        logInfo('Logs: message getOrgs');
        this.post({ type: 'loading', value: true });
        try {
          await this.sendOrgs();
        } finally {
          this.post({ type: 'loading', value: false });
        }
      } else if (message?.type === 'selectOrg') {
        const target = typeof message.target === 'string' ? message.target.trim() : undefined;
        const next = target || undefined;
        this.setSelectedOrg(next);
        logInfo('Logs: selected org set to', next || '(none)');
        await this.refresh();
      } else if (message?.type === 'openLog' && message.logId) {
        logInfo('Logs: openLog', message.logId);
        await this.openLog(message.logId);
      } else if (message?.type === 'replay' && message.logId) {
        logInfo('Logs: replay', message.logId);
        await this.debugLog(message.logId);
      } else if (message?.type === 'loadMore') {
        logInfo('Logs: loadMore');
        await this.loadMore();
      }
    });
  }

  public async refresh() {
    if (!this.view) {
      return;
    }
    const token = ++this.refreshToken;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize('refreshingLogs', 'Refreshing logs…')
      },
      async () => {
        this.post({ type: 'loading', value: true });
        try {
          clearListCache();
          const configuredLimit = getNumberConfig('sfLogs.pageSize', this.pageLimit, 10, Number.MAX_SAFE_INTEGER);
          if (configuredLimit > 200) {
            logWarn('Logs: sfLogs.pageSize clamped to 200 (was', configuredLimit, ')');
          }
          this.pageLimit = Math.min(configuredLimit, 200);
          const nextConc = getNumberConfig('sfLogs.headConcurrency', this.headConcurrency, 1, Number.MAX_SAFE_INTEGER);
          if (nextConc !== this.headConcurrency) {
            this.headConcurrency = nextConc;
            this.headLimiter = createLimiter(this.headConcurrency);
          }
          const auth = await getOrgAuth(this.selectedOrg);
          this.currentOffset = 0;
          const logs: ApexLogRow[] = await fetchApexLogs(auth, this.pageLimit, this.currentOffset);
          logInfo('Logs: fetched', logs.length, 'rows (pageSize =', this.pageLimit, ')');
          this.currentOffset += logs.length;
          if (token !== this.refreshToken || this.disposed) {
            return;
          }
          this.post({ type: 'init', locale: vscode.env.language });
          const hasMore = logs.length === this.pageLimit;
          this.post({ type: 'logs', data: logs, hasMore });
          // Limited parallel fetch of log heads
          this.loadLogHeads(logs, auth, token);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn('Logs: refresh failed ->', msg);
          this.post({ type: 'error', message: msg });
        } finally {
          this.post({ type: 'loading', value: false });
        }
      }
    );
  }

  private async loadMore() {
    if (!this.view) {
      return;
    }
    const token = this.refreshToken;
    this.post({ type: 'loading', value: true });
    try {
      const auth = await getOrgAuth(this.selectedOrg);
      const logs: ApexLogRow[] = await fetchApexLogs(auth, this.pageLimit, this.currentOffset);
      logInfo('Logs: loadMore fetched', logs.length);
      this.currentOffset += logs.length;
      if (token !== this.refreshToken || this.disposed) {
        return;
      }
      const hasMore = logs.length === this.pageLimit;
      this.post({ type: 'appendLogs', data: logs, hasMore });
      this.loadLogHeads(logs, auth, token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Logs: loadMore failed ->', msg);
      this.post({ type: 'error', message: msg });
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private loadLogHeads(logs: ApexLogRow[], auth: OrgAuth, token: number): void {
    for (const log of logs) {
      void this.headLimiter(async () => {
        try {
          const headLines = await fetchApexLogHead(
            auth,
            log.Id,
            10,
            typeof log.LogLength === 'number' ? log.LogLength : undefined
          );
          const codeUnit = extractCodeUnitStartedFromLines(headLines);
          if (codeUnit && token === this.refreshToken && !this.disposed) {
            this.post({ type: 'logHead', logId: log.Id, codeUnitStarted: codeUnit });
          }
        } catch {
          // ignore per-log error
        }
      });
    }
  }

  private async openLog(logId: string) {
    this.post({ type: 'loading', value: true });
    try {
      // Open directly if already present (works even without CLI)
      const existing = await this.findExistingLogFile(logId);
      let targetPath: string;
      if (existing) {
        targetPath = existing;
      } else {
        const auth = await getOrgAuth(this.selectedOrg);
        const { filePath } = await this.getLogFilePathWithUsername(auth.username, logId);
        const body = await fetchApexLogBody(auth, logId);
        await fs.writeFile(filePath, body, 'utf8');
        targetPath = filePath;
      }
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (e) {
      vscode.window.showErrorMessage(
        localize('openError', 'Failed to open log: ') + (e instanceof Error ? e.message : String(e))
      );
      logWarn('Logs: openLog failed ->', e instanceof Error ? e.message : String(e));
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async debugLog(logId: string) {
    try {
      // Ensure Replay Debugger is available before doing work
      const ok = await ensureReplayDebuggerAvailable();
      if (!ok) {
        return;
      }
      this.post({ type: 'loading', value: true });
      // Use existing file if present; otherwise fetch and save with username prefix
      let targetPath = await this.findExistingLogFile(logId);
      if (!targetPath) {
        const auth = await getOrgAuth(this.selectedOrg);
        const { filePath } = await this.getLogFilePathWithUsername(auth.username, logId);
        const body = await fetchApexLogBody(auth, logId);
        await fs.writeFile(filePath, body, 'utf8');
        targetPath = filePath;
      }
      const uri = vscode.Uri.file(targetPath);
      // Keep loading visible for the user-triggered launch and show a notification
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize('replayStarting', 'Starting Apex Replay Debugger…')
        },
        async () => {
          try {
            await vscode.commands.executeCommand('sf.launch.replay.debugger.logfile', uri);
          } catch (e) {
            logWarn('Logs: sf.launch.replay.debugger.logfile failed ->', e instanceof Error ? e.message : String(e));
            await vscode.commands.executeCommand('sfdx.launch.replay.debugger.logfile', uri);
          }
        }
      );
    } catch (e) {
      vscode.window.showErrorMessage(
        localize('replayError', 'Failed to launch Apex Replay Debugger: ') +
          (e instanceof Error ? e.message : String(e))
      );
      logWarn('Logs: replay failed ->', e instanceof Error ? e.message : String(e));
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return buildWebviewHtml(
      webview,
      this.context.extensionUri,
      'main.js',
      localize('salesforce.logs.view.name', 'Electivus Apex Logs')
    );
  }

  public async sendOrgs(forceRefresh = false) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize('listingOrgs', 'Listing Salesforce orgs…')
      },
      async () => {
        try {
          const orgs = await listOrgs(forceRefresh);
          const selected = pickSelectedOrg(orgs, this.selectedOrg);
          this.post({ type: 'orgs', data: orgs, selected });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError('Logs: list orgs failed ->', msg);
          void vscode.window.showErrorMessage(localize('sendOrgsFailed', 'Failed to list Salesforce orgs: {0}', msg));
          this.post({ type: 'orgs', data: [], selected: this.selectedOrg });
        }
      }
    );
  }

  // Expose for command integration
  public setSelectedOrg(username?: string) {
    this.selectedOrg = username;
    persistSelectedOrg(this.context, username);
  }

  public async tailLogs() {
    await vscode.commands.executeCommand('workbench.view.extension.salesforceTailPanel');
    await vscode.commands.executeCommand('workbench.viewsService.openView', 'sfLogTail');
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
