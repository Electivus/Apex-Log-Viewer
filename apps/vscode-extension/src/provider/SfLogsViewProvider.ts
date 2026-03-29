import * as vscode from 'vscode';
import { localize } from '../../../../src/utils/localize';
import { clearListCache, getApiVersionFallbackWarning } from '../../../../src/salesforce/http';
import { pickSelectedOrg } from '../../../../src/utils/orgs';
import type { ApexLogRow } from '../shared/types';
import type { OrgAuth } from '../../../../src/salesforce/types';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import { logInfo, logWarn, logError, logTrace } from '../../../../src/utils/logger';
import { safeSendEvent } from '../shared/telemetry';
import { buildWebviewHtml } from '../../../../src/utils/webviewHtml';
import { getErrorMessage } from '../../../../src/utils/error';
import { LogService, type EnsureLogsSavedSummary } from '../../../../src/services/logService';
import { clearApexLogs } from '../../../../src/services/apexLogCleanup';
import { LogsMessageHandler } from './logsMessageHandler';
import { runtimeClient } from '../runtime/runtimeClient';
import { OrgManager } from '../utils/orgManager';
import { ConfigManager } from '../../../../src/utils/configManager';
import { DebugFlagsPanel } from '../panel/DebugFlagsPanel';
import { affectsConfiguration, getConfig } from '../../../../src/utils/config';
import { getWorkspaceRoot, purgeSavedLogs } from '../../../../src/utils/workspace';
import { DEFAULT_LOGS_COLUMNS_CONFIG, normalizeLogsColumnsConfig, type NormalizedLogsColumnsConfig } from '../shared/logsColumns';
import { normalizeLogTriageSummary, type LogTriageSummary } from '../shared/logTriage';
import { bucketQueryLength } from '../shared/telemetryBuckets';
import { createWebviewPanelHost, createWebviewViewHost, type BoundWebviewHost } from './webviewHost';

const SALESFORCE_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

