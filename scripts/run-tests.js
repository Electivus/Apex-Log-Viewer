const { spawn, execFile, spawnSync } = require('child_process');
const { platform, tmpdir } = require('os');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('fs');
const { join, resolve } = require('path');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} = require('@vscode/test-electron');

function execFileAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 * 10, encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(stderr || err.message);
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout, stderr });
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
  } catch {}
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

async function addGlobalBinToPath() {
  try {
    const { stdout } = await execFileAsync('npm', ['bin', '-g']);
    const bin = (stdout || '').trim();
    if (bin) {
      const sep = platform() === 'win32' ? ';' : ':';
      const pathNow = process.env.PATH || '';
      if (!pathNow.split(sep).includes(bin)) {
        process.env.PATH = bin + sep + pathNow;
      }
    }
  } catch {}
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
  if (!cli || !authUrl) return;
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
  if (!cli) return { cleanup: async () => {} };
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
    } catch {}

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
      if (keep) return;
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

async function pretestSetup() {
  const devhubAuthUrl = process.env.SF_DEVHUB_AUTH_URL || process.env.SFDX_AUTH_URL;
  const devhubAlias = process.env.SF_DEVHUB_ALIAS || 'DevHub';
  const scratchAlias = process.env.SF_SCRATCH_ALIAS || 'ALV_Test_Scratch';
  const keepScratch = /^1|true$/i.test(String(process.env.SF_TEST_KEEP_ORG || ''));
  const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1);

  const cli = await ensureSfCliInstalled();
  if (!cli) {
    console.warn('[test-setup] Salesforce CLI not found; skipping org setup.');
    return { cleanup: async () => {} };
  }

  if (devhubAuthUrl) {
    console.log('[test-setup] Authenticating Dev Hub from env...');
    await ensureDevHub(cli, { authUrl: devhubAuthUrl, alias: devhubAlias });
  }

  const toggle = process.env.SF_SETUP_SCRATCH || process.env.CI || devhubAuthUrl;
  let cleanup = async () => {};
  if (toggle) {
    const res = await ensureDefaultScratch(cli, {
      alias: scratchAlias,
      durationDays,
      definitionJson: undefined,
      keep: keepScratch
    });
    if (res && res.cleanup) cleanup = res.cleanup;
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
      if (wantTrace) settings['sfLogs.trace'] = true;
      const logLevel = process.env.VSCODE_TEST_LOG_LEVEL || process.env.VSCODE_LOG_LEVEL;
      if (logLevel) settings['window.logLevel'] = String(logLevel);
      if (Object.keys(settings).length > 0) {
        writeFileSync(join(vsdir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
      }
    } catch {}
    process.env.VSCODE_TEST_WORKSPACE = ws;
    const prevCleanup = cleanup;
    cleanup = async () => {
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {}
      await prevCleanup();
    };
  } catch (e) {
    console.warn('[test-setup] Failed to prepare temp workspace:', e && e.message ? e.message : e);
  }
  return { cleanup };
}

async function run() {
  // Re-exec under Xvfb when DISPLAY is missing on Linux
  if (platform() === 'linux' && !process.env.DISPLAY && !process.env.__ALV_XVFB_RAN) {
    try {
      await execFileAsync('bash', ['-lc', 'command -v xvfb-run >/dev/null 2>&1']);
      const re = spawn('xvfb-run', [
        '-a',
        '-s',
        '-screen 0 1280x1024x24',
        process.execPath,
        __filename
      ], {
        stdio: 'inherit',
        env: { ...process.env, __ALV_XVFB_RAN: '1' }
      });
      re.on('exit', code => process.exit(code ?? 0));
      return;
    } catch {
      // no xvfb-run; continue and let Electron try (may fail)
    }
  }

  const { cleanup } = await pretestSetup();

  // Hint Electron to avoid GPU issues in headless envs
  process.env.ELECTRON_DISABLE_GPU = process.env.ELECTRON_DISABLE_GPU || '1';
  process.env.LC_ALL = process.env.LC_ALL || 'C.UTF-8';
  // Reduce DBus/AT-SPI chatter in headless CI
  process.env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null';
  process.env.NO_AT_BRIDGE = process.env.NO_AT_BRIDGE || '1';

  // Global timeout to avoid indefinite hangs (e.g., Marketplace downloads, Electron issues)
  // Defaults: 8m for unit, 15m for integration/all. Override via VSCODE_TEST_TOTAL_TIMEOUT_MS.
  const scope = String(process.env.VSCODE_TEST_SCOPE || 'all');
  const defaultMs = scope === 'unit' ? 8 * 60 * 1000 : 15 * 60 * 1000;
  const totalTimeout = Number(process.env.VSCODE_TEST_TOTAL_TIMEOUT_MS || defaultMs);

  // Download VS Code (use env override or insiders)
  const vsVer = String(process.env.VSCODE_TEST_VERSION || 'insiders');
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vsVer);
  const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

  // Install dependency extensions directly (docs approach) when running integration
  const shouldInstall = scope === 'integration' || /^1|true$/i.test(String(process.env.VSCODE_TEST_INSTALL_DEPS || ''));
  if (shouldInstall) {
    const toInstall = (process.env.VSCODE_TEST_EXTENSIONS || 'salesforce.salesforcedx-vscode')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    for (const id of toInstall) {
      console.log(`[deps] Installing extension: ${id}`);
      const res = spawnSync(cliPath, [...cliArgs, '--install-extension', id], {
        stdio: 'inherit',
        encoding: 'utf8'
      });
      if (res.status !== 0) {
        console.warn(`[deps] Failed to install ${id}. Continuing; tests may skip/fail.`);
      }
    }
  }

  // Run tests via @vscode/test-electron with our programmatic Mocha runner
  const extensionDevelopmentPath = resolve(__dirname, '..');
  const extensionTestsPath = resolve(__dirname, '..', 'out', 'test', 'runner.js');

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    console.error(`\n[test-runner] Timed out after ${Math.round(totalTimeout / 1000)}s. Exiting...`);
    process.exit(124);
  }, totalTimeout);

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        // Use clean profile
        '--user-data-dir',
        join(tmpdir(), 'alv-user-data'),
        // Use the prepared workspace (set in pretestSetup)
        ...(process.env.VSCODE_TEST_WORKSPACE ? [process.env.VSCODE_TEST_WORKSPACE] : [])
      ]
    });
  } finally {
    clearTimeout(killer);
    try { await cleanup(); } catch {}
    if (timedOut) return;
  }
}

run();
