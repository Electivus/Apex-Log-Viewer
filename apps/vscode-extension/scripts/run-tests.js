const { spawn, execFile, spawnSync } = require('child_process');
const { platform, tmpdir } = require('os');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join, resolve } = require('path');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');
const { cleanVsCodeTest } = require('./clean-vscode-test.js');

function execFileAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 * 10, encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) {
        const output = [stderr, stdout].filter(Boolean).join('\n').trim();
        const e = new Error(output || err.message);
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout, stderr });
    });
  });
}

function execStreaming(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      const e = new Error(`Command failed: ${file} ${args.join(' ')}`);
      e.code = code;
      reject(e);
    });
  });
}

function addLocalBinToPath() {
  try {
    const bin = join(process.cwd(), 'node_modules', '.bin');
    const sep = platform() === 'win32' ? ';' : ':';
    const pathNow = process.env.PATH || '';
    if (!pathNow.split(sep).includes(bin)) {
      process.env.PATH = bin + sep + pathNow;
    }
  } catch (e) {
    console.warn('Failed to add local bin to PATH:', e && e.message ? e.message : e);
  }
}

function normalizeForMatch(value) {
  if (!value) {
    return null;
  }
  return value.replace(/\\/g, '/').toLowerCase();
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function killLeakedVSCodeProcesses(markers) {
  const normalized = Array.from(new Set(markers.map(normalizeForMatch).filter(Boolean)));
  if (normalized.length === 0) {
    return;
  }

  const plat = platform();
  if (plat === 'win32') {
    try {
      const markerExpr = normalized.map(m => m.replace(/"/g, '""')).join(' -and ');
      const psCommand =
        `$procs = Get-CimInstance Win32_Process | Where-Object { ${normalized
          .map((m, idx) => `$_.CommandLine -like '*${m.replace(/'/g, "''")}*'`)
          .join(' -or ')} }; $pids = $procs | ForEach-Object { $_.ProcessId }; if ($pids) { $pids }`;
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', psCommand]);
      const pids = stdout
        .split(/\r?\n/)
        .map(l => Number.parseInt(l, 10))
        .filter(n => Number.isInteger(n));
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch (e) {
          console.warn('[test-runner] Failed to terminate VS Code process', pid, e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      console.warn('[test-runner] Unable to enumerate VS Code processes on Windows:', e && e.message ? e.message : e);
    }
    return;
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync('ps', ['-eo', 'pid=,args=']));
  } catch (e) {
    console.warn('[test-runner] Failed to list processes for VS Code cleanup:', e && e.message ? e.message : e);
    return;
  }

  const toKill = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^([0-9]+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    if (pid === process.pid || pid === process.ppid) {
      continue;
    }
    const cmd = normalizeForMatch(match[2] || '');
    if (!Number.isInteger(pid) || !cmd) {
      continue;
    }
    if (normalized.some(marker => cmd.includes(marker))) {
      toKill.add(pid);
    }
  }

  if (!toKill.size) {
    return;
  }

  for (const pid of toKill) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      if (e && e.code !== 'ESRCH') {
        console.warn('[test-runner] Failed to TERM VS Code process', pid, e.message || e);
      }
    }
  }

  await delay(300);

  for (const pid of toKill) {
    if (!isProcessAlive(pid)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      if (e && e.code !== 'ESRCH') {
        console.warn('[test-runner] Failed to KILL VS Code process', pid, e.message || e);
      }
    }
  }
}

async function whichSf() {
  try {
    await execFileAsync('sf', ['--version']);
    return 'sf';
  } catch (e) {
    try {
      await execFileAsync('sfdx', ['--version']);
      return 'sfdx';
    } catch {
      return null;
    }
  }
}

async function resolveGlobalNpmBin() {
  const attempts = [
    ['npm', ['bin', '-g'], bin => bin],
    ['npm', ['prefix', '-g'], prefix => (platform() === 'win32' ? prefix : join(prefix, 'bin'))],
    ['npm', ['config', 'get', 'prefix'], prefix => (platform() === 'win32' ? prefix : join(prefix, 'bin'))]
  ];
  for (const [cmd, args, mapper] of attempts) {
    try {
      const { stdout } = await execFileAsync(cmd, args);
      const raw = (stdout || '').trim();
      if (raw) {
        return mapper(raw);
      }
    } catch {
      // try next option
    }
  }
  return '';
}

async function addGlobalBinToPath() {
  try {
    const bin = await resolveGlobalNpmBin();
    if (bin) {
      const sep = platform() === 'win32' ? ';' : ':';
      const pathNow = process.env.PATH || '';
      if (!pathNow.split(sep).includes(bin)) {
        process.env.PATH = bin + sep + pathNow;
      }
      return;
    }
    console.warn('Failed to locate global npm bin; continuing without it.');
  } catch (e) {
    console.warn('Failed to add global npm bin to PATH:', e && e.message ? e.message : e);
  }
}

async function ensureSfCliInstalled() {
  // Try to make sure global npm bin is on PATH first
  await addGlobalBinToPath();

  let cli = await whichSf();
  if (cli) {
    addLocalBinToPath();
    return cli;
  }
  try {
    console.log('[test-setup] Installing @salesforce/cli globally via npm...');
    await execFileAsync('npm', ['i', '--no-audit', '--no-fund', '-g', '@salesforce/cli@latest']);
    await addGlobalBinToPath();
  } catch (e) {
    console.warn('[test-setup] Failed to install @salesforce/cli globally:', e && e.message ? e.message : e);
  }
  cli = await whichSf();
  return cli;
}

async function ensureDevHub(cli, { authUrl, alias }) {
  if (!cli || !authUrl) {
    return;
  }
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'alv-'));
    const file = join(tmp, 'devhub.sfdxurl');
    writeFileSync(file, authUrl, 'utf8');
    if (cli === 'sf') {
      await execFileAsync('sf', [
        'org',
        'login',
        'sfdx-url',
        '--sfdx-url-file',
        file,
        '--alias',
        alias,
        '--set-default-dev-hub',
        '--json'
      ]);
      await execFileAsync('sf', ['config', 'set', `target-dev-hub=${alias}`, `target-org=${alias}`, '--global']);
    } else {
      await execFileAsync('sfdx', ['force:auth:sfdxurl:store', '-f', file, '-a', alias, '-d', '--json']);
      await execFileAsync('sfdx', [
        'force:config:set',
        `defaultdevhubusername=${alias}`,
        `defaultusername=${alias}`,
        '--global'
      ]);
    }
  } catch (e) {
    console.warn('[test-setup] Dev Hub auth failed:', e && e.message ? e.message : e);
  }
}

async function ensureDefaultScratch(cli, { alias, durationDays, definitionJson, keep }) {
  if (!cli) {
    return { cleanup: async () => {} };
  }
  try {
    // If already exists, set as default and return
    try {
      if (cli === 'sf') {
        await execFileAsync('sf', ['org', 'display', '-o', alias, '--json']);
      } else {
        await execFileAsync('sfdx', ['force:org:display', '-u', alias, '--json']);
      }
      if (cli === 'sf') {
        await execFileAsync('sf', ['config', 'set', `target-org=${alias}`, '--global']);
      } else {
        await execFileAsync('sfdx', ['force:config:set', `defaultusername=${alias}`, '--global']);
      }
      console.log(`[test-setup] Using existing scratch org '${alias}' as default.`);
      return { alias, cleanup: async () => {} };
    } catch (e) {
      console.warn(`[test-setup] Failed to check existing scratch org '${alias}':`, e && e.message ? e.message : e);
    }

    const tmp = mkdtempSync(join(tmpdir(), 'alv-'));
    const defFile = join(tmp, 'project-scratch-def.json');
    const def = definitionJson || {
      orgName: 'apex-log-viewer-tests',
      edition: 'Developer',
      hasSampleData: false
    };
    writeFileSync(defFile, JSON.stringify(def), 'utf8');

    if (cli === 'sf') {
      await execFileAsync('sf', [
        'org',
        'create',
        'scratch',
        '--alias',
        alias,
        '--definition-file',
        defFile,
        '--duration-days',
        String(durationDays),
        '--set-default',
        '--wait',
        '15',
        '--json'
      ]);
    } else {
      await execFileAsync('sfdx', [
        'force:org:create',
        '-s',
        '-f',
        defFile,
        '-a',
        alias,
        '-d',
        String(durationDays),
        '--wait',
        '15',
        '--json'
      ]);
    }
    console.log(`[test-setup] Created scratch org '${alias}' and set as default.`);

    const cleanup = async () => {
      if (keep) {
        return;
      }
      try {
        if (cli === 'sf') {
          await execFileAsync('sf', ['org', 'delete', 'scratch', '-o', alias, '--no-prompt', '--json']);
        } else {
          await execFileAsync('sfdx', ['force:org:delete', '-u', alias, '-p', '--json']);
        }
        console.log(`[test-setup] Deleted scratch org '${alias}'.`);
      } catch (e) {
        console.warn('[test-setup] Scratch org delete failed:', e && e.message ? e.message : e);
      }
    };
    return { alias, cleanup };
  } catch (e) {
    console.warn('[test-setup] Scratch org setup failed:', e && e.message ? e.message : e);
    return { cleanup: async () => {} };
  }
}

async function pretestSetup(scope = 'all', opts = {}) {
  const smokeVsix = !!opts.smokeVsix;
  const normalizedScope = String(scope || '').trim().toLowerCase();
  const devhubAuthUrl = process.env.SF_DEVHUB_AUTH_URL || process.env.SFDX_AUTH_URL;
  const devhubAlias = process.env.SF_DEVHUB_ALIAS || 'DevHub';
  const scratchAlias = process.env.SF_SCRATCH_ALIAS || 'ALV_Test_Scratch';
  const keepScratch = /^1|true$/i.test(String(process.env.SF_TEST_KEEP_ORG || ''));
  const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1);
  // When running unit tests, skip any Salesforce CLI/Dev Hub setup.
  // Keep only the temporary workspace preparation below.
  let cleanup = async () => {};
  if (normalizedScope !== 'unit' && !smokeVsix) {
    const cli = await ensureSfCliInstalled();
    if (!cli) {
      console.warn('[test-setup] Salesforce CLI not found; skipping org setup.');
      // Continue to workspace creation so tests still have a workspace.
    } else {
      if (devhubAuthUrl) {
        console.log('[test-setup] Authenticating Dev Hub from env...');
        await ensureDevHub(cli, { authUrl: devhubAuthUrl, alias: devhubAlias });
      }

      const toggle = process.env.SF_SETUP_SCRATCH || devhubAuthUrl;
      if (toggle) {
        const res = await ensureDefaultScratch(cli, {
          alias: scratchAlias,
          durationDays,
          definitionJson: undefined,
          keep: keepScratch
        });
        if (res && res.cleanup) {
          cleanup = res.cleanup;
        }
      }
    }
  }
  // Create a temporary VS Code workspace with expected sfdx-project.json
  try {
    const apiVersion = String(process.env.SF_TEST_API_VERSION || '60.0');
    const ws = mkdtempSync(join(tmpdir(), 'alv-ws-'));
    const proj = {
      packageDirectories: [{ path: 'force-app', default: true }],
      name: 'apex-log-viewer-tests',
      namespace: '',
      sfdcLoginUrl: 'https://login.salesforce.com',
      sourceApiVersion: apiVersion
    };
    writeFileSync(join(ws, 'sfdx-project.json'), JSON.stringify(proj, null, 2), 'utf8');
    mkdirSync(join(ws, 'force-app'), { recursive: true });
    // Optional: enable verbose logs via env. Creates .vscode/settings.json in the temp workspace.
    try {
      const vsdir = join(ws, '.vscode');
      mkdirSync(vsdir, { recursive: true });
      const settings = {};
      const wantTrace = /^1|true$/i.test(String(process.env.SF_LOG_TRACE || ''));
      if (wantTrace) {
        settings['sfLogs.trace'] = true;
      }
      const logLevel = process.env.VSCODE_TEST_LOG_LEVEL || process.env.VSCODE_LOG_LEVEL;
      if (logLevel) {
        settings['window.logLevel'] = String(logLevel);
      }
      if (Object.keys(settings).length > 0) {
        writeFileSync(join(vsdir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
      }
    } catch (e) {
      console.warn('[test-setup] Failed to write VS Code settings:', e && e.message ? e.message : e);
    }
    process.env.VSCODE_TEST_WORKSPACE = ws;
    const prevCleanup = cleanup;
    cleanup = async () => {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch (e) {
        console.warn('[test-setup] Failed to remove temp workspace:', e && e.message ? e.message : e);
      }
      await prevCleanup();
    };
  } catch (e) {
    console.warn('[test-setup] Failed to prepare temp workspace:', e && e.message ? e.message : e);
  }
  return { cleanup };
}

function parseArgs(argv) {
  const out = { scope: 'all', vscode: 'insiders', installDeps: false, timeoutMs: undefined, smokeVsix: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--scope=')) out.scope = a.split('=')[1];
    else if (a.startsWith('--vscode=')) out.vscode = a.split('=')[1];
    else if (a === '--install-deps') out.installDeps = true;
    else if (a.startsWith('--timeout=')) out.timeoutMs = Number(a.split('=')[1]) || undefined;
    else if (a === '--smoke-vsix') out.smokeVsix = true;
  }
  if (/^1|true$/i.test(String(process.env.ALWAYS_SMOKE_VSIX || ''))) {
    out.smokeVsix = true;
  }
  return out;
}

async function run() {
  const args = parseArgs(process.argv);
  // Ensure Electron launches as a GUI app, not Node.
  // Some environments leak ELECTRON_RUN_AS_NODE=1 which breaks VS Code when
  // passed common flags like --user-data-dir. Explicitly unset it here.
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
  } catch (e) {
    console.warn('Failed to unset ELECTRON_RUN_AS_NODE:', e && e.message ? e.message : e);
  }
  // Re-exec under Xvfb when DISPLAY is missing on Linux
  if (platform() === 'linux' && !process.env.DISPLAY && !process.env.__ALV_XVFB_RAN) {
    try {
      await execFileAsync('bash', ['-lc', 'command -v xvfb-run >/dev/null 2>&1']);
      const re = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x1024x24', process.execPath, __filename], {
        stdio: 'inherit',
        env: { ...process.env, __ALV_XVFB_RAN: '1' }
      });
      re.on('exit', code => process.exit(code ?? 0));
      return;
    } catch {
      // no xvfb-run; continue and let Electron try (may fail)
    }
  }

  const { cleanup } = await pretestSetup(args.scope, { smokeVsix: args.smokeVsix });

  // Hint Electron to avoid GPU issues in headless envs
  process.env.ELECTRON_DISABLE_GPU = process.env.ELECTRON_DISABLE_GPU || '1';
  process.env.LC_ALL = process.env.LC_ALL || 'C.UTF-8';
  // Reduce DBus/AT-SPI chatter in headless CI
  process.env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null';
  process.env.NO_AT_BRIDGE = process.env.NO_AT_BRIDGE || '1';

  // Global timeout to avoid indefinite hangs (e.g., Marketplace downloads, Electron issues)
  // Defaults: 8m for unit, 15m for integration/all.
  const scope = String(args.scope || 'all');
  const defaultMs = scope === 'unit' ? 8 * 60 * 1000 : 15 * 60 * 1000;
  const totalTimeout = Number(args.timeoutMs || defaultMs);

  // Download VS Code: prefer stable for unit tests to maximize cache reuse
  // (avoid frequent Insiders updates triggering re-downloads). Can be overridden via --vscode.
  const vsVer = String(args.vscode || (scope === 'unit' ? 'stable' : 'insiders'));
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vsVer);
  const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
    reuseMachineInstall: true
  });

  // Install dependency extensions directly (docs approach) when running integration or all
  const shouldInstall = scope === 'integration' || scope === 'all' || !!args.installDeps;
  let sfExtPresent = false;
  if (shouldInstall) {
    const toInstall = (process.env.VSCODE_TEST_EXTENSIONS || 'salesforce.salesforcedx-vscode')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const userDataDir = join(tmpdir(), 'alv-user-data');
    const extensionsDir = join(tmpdir(), 'alv-extensions');
    for (const id of toInstall) {
      console.log(`[deps] Installing extension: ${id}`);
      // In WSL, code CLI prompts; feed 'y' automatically. Also isolate dirs.
      const args = [
        ...cliArgs,
        '--install-extension',
        id,
        '--force',
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir
      ];
      const res = spawnSync(cliPath, args, {
        stdio: ['pipe', 'inherit', 'inherit'],
        encoding: 'utf8',
        input: 'y\n',
        env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
      });
      if (res.status !== 0) {
        console.warn(`[deps] Failed to install ${id}. Continuing; tests may skip/fail.`);
      }
    }
    // List extensions to aid debugging and flag presence
    try {
      const list = spawnSync(
        cliPath,
        [
          ...cliArgs,
          '--list-extensions',
          '--show-versions',
          '--user-data-dir',
          join(tmpdir(), 'alv-user-data'),
          '--extensions-dir',
          join(tmpdir(), 'alv-extensions')
        ],
        { encoding: 'utf8' }
      );
      const out = (list.stdout || '').trim();
      console.log('[deps] Extensions installed in test dir:\n' + out);
      if (
        /^salesforce\.salesforcedx-vscode(?:@|$)/m.test(out) ||
        /^salesforce\.salesforcedx-vscode-core(?:@|$)/m.test(out) ||
        /^salesforce\.salesforcedx-vscode-apex(?:@|$)/m.test(out)
      ) {
        sfExtPresent = true;
      }
    } catch (e) {
      console.warn('[deps] Failed to list installed extensions:', e && e.message ? e.message : e);
    }
  }

  // Run tests via @vscode/test-electron with our programmatic Mocha runner
  let extensionDevelopmentPath = resolve(__dirname, '..');
  let extensionTestsPath = resolve(__dirname, '..', 'out', 'test', 'runner.js');

  // Optional: VSIX smoke mode installs the freshly built VSIX and runs a minimal activation test
  if (args.smokeVsix) {
    // Package VSIX
    console.log('[smoke] Packaging VSIX...');
    // Build artifacts (avoid full 'package' to reduce flakiness on CI)
    await execFileAsync('npm', ['run', '-s', 'build']);
    // Ensure NLS files exist (best-effort)
    try {
      await execFileAsync('npm', ['run', '-s', 'nls:write']);
    } catch {}
    // Create the VSIX (this will also run vscode:prepublish)
    const localVsce = join(
      process.cwd(),
      'node_modules',
      '.bin',
      platform() === 'win32' ? 'vsce.cmd' : 'vsce'
    );
    if (existsSync(localVsce)) {
      await execStreaming(localVsce, ['package', '--no-yarn']);
    } else {
      await execStreaming('npx', ['--yes', '@vscode/vsce', 'package', '--no-yarn']);
    }
    const vsix = require('fs')
      .readdirSync(process.cwd())
      .find(f => /\.vsix$/.test(f));
    if (!vsix) throw new Error('[smoke] VSIX not found');
    // Install into test profile
    const userDataDir = join(tmpdir(), 'alv-user-data');
    const extensionsDir = join(tmpdir(), 'alv-extensions');
    console.log('[smoke] Installing VSIX into isolated profile...');
    const inst = spawnSync(
      cliPath,
      [
        ...cliArgs,
        '--install-extension',
        resolve(vsix),
        '--force',
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir
      ],
      {
        stdio: ['pipe', 'inherit', 'inherit'],
        encoding: 'utf8',
        input: 'y\n',
        env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
      }
    );
    if (inst.status !== 0) {
      throw new Error('[smoke] Failed to install VSIX');
    }
    // Create minimal harness extension
    const dev = mkdtempSync(join(tmpdir(), 'alv-smoke-dev-'));
    const pkg = {
      name: 'alv-smoke-harness',
      version: '0.0.0',
      engines: { vscode: '*' },
      main: './index.js',
      activationEvents: ['*']
    };
    writeFileSync(join(dev, 'package.json'), JSON.stringify(pkg, null, 2));
    writeFileSync(join(dev, 'index.js'), 'exports.activate=()=>{};exports.deactivate=()=>{};\n');
    extensionDevelopmentPath = dev;
    // Write runner that activates installed extension
    const runner = `"use strict";const assert=require('assert/strict');const vscode=require('vscode');exports.run=async function(){const ext=vscode.extensions.getExtension('electivus.apex-log-viewer');assert.ok(ext,'extension not found');await ext.activate();const cmds=await vscode.commands.getCommands(true);for(const c of ['sfLogs.refresh','sfLogs.selectOrg','sfLogs.tail','sfLogs.showOutput']){assert.ok(cmds.includes(c),'missing command: '+c);} };\n`;
    const testsDir = mkdtempSync(join(tmpdir(), 'alv-smoke-tests-'));
    extensionTestsPath = join(testsDir, 'smoke-runner.js');
    writeFileSync(extensionTestsPath, runner, 'utf8');
    // Override launchArgs to reuse the isolated profile with installed VSIX
    process.env.__ALV_SMOKE_USER_DIR = userDataDir;
    process.env.__ALV_SMOKE_EXT_DIR = extensionsDir;
  }
  // Configure Mocha grep via env for the in-host runner
  if (scope === 'unit') {
    process.env.VSCODE_TEST_GREP = '^integration:';
    process.env.VSCODE_TEST_INVERT = '1';
  } else if (scope === 'integration') {
    process.env.VSCODE_TEST_GREP = '^integration:';
    delete process.env.VSCODE_TEST_INVERT;
  } else {
    delete process.env.VSCODE_TEST_GREP;
    delete process.env.VSCODE_TEST_INVERT;
  }

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    console.error(`\n[test-runner] Timed out after ${Math.round(totalTimeout / 1000)}s. Exiting...`);
    process.exit(124);
  }, totalTimeout);

  let userDataDir = process.env.__ALV_SMOKE_USER_DIR || join(tmpdir(), 'alv-user-data');
  let extensionsDir = process.env.__ALV_SMOKE_EXT_DIR || join(tmpdir(), 'alv-extensions');

  try {
    userDataDir = process.env.__ALV_SMOKE_USER_DIR || join(tmpdir(), 'alv-user-data');
    extensionsDir = process.env.__ALV_SMOKE_EXT_DIR || join(tmpdir(), 'alv-extensions');

    const launch = [
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      '--skip-welcome',
      '--skip-release-notes',
      // Use the prepared workspace (set in pretestSetup)
      ...(process.env.VSCODE_TEST_WORKSPACE ? [process.env.VSCODE_TEST_WORKSPACE] : [])
    ];
    const extensionTestsEnv = {};
    if (sfExtPresent) {
      extensionTestsEnv.SF_EXT_PRESENT = '1';
    }
    if (process.env.NODE_V8_COVERAGE) {
      extensionTestsEnv.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
    }
    if (process.env.NODE_OPTIONS) {
      extensionTestsEnv.NODE_OPTIONS = process.env.NODE_OPTIONS;
    }
    if (process.env.ENABLE_COVERAGE) {
      extensionTestsEnv.ENABLE_COVERAGE = process.env.ENABLE_COVERAGE;
    }

    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: Object.keys(extensionTestsEnv).length ? extensionTestsEnv : undefined,
      launchArgs: launch
    });
  } finally {
    clearTimeout(killer);
    try {
      await cleanup();
    } catch (e) {
      console.warn('[test-runner] Cleanup failed:', e && e.message ? e.message : e);
    }
    if (timedOut) {
      return;
    }

    try {
      const cleanupMarkers = [
        vscodeExecutablePath,
        'code-insiders',
        'vscode-linux-x64-insiders',
        'chrome_crashpad_handler'
      ];
      await killLeakedVSCodeProcesses(cleanupMarkers);
      cleanVsCodeTest({ quiet: true });
    } catch (e) {
      console.warn('[test-runner] VS Code cleanup failed:', e && e.message ? e.message : e);
    }
  }
}

run();
