#!/usr/bin/env node
'use strict';

const { execFile, spawn } = require('child_process');
const { existsSync } = require('fs');
const { platform } = require('os');
const path = require('path');

function resolveRuntimeBinaryRelativePath(targetPlatform = process.platform, targetArch = process.arch) {
  const target = `${targetPlatform}-${targetArch}`;
  const bin = targetPlatform === 'win32' ? 'apex-log-viewer.exe' : 'apex-log-viewer';
  return path.posix.join('apps', 'vscode-extension', 'bin', target, bin);
}

const requiredBuildArtifacts = [
  resolveRuntimeBinaryRelativePath(),
  'apps/vscode-extension/dist/extension.js',
  'apps/vscode-extension/media/webview.css',
  'apps/vscode-extension/media/main.js',
  'apps/vscode-extension/media/tail.js',
  'apps/vscode-extension/media/logViewer.js',
  'apps/vscode-extension/media/debugFlags.js'
];

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
      args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'build']
    };
  }

  return {
    command: 'npm',
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
  if (!missingArtifacts.length) {
    return;
  }

  console.log(
    `[e2e] Missing build artifacts (${missingArtifacts.join(', ')}). Running npm run build before Playwright...`
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
    throw new Error(`npm run build failed while preparing Playwright E2E (${details}).`);
  }
}

function resolvePlaywrightInvocation(extraArgs) {
  try {
    // Prefer the local Playwright CLI directly. On Windows under Git Bash,
    // spawning npx.cmd can throw EINVAL before Playwright even starts.
    const cliPath = require.resolve('@playwright/test/cli');
    return {
      command: process.execPath,
      args: [cliPath, 'test', ...extraArgs]
    };
  } catch {}

  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['playwright', 'test', ...extraArgs]
  };
}

async function main() {
  // Some environments leak ELECTRON_RUN_AS_NODE=1; VS Code won't boot properly.
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } catch {}

  // Re-exec under Xvfb when DISPLAY is missing on Linux.
  if (platform() === 'linux' && !process.env.DISPLAY && !process.env.__ALV_XVFB_RAN) {
    try {
      await execFileAsync('bash', ['-lc', 'command -v xvfb-run >/dev/null 2>&1']);
      const child = spawn(
        'xvfb-run',
        ['-a', '-s', '-screen 0 1280x1024x24', process.execPath, __filename, ...process.argv.slice(2)],
        {
          stdio: 'inherit',
          env: { ...process.env, __ALV_XVFB_RAN: '1' }
        }
      );
      child.on('exit', exitWithChildResult);
      return;
    } catch {
      // no xvfb-run; continue and let Electron try (may fail)
    }
  }

  const repoRoot = path.join(__dirname, '..');
  await ensureBuildArtifacts(repoRoot);
  const invocation = resolvePlaywrightInvocation(process.argv.slice(2));
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env
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
  resolveRuntimeBinaryRelativePath,
  resolveBuildInvocation,
  resolvePlaywrightInvocation
};
