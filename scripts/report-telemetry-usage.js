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
    "| extend outcome = tostring(props['outcome'])",
    '| summarize events = sum(coalesce(tolong(ItemCount), 1)) by name = Name, outcome',
    '| order by name asc, events desc'
  ].join(' ');
}

function buildLatencyQuery({ componentResourceId, lookback }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| extend measurements = parse_json(Measurements)',
    "| extend durationMs = todouble(measurements['durationMs'])",
    '| where isfinite(durationMs)',
    '| summarize avgMs = round(avg(durationMs), 1), p50Ms = percentile(durationMs, 50), p95Ms = percentile(durationMs, 95) by name = Name',
    '| order by p95Ms desc'
  ].join(' ');
}

function buildCliErrorQuery({ componentResourceId, lookback }) {
  const cliExec = kqlQuote('electivus.apex-log-viewer/cli.exec');
  const cliGetOrgAuth = kqlQuote('electivus.apex-log-viewer/cli.getOrgAuth');
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    `| where Name in (${cliExec}, ${cliGetOrgAuth})`,
    '| extend props = parse_json(Properties)',
    "| summarize events = sum(coalesce(tolong(ItemCount), 1)) by name = Name, code = tostring(props['code'])",
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
    `| where Name contains ${kqlQuote('search')} or Name contains ${kqlQuote('filter')}`,
    '| summarize events = sum(coalesce(tolong(ItemCount), 1))'
  ].join(' ');
}

const AUTOMATIC_EVENTS = ['extension.activate', 'host.responsiveness'];
const DORMANT_MIN_PROJECT_DAYS = 5;

