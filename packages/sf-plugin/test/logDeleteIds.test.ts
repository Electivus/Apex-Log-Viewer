import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
