export type QueueWaitStats = {
  message: string;
  count: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
};

export type QueueWaitSummary = {
  total: number;
  byType: QueueWaitStats[];
};

const QUEUE_WAIT_LINE = /\] (?:\[trace\] )?(\w+): (\S+) waited (\d+) ms in the extension host queue/;

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

export function summarizeQueueWaits(outputLog: string): QueueWaitSummary {
  const waits = new Map<string, number[]>();
  for (const line of outputLog.split('\n')) {
    const match = QUEUE_WAIT_LINE.exec(line);
    if (!match) continue;
    const key = `${match[1]}: ${match[2]}`;
    waits.set(key, [...(waits.get(key) ?? []), Number(match[3])]);
  }
  const byType = [...waits.entries()]
    .map(([message, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        message,
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
        maxMs: sorted[sorted.length - 1]!
      };
    })
    .sort((a, b) => a.message.localeCompare(b.message));
  return { total: byType.reduce((sum, stats) => sum + stats.count, 0), byType };
}

export type RefreshCycleSummary = {
  count: number;
  foregroundP50Ms: number;
  foregroundMaxMs: number;
  clickToRowsP50Ms: number;
  clickToRowsMaxMs: number;
};

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/;
const REFRESH_WAIT_LINE = /\] (?:\[trace\] )?Logs: refresh waited (\d+) ms in the extension host queue/;
const ROWS_FETCHED_LINE = /\] Logs: fetched \d+ rows/;

function lineTime(line: string): number | undefined {
  const match = LOG_TIMESTAMP.exec(line);
  return match ? Date.parse(`${match[1]}T${match[2]}`) : undefined;
}

// Pairs each webview Refresh (its queue-wait line) with the next "Logs: fetched" line, so the host's own
// timestamps give the foreground refresh time without any test-only instrumentation.
export function summarizeRefreshCycles(outputLog: string): RefreshCycleSummary {
  const foreground: number[] = [];
  const clickToRows: number[] = [];
  let pending: { startedAt: number; waitMs: number } | undefined;
  for (const line of outputLog.split('\n')) {
    const startedAt = lineTime(line);
    if (startedAt === undefined) continue;
    const wait = REFRESH_WAIT_LINE.exec(line);
    if (wait) {
      pending = { startedAt, waitMs: Number(wait[1]) };
      continue;
    }
    if (pending && ROWS_FETCHED_LINE.test(line)) {
      foreground.push(startedAt - pending.startedAt);
      clickToRows.push(startedAt - pending.startedAt + pending.waitMs);
      pending = undefined;
    }
  }
  const sortedForeground = [...foreground].sort((a, b) => a - b);
  const sortedClickToRows = [...clickToRows].sort((a, b) => a - b);
  return {
    count: foreground.length,
    foregroundP50Ms: foreground.length ? percentile(sortedForeground, 0.5) : 0,
    foregroundMaxMs: sortedForeground[sortedForeground.length - 1] ?? 0,
    clickToRowsP50Ms: clickToRows.length ? percentile(sortedClickToRows, 0.5) : 0,
    clickToRowsMaxMs: sortedClickToRows[sortedClickToRows.length - 1] ?? 0
  };
}
