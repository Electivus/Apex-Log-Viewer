import { promises as fs } from 'fs';
import { fetchApexLogs, fetchApexLogBody } from '../salesforce/http';
import { getOrgAuth } from '../salesforce/cli';
import { ensureUserTraceFlag } from '../salesforce/traceflags';
import type { OrgAuth } from '../salesforce/types';
import type { ExtensionToWebviewMessage } from '../shared/messages';
import { logInfo, logWarn, logError, showOutput } from './logger';
import { localize } from './localize';
import {
  getWorkspaceRoot as utilGetWorkspaceRoot,
  ensureApexLogsDir as utilEnsureApexLogsDir,
  getLogFilePathWithUsername as utilGetLogFilePathWithUsername
} from './workspace';

/**
 * Handles Apex log tailing mechanics independent of the webview.
 */
export class TailService {
  private tailRunning = false;
  private tailTimer: NodeJS.Timeout | undefined;
  private tailHardStopTimer: NodeJS.Timeout | undefined;
  private seenLogIds = new Set<string>();
  private currentAuth: OrgAuth | undefined;
  private currentDebugLevel: string | undefined;
  private lastPollErrorAt = 0;
  private logIdToPath = new Map<string, string>();
  private readonly logIdToPathLimit = 100;
  private disposed = false;
  private selectedOrg: string | undefined;
  private windowActive = true;

  constructor(private readonly post: (msg: ExtensionToWebviewMessage) => void) {}

  setOrg(username?: string): void {
    this.selectedOrg = username;
  }

  setWindowActive(active: boolean): void {
    this.windowActive = active;
  }

  isRunning(): boolean {
    return this.tailRunning;
  }

  promptPoll(): void {
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
    }
    this.tailTimer = setTimeout(() => void this.pollOnce(), 100);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  async start(debugLevel?: string): Promise<void> {
    if (this.tailRunning) {
      logInfo('Tail: start requested but already running.');
      return;
    }
    if (!debugLevel) {
      this.post({ type: 'error', message: localize('tailSelectDebugLevel', 'Select a debug level') });
      logWarn('Tail: start aborted; no debug level selected.');
      return;
    }
    this.seenLogIds.clear();
    this.logIdToPath.clear();
    this.currentDebugLevel = debugLevel;
    try {
      const auth = await getOrgAuth(this.selectedOrg);
      this.currentAuth = auth;
      logInfo('Tail: acquired auth for', auth.username || '(default)', 'at', auth.instanceUrl);

      try {
        const created = await ensureUserTraceFlag(auth, debugLevel);
        if (created) {
          logInfo('Tail: TraceFlag created for user with level', debugLevel);
        } else {
          logInfo('Tail: TraceFlag already active or unchanged');
        }
      } catch {
        logWarn('Tail: ensure TraceFlag failed (continuing)');
      }

      try {
        const recent = await fetchApexLogs(auth, 20, 0, debugLevel);
        logInfo('Tail: primed seen set with', recent.length, 'recent logs for level', debugLevel);
        for (const r of recent) {
          if (r && typeof r.Id === 'string') {
            this.seenLogIds.add(r.Id);
          }
        }
      } catch {
        logWarn('Tail: prime recent logs failed; proceeding with empty seen set');
      }

      this.tailRunning = true;
      this.post({ type: 'tailStatus', running: true });
      logInfo('Tail: started; polling…');

      if (this.tailHardStopTimer) {
        clearTimeout(this.tailHardStopTimer);
      }
      this.tailHardStopTimer = setTimeout(
        () => {
          if (this.tailRunning && !this.disposed) {
            logInfo('Tail: auto-stopping after 30 minutes.');
            this.post({ type: 'error', message: localize('tailHardStop', 'Tail stopped after 30 minutes.') });
            this.stop();
          }
        },
        30 * 60 * 1000
      );

      void this.pollOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('Tail: start failed ->', msg);
      this.post({ type: 'error', message: msg });
      showOutput(true);
      this.post({ type: 'tailStatus', running: false });
      this.tailRunning = false;
    }
  }

