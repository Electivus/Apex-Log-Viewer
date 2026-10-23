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

export type RefreshCycleSummary = {
  count: number;
  foregroundP50Ms: number;
  foregroundMaxMs: number;
  clickToRowsP50Ms: number;
  clickToRowsMaxMs: number;
};

const QUEUE_WAIT_LINE = /\] (?:\[trace\] )?(\w+): (\S+) waited (\d+) ms in the extension host queue/;
const REFRESH_WAIT_LINE = /\] (?:\[trace\] )?Logs: refresh waited (\d+) ms in the extension host queue/;
const ROWS_FETCHED_LINE = /\] Logs: fetched \d+ rows/;
const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3})/;

// Same nearest-rank rule as the host.responsiveness telemetry, so lab and field percentiles agree.
function nearestRank(sortedValues: readonly number[], percentile: number): number {
  return sortedValues[Math.ceil((percentile / 100) * sortedValues.length) - 1] ?? 0;
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
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
      const ordered = sorted(values);
      return {
        message,
        count: ordered.length,
        p50Ms: nearestRank(ordered, 50),
        p90Ms: nearestRank(ordered, 90),
        maxMs: ordered[ordered.length - 1] ?? 0
      };
    })
    .sort((a, b) => a.message.localeCompare(b.message));
  return { total: byType.reduce((sum, stats) => sum + stats.count, 0), byType };
}

function lineTime(line: string): number | undefined {
  const match = LOG_TIMESTAMP.exec(line);
  return match ? Date.parse(`${match[1]}T${match[2]}`) : undefined;
}

// VS Code's main process stamps each Output line when it arrives, so both ends of a pair cross the same
// IPC hops. The provider logs "fetched" for every refresh, superseded ones included, so pairs are FIFO.
export function summarizeRefreshCycles(outputLog: string): RefreshCycleSummary {
  const foreground: number[] = [];
  const clickToRows: number[] = [];
  const pending: Array<{ startedAt: number; waitMs: number }> = [];
  for (const line of outputLog.split('\n')) {
    const at = lineTime(line);
    if (at === undefined) continue;
    const wait = REFRESH_WAIT_LINE.exec(line);
    if (wait) {
      pending.push({ startedAt: at, waitMs: Number(wait[1]) });
      continue;
    }
    if (!ROWS_FETCHED_LINE.test(line)) continue;
    const started = pending.shift();
    if (!started) continue;
    foreground.push(at - started.startedAt);
    clickToRows.push(at - started.startedAt + started.waitMs);
  }
  const orderedForeground = sorted(foreground);
  const orderedClickToRows = sorted(clickToRows);
  return {
    count: foreground.length,
    foregroundP50Ms: nearestRank(orderedForeground, 50),
    foregroundMaxMs: orderedForeground[orderedForeground.length - 1] ?? 0,
    clickToRowsP50Ms: nearestRank(orderedClickToRows, 50),
    clickToRowsMaxMs: orderedClickToRows[orderedClickToRows.length - 1] ?? 0
  };
}
