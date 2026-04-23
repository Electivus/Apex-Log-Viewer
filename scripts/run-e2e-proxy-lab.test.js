const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveComposeArgs } = require('./run-e2e-proxy-lab');

test('resolveComposeArgs runs the proxy lab runner with the compose file', () => {
  const repoRoot = path.join('/workspace', 'apex-log-viewer');
  assert.deepEqual(resolveComposeArgs([], { repoRoot }), [
    'compose',
    '-f',
    path.join(repoRoot, 'docker-compose.e2e-proxy.yml'),
    'run',
    '--rm',
    '--build',
    'runner'
  ]);
});

test('resolveComposeArgs forwards an explicit E2E command through the lab script', () => {
  const repoRoot = path.join('/workspace', 'apex-log-viewer');
  assert.deepEqual(resolveComposeArgs(['npm', 'run', 'test:e2e:cli'], { repoRoot }), [
    'compose',
    '-f',
    path.join(repoRoot, 'docker-compose.e2e-proxy.yml'),
    'run',
    '--rm',
    '--build',
    'runner',
    'bash',
    'test/e2e/proxy-lab/run.sh',
    'npm',
    'run',
    'test:e2e:cli'
  ]);
});
