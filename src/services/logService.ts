import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { createLimiter, type Limiter } from '../utils/limiter';
import { getOrgAuth } from '../salesforce/cli';
import { fetchApexLogBody, extractCodeUnitStartedFromLines } from '../salesforce/http';
import type { ApexLogCursor } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';
import type { ApexLogRow } from '../../apps/vscode-extension/src/shared/types';
import { getLogFilePathWithUsername, findExistingLogFile } from '../utils/workspace';
import { ensureReplayDebuggerAvailable } from '../utils/replayDebugger';
import { getErrorMessage } from '../utils/error';
import { logWarn, logInfo } from '../utils/logger';
import { localize } from '../utils/localize';
import { LogViewerPanel } from '../../apps/vscode-extension/src/panel/LogViewerPanel';
import { fetchApexLogs } from '../salesforce/http';
import { createUnreadableLogSummary, summarizeLogFile } from './logTriage';
import type { LogTriageSummary } from '../../apps/vscode-extension/src/shared/logTriage';

export type EnsureLogsSavedItemStatus = 'downloaded' | 'existing' | 'missing' | 'failed' | 'cancelled';

export type EnsureLogsSavedItemResult = {
  logId: string;
  status: EnsureLogsSavedItemStatus;
  error?: string;
};

export type EnsureLogsSavedSummary = {
  total: number;
  success: number;
  downloaded: number;
  existing: number;
  missing: number;
  failed: number;
  cancelled: number;
  failedLogIds: string[];
};

export type EnsureLogsSavedOptions = {
  downloadMissing?: boolean;
  onMissing?: (logId: string) => void;
  onItemComplete?: (result: EnsureLogsSavedItemResult) => void;
};

export type ClassifyLogsForErrorsProgress = {
  logId: string;
  summary: LogTriageSummary;
  hasErrors: boolean;
  inferredFromFailure?: boolean;
  processed: number;
  total: number;
  errorsFound: number;
};

export type ClassifyLogsForErrorsOptions = {
  onProgress?: (progress: ClassifyLogsForErrorsProgress) => void;
};

export class LogService {
  private headLimiter: Limiter;
  private headConcurrency: number;
  private saveLimiter: Limiter;
  private saveConcurrency: number;
  private classifyLimiter: Limiter;
  private classifyConcurrency: number;
  private inFlightSaves = new Map<string, Promise<string>>();

  constructor(headConcurrency = 5) {
    this.headConcurrency = headConcurrency;
    this.headLimiter = createLimiter(this.headConcurrency);
    this.saveConcurrency = Math.max(1, Math.min(3, Math.ceil(this.headConcurrency / 2)));
    this.saveLimiter = createLimiter(this.saveConcurrency);
    // Keep error scans from starving interactive save/download work.
    this.classifyConcurrency = Math.max(1, Math.min(2, this.saveConcurrency));
    this.classifyLimiter = createLimiter(this.classifyConcurrency);
  }

  setHeadConcurrency(conc: number): void {
    if (conc !== this.headConcurrency) {
      this.headConcurrency = conc;
      this.headLimiter = createLimiter(this.headConcurrency);
    }
    const nextSaveConcurrency = Math.max(1, Math.min(3, Math.ceil(this.headConcurrency / 2)));
    if (nextSaveConcurrency !== this.saveConcurrency) {
      this.saveConcurrency = nextSaveConcurrency;
      this.saveLimiter = createLimiter(this.saveConcurrency);
    }
    const nextClassifyConcurrency = Math.max(1, Math.min(2, this.saveConcurrency));
    if (nextClassifyConcurrency !== this.classifyConcurrency) {
      this.classifyConcurrency = nextClassifyConcurrency;
      this.classifyLimiter = createLimiter(this.classifyConcurrency);
    }
  }

  async fetchLogs(
    auth: OrgAuth,
    limit: number,
    offset: number,
    signal?: AbortSignal,
    _cursor?: ApexLogCursor
  ): Promise<ApexLogRow[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeOffset = Math.max(0, Math.floor(offset));
    return fetchApexLogs(auth, safeLimit, safeOffset, undefined, undefined, signal, _cursor);
  }

  loadLogHeads(
    logs: ApexLogRow[],
    auth: OrgAuth,
    _token: number,
    post: (logId: string, codeUnit: string) => void,
    signal?: AbortSignal,
    _options?: { preferLocalBodies?: boolean; selectedOrg?: string }
  ): void {
    for (const log of logs) {
      void this.headLimiter(async () => {
        if (signal?.aborted) {
          return;
        }
        try {
          const codeUnit = await this.loadCodeUnitFromSavedLog(log.Id, auth.username, signal);
          if (codeUnit) {
            post(log.Id, codeUnit);
          }
        } catch (e) {
          logWarn('LogService: loadLogHead failed for', log.Id, '->', e);
        }
      });
    }
  }

