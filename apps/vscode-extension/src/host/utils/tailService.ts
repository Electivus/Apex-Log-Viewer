import { getEffectiveApiVersion } from '../salesforce/http';
import { ensureUserTraceFlag } from '../salesforce/traceflags';
import type { OrgAuth } from '../salesforce/types';
import type { ExtensionToWebviewMessage } from '../../shared/messages';
import { runtimeClient } from '../../runtime/runtimeClient';
import { logInfo, logWarn, logError, showOutput } from './logger';
import { localize } from './localize';
import { getErrorMessage } from './error';
import { getWorkspaceRoot } from './workspace';
import {
  createConnectionFromAuth,
  createLoggingStreamingClient,
  type Connection,
  type StreamProcessor,
  type StreamingClient
} from '../salesforce/streaming';
import type { ReadApexLogResult } from '@alv/core';
import type { ApexLogRow } from '../../shared/types';

/**
 * Handles Apex log tailing mechanics independent of the webview.
 */
export const DEFAULT_TAIL_BUFFER_LINES = 10000;
export const MIN_TAIL_BUFFER_LINES = 1000;
export const MAX_TAIL_BUFFER_LINES = 200000;

const SUBSCRIBE_ACK_TIMEOUT_SECONDS = 30;

type TailRun = { subscribed: boolean };

export class TailService {
  private run: TailRun | undefined;
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
    return this.run?.subscribed === true;
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
    if (this.run) {
      logInfo('Tail: start requested but already running.');
      return;
    }
    if (!debugLevel) {
      this.post({ type: 'error', message: localize('tailSelectDebugLevel', 'Select a debug level') });
      logWarn('Tail: start aborted; no debug level selected.');
      return;
    }
    const run: TailRun = { subscribed: false };
    this.run = run;
    const current = () => this.run === run && !this.disposed;
    const startedAtMs = Date.now();
    this.seenLogIds.clear();
    this.logIdToPath.clear();
    this.currentDebugLevel = debugLevel;
    try {
      const auth = await this.getOrgAuth();
      if (!current()) {
        logWarn('Tail: start aborted while awaiting auth');
        return;
      }
      this.currentAuth = auth;
      logInfo('Tail: acquired auth for', auth.username || '(default)', 'at', auth.instanceUrl);

      const primed = await this.primeSeenLogs(auth, startedAtMs);
      if (!current()) {
        logWarn('Tail: start aborted after priming');
        return;
      }

      try {
        // Ensure a TraceFlag of the default log type (DEVELOPER_LOG), updating the existing one if present
        const created = await ensureUserTraceFlag(auth, debugLevel);
        if (created) {
          logInfo('Tail: TraceFlag created for user with level', debugLevel);
        } else {
          logInfo('Tail: TraceFlag updated or already matching for level', debugLevel);
        }
      } catch (e) {
        logWarn('Tail: ensure TraceFlag failed (continuing) ->', getErrorMessage(e));
      }

      this.connection = await this.getActiveConnection(auth);
      const client = await createLoggingStreamingClient(this.connection, message => this.onStreamMessage(message));
      if (!current()) {
        client.disconnect();
        logWarn('Tail: start aborted before subscribing');
        return;
      }
      this.streamingClient = client;
      logInfo('Tail: subscribing to /systemTopic/Logging…');
      await this.waitForSubscription(client);
      if (!current()) {
        return;
      }

      run.subscribed = true;
      this.post({ type: 'tailStatus', running: true });
      logInfo('Tail: subscribed to /systemTopic/Logging');
      this.tailHardStopTimer = setTimeout(
        () => {
          logInfo('Tail: auto-stopping after 30 minutes.');
          this.post({ type: 'error', message: localize('tailHardStop', 'Tail stopped after 30 minutes.') });
          this.stop();
        },
        30 * 60 * 1000
      );
      if (primed) {
        void this.backfillStartWindow(run, auth);
      }
    } catch (e) {
      const msg = getErrorMessage(e);
      if (!current()) {
        logInfo('Tail: start abandoned after stop ->', msg);
        return;
      }
      logError('Tail: start failed ->', msg);
      this.post({ type: 'error', message: msg });
      showOutput(true);
      this.stop();
    }
  }

  private async primeSeenLogs(auth: OrgAuth, startedAtMs: number): Promise<boolean> {
    try {
      const recent = await this.listRecentLogs(auth);
      const primedAtMs = Date.now();
      // ApexLog.StartTime has whole seconds.
      const startedAtSecondMs = startedAtMs - (startedAtMs % 1000);
      for (const { Id, StartTime } of recent) {
        const startMs = Date.parse(StartTime);
        const landedInStartWindow = startMs >= startedAtSecondMs && startMs <= primedAtMs;
        if (!landedInStartWindow) {
          this.seenLogIds.add(Id);
        }
      }
      logInfo('Tail: primed seen set with', this.seenLogIds.size, 'of', recent.length, 'recent logs');
      return true;
    } catch {
      logWarn('Tail: prime recent logs failed; proceeding with empty seen set');
      return false;
    }
  }

  private listRecentLogs(auth: OrgAuth): Promise<ApexLogRow[]> {
    return runtimeClient.logsList({ username: this.selectedOrg ?? auth.username, limit: 20 });
  }

  private async waitForSubscription(client: StreamingClient): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              localize(
                'tailSubscribeTimeout',
                'Salesforce did not acknowledge the log subscription within {0} seconds.',
                SUBSCRIBE_ACK_TIMEOUT_SECONDS
              )
            )
          ),
        SUBSCRIBE_ACK_TIMEOUT_SECONDS * 1000
      );
    });
    try {
      await client.handshake();
      client.replay(-1);
      await Promise.race([client.subscribeAndAwaitAck(), timedOut]);
    } catch (e) {
      throw new Error(`Subscribe failed: ${getErrorMessage(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private onStreamMessage(message: Record<string, unknown>): void {
    const id = (message as { sobject?: { Id?: string } }).sobject?.Id;
    if (id && !this.seenLogIds.has(id)) {
      void this.handleIncomingLogId(id);
    }
  }

  /** Salesforce can skip a log that landed before the subscription went live, so list those once it is live. */
  private async backfillStartWindow(run: TailRun, auth: OrgAuth): Promise<void> {
    try {
      const recent = await this.listRecentLogs(auth);
      for (const { Id } of recent.reverse()) {
        if (this.run !== run) {
          return;
        }
        if (!this.seenLogIds.has(Id)) {
          logInfo('Tail: backfilling log', Id);
          await this.handleIncomingLogId(Id);
        }
      }
    } catch (e) {
      logWarn('Tail: backfill failed ->', getErrorMessage(e));
    }
  }

  stop(): void {
    this.run = undefined;
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
    if (!this.run || this.disposed) {
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
        workspaceRoot: getWorkspaceRoot(),
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
    const local = await runtimeClient.requireLocalLogPath(
      { logId, targetOrg: this.selectedOrg, workspaceRoot: getWorkspaceRoot() },
      signal
    );
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
