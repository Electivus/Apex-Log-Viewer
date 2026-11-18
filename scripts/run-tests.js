const { spawn, execFile } = require('child_process');
const { platform, tmpdir } = require('os');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { dirname, join, resolve } = require('path');
const { stripVTControlCharacters } = require('node:util');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
const { build } = require('esbuild');
const { cacheCleanRequested } = require('./clean-vscode-test.js');
const {
  requiresScratchSetup,
  safeSfFailureMessage,
  resolveDevHubConfig,
  authenticateDevHub,
  salesforceChildEnv,
  scratchSignupEnv
} = require('./devhub-auth.js');
const { resolveSalesforceCliPath } = require('./run-playwright-cli-e2e.js');
const crossSpawn = require('cross-spawn');

function execFileAsync(file, args, opts = {}) {
  const isSalesforce = file === 'sf' || file === 'sfdx';
  if (file === 'sf') {
    file = resolveSalesforceCliPath(resolve(__dirname, '..')) || file;
  }
  return new Promise((resolve, reject) => {
    const options = {
      maxBuffer: 1024 * 1024 * 10,
      encoding: 'utf8',
      ...(isSalesforce ? { env: salesforceChildEnv() } : {}),
      ...opts
    };
    const callback = (err, stdout, stderr) => {
      if (err) {
        const output = [stderr, stdout].filter(Boolean).join('\n').trim();
        const e = new Error(isSalesforce ? safeSfFailureMessage(output || err.message) : output || err.message);
        e.code = err.code;
        return reject(e);
      }
      resolve({ stdout, stderr });
    };
    if (platform() === 'win32' && /\.cmd$/i.test(file)) {
      // cross-spawn preserves literal arguments when npm's Windows shim needs
      // cmd.exe, including configured CLI paths containing spaces.
      const child = crossSpawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = { stdout: [], stderr: [] };
      let bytes = 0;
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
          bytes += chunk.length;
          if (bytes > options.maxBuffer) {
            child.kill();
            reject(new Error('Command output exceeded the allowed buffer.'));
          } else {
            chunks[stream].push(chunk);
          }
        });
      }
      child.on('error', error => callback(error, '', ''));
      child.on('close', (code, signal) => {
        const error = code === 0 && !signal ? undefined : Object.assign(new Error('Command failed.'), { code });
        callback(error, Buffer.concat(chunks.stdout).toString('utf8'), Buffer.concat(chunks.stderr).toString('utf8'));
      });
      return;
    }
    execFile(file, args, options, callback);
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

// A test host stores Electron's "Code Safe Storage" key in the login keychain, the user's own on a developer Mac.
// Chromium's mock keychain keeps that key in memory.
function macKeychainLaunchArgs(hostPlatform = process.platform) {
  return hostPlatform === 'darwin' ? ['--use-mock-keychain'] : [];
}

function readEnvValue(name) {
  const value = String(process.env[name] || '').trim();
  return value || undefined;
}

function parseJsonOutput(stdout) {
  const text = stripVTControlCharacters(String(stdout || '')).trim();
  if (!text) {
    return undefined;
  }

  const candidates = [text];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction candidate.
    }
  }

  return undefined;
}

function resolveRequiredDevHubConfig({ requireConfig }) {
  return resolveDevHubConfig(process.env, { required: requireConfig, allowLocalAlias: true });
}

