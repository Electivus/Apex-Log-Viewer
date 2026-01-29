import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('parseArgs: --help toggles showHelp', () => {
  const result = parseArgs(['--help']);
  assert.equal(result.showHelp, true);
  assert.equal(result.error, undefined);
});

test('parseArgs: unknown flag returns error', () => {
  const result = parseArgs(['--nope']);
  assert.ok(result.error?.includes('Unknown argument'));
});

test('parseArgs: --project-dir requires value', () => {
  const result = parseArgs(['--project-dir']);
  assert.ok(result.error?.includes('--project-dir'));
});
