import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';

import CustomLogEntry from '../src/commands/electivus/custom-log/entry.ts';
import CustomLogGet from '../src/commands/electivus/custom-log/get.ts';
import CustomLogList from '../src/commands/electivus/custom-log/list.ts';
import CustomLogSources from '../src/commands/electivus/custom-log/sources.ts';
import { core } from '../src/core.ts';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = await Config.load({ root: pluginRoot });

type Capture = { params?: Record<string, unknown> };

function stub(method: 'sources' | 'list' | 'get' | 'entry', result: unknown): Capture {
  const capture: Capture = {};
  mock.method(core.customLog, method, async (params: Record<string, unknown>) => {
    capture.params = params;
    return result;
  });
  return capture;
}

test.afterEach(() => mock.restoreAll());

test('sources passes the org and the current directory as the project, and --refresh', async () => {
  const result = { sources: [], issues: [] };
  const capture = stub('sources', result);

  const output = await new CustomLogSources(['--target-org', 'acme-uat', '--refresh', '--json'], config).run();

  assert.deepEqual(capture.params, { targetOrg: 'acme-uat', projectDir: process.cwd(), refresh: true });
  assert.equal(output, result);
});

test('list maps every flag onto the core filter, window and payload paths', async () => {
  const result = { source: { id: 'app-log' }, columns: [], rows: [], payloadFields: [], nextCursor: null };
  const capture = stub('list', result);

  const output = await new CustomLogList(
    [
      '--target-org',
      'acme-dev',
      '--source',
      'app-log',
      '--limit',
      '2',
      '--min-level',
      'WARN',
      '--user',
      'dev@acme.com',
      '--since',
      '24h',
      '--until',
      '2026-10-30T00:00:00Z',
      '--cursor',
      'abc',
      '--payload-fields',
      'orderId,http.status',
      '--json'
    ],
    config
  ).run();

  assert.deepEqual(capture.params, {
    targetOrg: 'acme-dev',
    projectDir: process.cwd(),
    source: 'app-log',
    limit: 2,
    cursor: 'abc',
    filter: { minLevel: 'WARN', user: 'dev@acme.com', since: '24h', until: '2026-10-30T00:00:00Z' },
    payloadFields: ['orderId', 'http.status']
  });
  assert.equal(output, result);
});

test('list needs no flag at all, so one command works on every org', async () => {
  const capture = stub('list', { rows: [] });

  await new CustomLogList(['--json'], config).run();

  assert.deepEqual(capture.params, {
    targetOrg: undefined,
    projectDir: process.cwd(),
    source: undefined,
    limit: undefined,
    cursor: undefined,
    filter: { minLevel: undefined, user: undefined, since: undefined, until: undefined },
    payloadFields: undefined
  });
});

test('get takes a log id or a transaction id, never both and never neither', async () => {
  const capture = stub('get', { entries: [] });

  await new CustomLogGet(
    ['--log-id', 'a02000000000001AAA', '--limit', '5', '--min-level', 'ERROR', '--json'],
    config
  ).run();
  assert.deepEqual(capture.params, {
    targetOrg: undefined,
    projectDir: process.cwd(),
    source: undefined,
    limit: 5,
    cursor: undefined,
    minLevel: 'ERROR',
    payloadFields: undefined,
    logId: 'a02000000000001AAA'
  });

  await new CustomLogGet(['--transaction-id', 'ae12d024', '--source', 'nebula', '--json'], config).run();
  assert.equal(capture.params?.transactionId, 'ae12d024');
  assert.equal('logId' in (capture.params ?? {}), false);
  assert.equal(capture.params?.source, 'nebula');

  await assert.rejects(new CustomLogGet(['--json'], config).run(), /exactly one|One of the following/i);
  await assert.rejects(
    new CustomLogGet(['--log-id', 'a02000000000001AAA', '--transaction-id', 'x', '--json'], config).run(),
    /cannot also be provided|exclusive/i
  );
});

test('entry requires an entry id and forwards the optional source', async () => {
  const capture = stub('entry', { details: [] });

  await new CustomLogEntry(['--entry-id', 'a01000000000001AAA', '--source', 'nebula', '--json'], config).run();

  assert.deepEqual(capture.params, {
    targetOrg: undefined,
    projectDir: process.cwd(),
    source: 'nebula',
    entryId: 'a01000000000001AAA'
  });
  await assert.rejects(new CustomLogEntry(['--json'], config).run(), /entry-id/i);
});

test('flag values the contract does not allow are refused before core is called', async () => {
  const capture = stub('list', { rows: [] });

  await assert.rejects(
    new CustomLogList(['--min-level', 'LOUD', '--json'], config).run(),
    /Expected --min-level=LOUD to be one of/
  );
  await assert.rejects(new CustomLogList(['--limit', '0', '--json'], config).run(), /greater than or equal to 1/);
  await assert.rejects(new CustomLogList(['--limit', '201', '--json'], config).run(), /less than or equal to 200/);
  await assert.rejects(
    new CustomLogGet(['--log-id', 'x', '--limit', '2001', '--json'], config).run(),
    /less than or equal to 2000/
  );
  assert.equal(capture.params, undefined);
});
