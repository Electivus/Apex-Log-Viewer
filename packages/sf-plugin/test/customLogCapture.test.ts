import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AlvError, type CaptureCallOptions } from '@alv/core';
import type {
  CustomLogCaptureParams,
  CustomLogCaptureResult,
  CustomLogCaptureState,
  CustomLogCaptureUpdate,
  CustomLogRow
} from '@alv/core/contracts';
import { Config } from '@oclif/core';

import CustomLogCapture from '../src/commands/electivus/custom-log/capture.ts';
import { core } from '../src/core.ts';
import { until, withStreams } from './support/streams.ts';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await Config.load({ root: pluginRoot });

const STORE = {
  state: 'notCaptured',
  eventsRoot: '/project/apexlogs/orgs/dev/events/App_Log__e',
  retentionDays: 30
} as const;

const resultOf = (over: Partial<CustomLogCaptureResult> = {}): CustomLogCaptureResult => ({
  source: { id: 'app-events', label: 'App events', shape: 'events' },
  outcome: 'quiet',
  delivered: 0,
  stored: 0,
  newGaps: [],
  store: STORE,
  ...over
});

const rowOf = (over: Partial<CustomLogRow>): CustomLogRow => ({
  id: 'e-0000000000-0000000000-00000000000000000000000000000000',
  time: '2026-10-30T12:00:01.123Z',
  extra: {},
  ...over
});

const updateOf = (
  capture: CustomLogCaptureState,
  over: Partial<CustomLogCaptureUpdate> = {}
): CustomLogCaptureUpdate => ({
  capture,
  store: STORE,
  rows: [],
  payloadFields: [],
  ...over
});

type Call = { params: CustomLogCaptureParams; options: CaptureCallOptions };

/** Replaces `core.customLog.capture`; every call is recorded, `behave` decides how the fake run goes. */
function fakeCore(behave: (call: Call) => Promise<CustomLogCaptureResult>): Call[] {
  const calls: Call[] = [];
  mock.method(core.customLog, 'capture', async (params: CustomLogCaptureParams, options: CaptureCallOptions = {}) => {
    const call = { params, options };
    calls.push(call);
    return behave(call);
  });
  return calls;
}

/** A fake run that stays up, reporting `updates`, until the caller's signal fires, like a follow run. */
const untilAborted =
  (updates: CustomLogCaptureUpdate[] = [], over: Partial<CustomLogCaptureResult> = {}) =>
  async ({ options }: Call): Promise<CustomLogCaptureResult> => {
    updates.forEach(update => options.onUpdate?.(update));
    await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return resultOf({ outcome: 'aborted', ...over });
  };

const command = (...argv: string[]) => new CustomLogCapture(['--source', 'app-events', ...argv], config);

/** `SfCommand` adds four signal handlers per `_run()`, so a test that runs many commands strips them. */
const resetSignals = (): void => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) process.removeAllListeners(signal);
};

