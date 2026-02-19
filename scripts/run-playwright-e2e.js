#!/usr/bin/env node
'use strict';

const { execFile, spawn } = require('child_process');
const { platform } = require('os');
const path = require('path');

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
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['playwright', 'test', ...process.argv.slice(2)];
  const child = spawn(cmd, args, { stdio: 'inherit', cwd: repoRoot, env: process.env });
  child.on('exit', exitWithChildResult);
}

main().catch(err => {
  console.error('[e2e] Failed to run Playwright E2E tests:', err && err.message ? err.message : err);
  process.exit(1);
});