  stop(): void {
    this.tailRunning = false;
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
      this.tailTimer = undefined;
    }
    if (this.tailHardStopTimer) {
      clearTimeout(this.tailHardStopTimer);
      this.tailHardStopTimer = undefined;
    }
    this.seenLogIds.clear();
    this.logIdToPath.clear();
    this.post({ type: 'tailStatus', running: false });
    logInfo('Tail: stopped.');
  }

  clearLogPaths(): void {
    this.logIdToPath.clear();
  }

  private async pollOnce(): Promise<void> {
    if (!this.tailRunning || this.disposed) {
      return;
    }
    let nextDelay = this.windowActive ? 1500 : 5000;
    try {
      const auth = this.currentAuth ?? (await getOrgAuth(this.selectedOrg));
      this.currentAuth = auth;
      const logs = await fetchApexLogs(auth, 20, 0, this.currentDebugLevel);
      logInfo('Tail: polled logs ->', logs.length);
      for (let i = logs.length - 1; i >= 0; i--) {
        const r = logs[i];
        const id = r?.Id as string | undefined;
        if (!id || this.seenLogIds.has(id)) {
          continue;
        }
        this.seenLogIds.add(id);
        logInfo('Tail: new log', id, r?.Operation, r?.Status, r?.LogLength);
        try {
          const body = await fetchApexLogBody(auth, id);
          await this.emitLogWithHeader(auth, r, body);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn('Tail: fetch body failed for', id, '->', msg);
          this.post({ type: 'error', message: msg });
        }
      }
      if (this.seenLogIds.size > 2000) {
        const toDelete = this.seenLogIds.size - 1500;
        let n = 0;
        for (const k of this.seenLogIds) {
          this.seenLogIds.delete(k);
          if (++n >= toDelete) {
            break;
          }
        }
      }
      this.lastPollErrorAt = 0;
      nextDelay = this.windowActive ? 1200 : 4500;
    } catch (e) {
      const now = Date.now();
      if (now - this.lastPollErrorAt > 5000) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn('Tail: poll error ->', msg);
        this.post({ type: 'error', message: msg });
        this.lastPollErrorAt = now;
      }
      nextDelay = this.windowActive ? 3000 : 6000;
    } finally {
      if (this.tailRunning && !this.disposed) {
        this.tailTimer = setTimeout(() => void this.pollOnce(), nextDelay);
      }
    }
  }

  private async emitLogWithHeader(auth: OrgAuth, r: any, body: string): Promise<void> {
    const lines: string[] = [];
    const id = r?.Id as string | undefined;
    const header = `=== ApexLog ${id ?? ''} | ${r?.StartTime ?? ''} | ${r?.Operation ?? ''} | ${r?.Status ?? ''} | ${r?.LogLength ?? ''}`;
    lines.push(header);
    try {
      const { filePath } = await this.getLogFilePathWithUsername(auth.username, id ?? String(Date.now()));
      await fs.writeFile(filePath, body, 'utf8');
      if (id) {
        this.addLogPath(id, filePath);
      }
      lines.push(localize('tailSavedTo', 'Saved to {0}', filePath));
      logInfo('Tail: saved log', id, 'to', filePath);
      if (id) {
        this.post({
          type: 'tailNewLog',
          logId: id,
          startTime: r?.StartTime,
          operation: r?.Operation,
          status: r?.Status,
          logLength: typeof r?.LogLength === 'number' ? r.LogLength : undefined,
          savedPath: filePath
        });
      }
    } catch {
      logWarn('Tail: failed to save log to workspace (best-effort).');
    }
    for (const l of String(body || '').split(/\r?\n/)) {
      if (l) {
        lines.push(l);
      }
    }
    this.post({ type: 'tailData', lines });
  }

  private addLogPath(logId: string, filePath: string): void {
    this.logIdToPath.set(logId, filePath);
    if (this.logIdToPath.size > this.logIdToPathLimit) {
      const oldest = this.logIdToPath.keys().next().value;
      if (oldest) {
        this.logIdToPath.delete(oldest);
      }
    }
  }

  async ensureLogSaved(logId: string): Promise<string> {
    const existing = this.logIdToPath.get(logId);
    if (existing) {
      return existing;
    }
    const auth = this.currentAuth ?? (await getOrgAuth(this.selectedOrg));
    this.currentAuth = auth;
    const body = await fetchApexLogBody(auth, logId);
    const { filePath } = await this.getLogFilePathWithUsername(auth.username, logId);
    await fs.writeFile(filePath, body, 'utf8');
    this.addLogPath(logId, filePath);
    logInfo('Tail: ensured log saved at', filePath);
    return filePath;
  }

  private getWorkspaceRoot(): string | undefined {
    return utilGetWorkspaceRoot();
  }

  private async ensureApexLogsDir(): Promise<string> {
    return utilEnsureApexLogsDir();
  }

  private async getLogFilePathWithUsername(
    username: string | undefined,
    logId: string
  ): Promise<{ dir: string; filePath: string }> {
    return utilGetLogFilePathWithUsername(username, logId);
  }
}
