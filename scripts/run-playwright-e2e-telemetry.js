#!/usr/bin/env node
'use strict';

const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const {
  azJson,
  kqlQuote,
  normalizeResourceId,
  queryWorkspace,
  resolveWorkspaceInfo,
  showComponent: showComponentFromAzure,
  toRows
} = require('./azure-monitor-helpers');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const REPO_ROOT = path.join(__dirname, '..');

function spawnAsync(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, options);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function isResourceNotFound(error) {
  const text = [error && error.message, error && error.stderr, error && error.stdout].filter(Boolean).join('\n');
  return /ResourceNotFound|was not found|ARMResourceNotFoundFix/i.test(text);
}

async function showComponentForConfig(config, appName) {
  return showComponentFromAzure({
    appName,
    resourceGroup: config.resourceGroup,
    subscription: config.subscription
  });
}

async function resolveWorkspaceId(config) {
  return (await resolveWorkspaceInfo(config)).workspaceResourceId;
}

async function ensureTelemetryComponent(config) {
  try {
    const existing = await showComponentForConfig(config, config.appName);
    return { component: existing, created: false };
  } catch (error) {
    if (!isResourceNotFound(error)) {
      throw error;
    }
  }

  const workspaceResourceId = await resolveWorkspaceId(config);
  const created = await azJson([
    'monitor',
    'app-insights',
    'component',
    'create',
    '-a',
    config.appName,
    '-g',
    config.resourceGroup,
    '-l',
    config.location,
    '--kind',
    'web',
    '--application-type',
    'web',
    '--workspace',
    workspaceResourceId,
    '--subscription',
    config.subscription,
    '--tags',
    'app=apex-log-viewer',
    'component=telemetry',
    'env=e2e',
    'managed-by=az-cli',
    'repo=Apex-Log-Viewer'
  ]);
  return { component: created, created: true };
}

function buildRunValidationQuery({ componentResourceId, lookback, runId }) {
  return [
    'AppEvents',
    `| where TimeGenerated > ago(${lookback})`,
    `| where _ResourceId =~ ${kqlQuote(normalizeResourceId(componentResourceId))}`,
    '| extend props = parse_json(Properties)',
    `| where tostring(props["testRunId"]) == ${kqlQuote(runId)}`,
    '| summarize events = sum(coalesce(tolong(ItemCount), 1)) by name = Name',
    '| order by events desc'
  ].join(' ');
}

async function queryTelemetryForRun(workspaceCustomerId, componentResourceId, runId, lookback) {
  const query = buildRunValidationQuery({ componentResourceId, lookback, runId });
  return queryWorkspace(workspaceCustomerId, query);
}

function summarizeTelemetry(rows) {
  const totalEvents = rows.reduce((sum, row) => sum + Number(row.events || 0), 0);
  const distinctNames = rows.length;
  const hasActivation = rows.some(row => /(^|\/)extension\.activate$/.test(String(row.name || '')));
  return { distinctNames, hasActivation, totalEvents };
}

function readEnv(env, name) {
  return String(env[name] || '').trim();
}

function resolveConfig(env = process.env) {
  const config = {
    appName: readEnv(env, 'ALV_E2E_TELEMETRY_APP'),
    baseApp: readEnv(env, 'ALV_E2E_TELEMETRY_BASE_APP'),
    location: readEnv(env, 'ALV_E2E_TELEMETRY_LOCATION') || 'eastus',
    resourceGroup: readEnv(env, 'ALV_E2E_TELEMETRY_RESOURCE_GROUP'),
    subscription: readEnv(env, 'ALV_E2E_TELEMETRY_SUBSCRIPTION') || readEnv(env, 'AZURE_SUBSCRIPTION_ID'),
    workspaceResourceId: readEnv(env, 'ALV_E2E_TELEMETRY_WORKSPACE_RESOURCE_ID') || undefined
  };

  const missing = [];
  if (!config.appName) missing.push('ALV_E2E_TELEMETRY_APP');
  if (!config.baseApp) missing.push('ALV_E2E_TELEMETRY_BASE_APP');
  if (!config.resourceGroup) missing.push('ALV_E2E_TELEMETRY_RESOURCE_GROUP');
  if (!config.subscription) missing.push('ALV_E2E_TELEMETRY_SUBSCRIPTION or AZURE_SUBSCRIPTION_ID');

  if (missing.length > 0) {
    throw new Error(
      `Missing required Azure telemetry config: ${missing.join(
        ', '
      )}. Set these env vars directly or configure the matching CI variables/secrets before running the telemetry E2E path.`
    );
  }

  return config;
}

