import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';

import LogDelete from '../src/commands/electivus/log/delete.ts';
import { core } from '../src/core.ts';
import { resolveLogIds } from '../src/logDeleteIds.ts';

test('explicit log ids retain only valid ApexLog ids', async () => {
  assert.deepEqual(await resolveLogIds(['invalid', '07L000000000001AAA', '07L000000000001AAA'], undefined), [
    '07L000000000001AAA'
  ]);
});

test('invalid explicit log ids are rejected', async () => {
  await assert.rejects(resolveLogIds(['not-an-id'], undefined), /No valid ApexLog ids were found in --log-id\./);
});

test('an ids file without valid ApexLog ids is rejected', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'alv-log-delete-ids-'));
  const idsFile = path.join(directory, 'ids.txt');
  await fs.writeFile(idsFile, 'not-an-id\n001000000000001AAA\n');

  await assert.rejects(resolveLogIds(undefined, idsFile), /No valid ApexLog ids were found in --ids-file:/);
});

test('log delete still accepts the deprecated --workspace-root but never passes a workspace to core', async t => {
  const config = await Config.load({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  let params: Record<string, unknown> | undefined;
  mock.method(core.log, 'delete', async (received: Record<string, unknown>) => {
    params = received;
    return { status: 'success', dryRun: true, logIds: received.ids };
  });
  t.after(() => mock.restoreAll());

  await new LogDelete(
    ['--target-org', 'acme-dev', '--log-id', '07L000000000001AAA', '--workspace-root', os.tmpdir(), '--json'],
    config
  ).run();

  assert.deepEqual(params?.ids, ['07L000000000001AAA']);
  assert.equal('workspaceRoot' in (params ?? {}), false);
});
