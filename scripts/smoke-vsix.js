#!/usr/bin/env node
/* VSIX smoke test: builds the VSIX, installs it into a clean VS Code profile,
 * then launches a minimal test harness to activate the extension and verify
 * key commands are registered. Fails on any activation/packaging regression.
 */
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { join, resolve } = require('path');
const { tmpdir, platform } = require('os');
const { spawnSync } = require('child_process');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    fail(`Command failed: ${cmd} ${args.join(' ')}`);
  }
  return res;
}

async function main() {
  const id = 'electivus.apex-log-viewer';
  // 1) Package VSIX (reuse project script)
  sh('npm', ['run', '-s', 'package']);
  sh('npx', ['--no-install', 'vsce', 'package', '--no-yarn']);
  // Grab first .vsix in cwd
  const vsix = require('fs').readdirSync(process.cwd()).find(f => /\.vsix$/.test(f));
  if (!vsix) fail('VSIX not found in current directory');

  // 2) Prepare VS Code + isolate profile dirs
  const vsVer = process.env.VSCODE_SMOKE_VERSION || 'insiders';
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vsVer);
  const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });

  // 3) Install the VSIX into the clean profile
  sh(cliPath, [
    ...cliArgs,
    '--install-extension', resolve(vsix),
    '--force'
  ], { env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });

  // 4) Create a minimal harness extension under a temp folder
  const dev = mkdtempSync(join(tmpdir(), 'alv-smoke-dev-'));
  const pkg = {
    name: 'alv-smoke-harness',
    displayName: 'ALV Smoke Harness',
    version: '0.0.0',
    engines: { vscode: '*' },
    main: './index.js',
    activationEvents: ['*']
  };
  writeFileSync(join(dev, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dev, 'index.js'), "exports.activate=()=>{};exports.deactivate=()=>{};\n");

  // 5) Write the smoke test runner (Mocha programmatic)
  const testsDir = mkdtempSync(join(tmpdir(), 'alv-smoke-tests-'));
  const runner = `"use strict";\nconst assert = require('assert/strict');\nconst vscode = require('vscode');\nconst Mocha = require('mocha');\nexports.run = async function run() {\n  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000, reporter: 'spec' });\n  mocha.suite.emit('pre-require', global, 'global', mocha);\n  suite('smoke: vsix activation', () => {\n    test('activates and registers commands', async () => {\n      const ext = vscode.extensions.getExtension('${id}');\n      assert.ok(ext, 'extension not found');\n      await ext.activate();\n      const cmds = await vscode.commands.getCommands(true);\n      for (const c of ['sfLogs.refresh','sfLogs.selectOrg','sfLogs.tail','sfLogs.showDiagram']) {\n        assert.ok(cmds.includes(c), 'missing command: '+c);\n      }\n    });\n  });\n  await new Promise((resolve, reject) => mocha.run(f => f ? reject(new Error(String(f)+' failing tests')) : resolve()));\n};\n`;
  const runnerPath = join(testsDir, 'smoke-runner.js');
  writeFileSync(runnerPath, runner, 'utf8');

  // 6) Environment hardening for headless CI
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_DISABLE_GPU = env.ELECTRON_DISABLE_GPU || '1';
  env.LC_ALL = env.LC_ALL || 'C.UTF-8';
  env.DONT_PROMPT_WSL_INSTALL = env.DONT_PROMPT_WSL_INSTALL || '1';
  if (platform() === 'linux' && !env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = '/dev/null';
    env.NO_AT_BRIDGE = '1';
  }

  // 7) Launch tests against the installed VSIX
  try {
    const [cliPath2, ...cliArgs2] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
    const args = [
      ...cliArgs2,
      '--extensionDevelopmentPath', dev,
      `--extensionTestsPath=${runnerPath}`,
      '--skip-welcome', '--skip-release-notes'
    ];
    const res = spawnSync(cliPath2, args, { stdio: ['pipe','inherit','inherit'], env, input: 'y\n' });
    if (res.status !== 0) fail(`VSIX smoke failed with exit code ${res.status}`);
  } finally {
    try { rmSync(dev, { recursive: true, force: true }); } catch {}
    try { rmSync(testsDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error(err && err.stack || String(err));
  process.exit(1);
});
