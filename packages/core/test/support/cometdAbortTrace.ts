import { monitorEventLoopDelay } from 'node:perf_hooks';

export const COMETD_ABORT_TRACE_PREFIX = 'cometd-abort-trace ';

export type CometdAbortMark = {
  /** `child:sent:<channel>`, `child:received:<channel>`, `double:received:<channel>`, `double:replied:<channel>` or a lifecycle stage. */
  stage: string;
  monotonicNs: string;
  messageId?: string;
  activeResources?: string[];
  /** Largest event-loop delay seen so far in the process that wrote the mark, in ms. */
  maxLoopDelayMs?: number;
};

const loopDelay = process.env.ALV_COMETD_ABORT_TRACE_DIR ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
loopDelay?.enable();

/** Starts the largest-delay count again, so one scenario's mark does not carry an earlier one's stall. */
export function resetLoopDelay(): void {
  loopDelay?.reset();
}

export function cometdAbortMark(
  stage: string,
  details?: Omit<CometdAbortMark, 'stage' | 'monotonicNs'>
): CometdAbortMark {
  return {
    stage,
    monotonicNs: process.hrtime.bigint().toString(),
    ...(loopDelay ? { maxLoopDelayMs: Math.round(loopDelay.max / 1e6) } : {}),
    ...details
  };
}
