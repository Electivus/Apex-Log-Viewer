import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CustomLogCaptureResult, CustomLogListResult } from '@alv/core/contracts';
import { Config } from '@oclif/core';

import CustomLogCapture from '../src/commands/electivus/custom-log/capture.ts';
import CustomLogList from '../src/commands/electivus/custom-log/list.ts';
import { core } from '../src/core.ts';
import { recordedEvents, startBayeuxDouble } from '../../core/test/support/cometdDouble.ts';
import { alvTestLogDescribe } from '../../core/test/support/describeFixtures.ts';
import { nebulaHandler } from '../../core/test/support/nebulaDouble.ts';
import { isolateSalesforceHome } from '../../core/test/support/salesforceDouble.ts';
import { until, withStreams } from './support/streams.ts';

/**
 * The commands over the real core: `capture` talks CometD to the Bayeux double that unit 7 built (the
 * real Faye client inside `@salesforce/core` against a local long-poll server), and `list` reads what
 * `capture` stored. The command tests with a fake core cover flags and signals; this file covers the
 * join between the two commands, which no fake can.
 */

isolateSalesforceHome();
// Faye reads http_proxy and ignores NO_PROXY, so a proxied machine would send the loopback double's traffic away.
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await Config.load({ root: pluginRoot });

const OBJECT = 'ALV_Test_Log__e';
const SOURCE = 'alv-events';

test.after(() => core.dispose());

/** A recording delivered as if it had just been published: same uuids, replay ids and order, instants moved so the retention purge keeps them. */
function freshSingleEvent() {
  const [recorded] = recordedEvents('single');
  const { data } = recorded!;
  const shift = Date.now() - 60_000 - Date.parse(String(data.payload.CreatedDate));
  const moved = (iso: unknown): string => new Date(Date.parse(String(iso)) + shift).toISOString();
  return [
    {
      data: {
        ...data,
        payload: {
          ...data.payload,
          CreatedDate: moved(data.payload.CreatedDate),
          Logged_At__c: moved(data.payload.Logged_At__c),
          Epoch_Ms__c: Number(data.payload.Epoch_Ms__c) + shift
        }
      }
    }
  ];
}

/** An org that serves the REST half of a capture and the Bayeux stream on one host, and a project with an event source over it. */
async function world(t: test.TestContext) {
  const double = await startBayeuxDouble(
    t,
    { connects: [{ events: freshSingleEvent() }] },
    nebulaHandler({
      describes: 'unlocked-admin',
      objects: [OBJECT],
      extraDescribes: { [OBJECT]: alvTestLogDescribe() },
      answer: (_soql, request) =>
        request.path === '/limits'
          ? { body: { DailyDeliveredPlatformEvents: { Max: 25_000, Remaining: 22_000 } } }
          : undefined
    })
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-cli-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'sfdx-project.json'),
    JSON.stringify({
      plugins: {
        electivus: {
          customLogs: {
            sources: [
              {
                id: SOURCE,
                label: 'ALV events',
                event: {
                  object: OBJECT,
                  fields: {
                    time: 'Logged_At__c',
                    message: 'Message__c',
                    level: 'Level__c',
                    user: 'Username__c',
                    transactionId: 'Transaction_Id__c',
                    order: 'Sequence__c'
                  }
                }
              }
            ]
          }
        }
      }
    })
  );
  const home = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(home));
  return { double, org: ['--target-org', double.username, '--source', SOURCE] };
}

const capture = (...argv: string[]) => new CustomLogCapture(argv, config);
const list = (...argv: string[]) => new CustomLogList(argv, config);

test('capture drains the event stream into the store, and list then reads it with the org unreachable', async t => {
  const { double, org } = await world(t);

  const first = await withStreams(() => capture(...org, '--max-time', '1', '--json')._run());
  const drained = JSON.parse(first.out).result as CustomLogCaptureResult;

  assert.equal(first.err, '');
  assert.equal(drained.source.shape, 'events');
  assert.equal(drained.outcome, 'timeLimit', 'the event was still arriving when the bound passed');
  assert.deepEqual([drained.delivered, drained.stored, drained.newGaps], [1, 1, []]);
  assert.equal(drained.store.state, 'captured');

  const second = await withStreams(() => capture(...org, '--max-time', '1', '--json')._run());
  const resumed = JSON.parse(second.out).result as CustomLogCaptureResult;

  assert.deepEqual([resumed.delivered, resumed.stored], [0, 0]);
  assert.equal(
    resumed.outcome,
    'timeLimit',
    'a 1 s bound ends a drain over a young position before its 15 s quiet wait'
  );
  const [{ data }] = recordedEvents('single') as [{ data: { event: { replayId: number } } }];
  assert.deepEqual(double.replays, [{ [`/event/${OBJECT}`]: -2 }, { [`/event/${OBJECT}`]: data.event.replayId }]);

  await double.close();
  const received = double.received;
  const offline = await withStreams(() => list(...org, '--json')._run());
  const page = JSON.parse(offline.out).result as CustomLogListResult;

  assert.equal(double.received, received, 'list made no request');
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0]!.title, 'Synthetic INFO entry 870 of 870 (bsn870)');
  assert.equal(page.store?.state, 'captured');
});

test('--follow prints the stored row, and Ctrl-C ends with the aborted summary and the row on disk', async t => {
  const { double, org } = await world(t);

  const followed = await withStreams(async ({ out }) => {
    const running = capture(...org, '--follow')._run();
    await until(() => out.length > 0);
    process.emit('SIGINT');
    return running;
  });

  assert.equal(followed.value.outcome, 'aborted');
  assert.equal(process.exitCode ?? 0, 0);
  assert.match(
    followed.out,
    /^\S+ INFO \S+ Synthetic INFO entry 870 of 870 \(bsn870\)\n$/,
    'one row line and nothing else'
  );
  assert.match(followed.err, /Replaying the events Salesforce still retains\./);
  assert.match(followed.err, /Stopping\. Press Ctrl-C again to quit now\./);
  assert.match(followed.err, /Delivered 1, stored 1\. Store: .*alv_test_log__e/);
  assert.equal(double.disconnects, 1, 'the subscription was closed on the server');

  await double.close();
  const offline = await withStreams(() => list(...org, '--json')._run());
  assert.equal((JSON.parse(offline.out).result as CustomLogListResult).rows.length, 1);
});
