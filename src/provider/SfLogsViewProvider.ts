import * as vscode from 'vscode';
import { localize } from '../utils/localize';
import { getOrgAuth } from '../salesforce/cli';
import { clearListCache, getApiVersionFallbackWarning } from '../salesforce/http';
import type { ApexLogRow } from '../shared/types';
import type { OrgAuth } from '../salesforce/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { logInfo, logWarn, logError } from '../utils/logger';
import { safeSendEvent } from '../shared/telemetry';
import { warmUpReplayDebugger } from '../utils/warmup';
import { buildWebviewHtml } from '../utils/webviewHtml';
import { getErrorMessage } from '../utils/error';
import { LogService, type EnsureLogsSavedSummary } from '../services/logService';
import { LogsMessageHandler } from './logsMessageHandler';
import { OrgManager } from '../utils/orgManager';
import { ConfigManager } from '../utils/configManager';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import { affectsConfiguration, getConfig } from '../utils/config';
import { ensureApexLogsDir, purgeSavedLogs, getLogIdFromLogFilePath } from '../utils/workspace';
import { ripgrepSearch, type RipgrepMatch } from '../utils/ripgrep';
import { DEFAULT_LOGS_COLUMNS_CONFIG, normalizeLogsColumnsConfig, type NormalizedLogsColumnsConfig } from '../shared/logsColumns';

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
  private currentLogIds = new Set<string>();
  private errorByLogId = new Map<string, boolean>();
  private errorScanAbortController: AbortController | undefined;
  private errorScanToken = 0;
  private errorScanLastPostedAt = 0;
  private lastSearchQuery = '';
  private searchToken = 0;
  private searchAbortController: AbortController | undefined;
  private purgePromise: Promise<void> | undefined;
  private readonly logCacheMaxAgeMs = 1000 * 60 * 60 * 24;
  private logsColumns: NormalizedLogsColumnsConfig = DEFAULT_LOGS_COLUMNS_CONFIG;
  private bulkDownloadInProgress = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logService = new LogService(),
    private readonly orgManager = new OrgManager(context),
    private readonly configManager = new ConfigManager(5, 100)
  ) {
    this.logService.setHeadConcurrency(this.configManager.getHeadConcurrency());
    this.logsColumns = this.readLogsColumns();
    this.messageHandler = new LogsMessageHandler(
      () => this.refresh(),
      () => this.downloadAllLogs(),
      () => this.sendOrgs(),
      o => this.setSelectedOrg(o),
      () => this.openDebugFlags(),
      id => this.logService.openLog(id, this.orgManager.getSelectedOrg()),
      id => this.logService.debugLog(id, this.orgManager.getSelectedOrg()),
      () => this.loadMore(),
      v => this.post({ type: 'loading', value: v }),
      value => this.setSearchQuery(value),
      value => this.saveLogsColumns(value)
    );
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        const prevFullBodies = this.configManager.shouldLoadFullLogBodies();
        this.configManager.handleChange(e);
        this.logService.setHeadConcurrency(this.configManager.getHeadConcurrency());
        if (affectsConfiguration(e, 'electivus.apexLogs.logsColumns')) {
          this.logsColumns = this.readLogsColumns();
          this.post({ type: 'logsColumns', value: this.logsColumns });
        }
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
        this.cancelErrorScan();
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
        const isCurrentRefresh = () => token === this.refreshToken && !this.disposed;
        const controller = new AbortController();
        ct.onCancellationRequested(() => controller.abort());
        this.cancelErrorScan();
        this.errorByLogId.clear();
        this.postErrorScanStatus(
          {
            state: 'idle',
            processed: 0,
            total: 0,
            errorsFound: 0
          },
          { force: true }
        );
        this.post({ type: 'loading', value: true });
        this.post({ type: 'warning', message: undefined });
        try {
          clearListCache();
          this.pageLimit = this.configManager.getPageLimit();
          const auth = await getOrgAuth(this.orgManager.getSelectedOrg(), undefined, controller.signal);
          if (isCurrentRefresh()) {
            const existingWarning = getApiVersionFallbackWarning(auth);
            if (existingWarning) {
              this.post({ type: 'warning', message: existingWarning });
            }
          }
          if (ct.isCancellationRequested || !isCurrentRefresh()) {
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
          if (isCurrentRefresh()) {
            const warning = getApiVersionFallbackWarning(auth);
            if (warning) {
              this.post({ type: 'warning', message: warning });
            }
          }
          if (!isCurrentRefresh()) {
            return;
          }
          this.preloadFullLogBodies(logs, controller.signal);
          this.post({
            type: 'init',
            locale: vscode.env.language,
            fullLogSearchEnabled: this.configManager.shouldLoadFullLogBodies(),
            logsColumns: this.logsColumns
          });
          const hasMore = logs.length === this.pageLimit;
          this.post({ type: 'logs', data: logs, hasMore });
          this.setCurrentLogs(logs);
          this.postKnownErrorStateForLogs(logs);
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
          this.startErrorScanForCurrentLogs(auth, token, controller.signal);
          if (this.lastSearchQuery.trim()) {
            this.rerunActiveSearch();
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
    const isCurrentRefresh = () => token === this.refreshToken && !this.disposed;
    const t0 = Date.now();
    this.post({ type: 'loading', value: true });
    this.post({ type: 'warning', message: undefined });
    try {
      const auth = await getOrgAuth(this.orgManager.getSelectedOrg());
      if (isCurrentRefresh()) {
        const existingWarning = getApiVersionFallbackWarning(auth);
        if (existingWarning) {
          this.post({ type: 'warning', message: existingWarning });
        }
      }
      if (!isCurrentRefresh()) {
        return;
      }
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
      if (isCurrentRefresh()) {
        const warning = getApiVersionFallbackWarning(auth);
        if (warning) {
          this.post({ type: 'warning', message: warning });
        }
      }
      if (!isCurrentRefresh()) {
        return;
      }
      this.preloadFullLogBodies(logs);
      const hasMore = logs.length === this.pageLimit;
      this.post({ type: 'appendLogs', data: logs, hasMore });
      this.setCurrentLogs([...this.currentLogs, ...logs]);
      this.postKnownErrorStateForLogs(logs);
      this.purgeLogCache();
      this.logService.loadLogHeads(logs, auth, token, (logId, codeUnit) => {
        if (token === this.refreshToken && !this.disposed) {
          this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
        }
      }, undefined, {
        preferLocalBodies: this.configManager.shouldLoadFullLogBodies(),
        selectedOrg: this.orgManager.getSelectedOrg()
      });
      this.startErrorScanForCurrentLogs(auth, token);
      this.rerunActiveSearch();
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
      .then(summary => {
        if (signal?.aborted || this.disposed) {
          return;
        }
        if (summary.downloaded > 0) {
          this.rerunActiveSearch();
        }
      })
      .catch(e => {
        if (!signal?.aborted) {
          logWarn('Logs: preload full log bodies failed ->', getErrorMessage(e));
        }
      });
  }

  private rerunActiveSearch(): void {
    if (this.disposed || !this.lastSearchQuery.trim()) {
      return;
    }
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = undefined;
    }
    const searchToken = ++this.searchToken;
    const controller = new AbortController();
    this.searchAbortController = controller;
    void this.executeSearch(this.lastSearchQuery, searchToken, controller.signal).finally(() => {
      if (this.searchAbortController === controller) {
        this.searchAbortController = undefined;
      }
    });
  }

  private isAbortLikeError(err: unknown, message?: string): boolean {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      return true;
    }
    const normalized = String(message ?? getErrorMessage(err) ?? '').toLowerCase();
    return normalized.includes('abort') || normalized.includes('canceled') || normalized.includes('cancelled');
  }

  private readLogsColumns(): NormalizedLogsColumnsConfig {
    const raw = getConfig<unknown>('electivus.apexLogs.logsColumns', DEFAULT_LOGS_COLUMNS_CONFIG);
    return normalizeLogsColumnsConfig(raw);
  }

  private async saveLogsColumns(value: unknown): Promise<void> {
    try {
      const normalized = normalizeLogsColumnsConfig(value);
      await vscode.workspace
        .getConfiguration()
        .update('electivus.apexLogs.logsColumns', normalized, vscode.ConfigurationTarget.Global);
    } catch (e) {
      logWarn('Logs: failed to persist logsColumns ->', getErrorMessage(e));
    }
  }

  private setCurrentLogs(logs: ApexLogRow[]): void {
    this.currentLogs = logs.slice();
    this.currentLogIds = new Set(
      logs
        .map(log => log?.Id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    );
  }

  private cancelErrorScan(): void {
    this.errorScanToken++;
    if (this.errorScanAbortController) {
      this.errorScanAbortController.abort();
      this.errorScanAbortController = undefined;
    }
    this.errorScanLastPostedAt = 0;
  }

  private postErrorScanStatus(
    status: { state: 'idle' | 'running'; processed: number; total: number; errorsFound: number },
    options?: { force?: boolean }
  ): void {
    const force = options?.force ?? false;
    if (!force) {
      const now = Date.now();
      if (now - this.errorScanLastPostedAt < 150 && status.state === 'running' && status.processed < status.total) {
        return;
      }
      this.errorScanLastPostedAt = now;
    }
    this.post({ type: 'errorScanStatus', ...status });
  }

  private postKnownErrorStateForLogs(logs: ApexLogRow[]): void {
    for (const log of logs) {
      if (!log?.Id) {
        continue;
      }
      const hasErrors = this.errorByLogId.get(log.Id);
      if (typeof hasErrors === 'boolean') {
        this.post({ type: 'logHead', logId: log.Id, hasErrors });
      }
    }
  }

  private startErrorScanForCurrentLogs(auth: OrgAuth, refreshToken: number, parentSignal?: AbortSignal): void {
    this.cancelErrorScan();
    const scanToken = this.errorScanToken;
    if (parentSignal?.aborted) {
      return;
    }
    const controller = new AbortController();
    this.errorScanAbortController = controller;
    if (parentSignal) {
      const onAbort = () => controller.abort();
      parentSignal.addEventListener('abort', onAbort, { once: true });
      controller.signal.addEventListener(
        'abort',
        () => {
          try {
            parentSignal.removeEventListener('abort', onAbort);
          } catch {}
        },
        { once: true }
      );
    }
    const selectedOrg = this.orgManager.getSelectedOrg();
    const toScan = this.currentLogs.filter(
      (log): log is ApexLogRow & { Id: string } =>
        typeof log?.Id === 'string' && log.Id.length > 0 && !this.errorByLogId.has(log.Id)
    );
    this.postErrorScanStatus(
      {
        state: 'running',
        processed: 0,
        total: toScan.length,
        errorsFound: 0
      },
      { force: true }
    );

    void (async () => {
      try {
        if (
          controller.signal.aborted ||
          scanToken !== this.errorScanToken ||
          refreshToken !== this.refreshToken ||
          this.disposed
        ) {
          return;
        }
        const total = toScan.length;
        if (total === 0) {
          this.postErrorScanStatus(
            {
              state: 'idle',
              processed: 0,
              total: 0,
              errorsFound: 0
            },
            { force: true }
          );
          return;
        }
        await this.logService.classifyLogsForErrors(
          toScan,
          selectedOrg,
          controller.signal,
          {
            onProgress: progress => {
              if (
                controller.signal.aborted ||
                scanToken !== this.errorScanToken ||
                refreshToken !== this.refreshToken ||
                this.disposed
              ) {
                return;
              }
              this.errorByLogId.set(progress.logId, progress.hasErrors);
              if (this.currentLogIds.has(progress.logId)) {
                this.post({ type: 'logHead', logId: progress.logId, hasErrors: progress.hasErrors });
              }
              this.postErrorScanStatus({
                state: 'running',
                processed: progress.processed,
                total: progress.total,
                errorsFound: progress.errorsFound
              });
            }
          }
        );
        if (
          controller.signal.aborted ||
          scanToken !== this.errorScanToken ||
          refreshToken !== this.refreshToken ||
          this.disposed
        ) {
          return;
        }
        const errorsFound = toScan
          .map(log => this.errorByLogId.get(log.Id))
          .filter(v => v === true).length;
        this.postErrorScanStatus(
          {
            state: 'idle',
            processed: total,
            total,
            errorsFound
          },
          { force: true }
        );
      } catch (e) {
        if (!controller.signal.aborted) {
          logWarn('Logs: org error scan failed ->', getErrorMessage(e));
        }
        if (
          !controller.signal.aborted &&
          scanToken === this.errorScanToken &&
          refreshToken === this.refreshToken &&
          !this.disposed
        ) {
          const errorsFound = toScan
            .map(log => this.errorByLogId.get(log.Id))
            .filter(v => v === true).length;
          this.postErrorScanStatus(
            {
              state: 'idle',
              processed: 0,
              total: 0,
              errorsFound
            },
            { force: true }
          );
        }
      } finally {
        if (this.errorScanAbortController === controller) {
          this.errorScanAbortController = undefined;
        }
      }
    })();
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
    const missingLogIds = new Set<string>();
    try {
      await this.logService.ensureLogsSaved(
        logsSnapshot,
        this.orgManager.getSelectedOrg(),
        signal,
        {
          downloadMissing: false,
          onMissing: id => {
            if (typeof id === 'string') {
              missingLogIds.add(id);
            }
          }
        }
      );
      if (!isActive() || signal?.aborted) {
        return;
      }
      if (missingLogIds.size > 0) {
        this.post({
          type: 'searchMatches',
          query: trimmed,
          logIds: [],
          snippets: {},
          pendingLogIds: Array.from(missingLogIds)
        });
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
        const logId = getLogIdFromLogFilePath(info.filePath);
        if (logId && known.has(logId)) {
          matches.add(logId);
          const snippet = this.buildSnippet(info);
          if (snippet) {
            snippets[logId] = snippet;
          }
        }
      }
      this.post({
        type: 'searchMatches',
        query: trimmed,
        logIds: Array.from(matches),
        snippets,
        pendingLogIds: Array.from(missingLogIds)
      });
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

  private async fetchAllOrgLogs(auth: OrgAuth, signal?: AbortSignal): Promise<ApexLogRow[]> {
    const all: ApexLogRow[] = [];
    const seen = new Set<string>();
    let cursorStartTime: string | undefined;
    let cursorId: string | undefined;
    let lastCursorKey: string | undefined;
    while (!signal?.aborted) {
      const batch = await this.logService.fetchLogs(
        auth,
        this.pageLimit,
        0,
        signal,
        cursorStartTime && cursorId
          ? { beforeStartTime: cursorStartTime, beforeId: cursorId }
          : undefined
      );
      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }
      for (const log of batch) {
        if (!log?.Id || seen.has(log.Id)) {
          continue;
        }
        seen.add(log.Id);
        all.push(log);
      }
      if (batch.length < this.pageLimit) {
        break;
      }
      const last = batch[batch.length - 1];
      if (!last?.StartTime || !last?.Id) {
        break;
      }
      const cursorKey = `${last.StartTime}|${last.Id}`;
      if (cursorKey === lastCursorKey) {
        break;
      }
      lastCursorKey = cursorKey;
      cursorStartTime = last.StartTime;
      cursorId = last.Id;
    }
    return all;
  }

  private async downloadAllLogs(): Promise<void> {
    if (this.bulkDownloadInProgress) {
      void vscode.window.showInformationMessage(
        localize('downloadAllLogsAlreadyRunning', 'A log bulk download is already in progress.')
      );
      return;
    }
    this.bulkDownloadInProgress = true;
    const t0 = Date.now();
    try {
      const selectedOrg = this.orgManager.getSelectedOrg();
      const confirmAction = localize('downloadAllLogsConfirmAction', 'Download');
      const confirmation = await vscode.window.showWarningMessage(
        localize(
          'downloadAllLogsPreflightConfirm',
          'Download all Apex logs for the selected org?'
        ),
        {
          modal: true,
          detail: localize(
            'downloadAllLogsPreflightConfirmDetail',
            'This action can perform many API calls and may download a large amount of data.'
          )
        },
        confirmAction
      );
      if (confirmation !== confirmAction) {
        try {
          safeSendEvent('logs.downloadAll', { outcome: 'cancel' }, { durationMs: Date.now() - t0 });
        } catch {}
        return;
      }

      this.pageLimit = this.configManager.getPageLimit();
      const auth = await getOrgAuth(selectedOrg);
      type BulkDownloadRunResult =
        | { kind: 'cancelled-before-download'; listed: number }
        | { kind: 'empty' }
        | {
            kind: 'done';
            total: number;
            processed: number;
            summary: EnsureLogsSavedSummary;
          };
      const runResult = await vscode.window.withProgress<BulkDownloadRunResult>(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize('downloadAllLogsProgressTitle', 'Downloading all org logs…'),
          cancellable: true
        },
        async (progress, ct) => {
          const controller = new AbortController();
          ct.onCancellationRequested(() => controller.abort());

          progress.report({
            message: localize('downloadAllLogsProgressListing', 'Listing logs from the selected org…')
          });
          let logs: ApexLogRow[] = [];
          try {
            logs = await this.fetchAllOrgLogs(auth, controller.signal);
          } catch (e) {
            const msg = getErrorMessage(e);
            if (controller.signal.aborted || this.isAbortLikeError(e, msg)) {
              return { kind: 'cancelled-before-download', listed: 0 };
            }
            throw e;
          }
          if (controller.signal.aborted) {
            return { kind: 'cancelled-before-download', listed: logs.length };
          }
          if (logs.length === 0) {
            return { kind: 'empty' };
          }

          let processed = 0;
          let progressPct = 0;
          const total = logs.length;
          progress.report({
            message: localize(
              'downloadAllLogsProgressMessage',
              'Processed {0}/{1} logs…',
              processed,
              total
            )
          });
          const summary = await this.logService.ensureLogsSaved(logs, selectedOrg, controller.signal, {
            onItemComplete: () => {
              processed += 1;
              const nextPct = Math.floor((processed / total) * 100);
              const increment = nextPct > progressPct ? nextPct - progressPct : undefined;
              progressPct = Math.max(progressPct, nextPct);
              progress.report({
                increment,
                message: localize(
                  'downloadAllLogsProgressMessage',
                  'Processed {0}/{1} logs…',
                  processed,
                  total
                )
              });
            }
          });
          return { kind: 'done', total, processed, summary };
        }
      );

      if (runResult.kind === 'cancelled-before-download') {
        void vscode.window.showWarningMessage(
          localize(
            'downloadAllLogsSummaryCancelledBeforeDownload',
            'Bulk download cancelled while listing logs for the selected org.'
          )
        );
        try {
          safeSendEvent(
            'logs.downloadAll',
            { outcome: 'cancelled' },
            {
              durationMs: Date.now() - t0,
              total: runResult.listed,
              success: 0,
              failed: 0,
              cancelled: runResult.listed
            }
          );
        } catch {}
        return;
      }

      if (runResult.kind === 'empty') {
        void vscode.window.showInformationMessage(
          localize('downloadAllLogsNoLogs', 'No Apex logs were found for the selected org.')
        );
        try {
          safeSendEvent('logs.downloadAll', { outcome: 'empty' }, { durationMs: Date.now() - t0 });
        } catch {}
        return;
      }

      const total = runResult.total;
      const processed = runResult.processed;
      const summary = runResult.summary;
      const success = summary.success;
      this.rerunActiveSearch();
      if (summary.cancelled > 0) {
        void vscode.window.showWarningMessage(
          localize(
            'downloadAllLogsSummaryCancelled',
            'Bulk download cancelled. Processed {0}/{1}. Success: {2}, failed: {3}.',
            processed,
            total,
            success,
            summary.failed
          )
        );
        try {
          safeSendEvent(
            'logs.downloadAll',
            { outcome: 'cancelled' },
            { durationMs: Date.now() - t0, total, success, failed: summary.failed, cancelled: summary.cancelled }
          );
        } catch {}
        return;
      }
      if (summary.failed > 0) {
        void vscode.window.showWarningMessage(
          localize(
            'downloadAllLogsSummaryPartial',
            'Bulk download finished with partial success. Success: {0}, failed: {1}.',
            success,
            summary.failed
          )
        );
        try {
          safeSendEvent('logs.downloadAll', { outcome: 'partial' }, { durationMs: Date.now() - t0, total, success, failed: summary.failed });
        } catch {}
        return;
      }

      void vscode.window.showInformationMessage(
        localize(
          'downloadAllLogsSummarySuccess',
          'Bulk download finished. {0} logs are available locally ({1} downloaded, {2} already cached).',
          success,
          summary.downloaded,
          summary.existing
        )
      );
      try {
        safeSendEvent('logs.downloadAll', { outcome: 'ok' }, { durationMs: Date.now() - t0, total, success });
      } catch {}
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('Logs: downloadAllLogs failed ->', msg);
      void vscode.window.showErrorMessage(
        localize('downloadAllLogsFailed', 'Failed to download all org logs: {0}', msg)
      );
      try {
        safeSendEvent('logs.downloadAll', { outcome: 'error' }, { durationMs: Date.now() - t0 });
      } catch {}
    } finally {
      this.bulkDownloadInProgress = false;
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
    try {
      await vscode.commands.executeCommand('workbench.viewsService.openView', 'sfLogTail');
    } catch {
      // Compatibility fallback for VS Code versions where workbench.viewsService.openView
      // is unavailable.
      try {
        await vscode.commands.executeCommand('workbench.action.openView', 'sfLogTail');
      } catch {
        // Container command above already focused the Tail panel; keep it best-effort.
      }
    }
  }

  private async openDebugFlags(): Promise<void> {
    await DebugFlagsPanel.show({
      selectedOrg: this.orgManager.getSelectedOrg(),
      sourceView: 'logs'
    });
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
