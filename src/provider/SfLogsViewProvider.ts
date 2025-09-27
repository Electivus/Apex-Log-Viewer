import * as vscode from 'vscode';
import * as path from 'path';
import { localize } from '../utils/localize';
import { getOrgAuth } from '../salesforce/cli';
import { clearListCache } from '../salesforce/http';
import type { ApexLogRow } from '../shared/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { logInfo, logWarn, logError } from '../utils/logger';
import { safeSendEvent } from '../shared/telemetry';
import { warmUpReplayDebugger } from '../utils/warmup';
import { buildWebviewHtml } from '../utils/webviewHtml';
import { getErrorMessage } from '../utils/error';
import { LogService } from '../services/logService';
import { LogsMessageHandler } from './logsMessageHandler';
import { OrgManager } from '../utils/orgManager';
import { ConfigManager } from '../utils/configManager';
import { ensureApexLogsDir } from '../utils/workspace';
import { ripgrepSearch } from '../utils/ripgrep';

export class SfLogsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sfLogViewer';
  private view?: vscode.WebviewView;
  private pageLimit = 100;
  private currentOffset = 0;
  private disposed = false;
  private refreshToken = 0;
  private messageHandler: LogsMessageHandler;
  private cursorStartTime: string | undefined;
  private cursorId: string | undefined;
  private currentLogs: ApexLogRow[] = [];
  private lastSearchQuery = '';
  private searchToken = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logService = new LogService(),
    private readonly orgManager = new OrgManager(context),
    private readonly configManager = new ConfigManager(5, 100)
  ) {
    const org = this.orgManager.getSelectedOrg();
    if (org) {
      logInfo('Logs: restored selected org from globalState:', org || '(default)');
    }
    this.logService.setHeadConcurrency(this.configManager.getHeadConcurrency());
    this.messageHandler = new LogsMessageHandler(
      () => this.refresh(),
      () => this.sendOrgs(),
      o => this.setSelectedOrg(o),
      id => this.logService.openLog(id, this.orgManager.getSelectedOrg()),
      id => this.logService.debugLog(id, this.orgManager.getSelectedOrg()),
      () => this.loadMore(),
      v => this.post({ type: 'loading', value: v }),
      value => this.setSearchQuery(value)
    );
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        const prevFullBodies = this.configManager.shouldLoadFullLogBodies();
        this.configManager.handleChange(e);
        this.logService.setHeadConcurrency(this.configManager.getHeadConcurrency());
        if (prevFullBodies !== this.configManager.shouldLoadFullLogBodies()) {
          void this.refresh();
        }
      })
    );
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
      logWarn('Logs: warm-up of Apex Replay Debugger failed ->', getErrorMessage(e));
    }
    // Dispose handling: stop posting and bump token to invalidate in-flight work
    this.context.subscriptions.push(
      webviewView.onDidDispose(() => {
        this.disposed = true;
        this.view = undefined;
        this.refreshToken++;
        logInfo('Logs webview disposed.');
      })
    );

    this.context.subscriptions.push(
      webviewView.webview.onDidReceiveMessage(message => {
        void this.messageHandler.handle(message);
      })
    );
  }

  public async refresh() {
    if (!this.view) {
      return;
    }
    const token = ++this.refreshToken;
    const t0 = Date.now();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize('refreshingLogs', 'Refreshing logs…'),
        cancellable: true
      },
      async (_progress, ct) => {
        const controller = new AbortController();
        ct.onCancellationRequested(() => controller.abort());
        this.post({ type: 'loading', value: true });
        try {
          clearListCache();
          this.pageLimit = this.configManager.getPageLimit();
          const auth = await getOrgAuth(this.orgManager.getSelectedOrg(), undefined, controller.signal);
          if (ct.isCancellationRequested) {
            return;
          }
          this.currentOffset = 0;
          this.cursorStartTime = undefined;
          this.cursorId = undefined;
          const logs: ApexLogRow[] = await this.logService.fetchLogs(
            auth,
            this.pageLimit,
            this.currentOffset,
            controller.signal
          );
          if (ct.isCancellationRequested) {
            return;
          }
          logInfo('Logs: fetched', logs.length, 'rows (pageSize =', this.pageLimit, ')');
          this.currentOffset += logs.length;
          if (logs.length > 0) {
            const last = logs[logs.length - 1];
            this.cursorStartTime = last?.StartTime;
            this.cursorId = last?.Id;
          }
          if (token !== this.refreshToken || this.disposed) {
            return;
          }
          this.post({ type: 'init', locale: vscode.env.language });
          const hasMore = logs.length === this.pageLimit;
          this.post({ type: 'logs', data: logs, hasMore });
          this.currentLogs = logs.slice();
          this.logService.loadLogHeads(
            logs,
            auth,
            token,
            (logId, codeUnit) => {
              if (token === this.refreshToken && !this.disposed) {
                this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
              }
            },
            controller.signal
          );
          if (this.lastSearchQuery.trim()) {
            const searchToken = ++this.searchToken;
            void this.executeSearch(this.lastSearchQuery, searchToken);
          } else {
            this.post({ type: 'searchMatches', query: '', logIds: [] });
          }
          try {
            const durationMs = Date.now() - t0;
            safeSendEvent('logs.refresh', { outcome: 'ok' }, { durationMs, pageSize: this.pageLimit });
          } catch {}
        } catch (e) {
          if (!controller.signal.aborted) {
            const msg = getErrorMessage(e);
            logWarn('Logs: refresh failed ->', msg);
            this.post({ type: 'error', message: msg });
            try {
              const durationMs = Date.now() - t0;
              safeSendEvent('logs.refresh', { outcome: 'error' }, { durationMs, pageSize: this.pageLimit });
            } catch {}
          }
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
    const t0 = Date.now();
    this.post({ type: 'loading', value: true });
    try {
      const auth = await getOrgAuth(this.orgManager.getSelectedOrg());
      const logs: ApexLogRow[] = await this.logService.fetchLogs(
        auth,
        this.pageLimit,
        this.currentOffset,
        undefined,
        this.cursorStartTime && this.cursorId
          ? { beforeStartTime: this.cursorStartTime, beforeId: this.cursorId }
          : undefined
      );
      logInfo('Logs: loadMore fetched', logs.length);
      this.currentOffset += logs.length;
      if (logs.length > 0) {
        const last = logs[logs.length - 1];
        this.cursorStartTime = last?.StartTime;
        this.cursorId = last?.Id;
      }
      if (token !== this.refreshToken || this.disposed) {
        return;
      }
      const hasMore = logs.length === this.pageLimit;
      this.post({ type: 'appendLogs', data: logs, hasMore });
      this.currentLogs = [...this.currentLogs, ...logs];
      this.logService.loadLogHeads(logs, auth, token, (logId, codeUnit) => {
        if (token === this.refreshToken && !this.disposed) {
          this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
        }
      });
      if (this.lastSearchQuery.trim()) {
        const searchToken = ++this.searchToken;
        void this.executeSearch(this.lastSearchQuery, searchToken);
      }
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('logs.loadMore', { outcome: 'ok' }, { durationMs, count: logs.length });
      } catch {}
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('Logs: loadMore failed ->', msg);
      this.post({ type: 'error', message: msg });
      try {
        const durationMs = Date.now() - t0;
        safeSendEvent('logs.loadMore', { outcome: 'error' }, { durationMs });
      } catch {}
    } finally {
      this.post({ type: 'loading', value: false });
    }
  }

  private async setSearchQuery(value: string): Promise<void> {
    this.lastSearchQuery = value ?? '';
    const token = ++this.searchToken;
    await this.executeSearch(this.lastSearchQuery, token);
  }

  private async executeSearch(query: string, token: number): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }
    const trimmed = (query ?? '').trim();
    if (!trimmed) {
      if (token === this.searchToken && !this.disposed) {
        this.post({ type: 'searchMatches', query: '', logIds: [] });
      }
      return;
    }
    if (!this.configManager.shouldLoadFullLogBodies()) {
      if (token === this.searchToken && !this.disposed) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
      }
      return;
    }
    const logsSnapshot = [...this.currentLogs];
    if (logsSnapshot.length === 0) {
      if (token === this.searchToken && !this.disposed) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
      }
      return;
    }
    try {
      await this.logService.ensureLogsSaved(logsSnapshot, this.orgManager.getSelectedOrg());
      if (token !== this.searchToken || this.disposed) {
        return;
      }
      const dir = await ensureApexLogsDir();
      const files = await ripgrepSearch(trimmed, dir);
      if (token !== this.searchToken || this.disposed) {
        return;
      }
      const known = new Set(logsSnapshot.map(l => l.Id));
      const matches = new Set<string>();
      for (const file of files) {
        const logId = this.extractLogIdFromPath(file);
        if (logId && known.has(logId)) {
          matches.add(logId);
        }
      }
      this.post({ type: 'searchMatches', query: trimmed, logIds: Array.from(matches) });
    } catch (e) {
      logWarn('Logs: search failed ->', getErrorMessage(e));
      if (token === this.searchToken && !this.disposed) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
      }
    }
  }

  private extractLogIdFromPath(filePath: string): string | undefined {
    const base = path.basename(filePath);
    if (!base.toLowerCase().endsWith('.log')) {
      return undefined;
    }
    const withoutExt = base.slice(0, -4);
    const idx = withoutExt.lastIndexOf('_');
    const candidate = idx !== -1 ? withoutExt.slice(idx + 1) : withoutExt;
    if (/^[a-zA-Z0-9]{15,18}$/.test(candidate)) {
      return candidate;
    }
    return undefined;
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
    const t0 = Date.now();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize('listingOrgs', 'Listing Salesforce orgs…'),
        cancellable: true
      },
      async (_progress, ct) => {
        const controller = new AbortController();
        ct.onCancellationRequested(() => controller.abort());
        try {
          const { orgs, selected } = await this.orgManager.list(forceRefresh, controller.signal);
          if (ct.isCancellationRequested) {
            return;
          }
          this.post({ type: 'orgs', data: orgs, selected });
          try {
            const durationMs = Date.now() - t0;
            safeSendEvent('orgs.list', { outcome: 'ok', view: 'logs' }, { durationMs, count: orgs.length });
          } catch {}
        } catch (e) {
          if (!controller.signal.aborted) {
            const msg = getErrorMessage(e);
            logError('Logs: list orgs failed ->', msg);
            void vscode.window.showErrorMessage(
              localize('sendOrgsFailed', 'Failed to list Salesforce orgs: {0}', msg)
            );
            this.post({ type: 'orgs', data: [], selected: this.orgManager.getSelectedOrg() });
            try {
              const durationMs = Date.now() - t0;
              safeSendEvent('orgs.list', { outcome: 'error', view: 'logs' }, { durationMs });
            } catch {}
          }
        }
      }
    );
  }

  // Expose for command integration
  public setSelectedOrg(username?: string) {
    this.orgManager.setSelectedOrg(username);
  }

  public async tailLogs() {
    await vscode.commands.executeCommand('workbench.view.extension.salesforceTailPanel');
    await vscode.commands.executeCommand('workbench.viewsService.openView', 'sfLogTail');
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
