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
import { ensureApexLogsDir, purgeSavedLogs } from '../utils/workspace';
import { ripgrepSearch, type RipgrepMatch } from '../utils/ripgrep';

const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

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
  private searchAbortController: AbortController | undefined;
  private purgePromise: Promise<void> | undefined;
  private readonly logCacheMaxAgeMs = 1000 * 60 * 60 * 24;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logService = new LogService(),
    private readonly orgManager = new OrgManager(context),
    private readonly configManager = new ConfigManager(5, 100)
  ) {
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
          this.preloadFullLogBodies(logs, controller.signal);
          this.post({ type: 'init', locale: vscode.env.language });
          const hasMore = logs.length === this.pageLimit;
          this.post({ type: 'logs', data: logs, hasMore });
          this.currentLogs = logs.slice();
          this.purgeLogCache(controller.signal);
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
            {
              preferLocalBodies: this.configManager.shouldLoadFullLogBodies(),
              selectedOrg: this.orgManager.getSelectedOrg()
            }
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
      this.preloadFullLogBodies(logs);
      const hasMore = logs.length === this.pageLimit;
      this.post({ type: 'appendLogs', data: logs, hasMore });
      this.currentLogs = [...this.currentLogs, ...logs];
      this.purgeLogCache();
      this.logService.loadLogHeads(logs, auth, token, (logId, codeUnit) => {
        if (token === this.refreshToken && !this.disposed) {
          this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
        }
      }, undefined, {
        preferLocalBodies: this.configManager.shouldLoadFullLogBodies(),
        selectedOrg: this.orgManager.getSelectedOrg()
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

  private preloadFullLogBodies(logs: ApexLogRow[], signal?: AbortSignal): void {
    if (!this.configManager.shouldLoadFullLogBodies()) {
      return;
    }
    if (!Array.isArray(logs) || logs.length === 0) {
      return;
    }
    void this.logService
      .ensureLogsSaved(logs, this.orgManager.getSelectedOrg(), signal)
      .catch(e => {
        if (!signal?.aborted) {
          logWarn('Logs: preload full log bodies failed ->', getErrorMessage(e));
        }
      });
  }

  private postSearchStatus(state: 'idle' | 'loading'): void {
    this.post({ type: 'searchStatus', state });
  }

  private purgeLogCache(signal?: AbortSignal): void {
    if (signal?.aborted) {
      return;
    }
    const keepIds = new Set(
      this.currentLogs
        .map(log => log.Id)
        .filter((id): id is string => typeof id === 'string' && SALESFORCE_ID_REGEX.test(id))
    );
    if (this.purgePromise) {
      return;
    }
    const purgeTask = purgeSavedLogs({ keepIds, maxAgeMs: this.logCacheMaxAgeMs, signal })
      .then(() => undefined)
      .catch(err => {
        if (!signal?.aborted) {
          logWarn('Logs: purge cached log files failed ->', getErrorMessage(err));
        }
      })
      .finally(() => {
        if (this.purgePromise === purgeTask) {
          this.purgePromise = undefined;
        }
      });
    this.purgePromise = purgeTask;
  }

  private async setSearchQuery(value: string): Promise<void> {
    this.lastSearchQuery = value ?? '';
    const token = ++this.searchToken;
    if (this.searchAbortController) {
      this.searchAbortController.abort();
    }
    const controller = new AbortController();
    this.searchAbortController = controller;
    try {
      await this.executeSearch(this.lastSearchQuery, token, controller.signal);
    } finally {
      if (this.searchAbortController === controller) {
        this.searchAbortController = undefined;
      }
    }
  }

  private async executeSearch(query: string, token: number, signal?: AbortSignal): Promise<void> {
    if (!this.view || this.disposed) {
      return;
    }
    if (signal?.aborted) {
      return;
    }
    const trimmed = (query ?? '').trim();
    const isActive = () => token === this.searchToken && !this.disposed;
    if (!trimmed) {
      if (isActive()) {
        this.post({ type: 'searchMatches', query: '', logIds: [] });
        this.postSearchStatus('idle');
      }
      return;
    }
    if (!this.configManager.shouldLoadFullLogBodies()) {
      if (isActive()) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
        this.postSearchStatus('idle');
      }
      return;
    }
    const logsSnapshot = [...this.currentLogs];
    if (logsSnapshot.length === 0) {
      if (isActive()) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
        this.postSearchStatus('idle');
      }
      return;
    }
    if (isActive()) {
      this.postSearchStatus('loading');
    }
    try {
      await this.logService.ensureLogsSaved(logsSnapshot, this.orgManager.getSelectedOrg(), signal);
      if (!isActive() || signal?.aborted) {
        return;
      }
      const dir = await ensureApexLogsDir();
      if (signal?.aborted) {
        return;
      }
      const matchesInfo = await ripgrepSearch(trimmed, dir, signal);
      if (!isActive() || signal?.aborted) {
        return;
      }
      const known = new Set(logsSnapshot.map(l => l.Id));
      const matches = new Set<string>();
      const snippets: Record<string, { text: string; ranges: [number, number][] }> = {};
      for (const info of matchesInfo) {
        const logId = this.extractLogIdFromPath(info.filePath);
        if (logId && known.has(logId)) {
          matches.add(logId);
          const snippet = this.buildSnippet(info);
          if (snippet) {
            snippets[logId] = snippet;
          }
        }
      }
      this.post({ type: 'searchMatches', query: trimmed, logIds: Array.from(matches), snippets });
    } catch (e) {
      logWarn('Logs: search failed ->', getErrorMessage(e));
      if (token === this.searchToken && !this.disposed && !signal?.aborted) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
      }
    } finally {
      if (isActive()) {
        this.postSearchStatus('idle');
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

  private buildSnippet(match: RipgrepMatch): { text: string; ranges: [number, number][] } | undefined {
    const rawLine = typeof match.lineText === 'string' ? match.lineText : '';
    const line = rawLine.replace(/\r?\n$/, '');
    if (!line) {
      return undefined;
    }
    const rawRanges = Array.isArray(match.submatches) ? match.submatches : [];
    const charRanges = rawRanges
      .map(({ start, end }) => {
        const charStart = this.byteOffsetToStringIndex(line, start ?? 0);
        const charEnd = this.byteOffsetToStringIndex(line, end ?? 0);
        return [charStart, Math.max(charStart, charEnd)] as [number, number];
      })
      .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);

    const context = 60;
    const earliest = charRanges.length > 0 ? Math.min(...charRanges.map(r => r[0])) : 0;
    const latest = charRanges.length > 0 ? Math.max(...charRanges.map(r => r[1])) : Math.min(line.length, earliest + context);
    const sliceStart = Math.max(0, earliest - context);
    const sliceEnd = Math.min(line.length, latest + context);
    const core = line.slice(sliceStart, sliceEnd);
    const prefix = sliceStart > 0 ? '...' : '';
    const suffix = sliceEnd < line.length ? '...' : '';
    const prefixLength = prefix.length;
    const snippetLength = core.length + prefixLength + suffix.length;
    const adjustedRanges = charRanges
      .map(([start, end], idx) => {
        const adjustedStart = Math.max(0, start - sliceStart) + prefixLength;
        const adjustedEnd = Math.max(adjustedStart, Math.min(core.length, end - sliceStart) + prefixLength);
        return [adjustedStart, Math.max(adjustedStart, adjustedEnd)] as [number, number];
      })
      .filter(([start, end]) => end > start);

    const finalSnippet = `${prefix}${core}${suffix}`;
    const boundedRanges = adjustedRanges.map(([start, end]) => {
      const boundedStart = Math.max(0, Math.min(start, snippetLength));
      const boundedEnd = Math.max(0, Math.min(end, snippetLength));
      return [boundedStart, Math.max(boundedStart, boundedEnd)] as [number, number];
    });

    return {
      text: finalSnippet,
      ranges: boundedRanges
    };
  }

  private byteOffsetToStringIndex(text: string, byteOffset: number): number {
    if (!text || !Number.isFinite(byteOffset) || byteOffset <= 0) {
      return 0;
    }
    let byteTally = 0;
    let index = 0;
    while (index < text.length) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) {
        break;
      }
      const codeUnitLength = codePoint > 0xffff ? 2 : 1;
      const utf8Length = this.utf8ByteLength(codePoint);
      if (byteTally + utf8Length > byteOffset) {
        break;
      }
      byteTally += utf8Length;
      index += codeUnitLength;
    }
    return index;
  }

  private utf8ByteLength(codePoint: number): number {
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
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
