export const COMETD_ABORT_TRACE_PREFIX = 'cometd-abort-trace ';

export type CometdAbortMark = {
  stage:
    | 'abort'
    | 'handshake-received'
    | 'disconnect-sent'
    | 'disconnect-received'
    | 'ack-sent'
    | 'ack-received'
    | 'transport-resolved'
    | 'child-exit'
    | 'child-close';
  monotonicNs: string;
  messageId?: string;
  activeResources?: string[];
};

export function cometdAbortMark(
  stage: CometdAbortMark['stage'],
  details?: Omit<CometdAbortMark, 'stage' | 'monotonicNs'>
): CometdAbortMark {
  return { stage, monotonicNs: process.hrtime.bigint().toString(), ...details };
}
