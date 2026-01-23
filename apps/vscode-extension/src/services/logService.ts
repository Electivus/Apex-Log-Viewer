import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { createLimiter, type Limiter } from '../utils/limiter';
import { getOrgAuth } from '../salesforce/cli';
import {
  fetchApexLogHead,
  fetchApexLogBody,
  extractCodeUnitStartedFromLines
} from '../salesforce/http';
import type { ApexLogCursor } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';
import type { ApexLogRow } from '../shared/types';
import { getLogFilePathWithUsername, findExistingLogFile, getWorkspaceRoot } from '../utils/workspace';
import { ensureReplayDebuggerAvailable } from '../utils/warmup';
import { getErrorMessage } from '../utils/error';
import { logWarn, logInfo } from '../utils/logger';
import { localize } from '../utils/localize';
import { LogViewerPanel } from '../panel/LogViewerPanel';
import { syncLogs } from '../utils/cliClient';

export class LogService {
  private headLimiter: Limiter;
  private headConcurrency: number;
  private saveLimiter: Limiter;
  private saveConcurrency: number;
  private inFlightSaves = new Map<string, Promise<string>>();

  constructor(headConcurrency = 5) {
    this.headConcurrency = headConcurrency;
    this.headLimiter = createLimiter(this.headConcurrency);
    this.saveConcurrency = Math.max(1, Math.min(3, Math.ceil(this.headConcurrency / 2)));
    this.saveLimiter = createLimiter(this.saveConcurrency);
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
    const totalLimit = safeOffset + safeLimit;
    const cwd = getWorkspaceRoot();
    const output = await syncLogs({
      limit: totalLimit,
      target: auth.username,
      cwd: cwd || undefined,
      signal
    });
    const logs = Array.isArray(output.logs) ? output.logs : [];
    return logs.slice(safeOffset, safeOffset + safeLimit);
  }

  loadLogHeads(
    logs: ApexLogRow[],
    auth: OrgAuth,
    token: number,
    post: (logId: string, codeUnit: string) => void,
    signal?: AbortSignal,
    options?: { preferLocalBodies?: boolean; selectedOrg?: string }
  ): void {
    const preferLocalBodies = options?.preferLocalBodies ?? false;
    const selectedOrg = options?.selectedOrg;
    for (const log of logs) {
      void this.headLimiter(async () => {
        if (signal?.aborted) {
          return;
        }
        try {
          let codeUnit: string | undefined;
          if (preferLocalBodies) {
            codeUnit = await this.loadCodeUnitFromLocalFile(log.Id, selectedOrg, signal);
            if (signal?.aborted) {
              return;
            }
          }
          if (!codeUnit) {
            const headLines = await fetchApexLogHead(
              auth,
              log.Id,
              10,
              typeof log.LogLength === 'number' ? log.LogLength : undefined,
              undefined,
              signal
            );
            if (signal?.aborted) {
              return;
            }
            codeUnit = extractCodeUnitStartedFromLines(headLines);
          }
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
    const existing = await findExistingLogFile(logId);
    if (existing) {
      return existing;
    }
    const auth = await getOrgAuth(selectedOrg, undefined, signal);
    const key = `${auth.username ?? ''}:${logId}`;
    const pending = this.inFlightSaves.get(key);
    if (pending) {
      return pending;
    }
    const task = (async () => {
      const maybeExisting = await findExistingLogFile(logId);
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

  private async loadCodeUnitFromLocalFile(
    logId: string | undefined,
    selectedOrg?: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (!logId) {
      return undefined;
    }
    if (signal?.aborted) {
      return undefined;
    }
    try {
      const filePath = await this.ensureLogFile(logId, selectedOrg, signal);
      if (signal?.aborted) {
        return undefined;
      }
      const handle = await fs.open(filePath, 'r');
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
    } catch (e) {
      if (!signal?.aborted) {
        logWarn('LogService: loadCodeUnitFromLocalFile failed ->', getErrorMessage(e));
      }
    }
    return undefined;
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
    options?: { downloadMissing?: boolean; onMissing?: (logId: string) => void }
  ): Promise<void> {
    const downloadMissing = options?.downloadMissing !== false;
    const tasks: Promise<void>[] = [];
    for (const log of logs) {
      if (!log?.Id) {
        continue;
      }
      tasks.push(
        this.saveLimiter(async () => {
          if (signal?.aborted) {
            return;
          }
          try {
            if (downloadMissing) {
              await this.ensureLogFile(log.Id, selectedOrg, signal);
            } else {
              const existing = await findExistingLogFile(log.Id);
              if (!existing) {
                options?.onMissing?.(log.Id);
              }
            }
          } catch (e) {
            logWarn('LogService: ensureLogFile failed ->', getErrorMessage(e));
          }
        })
      );
    }
    await Promise.all(tasks);
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