async function waitForTelemetry(config, component, runId) {
  const attempts = Math.max(1, Number(process.env.ALV_E2E_TELEMETRY_QUERY_ATTEMPTS || 18) || 18);
  const delayMs = Math.max(1000, Number(process.env.ALV_E2E_TELEMETRY_QUERY_DELAY_MS || 10000) || 10000);
  const lookback = String(process.env.ALV_E2E_TELEMETRY_LOOKBACK || '2h').trim() || '2h';
  const workspace = await resolveWorkspaceInfo({
    ...config,
    workspaceResourceId: component.workspaceResourceId || config.workspaceResourceId
  });

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await queryTelemetryForRun(workspace.workspaceCustomerId, component.id, runId, lookback);
    const rows = toRows(result);
    const summary = summarizeTelemetry(rows);
    if (summary.hasActivation && summary.totalEvents >= 5 && summary.distinctNames >= 3) {
      return { rows, summary, attempt };
    }
    if (attempt < attempts) {
      console.log(
        `[e2e] Waiting for Log Analytics ingestion (${attempt}/${attempts}) -> ${summary.totalEvents} events, ${summary.distinctNames} names`
      );
      await sleep(delayMs);
    }
  }

  const finalResult = await queryTelemetryForRun(workspace.workspaceCustomerId, component.id, runId, lookback);
  const finalRows = toRows(finalResult);
  const finalSummary = summarizeTelemetry(finalRows);
  throw new Error(
    `Telemetry validation failed for run ${runId}. Expected at least one activation event, 5 total events, and 3 distinct names, but observed ${finalSummary.totalEvents} events across ${finalSummary.distinctNames} names.`
  );
}

async function main() {
  const config = resolveConfig(process.env);

  const { component, created } = await ensureTelemetryComponent(config);
  const runId = randomUUID();

  console.log(
    `[e2e] ${created ? 'Created' : 'Using'} dedicated Application Insights resource: ${component.name} (${component.resourceGroup})`
  );
  console.log(`[e2e] Test telemetry run id: ${runId}`);

  const childEnv = {
    ...process.env,
    ALV_ENABLE_TEST_TELEMETRY: '1',
    ALV_TEST_TELEMETRY_CONNECTION_STRING: component.connectionString,
    ALV_TEST_TELEMETRY_RUN_ID: runId
  };

  const child = await spawnAsync(
    process.execPath,
    [path.join(__dirname, 'run-playwright-e2e.js'), ...process.argv.slice(2)],
    {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: 'inherit'
    }
  );

  if (typeof child.code === 'number' && child.code !== 0) {
    process.exit(child.code);
    return;
  }
  if (child.signal) {
    throw new Error(`Playwright E2E process exited via signal ${child.signal}.`);
  }

  console.log('[e2e] Playwright suite passed. Validating telemetry arrival in the linked Log Analytics workspace...');
  const validation = await waitForTelemetry(config, component, runId);
  console.log(
    `[e2e] Telemetry validated after ${validation.attempt} query attempt(s): ${validation.summary.totalEvents} events across ${validation.summary.distinctNames} event names.`
  );
  for (const row of validation.rows) {
    console.log(`[e2e] ${row.name}: ${row.events}`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[e2e] Telemetry validation failed:', error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  buildRunValidationQuery,
  resolveConfig,
  summarizeTelemetry
};