function parseDeviceList(value) {
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function parseMinVersion(value) {
  if (value && !/^\d+(\.\d+){0,3}$/.test(value)) {
    throw new Error(`--min-version must be a version such as 0.56.0, got "${value}".`);
  }
  return value;
}

function buildDeviceEventsQuery({ componentResourceId, lookback, excludeDevices = [], minVersion = '' }) {
  return [
    buildScopedBaseQuery({ componentResourceId, lookback }),
    '| extend props = parse_json(Properties)',
    "| extend device = tostring(props['common.devDeviceId']), outcome = tostring(props['outcome'])",
    `| extend event = replace_string(Name, ${kqlQuote('electivus.apex-log-viewer/')}, '')`,
    `| extend engaged = event !in (${AUTOMATIC_EVENTS.map(kqlQuote).join(', ')})`,
    '| where isnotempty(device)',
    excludeDevices.length ? `| where device !in (${excludeDevices.map(kqlQuote).join(', ')})` : '',
    minVersion
      ? `| where parse_version(tostring(props['common.extversion'])) >= parse_version(${kqlQuote(minVersion)})`
      : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function buildAdoptionFunnelQuery(context) {
  return [
    buildDeviceEventsQuery(context),
    "| summarize projectDays = dcountif(startofday(TimeGenerated), event == 'extension.activate' and tostring(props['hasSalesforceProject']) == 'true'),",
    'engagedDays = dcountif(startofday(TimeGenerated), engaged),',
    "loadedLogs = max(toint(event == 'logs.refresh' and outcome == 'ok')),",
    "triedLog = max(toint(event in ('command.openLogInViewer', 'log.open'))),",
    "appliedFlags = max(toint(event == 'debugFlags.apply' and outcome == 'ok')),",
    'lastSeen = max(TimeGenerated) by device',
    `| extend dormant = engagedDays == 0 and projectDays >= ${DORMANT_MIN_PROJECT_DAYS}`,
    '| summarize devices = count(), inProject = countif(projectDays > 0), acted = countif(engagedDays > 0), loadedLogs = sum(loadedLogs),',
    'triedLog = sum(triedLog), appliedFlags = sum(appliedFlags), returned = countif(engagedDays > 1),',
    'dormant = countif(dormant), dormantSeenLast14d = countif(dormant and lastSeen > ago(14d))'
  ].join(' ');
}

function buildWeeklyAdoptionQuery(context) {
  return [
    `let events = ${buildDeviceEventsQuery(context)};`,
    'let firsts = events | summarize firstSeen = startofweek(min(TimeGenerated)), firstEngaged = startofweek(minif(TimeGenerated, engaged)) by device;',
    'events',
    '| summarize activated = dcount(device), engaged = dcountif(device, engaged) by week = startofweek(TimeGenerated)',
    '| join kind=leftouter (firsts | summarize newDevices = count() by week = firstSeen) on week',
    '| join kind=leftouter (firsts | where isnotnull(firstEngaged) | summarize newEngaged = count() by week = firstEngaged) on week',
    '| project week, activated, engaged, newDevices = coalesce(newDevices, 0), newEngaged = coalesce(newEngaged, 0)',
    '| order by week asc'
  ].join(' ');
}

function buildCountryQuery(context) {
  return [
    buildDeviceEventsQuery(context),
    '| summarize engaged = max(toint(engaged)), arg_max(TimeGenerated, ClientCountryOrRegion) by device',
    "| summarize devices = count(), engaged = sum(engaged) by country = iff(isempty(ClientCountryOrRegion), '(unknown)', ClientCountryOrRegion)",
    '| order by engaged desc, devices desc, country asc'
  ].join(' ');
}

function share(part, whole) {
  return whole ? `${Math.round((Number(part) / Number(whole)) * 100)}%` : '0%';
}

function formatAdoptionFunnel(row) {
  const devices = Number(row.devices || 0);
  return [
    `Activated: ${devices}, ${row.inProject} of them in a Salesforce project`,
    `Did something beyond activation (a view or a command): ${row.acted} (${share(row.acted, devices)})`,
    `Loaded logs: ${row.loadedLogs} (${share(row.loadedLogs, devices)})`,
    `Tried to open a log: ${row.triedLog} (${share(row.triedLog, devices)})`,
    `Applied debug flags: ${row.appliedFlags} (${share(row.appliedFlags, devices)})`,
    `Came back on a second day: ${row.returned} (${share(row.returned, devices)})`,
    `Dormant (a Salesforce project open on ${DORMANT_MIN_PROJECT_DAYS}+ days, nothing else in the lookback): ${row.dormant}, ${row.dormantSeenLast14d} of them seen in the last 14 days`
  ];
}

function formatWeek(row) {
  const week = String(row.week).slice(0, 10);
  return `${week}: ${row.activated} activated, ${row.engaged} engaged, ${row.newDevices} new, ${row.newEngaged} newly engaged`;
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
    workspaceResourceId: readOption('workspace-resource-id', process.env.ALV_TELEMETRY_WORKSPACE_RESOURCE_ID || ''),
    excludeDevices: parseDeviceList(readOption('exclude-devices', process.env.ALV_TELEMETRY_EXCLUDE_DEVICES || '')),
    minVersion: parseMinVersion(readOption('min-version', process.env.ALV_TELEMETRY_MIN_VERSION || ''))
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
    await queryWorkspace(
      workspace.workspaceCustomerId,
      buildTopEventsQuery({
        componentResourceId: component.id,
        lookback: config.lookback
      })
    )
  );
  const outcomes = toRows(
    await queryWorkspace(
      workspace.workspaceCustomerId,
      buildOutcomeQuery({
        componentResourceId: component.id,
        lookback: config.lookback
      })
    )
  );
  const latencies = toRows(
    await queryWorkspace(
      workspace.workspaceCustomerId,
      buildLatencyQuery({
        componentResourceId: component.id,
        lookback: config.lookback
      })
    )
  );
  const cliErrors = toRows(
    await queryWorkspace(
      workspace.workspaceCustomerId,
      buildCliErrorQuery({
        componentResourceId: component.id,
        lookback: config.lookback
      })
    )
  );
  const exceptions = toRows(
    await queryWorkspace(
      workspace.workspaceCustomerId,
      buildExceptionsQuery({
        componentResourceId: component.id,
        lookback: config.lookback
      })
    )
  );
  const searchCoverage = toRows(
    await queryWorkspace(
      workspace.workspaceCustomerId,
      buildSearchCoverageQuery({
        componentResourceId: component.id,
        lookback: config.lookback
      })
    )
  );

  const adoptionContext = {
    componentResourceId: component.id,
    lookback: config.lookback,
    excludeDevices: config.excludeDevices,
    minVersion: config.minVersion
  };
  const [funnel] = toRows(
    await queryWorkspace(workspace.workspaceCustomerId, buildAdoptionFunnelQuery(adoptionContext))
  );
  const weeks = toRows(await queryWorkspace(workspace.workspaceCustomerId, buildWeeklyAdoptionQuery(adoptionContext)));
  const countries = toRows(await queryWorkspace(workspace.workspaceCustomerId, buildCountryQuery(adoptionContext)));

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
  console.log(`- Excluded devices: ${config.excludeDevices.length}`);
  console.log(`- Adoption counts events from extension version: ${config.minVersion || 'any'}`);

  printTable('Adoption funnel (devices)', formatAdoptionFunnel(funnel), line => line);
  printTable(
    'Weekly devices (new means first seen in the lookback, so the first weeks also count earlier users; the last week is still in progress)',
    weeks,
    formatWeek
  );
  printTable(
    'Engaged devices by country',
    countries.slice(0, 10),
    row => `${row.country}: ${row.engaged} of ${row.devices}`
  );

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
  console.log(
    '- Salesforce CLI install, PATH validation, org auth, and troubleshooting should stay first if CLI/auth buckets dominate.'
  );
  console.log(
    '- The core workflow should stay explicit: select org, refresh logs, open viewer, tail logs, then cleanup/download as secondary paths.'
  );
  console.log(
    '- Debug Levels and Debug Flags deserve a troubleshooting section if debugLevels.load keeps a high error rate or slow p95 latency.'
  );
  if (searchEvents === 0) {
    console.log(
      '- Search/filter still has no dedicated telemetry signal in this component; add instrumentation before treating it as a measured adoption area.'
    );
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[telemetry-report] Failed:', error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  buildAdoptionFunnelQuery,
  buildCountryQuery,
  buildDeviceEventsQuery,
  buildWeeklyAdoptionQuery,
  formatAdoptionFunnel,
  parseDeviceList,
  parseMinVersion,
  buildCliErrorQuery,
  buildExceptionsQuery,
  buildLatencyQuery,
  buildOutcomeQuery,
  buildScopedBaseQuery,
  buildSearchCoverageQuery,
  buildTopEventsQuery,
  main
};
