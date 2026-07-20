import * as vscode from 'vscode';
import { createLimiter, type Limiter } from '../utils/limiter';
import type { OrgAuth } from '../salesforce/types';
import type { ApexLogRow } from '../../shared/types';
import { ensureReplayDebuggerAvailable } from '../utils/replayDebugger';
import { getErrorMessage } from '../utils/error';
import { logWarn, logInfo } from '../utils/logger';
import { localize } from '../utils/localize';
import { LogViewerPanel } from '../../panel/LogViewerPanel';
import { runtimeClient } from '../../runtime/runtimeClient';

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
  localLogPaths?: Record<string, string>;
};

export type EnsureLogsSavedOptions = {
  downloadMissing?: boolean;
  authHint?: OrgAuth;
  onMissing?: (logId: string) => void;
  onItemComplete?: (result: EnsureLogsSavedItemResult) => void;
};

type EnsureLogFileResult = {
  filePath: string;
  source: 'existing' | 'downloaded';
};

type EnsureLogFileRequest = {
  logId: string;
  selectedOrg?: string;
  signal?: AbortSignal;
  startTime?: string;
};

export class LogService {
  private headConcurrency: number;
  private saveLimiter: Limiter;
  private saveConcurrency: number;

  constructor(headConcurrency = 5) {
    this.headConcurrency = headConcurrency;
    this.saveConcurrency = Math.max(1, Math.min(3, Math.ceil(this.headConcurrency / 2)));
    this.saveLimiter = createLimiter(this.saveConcurrency);
  }

  setHeadConcurrency(conc: number): void {
    if (conc !== this.headConcurrency) {
      this.headConcurrency = conc;
    }
    const nextSaveConcurrency = Math.max(1, Math.min(3, Math.ceil(this.headConcurrency / 2)));
    if (nextSaveConcurrency !== this.saveConcurrency) {
      this.saveConcurrency = nextSaveConcurrency;
      this.saveLimiter = createLimiter(this.saveConcurrency);
    }
  }

  private async ensureLogFileResult({
    logId,
    selectedOrg,
    signal,
    startTime
  }: EnsureLogFileRequest): Promise<EnsureLogFileResult> {
    const file = await runtimeClient.requireLocalLogPath({ logId, targetOrg: selectedOrg, startTime }, signal);
    return { filePath: file.localPath, source: file.source === 'remote' ? 'downloaded' : 'existing' };
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
          const targetPath = (await this.ensureLogFileResult({ logId, selectedOrg, signal: controller.signal }))
            .filePath;
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
            void vscode.window.showErrorMessage(localize('openLogFailed', 'Failed to open Apex log: {0}', msg));
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
    const validLogs = logs.filter(
      (log): log is ApexLogRow & { Id: string } => typeof log?.Id === 'string' && log.Id.length > 0
    );
    const summary: EnsureLogsSavedSummary = {
      total: validLogs.length,
      success: 0,
      downloaded: 0,
      existing: 0,
      missing: 0,
      failed: 0,
      cancelled: 0,
      failedLogIds: [],
      localLogPaths: {}
    };
    if (!downloadMissing) {
      const local = await runtimeClient.availableLocalLogPaths(
        {
          targetOrg: options?.authHint?.username ?? selectedOrg,
          logs: validLogs.map(log => ({ logId: log.Id, startTime: log.StartTime }))
        },
        signal
      );
      for (const file of local.available) {
        summary.success += 1;
        summary.existing += 1;
        summary.localLogPaths![file.logId] = file.localPath;
        options?.onItemComplete?.({ logId: file.logId, status: 'existing' });
      }
      for (const log of local.missing) {
        summary.missing += 1;
        options?.onMissing?.(log.logId);
        options?.onItemComplete?.({ logId: log.logId, status: 'missing' });
      }
      for (const failure of local.failures) {
        summary.failed += 1;
        summary.failedLogIds.push(failure.logId);
        options?.onItemComplete?.({ logId: failure.logId, status: 'failed', error: failure.error.message });
      }
      return summary;
    }
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
            const result = await this.ensureLogFileResult({
              logId: log.Id,
              selectedOrg: options?.authHint?.username ?? selectedOrg,
              signal,
              startTime: log.StartTime
            });
            if (signal?.aborted) {
              summary.cancelled++;
              options?.onItemComplete?.({ logId: log.Id, status: 'cancelled' });
              return;
            }
            summary.success++;
            summary[result.source]++;
            summary.localLogPaths![log.Id] = result.filePath;
            options?.onItemComplete?.({ logId: log.Id, status: result.source });
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
          const targetPath = (await this.ensureLogFileResult({ logId, selectedOrg, signal: controller.signal }))
            .filePath;
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
