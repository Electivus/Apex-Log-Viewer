import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidenceName,
  hasTargetOrg,
  scratchStrategy,
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
