#!/usr/bin/env node
'use strict';

const {
  kqlQuote,
  normalizeResourceId,
  queryWorkspace,
  resolveWorkspaceInfo,
  showComponent,
  toRows
} = require('./azure-monitor-helpers');

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find(entry => entry.startsWith(prefix));
  if (!arg) {
    return fallback;
  }
  return arg.slice(prefix.length).trim() || fallback;
}

function buildScopedBaseQuery({ componentResourceId, lookback }) {
  return [
    'AppEvents',
    `| where TimeGenerated > ago(${lookback})`,
    `| where _ResourceId =~ ${kqlQuote(normalizeResourceId(componentResourceId))}`,
    `| where Name startswith ${kqlQuote('electivus.apex-log-viewer/')}`
  ].join(' ');
}

function buildTopEventsQuery({ componentResourceId, lookback }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| summarize events = sum(coalesce(tolong(ItemCount), 1)) by name = Name',
    '| order by events desc'
  ].join(' ');
}

function buildOutcomeQuery({ componentResourceId, lookback }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| extend props = parse_json(Properties)',
    '| summarize events = sum(coalesce(tolong(ItemCount), 1)) by name = Name, outcome = tostring(props["outcome"])',
    '| order by name asc, events desc'
  ].join(' ');
}

function buildLatencyQuery({ componentResourceId, lookback }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| extend measurements = parse_json(Measurements)',
    '| extend durationMs = todouble(measurements["durationMs"])',
    '| where isfinite(durationMs)',
    '| summarize avgMs = round(avg(durationMs), 1), p50Ms = percentile(durationMs, 50), p95Ms = percentile(durationMs, 95) by name = Name',
    '| order by p95Ms desc'
  ].join(' ');
}

function buildCliErrorQuery({ componentResourceId, lookback }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| where Name in ("electivus.apex-log-viewer/cli.exec", "electivus.apex-log-viewer/cli.getOrgAuth")',
    '| extend props = parse_json(Properties)',
    '| summarize events = sum(coalesce(tolong(ItemCount), 1)) by name = Name, code = tostring(props["code"])',
    '| order by name asc, events desc'
  ].join(' ');
}

function buildExceptionsQuery({ componentResourceId, lookback }) {
  return [
    'AppExceptions',
    `| where TimeGenerated > ago(${lookback})`,
    `| where _ResourceId =~ ${kqlQuote(normalizeResourceId(componentResourceId))}`,
    '| summarize exceptions = sum(coalesce(tolong(ItemCount), 1))'
  ].join(' ');
}

function buildSearchCoverageQuery({ componentResourceId, lookback }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| where Name contains "search" or Name contains "filter"',
    '| summarize events = sum(coalesce(tolong(ItemCount), 1))'
  ].join(' ');
}

function rowsByName(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.name), row);
  }
  return map;
}

function outcomeCount(outcomeRows, targetName, targetOutcome) {
  return outcomeRows
    .filter(row => String(row.name) === targetName && String(row.outcome || '') === targetOutcome)
    .reduce((sum, row) => sum + Number(row.events || 0), 0);
}

function totalCount(outcomeRows, targetName) {
  return outcomeRows
    .filter(row => String(row.name) === targetName)
    .reduce((sum, row) => sum + Number(row.events || 0), 0);
}

function printTable(title, rows, formatter) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('- none');
    return;
  }
  for (const row of rows) {
    console.log(`- ${formatter(row)}`);
  }
}

