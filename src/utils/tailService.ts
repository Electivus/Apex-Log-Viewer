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
import {
  createConnectionFromAuth,
  createLoggingStreamingClient,
  createOrgFromConnection,
  type StreamProcessor,
  type StreamingClient
} from '../salesforce/streaming';
import { LogService } from '@salesforce/apex-node';
import type { Connection } from '@salesforce/core';

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
  private streamingClient: StreamingClient | undefined;
  private connection: Connection | undefined;
  private logService: LogService | undefined;
  private lastReplayId: number | undefined;

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
    // No-op with Streaming API (kept for compatibility with older VS Code versions)
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
    }
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

      // Build core connection/org from existing CLI OAuth (no extra login)
      this.connection = await createConnectionFromAuth(auth);
      const org = await createOrgFromConnection(this.connection);
      this.logService = new (LogService as any)(this.connection as any);

      try {
        // Prefer apex-node trace flag management
        await (this.logService as any)?.prepareTraceFlag(debugLevel);
        logInfo('Tail: TraceFlag ensured via apex-node with level', debugLevel);
      } catch {
        // Fall back to our helper if apex-node path fails
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
      logInfo('Tail: started; subscribing to /systemTopic/Logging…');

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
      // Create StreamingClient (uses API 36.0 for system topics automatically)
      const processor: StreamProcessor = (message: Parameters<StreamProcessor>[0]) => {
        try {
          const errName = (message as any)?.errorName;
          if (errName === 'streamListenerAborted') {
            return { completed: true };
          }
          // Store replay id when available for short replays on reconnect
          const replayIdRaw = (message as any)?.event?.replayId;
          if (typeof replayIdRaw === 'number') {
            this.lastReplayId = replayIdRaw;
          } else if (typeof replayIdRaw === 'string' && /^\d+$/.test(replayIdRaw)) {
            this.lastReplayId = Number(replayIdRaw);
          }
          const id: string | undefined = (message as any)?.sobject?.Id;
          if (id && !this.seenLogIds.has(id)) {
            // Process new log id asynchronously
            void this.handleIncomingLogId(id);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn('Tail: streaming processor error ->', msg);
        }
        return { completed: false };
      };
      this.streamingClient = await createLoggingStreamingClient(org, processor);
      try {
        await this.streamingClient.handshake();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError('Tail: handshake failed ->', msg);
        this.post({ type: 'error', message: `Handshake failed: ${msg}` });
        showOutput(true);
        throw e;
      }
      try {
        // Request replay from lastReplayId exactly (not sequential)
        try {
          if (typeof this.lastReplayId === 'number') {
            this.streamingClient.replay(this.lastReplayId);
            logInfo('Tail: requested replay from', this.lastReplayId);
          } else {
            // -1 means only new events
            this.streamingClient.replay(-1);
            logInfo('Tail: starting fresh with replay -1');
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logWarn('Tail: failed to set replay id ->', msg);
        }
        // Don't await subscribe; it resolves only when the processor returns completed or on timeout.
        void this.streamingClient
          .subscribe()
          .then(() => logInfo('Tail: streaming subscribe completed.'))
          .catch((err: any) => {
            const msg = err instanceof Error ? err.message : String(err);
            // Treat generic subscribe timeout as expected end when long-running
            if (/Socket timeout occurred/i.test(msg)) {
              logInfo('Tail: subscribe timed out (socket); continuing.');
              return;
            }
            logError('Tail: subscribe async error ->', msg);
            this.post({ type: 'error', message: `Subscribe failed: ${msg}` });
            showOutput(true);
          });
        logInfo('Tail: subscribed to /systemTopic/Logging (started)');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logWarn('Tail: subscribe init failed ->', msg);
        // If replayId is invalid/expired, retry once with -1
        const isReplayError = /replay/i.test(msg) || /400::/.test(msg) || /invalid/i.test(msg);
        if (isReplayError) {
          try {
            this.streamingClient.replay(-1);
            logInfo('Tail: retrying subscribe with replay -1');
            void this.streamingClient
              .subscribe()
              .then(() => logInfo('Tail: streaming subscribe completed (fallback).'))
              .catch((err2: any) => {
                const m2 = err2 instanceof Error ? err2.message : String(err2);
                if (/Socket timeout occurred/i.test(m2)) {
                  logInfo('Tail: subscribe fallback timed out (socket); continuing.');
                  return;
                }
                logError('Tail: subscribe retry async error ->', m2);
                this.post({ type: 'error', message: `Subscribe failed: ${m2}` });
                showOutput(true);
              });
            logInfo('Tail: subscribed to /systemTopic/Logging (fallback started)');
          } catch (e2) {
            const m2 = e2 instanceof Error ? e2.message : String(e2);
            logError('Tail: subscribe retry failed ->', m2);
            this.post({ type: 'error', message: `Subscribe failed: ${m2}` });
            showOutput(true);
            throw e2;
          }
        } else {
          this.post({ type: 'error', message: `Subscribe failed: ${msg}` });
          showOutput(true);
          throw e;
        }
      }
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
    try {
      if (this.streamingClient) {
        // sfdx-core types don’t expose disconnect; cast to any
        (this.streamingClient as any).disconnect?.();
        this.streamingClient = undefined;
        logInfo('Tail: streaming client disconnected.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: streaming disconnect error ->', msg);
    }
    try {
      (this.connection as any)?.logout?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: connection logout error ->', msg);
    }
    try {
      (this.connection as any)?.dispose?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: connection dispose error ->', msg);
    }
    this.connection = undefined;
    try {
      (this.logService as any)?.logout?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: log service logout error ->', msg);
    }
    try {
      (this.logService as any)?.dispose?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: log service dispose error ->', msg);
    }
    this.logService = undefined;
    this.currentAuth = undefined;
    this.lastReplayId = undefined;
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

  // Streaming handler: fetch body via apex-node and header fields via Tooling API
  private async handleIncomingLogId(id: string): Promise<void> {
    if (!this.tailRunning || this.disposed) {
      return;
    }
    this.seenLogIds.add(id);
    try {
      const auth = this.currentAuth ?? (await getOrgAuth(this.selectedOrg));
      this.currentAuth = auth;
      const svc = this.logService;
      const conn = this.connection;
      if (!svc || !conn) {
        // fallback: use existing HTTP path
        const body = await fetchApexLogBody(auth, id);
        await this.emitLogWithHeader(auth, { Id: id }, body);
        return;
      }
      const [{ log }, meta] = await Promise.all([
        (svc as any).getLogById(id),
        conn.singleRecordQuery(
          "SELECT Id, StartTime, Operation, Status, LogLength FROM ApexLog WHERE Id = '" + id + "'",
          { tooling: true }
        )
      ]);
      await this.emitLogWithHeader(auth, meta as any, log || '');
    } catch (e) {
      // Ensure failures don't permanently mark the log ID as seen
      this.seenLogIds.delete(id);
      const msg = e instanceof Error ? e.message : String(e);
      logWarn('Tail: failed processing streamed log', id, '->', msg);
      this.post({ type: 'error', message: msg });
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
      logWarn(localize('tailSaveFailed', 'Tail: failed to save log to workspace (best-effort).'));
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
