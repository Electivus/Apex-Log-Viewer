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
