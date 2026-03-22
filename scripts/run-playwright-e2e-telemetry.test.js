const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRunValidationQuery,
  resolveConfig,
  spawnAsync,
  summarizeTelemetry
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