// From the moment the run creates its profile, Ctrl+C must not end the process before the profile is removed.
// The first Ctrl+C sends SIGINT to the child in progress and starts no other step; a second one sends SIGKILL,
// or stops waiting for in-process work. Only the run's own child is signaled.
function watchInterrupts() {
  let presses = 0;
  let stopChild;
  let abandon;
  const abandoned = new Promise((_, reject) => {
    abandon = reject;
  });
  abandoned.catch(() => {});
  const interrupted = () => new Error('[test-runner] Interrupted.');
  const onInterrupt = () => {
    presses += 1;
    if (presses === 1) console.error('\n[test-runner] Interrupted. Cleaning up; press Ctrl+C again to stop now.');
    if (stopChild) stopChild(presses === 1 ? 'SIGINT' : 'SIGKILL');
    else if (presses > 1) abandon(interrupted());
  };
  process.on('SIGINT', onInterrupt);
  const assertNotInterrupted = () => {
    if (presses) throw interrupted();
  };

  return {
    settle(work) {
      assertNotInterrupted();
      return Promise.race([work, abandoned]);
    },
    start(file, args, { label = file, input, capture = false, allowFailure = false, env } = {}) {
      assertNotInterrupted();
      const child = crossSpawn(file, args, {
        stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
        ...(env ? { env } : {})
      });
      let running = Boolean(child.pid);
      const stop = signal => {
        if (!running) return;
        try {
          child.kill(signal);
        } catch (error) {
          console.warn(`[test-runner] Could not stop ${label}:`, error.message);
        }
      };
      stopChild = stop;
      let output = '';
      if (capture) {
        for (const stream of [child.stdout, child.stderr]) {
          stream.setEncoding('utf8');
          stream.on('data', chunk => {
            output += chunk;
          });
        }
      }
      if (input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
      const finished = new Promise((resolve, reject) => {
        child.on('error', error => {
          if (running) console.warn(`[test-runner] ${label} error:`, error.message);
          else if (allowFailure && !presses) resolve({ status: null, output: '' });
          else reject(error);
        });
        child.once(capture ? 'close' : 'exit', (code, signal) => {
          running = false;
          const text = output.trim();
          if (!presses && (code === 0 || allowFailure)) resolve({ status: code, output: text });
          else reject(new Error(`${label} exited with ${signal ?? code}${text && !presses ? `:\n${text}` : ''}`));
        });
      }).finally(() => {
        if (stopChild === stop) stopChild = undefined;
      });
      return { finished, stop };
    },
    dispose() {
      process.removeListener('SIGINT', onInterrupt);
    }
  };
}

function resolveMissingExtensionIds(requiredExtensionIds, listOutput) {
  const installed = new Set(
    String(listOutput || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.split('@')[0].trim().toLowerCase())
  );

  return Array.from(new Set(requiredExtensionIds.map(id => String(id).trim()).filter(Boolean))).filter(
    extensionId => !installed.has(extensionId.toLowerCase())
  );
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
    await execFileAsync('npm', ['i', '--no-audit', '--no-fund', '-g', '@salesforce/cli@2.150.6']);
    await addGlobalBinToPath();
  } catch (e) {
    console.warn('[test-setup] Failed to install @salesforce/cli globally:', e && e.message ? e.message : e);
  }
  cli = await whichSf();
  return cli;
}

async function ensureDevHub(cli, config, helpers = {}) {
  const execFileAsyncFn = helpers.execFileAsync || execFileAsync;
  if (!cli) {
    throw new Error('Salesforce CLI is required for Dev Hub authentication.');
  }
  return authenticateDevHub(
    config,
    async (args, options) => {
      let cliArgs = args;
      if (cli === 'sfdx') {
        // Keep command spelling in this execution adapter; selection and
        // identity validation remain owned by the shared policy.
        if (args[1] === 'delete') {
          cliArgs = ['force:org:delete', '-u', args[args.indexOf('--target-org') + 1], '-p'];
        } else if (args[1] === 'logout') {
          cliArgs = ['force:auth:logout', '-u', args[args.indexOf('--target-org') + 1], '-p'];
        } else if (args[1] === 'auth') {
          cliArgs = ['force:org:display', '-u', args[args.indexOf('--target-org') + 1], '--verbose'];
        } else if (args[2] === 'sfdx-url') {
          cliArgs = [
            'force:auth:sfdxurl:store',
            '-f',
            args[args.indexOf('--sfdx-url-file') + 1],
            '-a',
            args[args.indexOf('--alias') + 1],
            ...(args.includes('--set-default') ? ['-s'] : [])
          ];
        } else if (args[1] === 'display') {
          cliArgs = ['force:org:display', '-u', args[3]];
        } else {
          const legacyFlags = {
            '--client-id': '--clientid',
            '--instance-url': '--instanceurl',
            '--jwt-key-file': '--jwtkeyfile'
          };
          cliArgs = ['force:auth:jwt:grant', ...args.slice(3).map(arg => legacyFlags[arg] || arg)];
        }
      }
      const { stdout } = await execFileAsyncFn(cli, [...cliArgs, '--json'], options);
      return parseJsonOutput(stdout);
    },
    helpers.fs
  );
}

