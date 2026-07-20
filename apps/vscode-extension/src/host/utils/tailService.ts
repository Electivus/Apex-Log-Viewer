import { getEffectiveApiVersion } from '../salesforce/http';
import { ensureUserTraceFlag } from '../salesforce/traceflags';
import type { OrgAuth } from '../salesforce/types';
import type { ExtensionToWebviewMessage } from '../../shared/messages';
import { runtimeClient } from '../../runtime/runtimeClient';
import { logInfo, logWarn, logError, showOutput } from './logger';
import { localize } from './localize';
import { getErrorMessage } from './error';
import {
  createConnectionFromAuth,
  createLoggingStreamingClient,
  type Connection,
  type StreamProcessor,
  type StreamingClient
} from '../salesforce/streaming';
import type { ReadApexLogResult } from '@alv/core';

/**
 * Handles Apex log tailing mechanics independent of the webview.
 */
export const DEFAULT_TAIL_BUFFER_LINES = 10000;
export const MIN_TAIL_BUFFER_LINES = 1000;
export const MAX_TAIL_BUFFER_LINES = 200000;

export class TailService {
  private tailRunning = false;
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
  private lastReplayId: number | undefined;
  private bufferLimit = DEFAULT_TAIL_BUFFER_LINES;
  private bufferedLines: string[] = [];
  private bufferedLinesOffset = 0;

  constructor(private readonly post: (msg: ExtensionToWebviewMessage) => void) {}

  setOrg(username?: string): void {
    this.selectedOrg = username;
  }

  setWindowActive(active: boolean): void {
    this.windowActive = active;
  }

  setBufferLimit(limit: number): void {
    if (!Number.isFinite(limit)) {
      return;
    }
    this.bufferLimit = Math.max(MIN_TAIL_BUFFER_LINES, Math.min(MAX_TAIL_BUFFER_LINES, Math.floor(limit)));
    this.trimBufferedLines();
  }

  isRunning(): boolean {
    return this.tailRunning;
  }

  getBufferedLines(): string[] {
    return this.bufferedLinesOffset > 0 ? this.bufferedLines.slice(this.bufferedLinesOffset) : [...this.bufferedLines];
  }

