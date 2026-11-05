#!/usr/bin/env node
'use strict';

const { execFile, spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');
const { XVFB_ARGS, shouldUseXvfb } = require('./e2e-display');
const { bootstrapLocalE2e } = require('./local-e2e-bootstrap');

const requiredBuildArtifacts = [
  'apps/vscode-extension/dist/extension.js',
  'apps/vscode-extension/media/webview.css',
  'apps/vscode-extension/media/main.js',
  'apps/vscode-extension/media/tail.js',
  'apps/vscode-extension/media/logViewer.js',
  'apps/vscode-extension/media/debugFlags.js'
];
const DEFAULT_PLAYWRIGHT_RETRIES = '2';

function hasExplicitShardArg(args = []) {
  return args.some(arg => arg === '--shard' || String(arg).startsWith('--shard='));
}

function resolvePlaywrightShardArgs(extraArgs = [], env = process.env) {
  if (hasExplicitShardArg(extraArgs)) {
    return [];
  }

  const configuredShard = String(env.PLAYWRIGHT_SHARD ?? '').trim();
  if (!configuredShard) {
    return [];
  }

  const match = configuredShard.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(`PLAYWRIGHT_SHARD must use the format current/total, got '${configuredShard}'.`);
  }

  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current < 1 || total < 1 || current > total) {
    throw new Error(`PLAYWRIGHT_SHARD must satisfy 1 <= current <= total, got '${configuredShard}'.`);
  }

  return [`--shard=${current}/${total}`];
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(stderr || error.message || 'exec failed');
        err.code = error.code;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function exitWithChildResult(code, signal) {
  if (typeof code === 'number') {
    process.exit(code);
    return;
  }
  if (signal) {
    console.error(`[e2e] Child process exited via signal: ${signal}`);
  } else {
    console.error('[e2e] Child process exited with null exit code.');
  }
  process.exit(1);
}

function resolveBuildInvocation(targetPlatform = process.platform) {
  if (targetPlatform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'run', 'build']
    };
  }

  return {
    command: 'pnpm',
    args: ['run', 'build']
  };
}

function findMissingBuildArtifacts(repoRoot) {
  return requiredBuildArtifacts.filter(relativePath => !existsSync(path.join(repoRoot, relativePath)));
}

function spawnAsync(command, args, options = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, options);
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function ensureBuildArtifacts(repoRoot, options = {}) {
  const missingArtifacts = findMissingBuildArtifacts(repoRoot);
  if (!missingArtifacts.length && !options.force) {
    return;
  }

  console.log(
    options.force
      ? '[e2e] Building before Playwright with the prepared runtime environment...'
      : `[e2e] Missing build artifacts (${missingArtifacts.join(', ')}). Running pnpm run build before Playwright...`
  );
  const buildInvocation = resolveBuildInvocation();
  const result = await spawnAsync(
    buildInvocation.command,
    buildInvocation.args,
    { cwd: repoRoot, env: process.env, stdio: 'inherit' },
    options.spawnImpl
  );
  if (result.code !== 0) {
    const details =
      typeof result.code === 'number' ? `exit code ${result.code}` : `signal ${result.signal || 'unknown'}`;
    throw new Error(`pnpm run build failed while preparing Playwright E2E (${details}).`);
  }
}

/**
 * `pnpm run test:e2e -- <spec>` hands the script a literal leading `--`, and Playwright ignores every
 * path after `--`, so the run would ignore the filter and take the whole suite.
 */
function withoutLeadingArgSeparator(args = []) {
  return args[0] === '--' ? args.slice(1) : args;
}

function resolvePlaywrightInvocation(rawExtraArgs) {
  const extraArgs = withoutLeadingArgSeparator(rawExtraArgs);
  const rawRetries = String(process.env.PLAYWRIGHT_RETRIES ?? '').trim();
  const configuredRetries = rawRetries === '' ? DEFAULT_PLAYWRIGHT_RETRIES : rawRetries;
  if (!/^\d+$/.test(configuredRetries)) {
    throw new Error(`PLAYWRIGHT_RETRIES must be a non-negative integer, got '${configuredRetries}'.`);
  }
  const retryArgs = [`--retries=${configuredRetries}`];
  const shardArgs = resolvePlaywrightShardArgs(extraArgs);

  try {
    // Prefer the local Playwright CLI directly. On Windows under Git Bash,
    // spawning npx.cmd can throw EINVAL before Playwright even starts.
    const cliPath = require.resolve('@playwright/test/cli');
    return {
      command: process.execPath,
      args: [cliPath, 'test', ...retryArgs, ...shardArgs, ...extraArgs]
    };
  } catch {}

  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['playwright', 'test', ...retryArgs, ...shardArgs, ...extraArgs]
  };
}

function resolvePlaywrightEnv(env = process.env, nodePath = process.execPath) {
  const resolvedEnv = { ...env };
  if (!String(resolvedEnv.ALV_NODE_BIN_PATH || '').trim() && nodePath) {
    resolvedEnv.ALV_NODE_BIN_PATH = nodePath;
  }
  return resolvedEnv;
}

async function main() {
  const localRun = await bootstrapLocalE2e({ entrypoint: __filename, args: process.argv.slice(2), gui: true });
  if (localRun) {
    exitWithChildResult(localRun.code, localRun.signal);
    return;
  }

  // Some environments leak ELECTRON_RUN_AS_NODE=1; VS Code won't boot properly.
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } catch {}

  // On Linux, re-exec under Xvfb so VS Code stays hidden, even when a DISPLAY exists.
  // ALV_E2E_SHOW_VSCODE=1 keeps the current DISPLAY instead.
  if (shouldUseXvfb(process.env)) {
    try {
      await execFileAsync('bash', ['-lc', 'command -v xvfb-run >/dev/null 2>&1']);
      const child = spawn('xvfb-run', [...XVFB_ARGS, process.execPath, __filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, __ALV_XVFB_RAN: '1' }
      });
      child.on('exit', exitWithChildResult);
      return;
    } catch {
      // No xvfb-run: use the current DISPLAY if there is one, otherwise let Electron try (may fail).
      if (process.env.DISPLAY) {
        console.warn('[e2e] xvfb-run not found; VS Code will open on the current display. Install xvfb to hide it.');
      }
    }
  }

  const repoRoot = path.join(__dirname, '..');
  // Package commands always rebuild, including when outputs already exist.
  // Running this after bootstrap keeps the build in the prepared environment.
  await ensureBuildArtifacts(repoRoot, { force: process.env.npm_lifecycle_event === 'test:e2e' });
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: resolvePlaywrightEnv(process.env)
  });
  child.on('exit', exitWithChildResult);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[e2e] Failed to run Playwright E2E tests:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  ensureBuildArtifacts,
  findMissingBuildArtifacts,
  requiredBuildArtifacts,
  resolveBuildInvocation,
  resolvePlaywrightEnv,
  resolvePlaywrightShardArgs,
  resolvePlaywrightInvocation,
  withoutLeadingArgSeparator
};
