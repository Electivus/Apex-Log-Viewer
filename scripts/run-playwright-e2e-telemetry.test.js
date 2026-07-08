const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  exportTelemetryEnv,
  buildRunValidationQuery,
  resolveConfig,
  resolvePlaywrightChildInvocation,
  resolveTelemetryRunId,
  runTelemetryE2e,
  spawnAsync,
  summarizeTelemetry,
  validateTelemetryOnly
} = require('./run-playwright-e2e-telemetry');

test('buildRunValidationQuery targets AppEvents in the workspace and filters by resource id plus testRunId', () => {
  const query = buildRunValidationQuery({
    componentResourceId:
      '/subscriptions/ABC/resourceGroups/rg/providers/Microsoft.Insights/components/appi-apex-log-viewer-telemetry-e2e-eastus',
    lookback: '2h',
    runId: 'run-123'
  });

  assert.match(query, /\bAppEvents\b/);
  assert.match(query, /TimeGenerated > ago\(2h\)/);
  assert.match(query, /_ResourceId =~ '\/subscriptions\/abc\/resourcegroups\/rg\/providers\/microsoft\.insights\/components\/appi-apex-log-viewer-telemetry-e2e-eastus'/);
  assert.match(query, /parse_json\(Properties\)/);
  assert.match(query, /tostring\(props\["testRunId"\]\) == 'run-123'/);
  assert.match(query, /summarize events = sum\(coalesce\(tolong\(ItemCount\), 1\)\) by name = Name/);
});

test('summarizeTelemetry counts total events and detects activation entries', () => {
  const summary = summarizeTelemetry([
    { name: 'electivus.apex-log-viewer/extension.activate', events: '3' },
    { name: 'electivus.apex-log-viewer/logs.refresh', events: '4' }
  ]);

  assert.deepEqual(summary, {
    distinctNames: 2,
    hasActivation: true,
    totalEvents: 7
  });
});

test('resolveConfig requires explicit telemetry target names and falls back to AZURE_SUBSCRIPTION_ID', () => {
  const config = resolveConfig({
    ALV_E2E_TELEMETRY_APP: 'appi-e2e',
    ALV_E2E_TELEMETRY_BASE_APP: 'appi-prod',
    ALV_E2E_TELEMETRY_RESOURCE_GROUP: 'rg-telemetry',
    AZURE_SUBSCRIPTION_ID: 'sub-123'
  });

  assert.deepEqual(config, {
    appName: 'appi-e2e',
    baseApp: 'appi-prod',
    location: 'eastus',
    resourceGroup: 'rg-telemetry',
    subscription: 'sub-123',
    workspaceResourceId: undefined
  });
});

test('resolveConfig fails fast when explicit telemetry target names are missing', () => {
  assert.throws(
    () =>
      resolveConfig({
        AZURE_SUBSCRIPTION_ID: 'sub-123'
      }),
    /Missing required Azure telemetry config/
  );
});

test('resolveTelemetryRunId derives stable UUIDs from workflow seeds', () => {
  const first = resolveTelemetryRunId({ ALV_E2E_TELEMETRY_RUN_ID_SEED: 'github:123/1/ubuntu-shards' });
  const second = resolveTelemetryRunId({ ALV_E2E_TELEMETRY_RUN_ID_SEED: 'github:123/1/ubuntu-shards' });
  const different = resolveTelemetryRunId({ ALV_E2E_TELEMETRY_RUN_ID_SEED: 'github:123/2/ubuntu-shards' });

  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(first, second);
  assert.notEqual(first, different);
});

test('resolveTelemetryRunId requires a configured id for validate-only mode', () => {
  assert.throws(
    () => resolveTelemetryRunId({}, () => '123e4567-e89b-12d3-a456-426614174000', { requireConfigured: true }),
    /Missing ALV_TEST_TELEMETRY_RUN_ID or ALV_E2E_TELEMETRY_RUN_ID_SEED/
  );
});