  promptPoll(): void {
    // No-op with Streaming API (kept for compatibility with older VS Code versions)
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
    this.tailRunning = true;
    this.seenLogIds.clear();
    this.logIdToPath.clear();
    this.currentDebugLevel = debugLevel;
    try {
      const auth = await this.getOrgAuth();
      if (!this.tailRunning || this.disposed) {
        logWarn('Tail: start aborted while awaiting auth');
        return;
      }
      this.currentAuth = auth;
      logInfo('Tail: acquired auth for', auth.username || '(default)', 'at', auth.instanceUrl);

      try {
        // Ensure TraceFlag using USER_DEBUG and update existing if present
        const created = await ensureUserTraceFlag(auth, debugLevel);
        if (created) {
          logInfo('Tail: TraceFlag created for user with level', debugLevel);
        } else {
          logInfo('Tail: TraceFlag updated or already matching for level', debugLevel);
        }
      } catch {
        logWarn('Tail: ensure TraceFlag failed (continuing)');
      }

      try {
        const recent = await runtimeClient.logsList({ username: this.selectedOrg ?? auth.username, limit: 20 });
        logInfo('Tail: primed seen set with', recent.length, 'recent logs for level', debugLevel);
        for (const r of recent) {
          if (r && typeof r.Id === 'string') {
            this.seenLogIds.add(r.Id);
          }
        }
      } catch {
        logWarn('Tail: prime recent logs failed; proceeding with empty seen set');
      }

      if (!this.tailRunning || this.disposed) {
        logWarn('Tail: start aborted after priming');
        return;
      }

      this.connection = await this.getActiveConnection(auth);
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
          const msg = getErrorMessage(e);
          logWarn('Tail: streaming processor error ->', msg);
        }
        return { completed: false };
      };
      this.streamingClient = await createLoggingStreamingClient(this.connection, processor);
      try {
        await this.streamingClient.handshake();
      } catch (e) {
        const msg = getErrorMessage(e);
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
          const msg = getErrorMessage(e);
          logWarn('Tail: failed to set replay id ->', msg);
        }
        // Don't await subscribe; it resolves only when the processor returns completed or on timeout.
        void this.streamingClient
          .subscribe()
          .then(() => logInfo('Tail: streaming subscribe completed.'))
          .catch((err: any) => {
            const msg = getErrorMessage(err);
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
        const msg = getErrorMessage(e);
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
                const m2 = getErrorMessage(err2);
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
            const m2 = getErrorMessage(e2);
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
      const msg = getErrorMessage(e);
      logError('Tail: start failed ->', msg);
      this.post({ type: 'error', message: msg });
      showOutput(true);
      this.post({ type: 'tailStatus', running: false });
      if (this.tailHardStopTimer) {
        clearTimeout(this.tailHardStopTimer);
        this.tailHardStopTimer = undefined;
      }
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
      const msg = getErrorMessage(e);
      logWarn('Tail: streaming disconnect error ->', msg);
    }
    this.connection = undefined;
    this.currentAuth = undefined;
    this.lastReplayId = undefined;
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

  clearBufferedLines(): void {
    this.bufferedLines = [];
    this.bufferedLinesOffset = 0;
  }

  // Streaming supplies the notification and optional metadata; the shared lifecycle owns body acquisition.
  private async handleIncomingLogId(id: string): Promise<void> {
    if (!this.tailRunning || this.disposed) {
      return;
    }
    this.seenLogIds.add(id);
    try {
      const auth = this.currentAuth ?? (await this.getOrgAuth());
      this.currentAuth = auth;
      const conn = this.connection
        ? await this.getActiveConnection(auth).catch(error => {
            logWarn('Tail: failed to refresh active connection; falling back to HTTP path ->', getErrorMessage(error));
            return undefined;
          })
        : undefined;
      const meta = conn ? await this.fetchLogMetadataFromConnection(conn, id).catch(() => undefined) : undefined;
      const startTime = typeof meta?.StartTime === 'string' ? meta.StartTime : undefined;
      const result = await runtimeClient.readApexLog({
        logId: id,
        startTime,
        targetOrg: this.selectedOrg,
        persistence: 'best-effort'
      });
      await this.emitLogWithHeader(meta || { Id: id }, result);
    } catch (e) {
      // Ensure failures don't permanently mark the log ID as seen
      this.seenLogIds.delete(id);
      const msg = getErrorMessage(e);
      logWarn('Tail: failed processing streamed log', id, '->', msg);
      this.post({ type: 'error', message: msg });
    }
  }

  private async emitLogWithHeader(r: any, result: ReadApexLogResult): Promise<void> {
    const lines: string[] = [];
    const id = r?.Id as string | undefined;
    const header = `=== ApexLog ${id ?? ''} | ${r?.StartTime ?? ''} | ${r?.Operation ?? ''} | ${r?.Status ?? ''} | ${r?.LogLength ?? ''}`;
    lines.push(header);
    const filePath = result.localPath;
    if (filePath) {
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
    } else {
      logWarn(localize('tailSaveFailed', 'Tail: failed to save log to workspace (best-effort).'));
    }
    for (const l of String(result.body || '').split(/\r?\n/)) {
      if (l) {
        lines.push(l);
      }
    }
    this.appendBufferedLines(lines);
    this.post({ type: 'tailData', lines });
  }

  private appendBufferedLines(lines: string[]): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      return;
    }
    this.compactBufferedLinesIfNeeded();
    this.bufferedLines.push(...lines);
    this.trimBufferedLines();
  }

  private trimBufferedLines(): void {
    const logicalLength = this.bufferedLines.length - this.bufferedLinesOffset;
    const drop = Math.max(0, logicalLength - this.bufferLimit);
    if (drop > 0) {
      this.bufferedLinesOffset += drop;
      this.compactBufferedLinesIfNeeded();
    }
  }

  private compactBufferedLinesIfNeeded(force = false): void {
    if (this.bufferedLinesOffset <= 0) {
      return;
    }
    if (
      force ||
      this.bufferedLinesOffset >= this.bufferLimit ||
      this.bufferedLinesOffset * 2 >= this.bufferedLines.length
    ) {
      this.bufferedLines = this.bufferedLines.slice(this.bufferedLinesOffset);
      this.bufferedLinesOffset = 0;
    }
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

  async ensureLogSaved(logId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.logIdToPath.get(logId);
    if (existing) {
      return existing;
    }
    const local = await runtimeClient.requireLocalLogPath({ logId, targetOrg: this.selectedOrg }, signal);
    const filePath = local.localPath;
    this.addLogPath(logId, filePath);
    logInfo('Tail: ensured log saved at', filePath);
    return filePath;
  }

  private async fetchLogMetadataFromConnection(
    connection: Connection,
    logId: string
  ): Promise<Record<string, unknown> | undefined> {
    const escapedId = String(logId || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'");
    const result = await connection.tooling.query<Record<string, unknown>>(
      `SELECT Id, StartTime, Operation, Status, LogLength FROM ApexLog WHERE Id = '${escapedId}' LIMIT 1`
    );
    return Array.isArray((result as any)?.records)
      ? ((result as any).records[0] as Record<string, unknown> | undefined)
      : undefined;
  }

  private async getActiveConnection(auth: OrgAuth): Promise<Connection> {
    const effectiveVersion = getEffectiveApiVersion(auth);
    if (!this.connection || this.connection.version !== effectiveVersion) {
      if (this.connection && this.connection.version !== effectiveVersion) {
        logInfo('Tail: refreshing connection for API version', effectiveVersion);
      }
      this.connection = await createConnectionFromAuth(auth, effectiveVersion);
    }
    return this.connection;
  }

  private async getOrgAuth(signal?: AbortSignal): Promise<OrgAuth> {
    if (signal?.aborted) {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      throw error;
    }
    const auth = await runtimeClient.getOrgAuth({ username: this.selectedOrg }, signal);
    if (signal?.aborted) {
      const error = new Error('Request aborted');
      error.name = 'AbortError';
      throw error;
    }
    return auth;
  }
}
