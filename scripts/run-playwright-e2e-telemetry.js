#!/usr/bin/env node
'use strict';

const { randomUUID } = require('crypto');
const { execFile, spawn } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const AZ_COMMAND = 'az';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr || stdout || error.message || 'exec failed');
        err.code = error.code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function execCommandAsync(command, args, options = {}) {
  if (process.platform === 'win32') {
    return execFileAsync('cmd.exe', ['/d', '/s', '/c', command, ...args], options);
  }
  return execFileAsync(command, args, options);
}

function spawnAsync(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, options);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function parseJson(text) {
  return JSON.parse(String(text || '').trim());
}

function toRows(result) {
  const table = result && Array.isArray(result.tables) ? result.tables[0] : undefined;
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    return [];
  }
  return table.rows.map(row => {
    const entry = {};
    for (let index = 0; index < table.columns.length; index++) {
      entry[table.columns[index].name] = row[index];
    }
    return entry;
  });
}

function isResourceNotFound(error) {
  const text = [error && error.message, error && error.stderr, error && error.stdout].filter(Boolean).join('\n');
  return /ResourceNotFound|was not found|ARMResourceNotFoundFix/i.test(text);
}

function kqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function azJson(args) {
  const { stdout } = await execCommandAsync(AZ_COMMAND, [...args, '-o', 'json'], {
    cwd: REPO_ROOT,
    maxBuffer: 10 * 1024 * 1024
  });
  return parseJson(stdout);
}

async function showComponent(config, appName) {
  return azJson([
    'monitor',
    'app-insights',
    'component',
    'show',
    '-a',
    appName,
    '-g',
    config.resourceGroup,
    '--subscription',
    config.subscription
  ]);
}

async function resolveWorkspaceId(config) {
  if (config.workspaceResourceId) {
    return config.workspaceResourceId;
  }
  const base = await showComponent(config, config.baseApp);
  if (!base.workspaceResourceId) {
    throw new Error(`Base Application Insights resource "${config.baseApp}" does not expose a workspaceResourceId.`);
  }
  return base.workspaceResourceId;
}

async function ensureTelemetryComponent(config) {
  try {
    const existing = await showComponent(config, config.appName);
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

async function queryTelemetryForRun(config, runId, lookback) {
  const query = [
    'customEvents',
    `| where timestamp > ago(${lookback})`,
    `| extend runId = tostring(customDimensions['testRunId'])`,
    `| where runId == ${kqlQuote(runId)}`,
    '| summarize events = count() by name',
    '| order by events desc'
  ].join(' ');

  return azJson([
    'monitor',
    'app-insights',
    'query',
    '-a',
    config.appName,
    '-g',
    config.resourceGroup,
    '--subscription',
    config.subscription,
    '--analytics-query',
    query
  ]);
}

function summarizeTelemetry(rows) {
  const totalEvents = rows.reduce((sum, row) => sum + Number(row.events || 0), 0);
  const distinctNames = rows.length;
  const hasActivation = rows.some(row => /(^|\/)extension\.activate$/.test(String(row.name || '')));
  return { distinctNames, hasActivation, totalEvents };
}

async function waitForTelemetry(config, runId) {
  const attempts = Math.max(1, Number(process.env.ALV_E2E_TELEMETRY_QUERY_ATTEMPTS || 18) || 18);
  const delayMs = Math.max(1000, Number(process.env.ALV_E2E_TELEMETRY_QUERY_DELAY_MS || 10000) || 10000);
  const lookback = String(process.env.ALV_E2E_TELEMETRY_LOOKBACK || '2h').trim() || '2h';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await queryTelemetryForRun(config, runId, lookback);
    const rows = toRows(result);
    const summary = summarizeTelemetry(rows);
    if (summary.hasActivation && summary.totalEvents >= 5 && summary.distinctNames >= 3) {
      return { rows, summary, attempt };
    }
    if (attempt < attempts) {
      console.log(
        `[e2e] Waiting for App Insights ingestion (${attempt}/${attempts}) -> ${summary.totalEvents} events, ${summary.distinctNames} names`
      );
      await sleep(delayMs);
    }
  }

  const finalResult = await queryTelemetryForRun(config, runId, lookback);
  const finalRows = toRows(finalResult);
  const finalSummary = summarizeTelemetry(finalRows);
  throw new Error(
    `Telemetry validation failed for run ${runId}. Expected at least one activation event, 5 total events, and 3 distinct names, but observed ${finalSummary.totalEvents} events across ${finalSummary.distinctNames} names.`
  );
}

async function main() {
  const config = {
    appName: String(process.env.ALV_E2E_TELEMETRY_APP || 'appi-apex-log-viewer-telemetry-e2e-eastus').trim(),
    baseApp: String(process.env.ALV_E2E_TELEMETRY_BASE_APP || 'appi-apex-log-viewer-telemetry-eastus').trim(),
    location: String(process.env.ALV_E2E_TELEMETRY_LOCATION || 'eastus').trim(),
    resourceGroup: String(process.env.ALV_E2E_TELEMETRY_RESOURCE_GROUP || 'rg-apex-log-viewer-telemetry-eastus').trim(),
    subscription: String(
      process.env.ALV_E2E_TELEMETRY_SUBSCRIPTION || 'c1b4d537-c3dc-4d64-b022-a97fd1826665'
    ).trim(),
    workspaceResourceId: String(process.env.ALV_E2E_TELEMETRY_WORKSPACE_RESOURCE_ID || '').trim() || undefined
  };

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

  const child = await spawnAsync(process.execPath, [path.join(__dirname, 'run-playwright-e2e.js'), ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: 'inherit'
  });

  if (typeof child.code === 'number' && child.code !== 0) {
    process.exit(child.code);
    return;
  }
  if (child.signal) {
    throw new Error(`Playwright E2E process exited via signal ${child.signal}.`);
  }

  console.log('[e2e] Playwright suite passed. Validating telemetry arrival in the dedicated App Insights resource...');
  const validation = await waitForTelemetry(config, runId);
  console.log(
    `[e2e] Telemetry validated after ${validation.attempt} query attempt(s): ${validation.summary.totalEvents} events across ${validation.summary.distinctNames} event names.`
  );
  for (const row of validation.rows) {
    console.log(`[e2e] ${row.name}: ${row.events}`);
  }
}

main().catch(error => {
  console.error('[e2e] Telemetry validation failed:', error && error.message ? error.message : error);
  process.exit(1);
});
