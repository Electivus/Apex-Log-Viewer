import * as vscode from 'vscode';
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
import { persistPrefetchSetting, restorePrefetchSetting } from '../utils/prefetch';

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
  private prefetchLogBodies: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logService = new LogService(),
    private readonly orgManager = new OrgManager(context),
    private readonly configManager = new ConfigManager(5, 100)
  ) {
    this.prefetchLogBodies = restorePrefetchSetting(context);
    const org = this.orgManager.getSelectedOrg();
    if (org) {
      logInfo('Logs: restored selected org from globalState:', org || '(default)');
    }
    if (this.prefetchLogBodies) {
      logInfo('Logs: restored prefetch setting from globalState: enabled');
    }
    this.logService.setHeadConcurrency(this.configManager.getHeadConcurrency());
    this.messageHandler = new LogsMessageHandler(
      () => this.refresh(),
      () => this.sendOrgs(),
      o => this.setSelectedOrg(o),
      enabled => this.setPrefetchLogBodies(enabled),
      id => this.logService.openLog(id, this.orgManager.getSelectedOrg()),
      id => this.logService.debugLog(id, this.orgManager.getSelectedOrg()),
      () => this.loadMore(),
      v => this.post({ type: 'loading', value: v })
    );
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        this.configManager.handleChange(e);
        this.logService.setHeadConcurrency(this.configManager.getHeadConcurrency());
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

  private async setPrefetchLogBodies(enabled: boolean): Promise<void> {
    if (this.prefetchLogBodies === enabled) {
      return;
    }
    const confirmed = await this.confirmPrefetchChange(enabled);
    if (!confirmed) {
      this.postPrefetchState();
      return;
    }
    this.prefetchLogBodies = enabled;
    persistPrefetchSetting(this.context, enabled);
    this.postPrefetchState();
    if (this.view) {
      await this.refresh();
    }
  }

  private async confirmPrefetchChange(enabled: boolean): Promise<boolean> {
    const message = enabled
      ? localize(
          'logs.prefetch.enablePrompt',
          'Enable searching entire log text? This downloads full log bodies so search can match everything, which may impact performance.'
        )
      : localize(
          'logs.prefetch.disablePrompt',
          'Disable searching entire log text? Searches will fall back to header metadata only.'
        );
    const confirmLabel = enabled
      ? localize('logs.prefetch.enableConfirm', 'Enable')
      : localize('logs.prefetch.disableConfirm', 'Disable');
    const selection = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return selection === confirmLabel;
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
          this.postPrefetchState();
          this.logService.loadLogHeads(
            logs,
            auth,
            token,
            (logId, codeUnit) => {
              if (token === this.refreshToken && !this.disposed) {
                this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
              }
            },
            controller.signal,
            this.prefetchLogBodies
              ? {
                  includeBodies: true,
                  onBody: (logId, content) => {
                    if (token === this.refreshToken && !this.disposed) {
                      this.post({ type: 'logSearchContent', logId, content });
                    }
                  }
                }
              : undefined
          );
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
          this.logService.loadLogHeads(
        logs,
        auth,
        token,
        (logId, codeUnit) => {
          if (token === this.refreshToken && !this.disposed) {
            this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
          }
        },
        undefined,
        this.prefetchLogBodies
          ? {
              includeBodies: true,
              onBody: (logId, content) => {
                if (token === this.refreshToken && !this.disposed) {
                  this.post({ type: 'logSearchContent', logId, content });
                }
              }
            }
          : undefined
      );
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

  private postPrefetchState(): void {
    this.post({ type: 'prefetchState', value: this.prefetchLogBodies });
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
