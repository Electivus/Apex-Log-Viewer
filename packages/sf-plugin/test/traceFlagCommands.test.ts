import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';
import type { TraceFlagTargetStatus } from '@alv/core/contracts';

import TraceFlagApply from '../src/commands/electivus/trace-flag/apply.ts';
import TraceFlagRemove from '../src/commands/electivus/trace-flag/remove.ts';
import TraceFlagStatus from '../src/commands/electivus/trace-flag/status.ts';
import { core } from '../src/core.ts';
import { withStreams } from './support/streams.ts';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await Config.load({ root: pluginRoot });

type Capture = { params?: Record<string, unknown> };

function stub(method: 'status' | 'apply' | 'remove'): Capture {
  const capture: Capture = {};
  mock.method(core.traceFlag, method, async (params: Record<string, unknown>) => {
    capture.params = params;
    return { logType: params.logType };
  });
  return capture;
}

const commands = [
  { method: 'status', run: (argv: string[]) => new TraceFlagStatus(argv, config).run() },
  {
    method: 'apply',
    run: (argv: string[]) => new TraceFlagApply(['--debug-level', 'ALV_DEBUG', ...argv], config).run()
  },
  { method: 'remove', run: (argv: string[]) => new TraceFlagRemove(argv, config).run() }
] as const;

test.afterEach(() => mock.restoreAll());

test('trace-flag status, apply and remove default to DEVELOPER_LOG trace flags', async () => {
  for (const command of commands) {
    const capture = stub(command.method);

    await command.run(['--target-org', 'acme-dev', '--current-user', '--json']);

    assert.equal(capture.params?.logType, 'DEVELOPER_LOG', command.method);
  }
});

test('trace-flag status, apply and remove pass --log-type USER_DEBUG to core', async () => {
  for (const command of commands) {
    const capture = stub(command.method);

    await command.run(['--target-org', 'acme-dev', '--current-user', '--log-type', 'USER_DEBUG', '--json']);

    assert.equal(capture.params?.logType, 'USER_DEBUG', command.method);
  }
});

test('trace-flag commands reject a log type Salesforce does not define', async () => {
  for (const command of commands) {
    const capture = stub(command.method);

    await assert.rejects(
      command.run(['--target-org', 'acme-dev', '--current-user', '--log-type', 'SYSTEM_LOG']),
      /DEVELOPER_LOG, USER_DEBUG/
    );
    assert.equal(capture.params, undefined, command.method);
  }
});

const USER = { type: 'user', userId: '005000000000001AAA' } as const;
const PLATFORM_INTEGRATION = { type: 'platformIntegration' } as const;

const statusOf = (over: Partial<TraceFlagTargetStatus>): TraceFlagTargetStatus => ({
  target: USER,
  logType: 'DEVELOPER_LOG',
  targetLabel: 'Ada Lovelace',
  targetAvailable: true,
  isActive: false,
  resolvedTargetCount: 1,
  activeTargetCount: 0,
  ...over
});

const activeDeveloperLog = {
  logType: 'DEVELOPER_LOG',
  isActive: true,
  activeTargetCount: 1,
  expirationDate: '2098-06-01T12:00:00.000+0000'
} as const;
const activeUserDebug = {
  logType: 'USER_DEBUG',
  isActive: true,
  activeTargetCount: 1,
  expirationDate: '2099-01-01T00:00:00.000+0000'
} as const;

async function statusWarnings(status: TraceFlagTargetStatus): Promise<unknown> {
  const stubbed = mock.method(core.traceFlag, 'status', async () => status);
  try {
    const { out } = await withStreams(() =>
      new TraceFlagStatus(['--target-org', 'acme-dev', '--log-type', status.logType, '--json'], config)._run()
    );
    return JSON.parse(out).warnings;
  } finally {
    stubbed.mock.restore();
  }
}

test('trace-flag status warns in --json when an active DEVELOPER_LOG flag sets the level of a USER_DEBUG target', async () => {
  assert.deepEqual(
    await statusWarnings(statusOf({ logType: 'USER_DEBUG', isActive: true, otherLogType: activeDeveloperLog })),
    [
      "A DEVELOPER_LOG trace flag is also active on this target until 2098-06-01T12:00:00.000+0000. Salesforce writes each transaction's log at that flag's debug level, so the USER_DEBUG level does not apply until then."
    ]
  );
  assert.deepEqual(
    await statusWarnings(
      statusOf({
        target: PLATFORM_INTEGRATION,
        logType: 'USER_DEBUG',
        resolvedTargetCount: 2,
        otherLogType: activeDeveloperLog
      })
    ),
    [
      "A DEVELOPER_LOG trace flag is also active on 1 of 2 matched targets until 2098-06-01T12:00:00.000+0000. Salesforce writes each transaction's log at that flag's debug level, so the USER_DEBUG level does not apply until then."
    ]
  );
});

test('trace-flag status warns in --json when only a USER_DEBUG flag is active on a DEVELOPER_LOG target', async () => {
  assert.deepEqual(await statusWarnings(statusOf({ otherLogType: activeUserDebug })), [
    'No active DEVELOPER_LOG trace flag, but a USER_DEBUG trace flag is active on this target until 2099-01-01T00:00:00.000+0000. Run with --log-type USER_DEBUG to see it.'
  ]);
});

test('trace-flag status adds no warning when the other log type changes nothing', async () => {
  const quiet = [
    statusOf({ otherLogType: { logType: 'USER_DEBUG', isActive: false, activeTargetCount: 0 } }),
    statusOf({ isActive: true, otherLogType: activeUserDebug }),
    statusOf({
      logType: 'USER_DEBUG',
      isActive: true,
      otherLogType: { logType: 'DEVELOPER_LOG', isActive: false, activeTargetCount: 0 }
    }),
    statusOf({ targetAvailable: false })
  ];
  for (const status of quiet) {
    assert.deepEqual(await statusWarnings(status), [], JSON.stringify(status));
  }
});

test('trace-flag status prints its warning on stderr without --json', async () => {
  mock.method(core.traceFlag, 'status', async () => statusOf({ otherLogType: activeUserDebug }));

  const { value, out, err } = await withStreams(() =>
    new TraceFlagStatus(['--target-org', 'acme-dev', '--current-user'], config).run()
  );

  assert.deepEqual(JSON.parse(out), value);
  assert.match(err, /Warning.*a USER_DEBUG trace flag is active on this target until 2099-01-01T00:00:00\.000\+0000/);
});
