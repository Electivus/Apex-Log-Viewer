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

function spawnAsync(command, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, options);
    child.on('error', reject);
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

async function prepareTelemetryValidationContext(
  config,
  component,
  resolveWorkspaceInfoImpl = resolveWorkspaceInfo
) {
  const workspace = await resolveWorkspaceInfoImpl({
    ...config,
    workspaceResourceId: component.workspaceResourceId || config.workspaceResourceId
  });

  return {
    componentResourceId: component.id,
    workspaceCustomerId: workspace.workspaceCustomerId
  };
}

async function prewarmTelemetryQueryToken(validationContext, runId, options = {}) {
  const queryTelemetryForRunImpl = options.queryTelemetryForRunImpl || queryTelemetryForRun;
  const lookback = String(options.lookback || '5m').trim() || '5m';
  await queryTelemetryForRunImpl(
    validationContext.workspaceCustomerId,
    validationContext.componentResourceId,
    runId,
    lookback
  );
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

function envFlag(env, name) {
  const normalized = String(env[name] || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function resolvePlaywrightChildInvocation(extraArgs, env = process.env, repoRoot = REPO_ROOT) {
  if (envFlag(env, 'ALV_E2E_TELEMETRY_PROXY_LAB')) {
    return {
      command: process.execPath,
      args: [
        path.join(repoRoot, 'scripts', 'run-e2e-proxy-lab.js'),
        'npm',
        'run',
        'test:e2e',
        '--',
        ...extraArgs
      ]
    };
  }

  return {
    command: process.execPath,
    args: [path.join(repoRoot, 'scripts', 'run-playwright-e2e.js'), ...extraArgs]
  };
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

async function waitForTelemetry(config, component, runId, options = {}) {
  const attempts = Math.max(1, Number(process.env.ALV_E2E_TELEMETRY_QUERY_ATTEMPTS || 18) || 18);
  const delayMs = Math.max(1000, Number(process.env.ALV_E2E_TELEMETRY_QUERY_DELAY_MS || 10000) || 10000);
  const lookback = String(process.env.ALV_E2E_TELEMETRY_LOOKBACK || '2h').trim() || '2h';
  const validationContext =
    options.validationContext ||
    (await prepareTelemetryValidationContext(config, component, options.resolveWorkspaceInfoImpl));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await queryTelemetryForRun(
      validationContext.workspaceCustomerId,
      validationContext.componentResourceId,
      runId,
      lookback
    );
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

  const finalResult = await queryTelemetryForRun(
    validationContext.workspaceCustomerId,
    validationContext.componentResourceId,
    runId,
    lookback
  );
  const finalRows = toRows(finalResult);
  const finalSummary = summarizeTelemetry(finalRows);
  throw new Error(
    `Telemetry validation failed for run ${runId}. Expected at least one activation event, 5 total events, and 3 distinct names, but observed ${finalSummary.totalEvents} events across ${finalSummary.distinctNames} names.`
  );
}

async function runTelemetryE2e(options = {}) {
  const env = options.env || process.env;
  const extraArgs = options.extraArgs || process.argv.slice(2);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const logger = options.logger || console;
  const randomUUIDImpl = options.randomUUIDImpl || randomUUID;
  const ensureTelemetryComponentImpl = options.ensureTelemetryComponentImpl || ensureTelemetryComponent;
  const prepareTelemetryValidationContextImpl =
    options.prepareTelemetryValidationContextImpl || prepareTelemetryValidationContext;
  const prewarmTelemetryQueryTokenImpl = options.prewarmTelemetryQueryTokenImpl || prewarmTelemetryQueryToken;
  const queryTelemetryForRunImpl = options.queryTelemetryForRunImpl || queryTelemetryForRun;
  const resolvePlaywrightChildInvocationImpl =
    options.resolvePlaywrightChildInvocationImpl || resolvePlaywrightChildInvocation;
  const spawnAsyncImpl = options.spawnAsyncImpl || spawnAsync;
  const waitForTelemetryImpl = options.waitForTelemetryImpl || waitForTelemetry;

  const config = resolveConfig(env);

  const { component, created } = await ensureTelemetryComponentImpl(config);
  const runId = randomUUIDImpl();

  logger.log(
    `[e2e] ${created ? 'Created' : 'Using'} dedicated Application Insights resource: ${component.name} (${component.resourceGroup})`
  );
  logger.log(`[e2e] Test telemetry run id: ${runId}`);

  const validationContext = await prepareTelemetryValidationContextImpl(config, component);
  await prewarmTelemetryQueryTokenImpl(validationContext, runId, { queryTelemetryForRunImpl });

  const childEnv = {
    ...env,
    ALV_ENABLE_TEST_TELEMETRY: '1',
    ALV_TEST_TELEMETRY_CONNECTION_STRING: component.connectionString,
    ALV_TEST_TELEMETRY_RUN_ID: runId
  };

  const childInvocation = resolvePlaywrightChildInvocationImpl(extraArgs, childEnv, repoRoot);
  const child = await spawnAsyncImpl(childInvocation.command, childInvocation.args, {
    cwd: repoRoot,
    env: childEnv,
    stdio: 'inherit'
  });

  if (typeof child.code === 'number' && child.code !== 0) {
    return { exitCode: child.code };
  }
  if (child.signal) {
    throw new Error(`Playwright E2E process exited via signal ${child.signal}.`);
  }

  logger.log('[e2e] Playwright suite passed. Validating telemetry arrival in the linked Log Analytics workspace...');
  const validation = await waitForTelemetryImpl(config, component, runId, { validationContext });
  logger.log(
    `[e2e] Telemetry validated after ${validation.attempt} query attempt(s): ${validation.summary.totalEvents} events across ${validation.summary.distinctNames} event names.`
  );
  for (const row of validation.rows) {
    logger.log(`[e2e] ${row.name}: ${row.events}`);
  }

  return { exitCode: 0, validation };
}

async function main() {
  const result = await runTelemetryE2e();
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
    process.exit(result.exitCode);
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
  prepareTelemetryValidationContext,
  prewarmTelemetryQueryToken,
  resolveConfig,
  resolvePlaywrightChildInvocation,
  runTelemetryE2e,
  spawnAsync,
  summarizeTelemetry
};
