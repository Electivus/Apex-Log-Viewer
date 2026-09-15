'use strict';

const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { hasDevHubJwtConfig } = require('./devhub-auth');

function assertSupportedNode(
  version = process.versions.node,
  baseline = readFileSync(path.join(__dirname, '..', '.nvmrc'), 'utf8').trim()
) {
  const actual = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const required = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseline)?.slice(1).map(Number);
  if (!required) throw new Error('Native Linux E2E requires a complete Node version in .nvmrc.');
  if (
    !actual ||
    actual[0] !== required[0] ||
    actual[1] < required[1] ||
    (actual[1] === required[1] && actual[2] < required[2])
  ) {
    throw new Error(
      `Native Linux E2E requires Node ${required[0]}.x at least ${baseline}; detected ${version}. Select the .nvmrc version in this shell (for example: fnm use).`
    );
  }
}

async function bootstrapLocalE2e(
  { entrypoint, args = [], gui = false },
  { env = process.env, platform = process.platform, home = homedir(), spawnImpl = spawn } = {}
) {
  const ci = /^(1|true)$/i.test(String(env.CI || '').trim()) || String(env.GITHUB_ACTIONS || '').trim() === 'true';
  // The private Linux configuration is an explicit local opt-in. CI and callers
  // supplying any credential input retain their existing validation contract,
  // including rejection of partial JWT and legacy alias/auth-URL inputs.
  if (
    platform !== 'linux' ||
    ci ||
    hasDevHubJwtConfig(env) ||
    env.SF_DEVHUB_ALIAS ||
    env.SF_DEVHUB_AUTH_URL ||
    env.SFDX_AUTH_URL ||
    args.some(arg => ['--help', '-h', '--version', '-V', '--list', '--config', '-c'].includes(arg)) ||
    args.some(arg => arg.startsWith('--config=') || arg.startsWith('-c='))
  ) {
    return undefined;
  }

  const config = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'electivus', 'apex-log-viewer', 'e2e.sh');
  if (!existsSync(config)) return undefined;

  const command = ['node', entrypoint, ...args];
  if (gui) command.unshift('xvfb-run', '-a', '-s', '-screen 0 1280x1024x24');

  return new Promise((resolve, reject) => {
    const child = spawnImpl('bash', [path.join(__dirname, 'run-wsl-e2e.sh'), 'run', '--', ...command], {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: 'inherit'
    });
    child.once('error', () => reject(new Error('Cannot start the configured local E2E environment.')));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

module.exports = { assertSupportedNode, bootstrapLocalE2e };
