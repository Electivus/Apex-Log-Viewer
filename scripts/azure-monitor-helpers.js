'use strict';

const { execFile } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const AZ_COMMAND = 'az';

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

function parseJson(text) {
  return JSON.parse(String(text || '').trim());
}

function toRows(result) {
  if (Array.isArray(result)) {
    return result;
  }

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

function kqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeResourceId(resourceId) {
  return String(resourceId || '').trim().toLowerCase();
}

async function azJson(args, options = {}) {
  const { cwd = REPO_ROOT, ...rest } = options;
  const { stdout } = await execCommandAsync(AZ_COMMAND, [...args, '-o', 'json'], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    ...rest
  });
  return parseJson(stdout);
}

async function showComponent({ appName, resourceGroup, subscription }) {
  return azJson([
    'monitor',
    'app-insights',
    'component',
    'show',
    '-a',
    appName,
    '-g',
    resourceGroup,
    '--subscription',
    subscription
  ]);
}

async function showWorkspaceById(workspaceResourceId) {
  return azJson(['monitor', 'log-analytics', 'workspace', 'show', '--ids', workspaceResourceId]);
}

async function resolveWorkspaceInfo(config) {
  const workspaceResourceId =
    config.workspaceResourceId ||
    (await showComponent({
      appName: config.baseApp || config.appName,
      resourceGroup: config.resourceGroup,
      subscription: config.subscription
    })).workspaceResourceId;

  if (!workspaceResourceId) {
    throw new Error(
      `Application Insights resource "${config.baseApp || config.appName}" does not expose a workspaceResourceId.`
    );
  }

  const workspace = await showWorkspaceById(workspaceResourceId);
  if (!workspace.customerId) {
    throw new Error(`Workspace "${workspaceResourceId}" does not expose a customerId.`);
  }

  return {
    workspaceResourceId,
    workspaceCustomerId: workspace.customerId,
    workspaceName: workspace.name
  };
}

async function queryWorkspace(workspaceId, query, options = {}) {
  return azJson(['monitor', 'log-analytics', 'query', '-w', workspaceId, '--analytics-query', query], options);
}

module.exports = {
  azJson,
  kqlQuote,
  normalizeResourceId,
  parseJson,
  queryWorkspace,
  resolveWorkspaceInfo,
  showComponent,
  showWorkspaceById,
  toRows
};
