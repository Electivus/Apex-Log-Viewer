const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildDeploymentArgs, runAzCommand } = require('./deploy-azure-monitor');

test('buildDeploymentArgs omits --template-file when using a .bicepparam file', () => {
  const repoRoot = path.join('C:', 'repo');

  const args = buildDeploymentArgs({
    repoRoot,
    resourceGroup: 'rg-telemetry',
    parametersFile: 'infra/azure-monitor/parameters/apex-log-viewer.bicepparam',
    mode: 'what-if',
    parameterOverrides: []
  });

  assert.deepEqual(args, [
    'deployment',
    'group',
    'what-if',
    '--resource-group',
    'rg-telemetry',
    '--parameters',
    path.resolve(repoRoot, 'infra/azure-monitor/parameters/apex-log-viewer.bicepparam')
  ]);
});

test('buildDeploymentArgs keeps --template-file for inline overrides', () => {
  const repoRoot = path.join('C:', 'repo');

  const args = buildDeploymentArgs({
    repoRoot,
    resourceGroup: 'rg-telemetry',
    parametersFile: '',
    mode: 'create',
    parameterOverrides: ['deployWorkbook=true']
  });

  assert.deepEqual(args, [
    'deployment',
    'group',
    'create',
    '--resource-group',
    'rg-telemetry',
    '--template-file',
    path.join(repoRoot, 'infra', 'azure-monitor', 'main.bicep'),
    '--parameters',
    'deployWorkbook=true'
  ]);
});

test('runAzCommand rejects with a clear message when az cannot be started', async () => {
  await assert.rejects(
    () =>
      runAzCommand(['deployment', 'group', 'create'], {
        spawnImpl() {
          return {
            on(event, handler) {
              if (event === 'error') {
                process.nextTick(() => handler(new Error('spawn ENOENT')));
              }
            }
          };
        }
      }),
    /Failed to start Azure CLI/
  );
});
