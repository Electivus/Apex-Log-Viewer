import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSfArgs, normalizeParams } from '../src/command.js';

test('normalizeParams defaults and clamps', () => {
  const cwd = '/tmp/work';
  const params = normalizeParams({}, cwd);
  assert.equal(params.limit, 100);
  assert.equal(params.outputDir, path.resolve(cwd, 'apexlogs'));
  assert.equal(params.targetOrg, undefined);
});

test('normalizeParams clamps limit range', () => {
  const cwd = '/tmp/work';
  assert.equal(normalizeParams({ limit: 0 }, cwd).limit, 1);
  assert.equal(normalizeParams({ limit: 500 }, cwd).limit, 200);
});

test('buildSfArgs builds full command', () => {
  const args = buildSfArgs({
    targetOrg: 'my-org',
    outputDir: '/tmp/logs',
    limit: 5
  });
  assert.deepEqual(args, [
    'apex-log-viewer',
    'logs',
    'sync',
    '--json',
    '--target-org',
    'my-org',
    '--output-dir',
    '/tmp/logs',
    '--limit',
    '5'
  ]);
});
