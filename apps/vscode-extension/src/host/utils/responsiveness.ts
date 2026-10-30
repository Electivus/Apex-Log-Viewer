import * as vscode from 'vscode';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { CustomLogViewerFromWebviewMessage } from '../../shared/customLogViewerMessages';
import type { CustomLogsFromWebviewMessage } from '../../shared/customLogsMessages';
import type { DebugFlagsFromWebviewMessage } from '../../shared/debugFlagsMessages';
import type { LogViewerFromWebviewMessage } from '../../shared/logViewerMessages';
import { parseMessageSentAt, type WebviewToExtensionMessage } from '../../shared/messages';
import { safeSendEvent } from '../../shared/telemetry';
import { logInfo, logTrace } from './logger';

type LoopDelayHistogram = ReturnType<typeof monitorEventLoopDelay>;

export type ResponsivenessSurface = 'logs' | 'tail' | 'logViewer' | 'debugFlags' | 'customLogs' | 'customLogViewer';

export type HostResponsivenessMeasurements = {
  windowMs: number;
  messageCount: number;
  waitP50Ms: number;
  waitP90Ms: number;
  waitMaxMs: number;
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
};

export interface ResponsivenessEnvironment {
  now(): number;
  loopDelay: Pick<LoopDelayHistogram, 'percentile' | 'max' | 'reset'>;
  send(measurements: HostResponsivenessMeasurements): void;
}

export interface ResponsivenessMonitor {
  record(surface: ResponsivenessSurface, raw: unknown): void;
  flush(): void;
}

const WINDOW_MS = 5 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;
const MAX_WAIT_SAMPLES = 1000;
const INFO_WAIT_MS = 250;
const LOOP_DELAY_RESOLUTION_MS = 20;

const SURFACE_LABELS: Record<ResponsivenessSurface, string> = {
  logs: 'Logs',
  tail: 'Tail',
  logViewer: 'LogViewer',
  debugFlags: 'DebugFlags',
  customLogs: 'CustomLogs',
  customLogViewer: 'CustomLogViewer'
};

type InboundMessageType =
  | WebviewToExtensionMessage['type']
  | LogViewerFromWebviewMessage['type']
  | DebugFlagsFromWebviewMessage['type']
  | CustomLogsFromWebviewMessage['type']
  | CustomLogViewerFromWebviewMessage['type'];

const INBOUND_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    ready: true,
    refresh: true,
    downloadAllLogs: true,
    clearLogs: true,
    selectOrg: true,
    openDebugFlags: true,
    openLog: true,
    replay: true,
    loadMore: true,
    searchQuery: true,
    trackLogsSearch: true,
    trackLogsFilter: true,
    setLogsColumns: true,
    tailStart: true,
    tailStop: true,
    tailClear: true,
    logViewerReady: true,
    logViewerViewRaw: true,
    logViewerCopyText: true,
    debugFlagsReady: true,
    debugFlagsSelectOrg: true,
    debugFlagsSearchUsers: true,
    debugFlagsSelectTarget: true,
    debugFlagsApply: true,
    debugFlagsManagerSave: true,
    debugFlagsManagerDelete: true,
    debugFlagsRemove: true,
    debugFlagsClearLogs: true,
    customLogsReady: true,
    customLogsSelectOrg: true,
    customLogsSelectSource: true,
    customLogsSetFilter: true,
    customLogsRefresh: true,
    customLogsLoadMore: true,
    customLogsOpenLog: true,
    customLogsOpenPayload: true,
    customLogsSetPayloadColumns: true,
    customLogsOpenConfig: true,
    customLogsOpenEditor: true,
    customLogViewerReady: true,
    customLogViewerRefresh: true,
    customLogViewerLoadMoreEntries: true,
    customLogViewerOpenEntry: true,
    customLogViewerOpenField: true,
    customLogViewerCopyField: true,
    customLogViewerOpenApexLog: true,
    customLogViewerSetPayloadColumns: true,
    customLogViewerCopyText: true
  } satisfies Record<InboundMessageType, true>)
);

function inboundMessageType(raw: unknown): string {
  const type = typeof raw === 'object' && raw !== null && 'type' in raw ? raw.type : undefined;
  return typeof type === 'string' && INBOUND_MESSAGE_TYPES.has(type) ? type : 'unknown';
}

function nearestRank(sortedValues: readonly number[], percentile: number): number {
  return sortedValues[Math.ceil((percentile / 100) * sortedValues.length) - 1] ?? 0;
}

// The histogram records whole timer intervals, so an idle loop reads as the resolution; report only the lateness.
function loopLagMs(intervalNs: number): number {
  return Math.max(0, Math.round(intervalNs / 1_000_000 - LOOP_DELAY_RESOLUTION_MS));
}

export function createResponsivenessMonitor(env: ResponsivenessEnvironment): ResponsivenessMonitor {
  let windowStart = env.now();
  let messageCount = 0;
  let waitMaxMs = 0;
  let waitSamplesMs: number[] = [];

  return {
    record(surface, raw) {
      const sentAt = parseMessageSentAt(raw);
      if (sentAt === undefined) {
        return;
      }
      const waitMs = env.now() - sentAt;
      if (waitMs < 0 || waitMs > MAX_WAIT_MS) {
        return;
      }
      messageCount += 1;
      waitMaxMs = Math.max(waitMaxMs, waitMs);
      if (waitSamplesMs.length < MAX_WAIT_SAMPLES) {
        waitSamplesMs.push(waitMs);
      }
      const line = `${SURFACE_LABELS[surface]}: ${inboundMessageType(raw)} waited ${waitMs} ms in the extension host queue`;
      if (waitMs >= INFO_WAIT_MS) {
        logInfo(line);
      } else {
        logTrace(line);
      }
    },
    flush() {
      const now = env.now();
      if (messageCount > 0) {
        waitSamplesMs.sort((left, right) => left - right);
        env.send({
          windowMs: now - windowStart,
          messageCount,
          waitP50Ms: nearestRank(waitSamplesMs, 50),
          waitP90Ms: nearestRank(waitSamplesMs, 90),
          waitMaxMs,
          loopP50Ms: loopLagMs(env.loopDelay.percentile(50)),
          loopP99Ms: loopLagMs(env.loopDelay.percentile(99)),
          loopMaxMs: loopLagMs(env.loopDelay.max)
        });
      }
      env.loopDelay.reset();
      windowStart = now;
      messageCount = 0;
      waitMaxMs = 0;
      waitSamplesMs = [];
    }
  };
}

let active:
  { monitor: ResponsivenessMonitor; loopDelay: LoopDelayHistogram; timer: ReturnType<typeof setInterval> } | undefined;

export function startResponsivenessMonitor(): void {
  // Webview and host stamps are only comparable when both read the same machine's clock.
  if (active || vscode.env.remoteName !== undefined || vscode.env.uiKind !== vscode.UIKind.Desktop) {
    return;
  }
  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  loopDelay.enable();
  const monitor = createResponsivenessMonitor({
    now: () => Date.now(),
    loopDelay,
    send: measurements => safeSendEvent('host.responsiveness', { outcome: 'ok' }, measurements)
  });
  const timer = setInterval(() => monitor.flush(), WINDOW_MS);
  timer.unref();
  active = { monitor, loopDelay, timer };
}

export function stopResponsivenessMonitor(): void {
  if (!active) {
    return;
  }
  clearInterval(active.timer);
  active.monitor.flush();
  active.loopDelay.disable();
  active = undefined;
}

export function recordInboundMessage(surface: ResponsivenessSurface, raw: unknown): void {
  active?.monitor.record(surface, raw);
}