test('spawnAsync rejects when the child process cannot be started', async () => {
  await assert.rejects(
    () =>
      spawnAsync('node', ['missing.js'], {}, () => ({
        on(event, handler) {
          if (event === 'error') {
            process.nextTick(() => handler(new Error('spawn ENOENT')));
          }
        }
      })),
    /spawn ENOENT/
  );
});

test('runTelemetryE2e preflights a Log Analytics query before spawning Playwright', async () => {
  const calls = [];
  const validationContext = {
    componentResourceId: '/subscriptions/sub/resourceGroups/rg/providers/microsoft.insights/components/appi-e2e',
    workspaceCustomerId: 'workspace-customer-id'
  };

  const result = await runTelemetryE2e({
    env: {
      ALV_E2E_TELEMETRY_APP: 'appi-e2e',
      ALV_E2E_TELEMETRY_BASE_APP: 'appi-base',
      ALV_E2E_TELEMETRY_RESOURCE_GROUP: 'rg-telemetry',
      AZURE_SUBSCRIPTION_ID: 'sub-123'
    },
    extraArgs: ['--grep', 'logs'],
    repoRoot: path.join('/repo', 'apex-log-viewer'),
    logger: { log() {} },
    randomUUIDImpl: () => '123e4567-e89b-12d3-a456-426614174000',
    ensureTelemetryComponentImpl: async config => {
      calls.push(['ensure', config.appName]);
      return {
        component: {
          connectionString: 'InstrumentationKey=00000000-0000-0000-0000-000000000000',
          id: validationContext.componentResourceId,
          name: 'appi-e2e',
          resourceGroup: 'rg-telemetry',
          workspaceResourceId:
            '/subscriptions/sub/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/law-e2e'
        },
        created: false
      };
    },
    prepareTelemetryValidationContextImpl: async (config, component) => {
      calls.push(['prepare', component.id]);
      assert.equal(config.appName, 'appi-e2e');
      return validationContext;
    },
    queryTelemetryForRunImpl: async (workspaceCustomerId, componentResourceId, runId, lookback) => {
      calls.push(['query-preflight', workspaceCustomerId, componentResourceId, runId, lookback]);
      return [];
    },
    resolvePlaywrightChildInvocationImpl: extraArgs => {
      calls.push(['resolve-child', extraArgs.join(' ')]);
      return { command: 'node', args: ['child.js'] };
    },
    spawnAsyncImpl: async (command, args) => {
      calls.push(['spawn', command, args.join(' ')]);
      return { code: 0, signal: null };
    },
    waitForTelemetryImpl: async (_config, _component, runId, options) => {
      calls.push(['wait', runId, options.validationContext.workspaceCustomerId]);
      return {
        attempt: 1,
        rows: [{ name: 'electivus.apex-log-viewer/extension.activate', events: 5 }],
        summary: { distinctNames: 3, hasActivation: true, totalEvents: 5 }
      };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ['ensure', 'appi-e2e'],
    ['prepare', validationContext.componentResourceId],
    [
      'query-preflight',
      validationContext.workspaceCustomerId,
      validationContext.componentResourceId,
      '123e4567-e89b-12d3-a456-426614174000',
      '5m'
    ],
    ['resolve-child', '--grep logs'],
    ['spawn', 'node', 'child.js'],
    ['wait', '123e4567-e89b-12d3-a456-426614174000', 'workspace-customer-id']
  ]);
});

test('exportTelemetryEnv writes the connection string and deterministic run id for later workflow steps', async () => {
  const written = [];
  const masked = [];
  const result = await exportTelemetryEnv({
    env: {
      ALV_E2E_TELEMETRY_APP: 'appi-e2e',
      ALV_E2E_TELEMETRY_BASE_APP: 'appi-base',
      ALV_E2E_TELEMETRY_RESOURCE_GROUP: 'rg-telemetry',
      ALV_E2E_TELEMETRY_RUN_ID_SEED: 'github:123/1/ubuntu-shards',
      AZURE_SUBSCRIPTION_ID: 'sub-123'
    },
    logger: { log() {} },
    ensureTelemetryComponentImpl: async () => ({
      component: {
        connectionString: 'InstrumentationKey=00000000-0000-0000-0000-000000000000',
        name: 'appi-e2e',
        resourceGroup: 'rg-telemetry'
      },
      created: false
    }),
    maskSecretImpl: value => masked.push(value),
    writeEnvImpl: values => written.push(values)
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.runId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(masked, ['InstrumentationKey=00000000-0000-0000-0000-000000000000']);
  assert.deepEqual(written, [
    {
      ALV_ENABLE_TEST_TELEMETRY: '1',
      ALV_TEST_TELEMETRY_CONNECTION_STRING: 'InstrumentationKey=00000000-0000-0000-0000-000000000000',
      ALV_TEST_TELEMETRY_RUN_ID: result.runId
    }
  ]);
});

test('validateTelemetryOnly queries a configured telemetry run without spawning Playwright', async () => {
  const calls = [];
  const validationContext = {
    componentResourceId: '/subscriptions/sub/resourceGroups/rg/providers/microsoft.insights/components/appi-e2e',
    workspaceCustomerId: 'workspace-customer-id'
  };

  const result = await validateTelemetryOnly({
    env: {
      ALV_E2E_TELEMETRY_APP: 'appi-e2e',
      ALV_E2E_TELEMETRY_BASE_APP: 'appi-base',
      ALV_E2E_TELEMETRY_RESOURCE_GROUP: 'rg-telemetry',
      ALV_TEST_TELEMETRY_RUN_ID: '123e4567-e89b-12d3-a456-426614174000',
      AZURE_SUBSCRIPTION_ID: 'sub-123'
    },
    logger: { log() {} },
    ensureTelemetryComponentImpl: async config => {
      calls.push(['ensure', config.appName]);
      return {
        component: {
          id: validationContext.componentResourceId,
          name: 'appi-e2e',
          resourceGroup: 'rg-telemetry',
          workspaceResourceId:
            '/subscriptions/sub/resourceGroups/rg/providers/microsoft.operationalinsights/workspaces/law-e2e'
        },
        created: false
      };
    },
    prepareTelemetryValidationContextImpl: async (_config, component) => {
      calls.push(['prepare', component.id]);
      return validationContext;
    },
    waitForTelemetryImpl: async (_config, _component, runId, options) => {
      calls.push(['wait', runId, options.validationContext.workspaceCustomerId]);
      return {
        attempt: 1,
        rows: [{ name: 'electivus.apex-log-viewer/extension.activate', events: 5 }],
        summary: { distinctNames: 3, hasActivation: true, totalEvents: 5 }
      };
    }
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ['ensure', 'appi-e2e'],
    ['prepare', validationContext.componentResourceId],
    ['wait', '123e4567-e89b-12d3-a456-426614174000', 'workspace-customer-id']
  ]);
});

test('resolvePlaywrightChildInvocation runs Playwright directly by default', () => {
  const repoRoot = path.join('/repo', 'apex-log-viewer');
  const invocation = resolvePlaywrightChildInvocation(['--grep', 'logs'], {}, repoRoot);

  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts', 'run-playwright-e2e.js'), '--grep', 'logs']
  });
});

test('resolvePlaywrightChildInvocation can run the Playwright child through the proxy lab', () => {
  const repoRoot = path.join('/repo', 'apex-log-viewer');
  const invocation = resolvePlaywrightChildInvocation(
    ['--grep', 'logs'],
    { ALV_E2E_TELEMETRY_PROXY_LAB: '1' },
    repoRoot
  );

  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [
      path.join(repoRoot, 'scripts', 'run-e2e-proxy-lab.js'),
      'npm',
      'run',
      'test:e2e',
      '--',
      '--grep',
      'logs'
    ]
  });
});