  private async ensureLogFile(logId: string, selectedOrg?: string, signal?: AbortSignal): Promise<string> {
    const auth = await getOrgAuth(selectedOrg, undefined, signal);
    const existing = await findExistingLogFile(logId, auth.username);
    if (existing) {
      return existing;
    }
    const key = `${auth.username ?? ''}:${logId}`;
    const pending = this.inFlightSaves.get(key);
    if (pending) {
      return pending;
    }
    const task = (async () => {
      const maybeExisting = await findExistingLogFile(logId, auth.username);
      if (maybeExisting) {
        return maybeExisting;
      }
      const { filePath } = await getLogFilePathWithUsername(auth.username, logId);
      const body = await fetchApexLogBody(auth, logId, undefined, signal);
      await fs.writeFile(filePath, body, 'utf8');
      return filePath;
    })();
    this.inFlightSaves.set(key, task);
    try {
      const result = await task;
      return result;
    } finally {
      this.inFlightSaves.delete(key);
    }
  }

  private async loadCodeUnitFromSavedLog(
    logId: string | undefined,
    username?: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (!logId) {
      return undefined;
    }
    if (signal?.aborted) {
      return undefined;
    }
    try {
      const existingPath = await findExistingLogFile(logId, username);
      if (existingPath) {
        const handle = await fs.open(existingPath, 'r');
        try {
          const buffer = Buffer.alloc(8192);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead <= 0) {
            return undefined;
          }
          const text = buffer.slice(0, bytesRead).toString('utf8');
          const lines = text.split(/\r?\n/).slice(0, 10);
          return extractCodeUnitStartedFromLines(lines);
        } finally {
          await handle.close();
        }
      }
    } catch (e) {
      if (!signal?.aborted) {
        logWarn('LogService: loadCodeUnit from local file failed ->', getErrorMessage(e));
      }
    }
    return undefined;
  }

  private async resolveSelectedUsername(selectedOrg?: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!selectedOrg || signal?.aborted) {
      return undefined;
    }
    try {
      return (await getOrgAuth(selectedOrg, undefined, signal)).username;
    } catch {
      return undefined;
    }
  }

  async classifyLogsForErrors(
    logs: ApexLogRow[],
    selectedOrg?: string,
    signal?: AbortSignal,
    options?: ClassifyLogsForErrorsOptions
  ): Promise<Map<string, LogTriageSummary>> {
    const validLogs = logs.filter(
      (log): log is ApexLogRow & { Id: string } => typeof log?.Id === 'string' && log.Id.length > 0
    );
    const total = validLogs.length;
    let processed = 0;
    let errorsFound = 0;
    const result = new Map<string, LogTriageSummary>();
    const tasks: Promise<void>[] = [];
    const selectedUsername = await this.resolveSelectedUsername(selectedOrg, signal);

    for (const log of validLogs) {
      tasks.push(
        this.classifyLimiter(async () => {
          let summary: LogTriageSummary = {
            hasErrors: false,
            reasons: []
          };
          let inferredFromFailure = false;
          try {
            if (signal?.aborted) {
              return;
            }
            const existingPath = await findExistingLogFile(log.Id, selectedUsername);
            const filePath = existingPath ?? (await this.ensureLogFile(log.Id, selectedOrg, signal));
            if (signal?.aborted) {
              return;
            }
            summary = await summarizeLogFile(filePath);
            result.set(log.Id, summary);
            if (summary.hasErrors) {
              errorsFound++;
            }
          } catch (e) {
            if (!signal?.aborted) {
              // Conservative fallback: unreadable/unavailable logs are treated as potentially erroneous
              // to avoid false negatives in the "Errors only" filter.
              summary = createUnreadableLogSummary(getErrorMessage(e));
              inferredFromFailure = true;
              result.set(log.Id, summary);
              errorsFound++;
              logWarn('LogService: classifyLogsForErrors failed for', log.Id, '->', getErrorMessage(e));
            }
          } finally {
            if (signal?.aborted) {
              return;
            }
            processed++;
            options?.onProgress?.({
              logId: log.Id,
              summary,
              hasErrors: summary.hasErrors,
              inferredFromFailure,
              processed,
              total,
              errorsFound
            });
          }
        })
      );
    }

    await Promise.all(tasks);
    return result;
  }

  async openLog(logId: string, selectedOrg?: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize('openingApexLog', 'Opening Apex Log…'),
        cancellable: true
      },
      async (_progress, ct) => {
        const controller = new AbortController();
        ct.onCancellationRequested(() => controller.abort());
        try {
          const targetPath = await this.ensureLogFile(logId, selectedOrg, controller.signal);
          if (ct.isCancellationRequested) {
            return;
          }
          await LogViewerPanel.show({ logId, filePath: targetPath, signal: controller.signal });
          if (!controller.signal.aborted) {
            logInfo('LogService: opened log in viewer', logId);
          }
        } catch (e) {
          if (!controller.signal.aborted) {
            const msg = getErrorMessage(e);
            logWarn('LogService: openLog failed ->', msg);
            void vscode.window.showErrorMessage(
              localize('openLogFailed', 'Failed to open Apex log: {0}', msg)
            );
          }
        }
      }
    );
  }

  async ensureLogsSaved(
    logs: ApexLogRow[],
    selectedOrg?: string,
    signal?: AbortSignal,
    options?: EnsureLogsSavedOptions
  ): Promise<EnsureLogsSavedSummary> {
    const downloadMissing = options?.downloadMissing !== false;
    const validLogs = logs.filter((log): log is ApexLogRow & { Id: string } => typeof log?.Id === 'string' && log.Id.length > 0);
    const selectedUsername = await this.resolveSelectedUsername(selectedOrg, signal);
    const summary: EnsureLogsSavedSummary = {
      total: validLogs.length,
      success: 0,
      downloaded: 0,
      existing: 0,
      missing: 0,
      failed: 0,
      cancelled: 0,
      failedLogIds: []
    };
    const tasks: Promise<void>[] = [];
    for (const log of validLogs) {
      tasks.push(
        this.saveLimiter(async () => {
          if (signal?.aborted) {
            summary.cancelled++;
            options?.onItemComplete?.({ logId: log.Id, status: 'cancelled' });
            return;
          }
          try {
            if (downloadMissing) {
              const existing = await findExistingLogFile(log.Id, selectedUsername);
              if (existing) {
                summary.success++;
                summary.existing++;
                options?.onItemComplete?.({ logId: log.Id, status: 'existing' });
                return;
              }
              await this.ensureLogFile(log.Id, selectedOrg, signal);
              if (signal?.aborted) {
                summary.cancelled++;
                options?.onItemComplete?.({ logId: log.Id, status: 'cancelled' });
                return;
              }
              summary.success++;
              summary.downloaded++;
              options?.onItemComplete?.({ logId: log.Id, status: 'downloaded' });
            } else {
              const existing = await findExistingLogFile(log.Id, selectedUsername);
              if (!existing) {
                summary.missing++;
                options?.onMissing?.(log.Id);
                options?.onItemComplete?.({ logId: log.Id, status: 'missing' });
              } else {
                summary.success++;
                summary.existing++;
                options?.onItemComplete?.({ logId: log.Id, status: 'existing' });
              }
            }
          } catch (e) {
            const msg = getErrorMessage(e);
            if (signal?.aborted || this.isAbortLikeError(msg, e)) {
              summary.cancelled++;
              options?.onItemComplete?.({ logId: log.Id, status: 'cancelled' });
              return;
            }
            summary.failed++;
            summary.failedLogIds.push(log.Id);
            options?.onItemComplete?.({ logId: log.Id, status: 'failed', error: msg });
            logWarn('LogService: ensureLogFile failed for', log.Id, '->', msg);
          }
        })
      );
    }
    await Promise.all(tasks);
    return summary;
  }

  private isAbortLikeError(message: string, err: unknown): boolean {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      return true;
    }
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('abort') || normalized.includes('canceled') || normalized.includes('cancelled');
  }

  async debugLog(logId: string, selectedOrg?: string): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Starting Apex Replay Debugger…',
        cancellable: true
      },
      async (_progress, ct) => {
        const controller = new AbortController();
        ct.onCancellationRequested(() => controller.abort());
        try {
          const ok = await ensureReplayDebuggerAvailable();
          if (!ok || ct.isCancellationRequested) {
            return;
          }
          const targetPath = await this.ensureLogFile(logId, selectedOrg, controller.signal);
          if (ct.isCancellationRequested) {
            return;
          }
          const uri = vscode.Uri.file(targetPath);
          try {
            await vscode.commands.executeCommand('sf.launch.replay.debugger.logfile', uri);
          } catch (e) {
            if (!controller.signal.aborted) {
              logWarn('LogService: sf.launch.replay.debugger.logfile failed ->', getErrorMessage(e));
              await vscode.commands.executeCommand('sfdx.launch.replay.debugger.logfile', uri);
            }
          }
        } catch (e) {
          if (!controller.signal.aborted) {
            const msg = getErrorMessage(e);
            logWarn('LogService: debugLog failed ->', msg);
            void vscode.window.showErrorMessage(
              localize('startReplayFailed', 'Failed to start Apex Replay Debugger: {0}', msg)
            );
          }
        }
      }
    );
  }
}