export class SfLogsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'sfLogViewer';
  private view?: { webview: vscode.Webview };
  private host?: BoundWebviewHost;
  private readonly disposables: vscode.Disposable[] = [];
  private hostDisposables: vscode.Disposable[] = [];
  private pageLimit = 100;
  private currentOffset = 0;
  private disposed = false;
  private refreshToken = 0;
  private messageHandler: LogsMessageHandler;
  private cursorStartTime: string | undefined;
  private cursorId: string | undefined;
  private currentLogs: ApexLogRow[] = [];
  private currentLogIds = new Set<string>();
  private errorByLogId = new Map<string, LogTriageSummary>();
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
  private clearLogsInProgress = false;

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
      scope => this.clearLogs(scope),
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
    this.disposables.push(
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
    this.bindHost(createWebviewViewHost(webviewView));
  }

  public resolveWebviewPanel(panel: vscode.WebviewPanel): void {
    this.bindHost(createWebviewPanelHost(panel));
  }

  public hasResolvedView(): boolean {
    return Boolean(this.view) && !this.disposed;
  }

  public getSelectedOrg(): string | undefined {
    return this.orgManager.getSelectedOrg();
  }

  public dispose(): void {
    this.disposed = true;
    this.view = undefined;
    this.host = undefined;
    this.refreshToken++;
    this.cancelErrorScan();
    if (this.searchAbortController) {
      this.searchAbortController.abort();
      this.searchAbortController = undefined;
    }
    vscode.Disposable.from(...this.hostDisposables).dispose();
    this.hostDisposables = [];
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
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
          await this.orgManager.ensureProjectDefaultSelected();
          const auth = await runtimeClient.getOrgAuth({ username: this.orgManager.getSelectedOrg() });
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
          const logs = (await runtimeClient.logsList(
            {
              username: this.orgManager.getSelectedOrg(),
              limit: this.pageLimit
            },
            controller.signal
          )) as ApexLogRow[];
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
          this.preloadFullLogBodies(logs, auth, token, controller.signal);
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
          this.startErrorScanForCurrentLogs(token, controller.signal);
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
      const auth = await runtimeClient.getOrgAuth({ username: this.orgManager.getSelectedOrg() });
      if (isCurrentRefresh()) {
        const existingWarning = getApiVersionFallbackWarning(auth);
        if (existingWarning) {
          this.post({ type: 'warning', message: existingWarning });
        }
      }
      if (!isCurrentRefresh()) {
        return;
      }
      const logs = (await runtimeClient.logsList({
        username: this.orgManager.getSelectedOrg(),
        limit: this.pageLimit,
        cursor:
          this.cursorStartTime && this.cursorId
            ? { beforeStartTime: this.cursorStartTime, beforeId: this.cursorId }
            : undefined
      })) as ApexLogRow[];
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
      this.preloadFullLogBodies(logs, auth, token);
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
      this.startErrorScanForCurrentLogs(token);
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

  private preloadFullLogBodies(logs: ApexLogRow[], auth: OrgAuth, refreshToken: number, signal?: AbortSignal): void {
    if (!this.configManager.shouldLoadFullLogBodies()) {
      return;
    }
    if (!Array.isArray(logs) || logs.length === 0) {
      return;
    }
    const logsById = new Map(
      logs
        .filter((log): log is ApexLogRow & { Id: string } => typeof log?.Id === 'string' && log.Id.length > 0)
        .map(log => [log.Id, log] as const)
    );
    let searchRerunTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSearchRerun = () => {
      if (searchRerunTimer) {
        return;
      }
      searchRerunTimer = setTimeout(() => {
        searchRerunTimer = undefined;
        if (!signal?.aborted && !this.disposed) {
          logTrace('Logs: rerunning active search after body preload');
          this.rerunActiveSearch();
        }
      }, 150);
    };
    void this.logService
      .ensureLogsSaved(logs, this.orgManager.getSelectedOrg(), signal, {
        onItemComplete: result => {
          if (signal?.aborted || this.disposed) {
            return;
          }
          if (result.status !== 'downloaded' && result.status !== 'existing') {
            return;
          }
          logTrace('Logs: preload body completed', { logId: result.logId, status: result.status });
          const log = logsById.get(result.logId);
          if (!log) {
            return;
          }
          this.logService.loadLogHeads([log], auth, refreshToken, (logId, codeUnit) => {
            if (refreshToken === this.refreshToken && !this.disposed && this.currentLogIds.has(logId)) {
              this.post({ type: 'logHead', logId, codeUnitStarted: codeUnit });
            }
          }, signal, {
            preferLocalBodies: true,
            selectedOrg: this.orgManager.getSelectedOrg()
          });
          scheduleSearchRerun();
        }
      })
      .then(summary => {
        if (searchRerunTimer) {
          clearTimeout(searchRerunTimer);
          searchRerunTimer = undefined;
        }
        if (signal?.aborted || this.disposed) {
          return;
        }
        if (summary.success > 0) {
          logTrace('Logs: rerunning active search after preload summary', summary);
          this.rerunActiveSearch();
        }
      })
      .catch(e => {
        if (searchRerunTimer) {
          clearTimeout(searchRerunTimer);
          searchRerunTimer = undefined;
        }
        if (!signal?.aborted) {
          logWarn('Logs: preload full log bodies failed ->', getErrorMessage(e));
        }
      });
  }

  private rerunActiveSearch(): void {
    if (this.disposed || !this.lastSearchQuery.trim()) {
      return;
    }
    logTrace('Logs: rerunActiveSearch', { queryLength: this.lastSearchQuery.trim().length });
    if (this.searchAbortController) {
      logTrace('Logs: aborting current active search for rerun');
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
      const summary = this.errorByLogId.get(log.Id);
      if (summary) {
        this.post({
          type: 'logHead',
          logId: log.Id,
          hasErrors: summary.hasErrors,
          primaryReason: summary.primaryReason,
          reasons: summary.reasons
        });
      }
    }
  }

  private startErrorScanForCurrentLogs(refreshToken: number, parentSignal?: AbortSignal): void {
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
        const entries = await runtimeClient.logsTriage(
          {
            username: selectedOrg,
            logIds: toScan.map(log => log.Id),
            workspaceRoot: getWorkspaceRoot()
          },
          controller.signal
        );
        let processed = 0;
        let errorsFound = 0;
        for (const entry of entries) {
          if (
            controller.signal.aborted ||
            scanToken !== this.errorScanToken ||
            refreshToken !== this.refreshToken ||
            this.disposed
          ) {
            return;
          }
          if (!entry?.logId) {
            continue;
          }
          const summary = normalizeLogTriageSummary(entry.summary);
          this.errorByLogId.set(entry.logId, summary);
          processed += 1;
          if (summary.hasErrors) {
            errorsFound += 1;
          }
          if (this.currentLogIds.has(entry.logId)) {
            this.post({
              type: 'logHead',
              logId: entry.logId,
              hasErrors: summary.hasErrors,
              primaryReason: summary.primaryReason,
              reasons: summary.reasons
            });
          }
          this.postErrorScanStatus({
            state: 'running',
            processed,
            total,
            errorsFound
          });
        }
        if (
          controller.signal.aborted ||
          scanToken !== this.errorScanToken ||
          refreshToken !== this.refreshToken ||
          this.disposed
        ) {
          return;
        }
        const totalErrorsFound = toScan
          .map(log => this.errorByLogId.get(log.Id))
          .filter(v => v?.hasErrors === true).length;
        this.postErrorScanStatus(
          {
            state: 'idle',
            processed: total,
            total,
            errorsFound: totalErrorsFound
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
            .filter(v => v?.hasErrors === true).length;
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
    logTrace('Logs: setSearchQuery', { queryLength: this.lastSearchQuery.trim().length });
    const token = ++this.searchToken;
    if (this.searchAbortController) {
      logTrace('Logs: aborting in-flight search before new query');
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
    const t0 = Date.now();
    const queryLength = bucketQueryLength(trimmed);
    if (queryLength === '0') {
      return;
    }
    if (!this.configManager.shouldLoadFullLogBodies()) {
      if (isActive()) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
        this.postSearchStatus('idle');
      }
      this.sendSearchTelemetry('searched', queryLength, { durationMs: 0, matchCount: 0, pendingCount: 0 });
      return;
    }
    const logsSnapshot = [...this.currentLogs];
    logTrace('Logs: executeSearch start', {
      queryLength: trimmed.length,
      logs: logsSnapshot.length,
      token
    });
    if (logsSnapshot.length === 0) {
      if (isActive()) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
        this.postSearchStatus('idle');
      }
      this.sendSearchTelemetry('searched', queryLength, { durationMs: 0, matchCount: 0, pendingCount: 0 });
      return;
    }
    if (isActive()) {
      this.postSearchStatus('loading');
    }
    try {
      const result = await runtimeClient.searchQuery(
        {
          username: this.orgManager.getSelectedOrg(),
          query: trimmed,
          logIds: logsSnapshot
            .map(log => log?.Id)
            .filter((logId): logId is string => typeof logId === 'string' && logId.length > 0),
          workspaceRoot: getWorkspaceRoot()
        },
        signal
      );
      if (!isActive() || signal?.aborted) {
        return;
      }
      this.post({
        type: 'searchMatches',
        query: trimmed,
        logIds: Array.isArray(result.logIds) ? result.logIds : [],
        snippets: result.snippets ?? {},
        pendingLogIds: Array.isArray(result.pendingLogIds) ? result.pendingLogIds : []
      });
      this.sendSearchTelemetry('searched', queryLength, {
        durationMs: Date.now() - t0,
        matchCount: Array.isArray(result.logIds) ? result.logIds.length : 0,
        pendingCount: Array.isArray(result.pendingLogIds) ? result.pendingLogIds.length : 0
      });
      logTrace('Logs: executeSearch result', {
        queryLength: trimmed.length,
        matches: Array.isArray(result.logIds) ? result.logIds.length : 0,
        pending: Array.isArray(result.pendingLogIds) ? result.pendingLogIds.length : 0,
        token
      });
    } catch (e) {
      logWarn('Logs: search failed ->', getErrorMessage(e));
      if (token === this.searchToken && !this.disposed && !signal?.aborted) {
        this.post({ type: 'searchMatches', query: trimmed, logIds: [] });
        this.sendSearchTelemetry('error', queryLength, {
          durationMs: Date.now() - t0,
          matchCount: 0,
          pendingCount: 0
        });
      }
    } finally {
      if (isActive()) {
        this.postSearchStatus('idle');
      }
    }
  }

  private sendSearchTelemetry(
    outcome: 'searched' | 'error',
    queryLength: '1-3' | '4-10' | '11-30' | '31+',
    measurements: { durationMs: number; matchCount: number; pendingCount: number }
  ): void {
    try {
      safeSendEvent('logs.search', { outcome, queryLength }, measurements);
    } catch {}
  }

  private async fetchAllOrgLogs(selectedOrg: string | undefined, signal?: AbortSignal): Promise<ApexLogRow[]> {
    const all: ApexLogRow[] = [];
    const seen = new Set<string>();
    let cursorStartTime: string | undefined;
    let cursorId: string | undefined;
    let lastCursorKey: string | undefined;
    while (!signal?.aborted) {
      const batch = (await runtimeClient.logsList(
        {
          username: selectedOrg,
          limit: this.pageLimit,
          cursor:
            cursorStartTime && cursorId
              ? { beforeStartTime: cursorStartTime, beforeId: cursorId }
              : undefined
        },
        signal
      )) as ApexLogRow[];
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

  private async clearLogs(scope: 'all' | 'mine'): Promise<void> {
    if (this.clearLogsInProgress) {
      void vscode.window.showInformationMessage(
        localize('logsCleanup.alreadyRunning', 'A log cleanup is already in progress.')
      );
      return;
    }
    this.clearLogsInProgress = true;
    const t0 = Date.now();
    try {
      const selectedOrg = this.orgManager.getSelectedOrg();
      const confirmAction = localize('logsCleanup.confirmAction', 'Delete');
      const confirmation = await vscode.window.showWarningMessage(
        scope === 'mine'
          ? localize('logsCleanup.confirmMine.title', 'Delete your Apex logs for the selected org?')
          : localize('logsCleanup.confirmAll.title', 'Delete all Apex logs for the selected org?'),
        {
          modal: true,
          detail:
            scope === 'mine'
              ? localize(
                  'logsCleanup.confirmMine.detail',
                  "This permanently deletes ApexLog records whose LogUser matches the currently authenticated org user. It can't be undone."
                )
              : localize(
                  'logsCleanup.confirmAll.detail',
                  "This permanently deletes ApexLog records stored in the org. It can't be undone."
                )
        },
        confirmAction
      );
      if (confirmation !== confirmAction) {
        try {
          safeSendEvent(
            'logs.cleanup',
            { outcome: 'cancel', scope, sourceView: 'logs' },
            { durationMs: Date.now() - t0 }
          );
        } catch {}
        return;
      }

      type CleanupRunResult =
        | { kind: 'cancelled'; deleted: number; failed: number; total: number }
        | { kind: 'empty' }
        | { kind: 'done'; deleted: number; failed: number; cancelled: number; total: number };
      const result = await vscode.window.withProgress<CleanupRunResult>(
        {
          location: vscode.ProgressLocation.Notification,
          title:
            scope === 'mine'
              ? localize('logsCleanup.progressTitleMine', 'Deleting my org logs…')
              : localize('logsCleanup.progressTitleAll', 'Deleting org logs…'),
          cancellable: true
        },
        async (progress, ct) => {
          const controller = new AbortController();
          ct.onCancellationRequested(() => controller.abort());

          progress.report({
            message:
              scope === 'mine'
                ? localize('logsCleanup.progressListingMine', 'Listing your Apex logs…')
                : localize('logsCleanup.progressListingAll', 'Listing Apex logs in the org…')
          });

          let progressPct = 0;
          let auth: OrgAuth;
          try {
            auth = await runtimeClient.getOrgAuth({ username: selectedOrg });
          } catch (e) {
            const msg = getErrorMessage(e);
            if (controller.signal.aborted || this.isAbortLikeError(e, msg)) {
              return { kind: 'cancelled', deleted: 0, failed: 0, total: 0 };
            }
            throw e;
          }

          let cleanup: Awaited<ReturnType<typeof clearApexLogs>>;
          try {
            cleanup = await clearApexLogs(auth, scope, {
              signal: controller.signal,
              concurrency: 3,
              onProgress: p => {
                if (p.stage !== 'deleting' || p.total <= 0) {
                  return;
                }
                const nextPct = Math.max(0, Math.min(100, Math.floor((p.processed / p.total) * 100)));
                const increment = nextPct - progressPct;
                progressPct = nextPct;
                progress.report({
                  message: localize('logsCleanup.progressDeleting', 'Deleting logs ({0}/{1})…', p.processed, p.total),
                  increment: increment > 0 ? increment : undefined
                });
              }
            });
          } catch (e) {
            const msg = getErrorMessage(e);
            if (controller.signal.aborted || this.isAbortLikeError(e, msg)) {
              return { kind: 'cancelled', deleted: 0, failed: 0, total: 0 };
            }
            throw e;
          }

          if (controller.signal.aborted || ct.isCancellationRequested) {
            return {
              kind: 'cancelled',
              deleted: cleanup.deleted,
              failed: cleanup.failed,
              total: cleanup.total
            };
          }
          if (cleanup.total === 0) {
            return { kind: 'empty' };
          }
          return {
            kind: 'done',
            deleted: cleanup.deleted,
            failed: cleanup.failed,
            cancelled: cleanup.cancelled,
            total: cleanup.total
          };
        }
      );

      if (result.kind === 'empty') {
        void vscode.window.showInformationMessage(
          scope === 'mine'
            ? localize('logsCleanup.emptyMine', 'No Apex logs were found for the authenticated user.')
            : localize('logsCleanup.emptyAll', 'No Apex logs were found in the org.')
        );
      } else if (result.kind === 'cancelled') {
        void vscode.window.showInformationMessage(
          localize(
            'logsCleanup.cancelledCounts',
            'Log cleanup cancelled (deleted {0}, failed {1}).',
            result.deleted,
            result.failed
          )
        );
      } else {
        if (result.failed > 0) {
          void vscode.window.showWarningMessage(
            localize(
              'logsCleanup.partial',
              'Deleted {0} log(s), but {1} failed.',
              result.deleted,
              result.failed
            )
          );
        } else {
          void vscode.window.showInformationMessage(
            localize('logsCleanup.done', 'Deleted {0} Apex log(s).', result.deleted)
          );
        }
      }

      try {
        safeSendEvent(
          'logs.cleanup',
          { outcome: result.kind, scope, sourceView: 'logs' },
          { durationMs: Date.now() - t0 }
        );
      } catch {}

      await this.refresh();
    } catch (e) {
      const msg = getErrorMessage(e);
      logError('Logs: cleanup failed ->', msg);
      void vscode.window.showErrorMessage(localize('logsCleanup.failed', 'Failed to clear logs: {0}', msg));
      try {
        safeSendEvent(
          'logs.cleanup',
          { outcome: 'error', scope, sourceView: 'logs' },
          { durationMs: Date.now() - t0 }
        );
      } catch {}
    } finally {
      this.clearLogsInProgress = false;
    }
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
          safeSendEvent(
            'logs.downloadAll',
            { outcome: 'cancel', sourceView: 'logs' },
            { durationMs: Date.now() - t0 }
          );
        } catch {}
        return;
      }

      this.pageLimit = this.configManager.getPageLimit();
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
            logs = await this.fetchAllOrgLogs(selectedOrg, controller.signal);
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
            { outcome: 'cancelled', sourceView: 'logs' },
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
          safeSendEvent(
            'logs.downloadAll',
            { outcome: 'empty', sourceView: 'logs' },
            { durationMs: Date.now() - t0 }
          );
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
            { outcome: 'cancelled', sourceView: 'logs' },
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
          safeSendEvent(
            'logs.downloadAll',
            { outcome: 'partial', sourceView: 'logs' },
            { durationMs: Date.now() - t0, total, success, failed: summary.failed }
          );
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
        safeSendEvent(
          'logs.downloadAll',
          { outcome: 'ok', sourceView: 'logs' },
          { durationMs: Date.now() - t0, total, success }
        );
      } catch {}
    } catch (e) {
      const msg = getErrorMessage(e);
      logWarn('Logs: downloadAllLogs failed ->', msg);
      void vscode.window.showErrorMessage(
        localize('downloadAllLogsFailed', 'Failed to download all org logs: {0}', msg)
      );
      try {
        safeSendEvent(
          'logs.downloadAll',
          { outcome: 'error', sourceView: 'logs' },
          { durationMs: Date.now() - t0 }
        );
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
        try {
          const orgs = await runtimeClient.orgList({ forceRefresh });
          await this.orgManager.ensureProjectDefaultSelected(orgs);
          const selected = pickSelectedOrg(orgs, this.orgManager.getSelectedOrg());
          this.orgManager.setSelectedOrg(selected);
          if (ct.isCancellationRequested) {
            return;
          }
          this.post({ type: 'orgs', data: orgs, selected });
          try {
            const durationMs = Date.now() - t0;
            safeSendEvent('orgs.list', { outcome: 'ok', view: 'logs' }, { durationMs, count: orgs.length });
          } catch {}
        } catch (e) {
          if (!ct.isCancellationRequested) {
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

  public async syncSelectedOrg(username?: string): Promise<void> {
    const next = typeof username === 'string' ? username.trim() || undefined : undefined;
    if (!next || next === this.orgManager.getSelectedOrg()) {
      return;
    }

    this.setSelectedOrg(next);
    if (!this.view || this.disposed) {
      return;
    }

    await this.sendOrgs();
    await this.refresh();
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

  private bindHost(host: BoundWebviewHost): void {
    vscode.Disposable.from(...this.hostDisposables).dispose();
    this.hostDisposables = [];
    this.host = host;
    this.view = host;
    this.disposed = false;
    host.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    host.webview.html = this.getHtmlForWebview(host.webview);
    logInfo(`Logs webview resolved (${host.kind}).`);

    this.hostDisposables.push(
      host.onDidDispose(() => {
        if (this.host !== host) {
          return;
        }
        this.disposed = true;
        this.view = undefined;
        this.host = undefined;
        this.refreshToken++;
        this.cancelErrorScan();
        if (this.searchAbortController) {
          this.searchAbortController.abort();
          this.searchAbortController = undefined;
        }
        logInfo(`Logs webview disposed (${host.kind}).`);
      }),
      host.webview.onDidReceiveMessage(message => {
        void this.messageHandler.handle(message);
      })
    );
  }

  private post(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }
}
