import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { createLimiter, type Limiter } from '../utils/limiter';
import { getOrgAuth } from '../salesforce/cli';
import {
  fetchApexLogs,
  fetchApexLogHead,
  fetchApexLogBody,
  extractCodeUnitStartedFromLines
} from '../salesforce/http';
import type { ApexLogCursor } from '../salesforce/http';
import type { OrgAuth } from '../salesforce/types';
import type { ApexLogRow } from '../shared/types';
import { getLogFilePathWithUsername, findExistingLogFile } from '../utils/workspace';
import { ensureReplayDebuggerAvailable } from '../utils/warmup';
import { getErrorMessage } from '../utils/error';
import { logWarn, logInfo } from '../utils/logger';
import { localize } from '../utils/localize';
import { LogViewerPanel } from '../panel/LogViewerPanel';

export class LogService {
  private headLimiter: Limiter;
  private headConcurrency: number;

  constructor(headConcurrency = 5) {
    this.headConcurrency = headConcurrency;
    this.headLimiter = createLimiter(this.headConcurrency);
  }

  setHeadConcurrency(conc: number): void {
    if (conc !== this.headConcurrency) {
      this.headConcurrency = conc;
      this.headLimiter = createLimiter(this.headConcurrency);
    }
  }

  async fetchLogs(
    auth: OrgAuth,
    limit: number,
    offset: number,
    signal?: AbortSignal,
    cursor?: ApexLogCursor
  ): Promise<ApexLogRow[]> {
    return fetchApexLogs(auth, limit, offset, undefined, undefined, signal, cursor);
  }

  loadLogHeads(
    logs: ApexLogRow[],
    auth: OrgAuth,
    token: number,
    post: (logId: string, codeUnit: string) => void,
    signal?: AbortSignal
  ): void {
    for (const log of logs) {
      void this.headLimiter(async () => {
        if (signal?.aborted) {
          return;
        }
        try {
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
          const codeUnit = extractCodeUnitStartedFromLines(headLines);
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
    const { filePath } = await getLogFilePathWithUsername(auth.username, logId);
    const body = await fetchApexLogBody(auth, logId, undefined, signal);
    await fs.writeFile(filePath, body, 'utf8');
    return filePath;
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
          let targetPath = await findExistingLogFile(logId);
          if (!targetPath) {
            const auth = await getOrgAuth(selectedOrg, undefined, controller.signal);
            if (ct.isCancellationRequested) {
              return;
            }
            const { filePath } = await getLogFilePathWithUsername(auth.username, logId);
            const body = await fetchApexLogBody(auth, logId, undefined, controller.signal);
            if (ct.isCancellationRequested) {
              return;
            }
            await fs.writeFile(filePath, body, 'utf8');
            targetPath = filePath;
          }
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