async function ensureDefaultScratch(
  cli,
  { alias, devHubAlias, devHub, durationDays, definitionJson, keep },
  helpers = {}
) {
  const execFileAsyncFn = (file, args, options = {}) =>
    (helpers.execFileAsync || execFileAsync)(file, args, {
      env: salesforceChildEnv(),
      ...options
    });
  const mkdtempSyncFn = helpers.mkdtempSync || mkdtempSync;
  const writeFileSyncFn = helpers.writeFileSync || writeFileSync;
  const rmSyncFn = helpers.rmSync || rmSync;
  const joinFn = helpers.join || join;

  if (!cli) {
    return { cleanup: async () => {} };
  }

  // If already exists, set as default and return
  try {
    if (cli === 'sf') {
      await execFileAsyncFn('sf', ['org', 'display', '-o', alias, '--json']);
    } else {
      await execFileAsyncFn('sfdx', ['force:org:display', '-u', alias, '--json']);
    }
    if (cli === 'sf') {
      await execFileAsyncFn('sf', ['config', 'set', `target-org=${alias}`, '--global']);
    } else {
      await execFileAsyncFn('sfdx', ['force:config:set', `defaultusername=${alias}`, '--global']);
    }
    console.log(`[test-setup] Using existing scratch org '${alias}' as default.`);
    return { alias, cleanup: async () => {} };
  } catch (e) {
    console.warn(`[test-setup] Could not reuse scratch org '${alias}':`, safeSfFailureMessage(e));
  }

  const tmp = mkdtempSyncFn(joinFn(tmpdir(), 'alv-'));
  const defFile = joinFn(tmp, 'project-scratch-def.json');
  const def = definitionJson || {
    orgName: 'apex-log-viewer-tests',
    edition: 'Developer',
    hasSampleData: false
  };
  if (!devHubAlias) {
    throw new Error('Missing required Dev Hub identifier for scratch org creation.');
  }
  writeFileSyncFn(defFile, JSON.stringify(def), 'utf8');

  try {
    if (cli === 'sf') {
      await execFileAsyncFn(
        'sf',
        [
          'org',
          'create',
          'scratch',
          '--target-dev-hub',
          devHubAlias,
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
        ],
        { env: scratchSignupEnv(devHub?.env) }
      );
    } else {
      await execFileAsyncFn(
        'sfdx',
        [
          'force:org:create',
          '-v',
          devHubAlias,
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
        ],
        { env: scratchSignupEnv(devHub?.env) }
      );
    }
    await devHub?.publishScratch(alias, { setDefault: true });
    console.log(`[test-setup] Created scratch org '${alias}' and set as default.`);

    const cleanup = async () => {
      if (keep) {
        return;
      }
      try {
        if (devHub?.deleteScratch) {
          await devHub.deleteScratch(alias);
        } else if (cli === 'sf') {
          await execFileAsyncFn('sf', ['org', 'delete', 'scratch', '-o', alias, '--no-prompt', '--json']);
        } else {
          await execFileAsyncFn('sfdx', ['force:org:delete', '-u', alias, '-p', '--json']);
        }
        console.log(`[test-setup] Deleted scratch org '${alias}'.`);
      } catch (e) {
        throw new Error(
          safeSfFailureMessage(e, `Scratch org cleanup failed for '${alias}'. Delete this test scratch explicitly.`)
        );
      }
    };
    return { alias, cleanup };
  } catch (error) {
    throw new Error(safeSfFailureMessage(error, 'Scratch signup failed.'));
  } finally {
    try {
      rmSyncFn(tmp, { recursive: true, force: true });
    } catch {}
  }
}

