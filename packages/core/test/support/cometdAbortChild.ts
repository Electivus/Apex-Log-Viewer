import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createCometdTransport } from '../../src/customLogs/events/cometd.ts';
import { COMETD_ABORT_TRACE_PREFIX, cometdAbortMark } from './cometdAbortTrace.ts';
import { loadSavedOrgs, openConnection } from './salesforceDouble.ts';

/**
 * Run as `node --import tsx cometdAbortChild.ts <username> <channel> <abortOn>`, with `savedOrgsEnv()`
 * of the test that saved `username`. It opens a subscription and aborts it when
 * `abortOn` happens: `start` (30 ms in, before the handshake reply), `down` (the transport reported
 * the connection lost) or `offline` (the same, 200 ms later, after printing `down` so the parent can
 * stop the server). The process exits by itself only when the adapter left no socket or timer
 * behind. Node emits `exit` once the event loop is empty, so the child prints `drained <ms>`, the
 * monotonic time from the abort to that moment, and the parent test checks it. Process teardown and
 * the pipe to the parent, which a loaded Windows runner can stretch past a second, are not counted.
 */
const ABORT_ON = ['start', 'down', 'offline'] as const;

async function main(): Promise<void> {
  const [username, channel, abortOn] = process.argv.slice(2);
  if (!username || !channel || !ABORT_ON.some(mode => mode === abortOn)) {
    throw new Error(`usage: cometdAbortChild.ts <username> <channel> <${ABORT_ON.join('|')}>`);
  }
  loadSavedOrgs();
  const connection = openConnection(username);
  const abort = new AbortController();
  const trace = process.env.ALV_COMETD_ABORT_TRACE_DIR
    ? (mark: ReturnType<typeof cometdAbortMark>) =>
        writeSync(1, COMETD_ABORT_TRACE_PREFIX + JSON.stringify(mark) + '\n')
    : undefined;
  if (trace) {
    type BayeuxMessage = { id?: string; channel?: string; successful?: boolean };
    const streaming = connection.streaming;
    const createClient = streaming.createClient.bind(streaming);
    streaming.createClient = (extensions = []) =>
      createClient([
        ...extensions,
        {
          outgoing(message: BayeuxMessage, next: (message: BayeuxMessage) => void) {
            if (message.channel === '/meta/disconnect') {
              trace(cometdAbortMark('disconnect-sent', { messageId: message.id }));
            }
            next(message);
          },
          incoming(message: BayeuxMessage, next: (message: BayeuxMessage) => void) {
            if (message.successful && message.channel === '/meta/disconnect') {
              trace(cometdAbortMark('ack-received', { messageId: message.id }));
            }
            if (message.successful && message.channel === '/meta/handshake') {
              trace(cometdAbortMark('handshake-received', { messageId: message.id }));
            }
            next(message);
          }
        }
      ]);
  }
  let abortedAt: number | undefined;
  process.on('exit', () => {
    const drained = abortedAt === undefined ? 'never aborted' : String(Math.round(performance.now() - abortedAt));
    trace?.(cometdAbortMark('child-exit'));
    // Synchronous, because nothing asynchronous runs after `exit`.
    writeSync(1, `drained ${drained}\n`);
  });
  const stop = () => {
    console.log('aborting');
    abortedAt = performance.now();
    const mark = trace ? cometdAbortMark('abort') : undefined;
    abort.abort();
    if (mark) trace?.(mark);
  };
  const finished = createCometdTransport().open({
    connection,
    channel,
    from: { kind: 'new' },
    durableCursor: () => undefined,
    signal: abort.signal,
    onSignal: signal => {
      if (signal.type !== 'down') return;
      if (abortOn === 'down') stop();
      if (abortOn === 'offline') {
        console.log('down');
        setTimeout(stop, 200);
      }
    }
  });
  if (abortOn === 'start') setTimeout(stop, 30);
  await finished;
  trace?.(cometdAbortMark('transport-resolved', { activeResources: process.getActiveResourcesInfo() }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