test.afterEach(() => {
  mock.restoreAll();
  resetSignals();
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------------------------
// flags

test('a drain asks core for the stored position with the caller flags, in milliseconds', async () => {
  const calls = fakeCore(async () => resultOf());

  await withStreams(() => command('--target-org', 'dev', '--max-time', '20', '--initial', 'new', '--json').run());

  assert.deepEqual(calls[0]!.params, {
    targetOrg: 'dev',
    projectDir: process.cwd(),
    source: 'app-events',
    follow: false,
    initial: 'new',
    maxDurationMs: 20_000,
    filter: { minLevel: undefined, user: undefined }
  });
  assert.equal(calls[0]!.options.onUpdate, undefined, 'a drain streams nothing');
});

test('with no flag beyond the source it drains, replays what Salesforce retains and leaves the time bound to core', async () => {
  const calls = fakeCore(async () => resultOf());

  await withStreams(() => command('--json').run());

  const { params } = calls[0]!;
  assert.equal(params.follow, false);
  assert.equal(params.initial, 'retained');
  assert.equal(params.maxDurationMs, undefined, 'core owns the default bound');
  assert.equal(params.targetOrg, undefined);
});

test('--follow passes the print filters to core', async () => {
  const calls = fakeCore(async () => resultOf());

  await withStreams(() => command('--follow', '--min-level', 'WARN', '--user', 'dev@acme.com', '--json').run());

  assert.equal(calls[0]!.params.follow, true);
  assert.deepEqual(calls[0]!.params.filter, { minLevel: 'WARN', user: 'dev@acme.com' });
});

test('values the contract does not allow are refused before core is called', async () => {
  const calls = fakeCore(async () => resultOf());
  const refused = (argv: string[], message: RegExp) =>
    assert.rejects(new CustomLogCapture(argv, config).run(), message, argv.join(' '));

  await refused(['--json'], /source/i);
  await refused(['--source', 'x', '--max-time', '0'], /greater than or equal to 1/);
  await refused(['--source', 'x', '--max-time', '3601'], /less than or equal to 3600/);
  await refused(['--source', 'x', '--initial', 'none'], /Expected --initial=none to be one of/);
  await refused(['--source', 'x', '--follow', '--max-time', '30'], /cannot also be provided|exclusive/i);
  await refused(['--source', 'x', '--min-level', 'WARN'], /follow/i);
  await refused(['--source', 'x', '--user', 'dev@acme.com'], /follow/i);
  await refused(['--source', 'x', '--follow', '--min-level', 'LOUD'], /Expected --min-level=LOUD to be one of/);

  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// drain output

test('--json prints one document, the result, and nothing on stderr', async () => {
  const result = resultOf({ outcome: 'quiet', delivered: 412, stored: 412 });
  fakeCore(async () => result);

  const { out, err } = await withStreams(() => command('--json')._run());

  assert.deepEqual(JSON.parse(out), { status: 0, result, warnings: [] });
  assert.equal(err, '');
});

test('without --json a drain prints the result once on stdout', async () => {
  const result = resultOf({ outcome: 'budget', delivered: 5_003, stored: 4_980 });
  fakeCore(async () => result);

  const { value, out, err } = await withStreams(() => command().run());

  assert.deepEqual(JSON.parse(out), result);
  assert.equal(value, result);
  assert.equal(err, '');
});

test('every outcome of a finished run exits 0', async () => {
  for (const outcome of ['quiet', 'timeLimit', 'budget', 'aborted', 'capturedElsewhere', 'needsInitial'] as const) {
    fakeCore(async () => resultOf({ outcome }));

    const { out } = await withStreams(() => command('--json')._run());

    assert.equal(JSON.parse(out).result.outcome, outcome);
    assert.equal(process.exitCode ?? 0, 0, outcome);
    mock.restoreAll();
    resetSignals();
  }
});

// ---------------------------------------------------------------------------------------------
// follow output

test('--follow prints stored rows to stdout and everything else to stderr', async () => {
  const live: CustomLogCaptureState = { state: 'live', basis: 'quiet' };
  const allowance = { remaining: 22_000, max: 25_000, budget: 11_000 };
  const calls = fakeCore(
    untilAborted(
      [
        updateOf({ state: 'connecting' }),
        updateOf({ state: 'catchingUp', from: 'retained' }, { allowance }),
        updateOf(
          { state: 'catchingUp', from: 'retained' },
          {
            allowance,
            rows: [
              rowOf({ level: 'ERROR', user: 'integration@example.com', title: 'Order sync failed' }),
              rowOf({ time: '2026-10-30T12:00:02.000Z', title: 'line one\nline two  ' })
            ]
          }
        ),
        updateOf(live, {
          rows: [rowOf({ time: '2026-10-30T12:00:03.000Z', level: 'INFO', user: 'a@b.c', title: 'late' })]
        }),
        updateOf(live)
      ],
      { delivered: 3, stored: 3 }
    )
  );

  const { out, err } = await withStreams(async ({ out }) => {
    const running = command('--follow')._run();
    await until(() => out.length >= 3);
    process.emit('SIGINT');
    return running;
  });

  assert.equal(
    out,
    [
      '2026-10-30T12:00:01.123Z ERROR integration@example.com Order sync failed',
      '2026-10-30T12:00:02.000Z - - line one line two',
      '2026-10-30T12:00:03.000Z INFO a@b.c late',
      ''
    ].join('\n')
  );
  assert.deepEqual(err.split('\n'), [
    'Connecting.',
    'Replaying the events Salesforce still retains.',
    'The org has 22000 of 25000 daily event deliveries left. This run stops after about 11000 deliveries.',
    'Live. The stream went quiet, so the backlog is probably done; Salesforce sends no end marker.',
    'Stopping. Press Ctrl-C again to quit now.',
    `Delivered 3, stored 3. Store: ${STORE.eventsRoot}`,
    ''
  ]);
  assert.equal(calls[0]!.params.follow, true);
});

test('--follow with --json keeps stdout and stderr for the result alone', async () => {
  const calls = fakeCore(
    untilAborted([updateOf({ state: 'connecting' }), updateOf({ state: 'live', basis: 'quiet' })])
  );

  const { out, err } = await withStreams(async () => {
    const running = command('--follow', '--json')._run();
    await until(() => calls.length === 1);
    process.emit('SIGINT');
    return running;
  });

  assert.equal(calls[0]!.options.onUpdate, undefined);
  assert.equal(JSON.parse(out).result.outcome, 'aborted');
  assert.equal(err, '');
});

test('a gap the run created is listed at the end of a follow run', async () => {
  const calls = fakeCore(
    untilAborted([], {
      newGaps: [
        {
          reason: 'cursorRejected',
          after: '2026-10-21T18:02:11.000Z',
          before: '2026-10-25T09:40:02.554Z',
          detectedAt: '2026-10-28T08:00:01.002Z'
        },
        { reason: 'retentionElapsed', after: '2026-10-29T00:00:00.000Z', detectedAt: '2026-10-30T00:00:00.000Z' }
      ]
    })
  );

  const { err } = await withStreams(async () => {
    const running = command('--follow')._run();
    await until(() => calls.length === 1);
    process.emit('SIGINT');
    return running;
  });

  assert.match(
    err,
    /Events between 2026-10-21T18:02:11.000Z and 2026-10-25T09:40:02.554Z may be missing \(cursorRejected\)\./
  );
  assert.match(err, /Events after 2026-10-29T00:00:00.000Z may be missing \(retentionElapsed\)\./);
});

test('a standby state names the process that holds the capture', async () => {
  const calls = fakeCore(
    untilAborted([
      updateOf({
        state: 'standby',
        holder: { surface: 'vscode', pid: 4242, host: 'laptop', since: '2026-10-30T10:00:00.000Z' }
      })
    ])
  );

  const { err } = await withStreams(async () => {
    const running = command('--follow')._run();
    await until(() => calls.length === 1);
    process.emit('SIGINT');
    return running;
  });

  assert.match(err, /Another vscode process \(pid 4242 on laptop\) is capturing this source/);
});

// ---------------------------------------------------------------------------------------------
// SIGINT

test('SIGINT aborts the run and ends with the aborted result, exit 0, instead of the exit 130 that SfCommand installs', async () => {
  const calls = fakeCore(untilAborted([], { delivered: 7, stored: 7 }));

  const { out } = await withStreams(async () => {
    const running = command('--follow', '--json')._run();
    await until(() => calls.length === 1);
    assert.equal(calls[0]!.options.signal?.aborted, false, 'the run is still going');
    assert.equal(process.listenerCount('SIGINT'), 1, 'ours is the only handler, so SfCommand cannot exit 130 first');
    process.emit('SIGINT');
    return running;
  });

  assert.equal(calls[0]!.options.signal?.aborted, true);
  assert.deepEqual(JSON.parse(out).result, resultOf({ outcome: 'aborted', delivered: 7, stored: 7 }));
  assert.equal(process.exitCode ?? 0, 0);
});

test('a second Ctrl-C quits at once with 130', async () => {
  const exit = mock.method(process, 'exit', ((code?: number) => code) as typeof process.exit);
  const calls = fakeCore(untilAborted());

  await withStreams(async () => {
    const running = command('--follow', '--json')._run();
    await until(() => calls.length === 1);
    process.emit('SIGINT');
    assert.equal(exit.mock.callCount(), 0, 'the first Ctrl-C only asks the run to stop');
    process.emit('SIGINT');
    return running;
  });

  assert.deepEqual(
    exit.mock.calls.map(call => call.arguments),
    [[130]]
  );
});

test('SIGINT also ends a drain with the aborted result', async () => {
  const calls = fakeCore(untilAborted());

  const { out } = await withStreams(async () => {
    const running = command('--json')._run();
    await until(() => calls.length === 1);
    process.emit('SIGINT');
    return running;
  });

  assert.equal(JSON.parse(out).result.outcome, 'aborted');
});

test('a closed stdout aborts the run instead of crashing it', async () => {
  const calls = fakeCore(untilAborted());
  const runner = process.stdout.listeners('error');
  process.stdout.removeAllListeners('error');

  try {
    const { value } = await withStreams(async () => {
      const running = command('--follow')._run();
      await until(() => calls.length === 1);
      assert.equal(process.stdout.listenerCount('error'), 1, 'the command listens for EPIPE');
      process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      return running;
    });

    assert.equal(calls[0]!.options.signal?.aborted, true);
    assert.equal(value.outcome, 'aborted');
    assert.equal(process.stdout.listenerCount('error'), 0, 'the listener is removed');
  } finally {
    for (const listener of runner) process.stdout.on('error', listener);
  }
});

// ---------------------------------------------------------------------------------------------
// rejections

const REJECTIONS = [
  ['INVALID_ARGUMENT', false],
  ['CUSTOM_LOG_SOURCE_NOT_FOUND', true],
  ['CUSTOM_LOG_NOT_EVENT_SOURCE', true],
  ['CUSTOM_LOG_SOURCE_UNAVAILABLE', true],
  ['CUSTOM_LOG_UNSUPPORTED_FILTER', true],
  ['CUSTOM_LOG_STORE_UNAVAILABLE', true],
  ['CUSTOM_LOG_DELIVERY_LIMIT', true],
  ['CUSTOM_LOG_CLIENT_LIMIT', true],
  ['CUSTOM_LOG_SUBSCRIBE_FORBIDDEN', true],
  ['CUSTOM_LOG_CAPTURE_FAILED', true]
] as const;

test('every rejection exits 1, names its code and, with --json, prints one error document', async () => {
  for (const [code, hasNextSteps] of REJECTIONS) {
    fakeCore(async () => {
      throw new AlvError(code, `core says ${code}`);
    });

    const { value, out, err } = await withStreams(async () => {
      try {
        await command('--json')._run();
      } catch (error) {
        return error as Error & { exitCode: number; code: string; actions?: string[] };
      }
      throw new assert.AssertionError({ message: `${code} did not reject` });
    });

    assert.equal(value.exitCode, 1, code);
    assert.equal(process.exitCode, 1, code);
    assert.equal(value.name, code);
    assert.equal(value.code, code);
    assert.equal(value.message, `core says ${code}`);
    assert.equal((value.actions?.length ?? 0) > 0, hasNextSteps, code);
    const document = JSON.parse(out);
    assert.equal(document.status, 1, code);
    assert.equal(document.name, code);
    assert.equal(document.message, `core says ${code}`);
    assert.deepEqual(document.actions, value.actions);
    assert.equal(err, '');
    mock.restoreAll();
    resetSignals();
    process.exitCode = undefined;
  }
});

test('without --json a rejection prints its message and next steps on stderr, and nothing on stdout', async () => {
  fakeCore(async () => {
    throw new AlvError('CUSTOM_LOG_SUBSCRIBE_FORBIDDEN', '403::Restricted channel');
  });

  const { out, err } = await withStreams(async () => {
    await assert.rejects(command()._run(), { exitCode: 1 });
  });

  assert.equal(out, '');
  assert.match(err, /403::Restricted channel/);
  assert.match(err, /needs Read access to the platform event/);
});

test('a failed state is not printed twice: the rejection carries it', async () => {
  fakeCore(async ({ options }) => {
    options.onUpdate?.(updateOf({ state: 'failed', code: 'CUSTOM_LOG_DELIVERY_LIMIT', message: '403::daily limit' }));
    throw new AlvError('CUSTOM_LOG_DELIVERY_LIMIT', '403::daily limit');
  });

  const { err } = await withStreams(async () => {
    await assert.rejects(command('--follow')._run(), { exitCode: 1 });
  });

  assert.equal(err.split('403::daily limit').length - 1, 1, 'the message appears once');
});

test('an error from outside the capture contract passes through with its own name', async () => {
  fakeCore(async () => {
    throw new Error('socket hang up');
  });

  const { value } = await withStreams(async () => {
    try {
      await command('--json')._run();
    } catch (error) {
      return error as Error & { exitCode: number };
    }
    throw new assert.AssertionError({ message: 'did not reject' });
  });

  assert.equal(value.exitCode, 1);
  assert.equal(value.name, 'Error');
  assert.equal(value.message, 'socket hang up');
});