async function pretestSetup(scope = 'all', opts = {}, helpers = {}) {
  const ensureSfCliInstalledFn = helpers.ensureSfCliInstalled || ensureSfCliInstalled;
  const ensureDevHubFn = helpers.ensureDevHub || ensureDevHub;
  const ensureDefaultScratchFn = helpers.ensureDefaultScratch || ensureDefaultScratch;
  const mkdtempSyncFn = helpers.mkdtempSync || mkdtempSync;
  const writeFileSyncFn = helpers.writeFileSync || writeFileSync;
  const mkdirSyncFn = helpers.mkdirSync || mkdirSync;
  const rmSyncFn = helpers.rmSync || rmSync;
  const joinFn = helpers.join || join;

  const smokeVsix = !!opts.smokeVsix;
  const normalizedScope = String(scope || '')
    .trim()
    .toLowerCase();
  const scratchAlias = process.env.SF_SCRATCH_ALIAS || 'ALV_Test_Scratch';
  const keepScratch = /^1|true$/i.test(String(process.env.SF_TEST_KEEP_ORG || ''));
  const durationDays = Number(process.env.SF_SCRATCH_DURATION || 1);
  const shouldSetupScratch = requiresScratchSetup(normalizedScope, { smokeVsix });
  const devHubConfig = resolveRequiredDevHubConfig({ requireConfig: shouldSetupScratch });
  // When running unit tests, skip any Salesforce CLI/Dev Hub setup.
  // Keep only the temporary workspace preparation below.
  let cleanup = async () => {};
  if (normalizedScope !== 'unit' && !smokeVsix) {
    const cli = await ensureSfCliInstalledFn();
    if (!cli) {
      if (shouldSetupScratch) {
        throw new Error('[test-setup] Salesforce CLI not found; scratch org setup requires the Salesforce CLI.');
      }
      console.warn('[test-setup] Salesforce CLI not found; skipping org setup.');
      // Continue to workspace creation so tests still have a workspace.
    } else {
      if (shouldSetupScratch) {
        console.log('[test-setup] Validating Dev Hub configuration...');
        const devHub = await ensureDevHubFn(cli, devHubConfig, helpers);
        try {
          const res = await ensureDefaultScratchFn(
            cli,
            {
              alias: scratchAlias,
              devHubAlias: devHub.targetOrg,
              devHub,
              durationDays,
              definitionJson: undefined,
              keep: keepScratch
            },
            helpers
          );
          if (res && res.cleanup) {
            cleanup = async () => {
              try {
                await res.cleanup();
              } finally {
                await devHub.cleanup();
              }
            };
          }
        } catch (error) {
          await devHub.cleanup();
          throw error;
        }
      }
    }
  }
  // Create a temporary VS Code workspace with expected sfdx-project.json
  try {
    const apiVersion = String(process.env.SF_TEST_API_VERSION || '60.0');
    const ws = mkdtempSyncFn(joinFn(tmpdir(), 'alv-ws-'));
    const proj = {
      packageDirectories: [{ path: 'force-app', default: true }],
      name: 'apex-log-viewer-tests',
      namespace: '',
      sfdcLoginUrl: 'https://login.salesforce.com',
      sourceApiVersion: apiVersion
    };
    writeFileSyncFn(joinFn(ws, 'sfdx-project.json'), JSON.stringify(proj, null, 2), 'utf8');
    mkdirSyncFn(joinFn(ws, 'force-app'), { recursive: true });
    // Optional: enable verbose logs via env. Creates .vscode/settings.json in the temp workspace.
    try {
      const vsdir = joinFn(ws, '.vscode');
      mkdirSyncFn(vsdir, { recursive: true });
      const settings = {};
      const wantTrace = /^1|true$/i.test(String(process.env.SF_LOG_TRACE || ''));
      if (wantTrace) {
        settings['electivus.apexLogViewer.logging.trace'] = true;
      }
      const logLevel = process.env.VSCODE_TEST_LOG_LEVEL || process.env.VSCODE_LOG_LEVEL;
      if (logLevel) {
        settings['window.logLevel'] = String(logLevel);
      }
      if (Object.keys(settings).length > 0) {
        writeFileSyncFn(joinFn(vsdir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
      }
    } catch (e) {
      console.warn('[test-setup] Failed to write VS Code settings:', e && e.message ? e.message : e);
    }
    process.env.VSCODE_TEST_WORKSPACE = ws;
    const prevCleanup = cleanup;
    cleanup = async () => {
      try {
        rmSyncFn(ws, { recursive: true, force: true });
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
  const out = {
    scope: 'all',
    vscode: String(process.env.VSCODE_TEST_VERSION || 'stable'),
    installDeps: false,
    forceInstallDeps: false,
    timeoutMs: undefined,
    smokeVsix: false
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--scope=')) out.scope = a.split('=')[1];
    else if (a.startsWith('--vscode=')) out.vscode = a.split('=')[1];
    else if (a === '--install-deps') out.installDeps = true;
    else if (a === '--force-install-deps') out.forceInstallDeps = true;
    else if (a.startsWith('--timeout=')) out.timeoutMs = Number(a.split('=')[1]) || undefined;
    else if (a === '--smoke-vsix') out.smokeVsix = true;
  }
  if (/^1|true$/i.test(String(process.env.ALWAYS_SMOKE_VSIX || ''))) {
    out.smokeVsix = true;
  }
  if (/^1|true$/i.test(String(process.env.VSCODE_TEST_FORCE_INSTALL_DEPS || ''))) {
    out.forceInstallDeps = true;
  }
  return out;
}

async function buildExtensionTestRunner(repoRoot) {
  const entryPoint = resolve(repoRoot, 'apps', 'vscode-extension', 'src', 'test', 'runner.ts');
  const outfile = resolve(repoRoot, 'apps', 'vscode-extension', 'out', 'test', 'runner.js');
  mkdirSync(dirname(outfile), { recursive: true });

  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    external: ['vscode', 'mocha', 'esbuild']
  });
}

async function run() {
  const args = parseArgs(process.argv);

  const repoRoot = resolve(__dirname, '..');
  try {
    process.chdir(repoRoot);
  } catch (e) {
    console.warn('[test-runner] Failed to chdir to repo root:', e && e.message ? e.message : e);
  }

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
      const re = spawn(
        'xvfb-run',
        ['-a', '-s', '-screen 0 1280x1024x24', process.execPath, __filename, ...process.argv.slice(2)],
        {
          stdio: 'inherit',
          env: { ...process.env, __ALV_XVFB_RAN: '1' }
        }
      );
      re.on('exit', code => process.exit(code ?? 0));
      return;
    } catch {
      // no xvfb-run; continue and let Electron try (may fail)
    }
  }

  const { cleanup } = await pretestSetup(args.scope, { smokeVsix: args.smokeVsix });
  let cleanupPromise;
  const cleanupOnce = () => cleanupPromise || (cleanupPromise = cleanup());
  const interrupts = watchInterrupts();
  let profileDir;
  const removeProfile = () => {
    if (!profileDir) return;
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('[test-runner] Could not remove the test profile:', error.message);
    }
  };
  let timedOut = false;
  let cleanupDeadline;
  try {
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

    // Download VS Code: default to stable for all test scopes.
    // Can be overridden via --vscode or VSCODE_TEST_VERSION.
    const vsVer = String(args.vscode || 'stable');
    profileDir = mkdtempSync(join(tmpdir(), 'alv-vscode-'));
    // Other runs may be using the shared cache, so a clean request downloads into this run's profile instead.
    const vscodeCachePath = cacheCleanRequested() ? join(profileDir, 'vscode-test') : join(repoRoot, '.vscode-test');
    const vscodeExecutablePath = await interrupts.settle(
      downloadAndUnzipVSCode({ version: vsVer, cachePath: vscodeCachePath })
    );
    const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, {
      reuseMachineInstall: true
    });
    const userDataDir = join(profileDir, 'user-data');
    const localExtensionsDir = join(profileDir, 'extensions');

    // Install dependency extensions directly (docs approach) when running integration or all
    const shouldInstall = scope === 'integration' || scope === 'all' || !!args.installDeps;
    const cachedExtensionsDir = join(vscodeCachePath, 'extensions');
    if (shouldInstall) {
      const toInstall = (
        process.env.VSCODE_TEST_EXTENSIONS ||
        'salesforce.salesforcedx-vscode,salesforce.salesforcedx-vscode-apex-replay-debugger'
      )
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const extensionsDir = cachedExtensionsDir;
      try {
        mkdirSync(extensionsDir, { recursive: true });
      } catch (e) {
        console.warn('[deps] Failed to ensure cached extensions dir exists:', e && e.message ? e.message : e);
      }

      const forceInstall = !!args.forceInstallDeps;
      // In WSL, code CLI prompts; feed 'y' automatically. Also isolate dirs.
      const codeCli = (cliArguments, capture) =>
        interrupts.start(
          cliPath,
          [...cliArgs, ...cliArguments, '--user-data-dir', userDataDir, '--extensions-dir', extensionsDir],
          {
            input: 'y\n',
            capture,
            allowFailure: true,
            env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' }
          }
        ).finished;
      const installed = new Set();
      const { output: alreadyInstalled } = await codeCli(['--list-extensions', '--show-versions'], true);
      for (const line of alreadyInstalled.split(/\r?\n/)) {
        const trimmed = (line || '').trim();
        if (!trimmed) continue;
        const id = trimmed.split('@')[0].trim().toLowerCase();
        if (id) installed.add(id);
      }

      for (const id of toInstall) {
        const key = String(id).toLowerCase();
        if (!forceInstall && installed.has(key)) {
          console.log(`[deps] Extension already installed; skipping: ${id}`);
          continue;
        }
        console.log(`[deps] Installing extension: ${id}${forceInstall ? ' (forced)' : ''}`);
        const res = await codeCli(['--install-extension', id, '--force'], false);
        if (res.status !== 0) {
          console.warn(`[deps] Failed to install ${id}. Continuing; tests may skip/fail.`);
        }
      }
      // List extensions to aid debugging and verify the isolated profile contents
      const { output: installedOutput } = await codeCli(['--list-extensions', '--show-versions'], true);
      console.log('[deps] Extensions installed in test dir:\n' + installedOutput);

      const missingExtensions = resolveMissingExtensionIds(toInstall, installedOutput);
      if (missingExtensions.length) {
        throw new Error(
          `[deps] Required VS Code extensions are missing from the isolated test profile: ${missingExtensions.join(', ')}`
        );
      }
    }

    let extensionDevelopmentPath = resolve(__dirname, '..', 'apps', 'vscode-extension');
    let extensionTestsPath = resolve(__dirname, '..', 'apps', 'vscode-extension', 'out', 'test', 'runner.js');

    if (!args.smokeVsix) {
      await interrupts.settle(buildExtensionTestRunner(repoRoot));
    }
    const extensionsDir = shouldInstall && !args.smokeVsix ? cachedExtensionsDir : localExtensionsDir;

    // Optional: VSIX smoke mode installs the freshly built VSIX and runs a minimal activation test
    if (args.smokeVsix) {
      // Package VSIX
      console.log('[smoke] Packaging VSIX...');
      // Build artifacts (avoid full 'package' to reduce flakiness on CI)
      await interrupts.start('pnpm', ['run', 'build'], { capture: true }).finished;
      // Ensure l10n bundles exist (best-effort)
      await interrupts.start('pnpm', ['run', 'l10n:write'], { capture: true, allowFailure: true }).finished;
      const smokeVsixPath = join(profileDir, 'apex-log-viewer-smoke.vsix');
      await interrupts.start(
        process.execPath,
        [
          resolve(repoRoot, 'scripts', 'run-vsce.js'),
          'package',
          '--no-dependencies',
          '--skip-prepublish',
          '--no-yarn',
          '--out',
          smokeVsixPath
        ],
        { label: 'VSIX packaging' }
      ).finished;
      if (!existsSync(smokeVsixPath)) throw new Error('[smoke] VSIX not found');
      // Install into test profile
      console.log('[smoke] Installing VSIX into isolated profile...');
      const inst = await interrupts.start(
        cliPath,
        [
          ...cliArgs,
          '--install-extension',
          smokeVsixPath,
          '--force',
          '--user-data-dir',
          userDataDir,
          '--extensions-dir',
          extensionsDir
        ],
        { input: 'y\n', allowFailure: true, env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } }
      ).finished;
      if (inst.status !== 0) {
        throw new Error('[smoke] Failed to install VSIX');
      }
      // Create minimal harness extension
      const dev = join(profileDir, 'smoke-dev');
      mkdirSync(dev);
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
      // Write a runner that activates the installed extension and verifies its autonomous package boundary.
      const runner = [
        '"use strict";',
        "const assert=require('assert/strict');",
        "const fs=require('fs');",
        "const path=require('path');",
        "const vscode=require('vscode');",
        'exports.run=async function(){',
        "const ext=vscode.extensions.getExtension('electivus.apex-log-viewer');",
        "assert.ok(ext,'extension not found');",
        'await ext.activate();',
        'const cmds=await vscode.commands.getCommands(true);',
        "for(const c of ['electivus.apexLogViewer.logs.refresh','electivus.apexLogViewer.org.select','electivus.apexLogViewer.tail.start','electivus.apexLogViewer.output.show']){assert.ok(cmds.includes(c),'missing command: '+c);}",
        "assert.equal(fs.existsSync(path.join(ext.extensionPath,'sf-plugin')),false,'VSIX must not contain an embedded plugin');",
        '};',
        ''
      ].join('\n');
      extensionTestsPath = join(profileDir, 'smoke-runner.js');
      writeFileSync(extensionTestsPath, runner, 'utf8');
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

    mkdirSync(extensionsDir, { recursive: true });
    const launch = [
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      ...macKeychainLaunchArgs(),
      ...(process.env.VSCODE_TEST_WORKSPACE ? [process.env.VSCODE_TEST_WORKSPACE] : []),
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      '--disable-workspace-trust',
      `--extensionTestsPath=${extensionTestsPath}`,
      `--extensionDevelopmentPath=${extensionDevelopmentPath}`
    ];
    const host = interrupts.start(vscodeExecutablePath, launch, { label: 'VS Code test host' });
    const killer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[test-runner] Timed out after ${Math.round(totalTimeout / 1000)}s. Cleaning up...`);
      cleanupDeadline = setTimeout(() => {
        console.error(
          `[test-runner] Cleanup still pending after 30s. Scratch deletion is unconfirmed; preserve scratch authorization and any alv-devhub-jwt-* state under ${tmpdir()} for recovery. See the scratch alias in setup output.`
        );
        removeProfile();
        process.exit(124);
      }, 30_000);
      host.stop('SIGKILL');
      cleanupOnce().catch(() => {});
    }, totalTimeout);

    try {
      await host.finished;
    } catch (error) {
      if (!timedOut) throw error;
    } finally {
      clearTimeout(killer);
    }
  } finally {
    removeProfile();
    try {
      await cleanupOnce();
    } catch (error) {
      if (!timedOut) throw error;
      console.error('[test-runner] Cleanup failed:', error.message);
    } finally {
      clearTimeout(cleanupDeadline);
      // A download abandoned by a second Ctrl+C keeps extracting into the profile until the process exits.
      removeProfile();
      interrupts.dispose();
    }
  }
  if (timedOut) process.exit(124);
}

if (require.main === module) {
  run().catch(error => {
    console.error('[test-runner] Failed:', error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  ensureDefaultScratch,
  ensureDevHub,
  pretestSetup,
  resolveMissingExtensionIds,
  resolveRequiredDevHubConfig
};
