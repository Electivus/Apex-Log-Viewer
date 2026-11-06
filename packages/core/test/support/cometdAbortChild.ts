import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { createCometdTransport } from '../../src/customLogs/events/cometd.ts';
import { openConnection } from './salesforceDouble.ts';

/**
 * Run as `node --import tsx cometdAbortChild.ts <username> <channel> <abortOn>`, with the isolated
 * Salesforce home of the test that saved `username`. It opens a subscription and aborts it when
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
  const connection = await openConnection(username);
  const abort = new AbortController();
  let abortedAt: number | undefined;
  process.on('exit', () => {
    const drained = abortedAt === undefined ? 'never aborted' : String(Math.round(performance.now() - abortedAt));
    // Synchronous, because nothing asynchronous runs after `exit`.
    writeSync(1, `drained ${drained}\n`);
  });
  const stop = () => {
    console.log('aborting');
    abortedAt = performance.now();
    abort.abort();
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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