async function main() {
  const config = {
    appName: readOption('app', process.env.ALV_TELEMETRY_APP || ''),
    baseApp: readOption('base-app', process.env.ALV_TELEMETRY_BASE_APP || ''),
    resourceGroup: readOption('resource-group', process.env.ALV_TELEMETRY_RESOURCE_GROUP || ''),
    subscription: readOption('subscription', process.env.ALV_TELEMETRY_SUBSCRIPTION || ''),
    lookback: readOption('lookback', '30d'),
    workspaceResourceId: readOption('workspace-resource-id', process.env.ALV_TELEMETRY_WORKSPACE_RESOURCE_ID || '')
  };

  if (!config.appName || !config.resourceGroup || !config.subscription) {
    throw new Error(
      'Missing Azure context. Provide --app, --resource-group, and --subscription (or ALV_TELEMETRY_APP / ALV_TELEMETRY_RESOURCE_GROUP / ALV_TELEMETRY_SUBSCRIPTION).'
    );
  }

  const component = await showComponent({
    appName: config.appName,
    resourceGroup: config.resourceGroup,
    subscription: config.subscription
  });
  const workspace = await resolveWorkspaceInfo(config);

  const topEvents = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildTopEventsQuery({
      componentResourceId: component.id,
      lookback: config.lookback
    }))
  );
  const outcomes = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildOutcomeQuery({
      componentResourceId: component.id,
      lookback: config.lookback
    }))
  );
  const latencies = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildLatencyQuery({
      componentResourceId: component.id,
      lookback: config.lookback
    }))
  );
  const cliErrors = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildCliErrorQuery({
      componentResourceId: component.id,
      lookback: config.lookback
    }))
  );
  const exceptions = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildExceptionsQuery({
      componentResourceId: component.id,
      lookback: config.lookback
    }))
  );
  const searchCoverage = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildSearchCoverageQuery({
      componentResourceId: component.id,
      lookback: config.lookback
    }))
  );

  const latencyByName = rowsByName(latencies);
  const refreshTotal = totalCount(outcomes, 'electivus.apex-log-viewer/logs.refresh');
  const refreshErrors = outcomeCount(outcomes, 'electivus.apex-log-viewer/logs.refresh', 'error');
  const debugLevelsTotal = totalCount(outcomes, 'electivus.apex-log-viewer/debugLevels.load');
  const debugLevelsErrors = outcomeCount(outcomes, 'electivus.apex-log-viewer/debugLevels.load', 'error');
  const searchEvents = searchCoverage.reduce((sum, row) => sum + Number(row.events || 0), 0);
  const exceptionCount = exceptions.reduce((sum, row) => sum + Number(row.exceptions || 0), 0);

  console.log('Telemetry usage report');
  console.log(`- App Insights component: ${component.name}`);
  console.log(`- Component resource id: ${component.id}`);
  console.log(`- Workspace: ${workspace.workspaceName}`);
  console.log(`- Workspace customer id: ${workspace.workspaceCustomerId}`);
  console.log(`- Lookback: ${config.lookback}`);

  printTable('Top events', topEvents.slice(0, 10), row => `${row.name}: ${row.events}`);
  printTable('CLI error buckets', cliErrors, row => `${row.name} / ${row.code || '(blank)'}: ${row.events}`);
  printTable(
    'Latency hotspots',
    latencies.slice(0, 6),
    row => `${row.name}: avg ${row.avgMs} ms, p50 ${row.p50Ms} ms, p95 ${row.p95Ms} ms`
  );

  console.log('\nSignals');
  console.log(
    `- logs.refresh: ${refreshTotal} total, ${refreshErrors} error, ${refreshTotal ? ((refreshErrors / refreshTotal) * 100).toFixed(2) : '0.00'}% error rate`
  );
  console.log(
    `- debugLevels.load: ${debugLevelsTotal} total, ${debugLevelsErrors} error, ${debugLevelsTotal ? ((debugLevelsErrors / debugLevelsTotal) * 100).toFixed(2) : '0.00'}% error rate`
  );
  if (latencyByName.has('electivus.apex-log-viewer/debugLevels.load')) {
    const row = latencyByName.get('electivus.apex-log-viewer/debugLevels.load');
    console.log(`- debugLevels.load latency: p50 ${row.p50Ms} ms, p95 ${row.p95Ms} ms`);
  }
  console.log(`- search/filter telemetry events: ${searchEvents}`);
  console.log(`- AppExceptions rows: ${exceptionCount}`);

  console.log('\nSuggested documentation focus');
  console.log('- Salesforce CLI install, PATH validation, org auth, and troubleshooting should stay first if CLI/auth buckets dominate.');
  console.log('- The core workflow should stay explicit: select org, refresh logs, open viewer, tail logs, then cleanup/download as secondary paths.');
  console.log('- Debug Levels and Debug Flags deserve a troubleshooting section if debugLevels.load keeps a high error rate or slow p95 latency.');
  if (searchEvents === 0) {
    console.log('- Search/filter still has no dedicated telemetry signal in this component; add instrumentation before treating it as a measured adoption area.');
  }
}

main().catch(error => {
  console.error('[telemetry-report] Failed:', error && error.message ? error.message : error);
  process.exit(1);
});
