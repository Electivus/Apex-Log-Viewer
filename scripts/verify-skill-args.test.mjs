import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evidenceName,
  hasTargetOrg,
  installIsStale,
  scratchStrategy,
  sfBinary,
  splitSfArgs
} from '../.agents/skills/verify-apex-log-viewer/scripts/sfArgs.mjs';

test('verify sf sees every spelling of the target org flag', () => {
  for (const args of [
    ['log', 'list', '--target-org', 'acme'],
    ['log', 'list', '--target-org=acme'],
    ['log', 'list', '-o', 'acme'],
    ['log', 'list', '-oacme'],
    ['log', 'list', '-o=acme']
  ]) {
    assert.equal(hasTargetOrg(args), true, args.join(' '));
  }
  assert.equal(hasTargetOrg(['log', 'list', '--json']), false);
  assert.equal(hasTargetOrg(['log', 'list', '--output-dir', 'x']), false);
});

test('verify sf names evidence after the command words, never a flag value', () => {
  assert.equal(evidenceName(['log', 'sync', '--json']), 'sf-log-sync');
  assert.equal(evidenceName(['doctor', '--workspace-root', '/tmp/a b/ws', '--json']), 'sf-doctor');
  assert.equal(evidenceName(['custom-log', 'list', 'extra', '--json']), 'sf-custom-log-list');
  assert.equal(evidenceName(['--json']), 'sf-command');
  assert.equal(evidenceName(['we/ird', 'na:me']), 'sf-we_ird-na_me');
  assert.equal(evidenceName(['log', 'status', '--json'], 'sf-linked'), 'sf-linked-log-status');
});

test('verify sf takes --linked only before the sf electivus arguments', () => {
  assert.deepEqual(splitSfArgs(['--', 'log', 'sync']), { linked: false, args: ['log', 'sync'] });
  assert.deepEqual(splitSfArgs(['log', 'sync']), { linked: false, args: ['log', 'sync'] });
  assert.deepEqual(splitSfArgs(['--linked', '--', 'log', 'sync']), { linked: true, args: ['log', 'sync'] });
  assert.deepEqual(splitSfArgs(['--linked', 'doctor']), { linked: true, args: ['doctor'] });
  assert.deepEqual(splitSfArgs(['--', '--linked']), { linked: false, args: ['--linked'] });
});

test('verify sf --linked runs the Salesforce CLI the E2E harness selects', () => {
  assert.equal(sfBinary({}), 'sf');
  assert.equal(sfBinary({ ALV_SF_BIN_PATH: ' /opt/alv-sf-node/sf ' }), '/opt/alv-sf-node/sf');
  assert.equal(sfBinary({ SF_CLI_BIN_PATH: '/opt/sf', ALV_SF_BIN_PATH: '/opt/alv-sf-node/sf' }), '/opt/sf');
  assert.equal(sfBinary({ SF_CLI_BIN_PATH: '  ', ALV_SF_BIN_PATH: '' }), 'sf');
});

test('verify doctor resolves the scratch strategy as the E2E harness does', () => {
  assert.deepEqual(scratchStrategy({}), { strategy: 'single', poolName: '' });
  assert.deepEqual(scratchStrategy({ SF_SCRATCH_POOL_NAME: ' ALV ' }), { strategy: 'pool', poolName: 'ALV' });
  assert.deepEqual(scratchStrategy({ SF_SCRATCH_STRATEGY: ' Pool ', SF_SCRATCH_POOL_NAME: 'ALV' }), {
    strategy: 'pool',
    poolName: 'ALV'
  });
  assert.deepEqual(scratchStrategy({ SF_SCRATCH_STRATEGY: 'SINGLE' }), { strategy: 'single', poolName: '' });
  assert.match(scratchStrategy({ SF_SCRATCH_STRATEGY: 'shared' }).error, /Expected 'single' or 'pool'/);
});

test('verify doctor flags an install whose lockfile copy differs from pnpm-lock.yaml', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'alv-install-'));
  try {
    assert.equal(installIsStale(root), false, 'no install to compare');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert.equal(installIsStale(root), false, 'no installed copy to compare');
    mkdirSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n');
    assert.equal(installIsStale(root), false, 'identical copies');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
    assert.equal(installIsStale(root), true, 'lockfile changed after the install');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
