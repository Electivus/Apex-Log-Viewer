const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const filename = path.join(__dirname, 'run-tests.js');
const { reportRunFailure } = require('./run-tests.js');
const source = readFileSync(filename, 'utf8');

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`VS Code cleanup owns only its launch (${platform})`, async () => {
    const executable = '/fixture/.vscode-test/Code';
    const grouped = platform !== 'win32';
    const ownedSignal = (pid, signal) =>
      grouped ? [pid, 'process group', -pid, signal] : [pid, 'launch handle', pid, signal];
    const inventory = new Map([
      [600, '/fixture/Google Chrome/chrome_crashpad_handler'],
      [601, '/fixture/other-electron/chrome_crashpad_handler'],
      [602, executable],
      [603, '/fixture/.vscode-test/chrome_crashpad_handler'],
      [604, `${executable} --user-data-dir=/fixture/unknown`]
    ]);
    const signals = [];
    const inventoryReads = [];
    const hosts = new Map();
    const removed = [];
    const profiles = new Map();
    const open = (pid, args, onLaunch) => {
      const child = new EventEmitter();
      child.pid = pid;
      child.kill = signal => {
        signals.push([pid, 'launch handle', pid, signal]);
        if (signal === 'SIGINT') return true;
        if (pid === 704) return child.emit('error', new Error('Synthetic signal failure'));
        inventory.delete(pid);
        child.emit('exit', null, signal);
        return true;
      };
      inventory.set(pid, executable);
      hosts.set(pid, child);
      profiles.set(pid, args[args.indexOf('--user-data-dir') + 1]);
      onLaunch();
      return child;
    };

    async function start(pid) {
      const module = {};
      const process = Object.assign(new EventEmitter(), {
        argv: ['node', filename, '--scope=unit', '--timeout=50'],
        env: { __ALV_XVFB_RAN: '1' },
        pid: pid + 1000,
        ppid: 1,
        platform,
        cwd: () => '/fixture',
        chdir() {},
        kill(target, signal) {
          assert.equal(target, -pid, 'Only the isolated host group may be signaled');
          assert.ok(grouped, 'Windows does not have POSIX process groups');
          signals.push([pid, 'process group', target, signal]);
          if (signal === 'SIGINT') return;
          if (pid === 704) throw new Error('Synthetic signal failure');
          inventory.delete(pid);
          hosts.get(pid).emit('exit', null, signal);
        },
        exit(code) {
          process.exitCode = code;
        }
      });
      let timeout;
      let launched;
      const ready = new Promise(resolve => {
        launched = resolve;
      });
      const stubRequire = name => {
        switch (name) {
          case 'child_process':
            return {
              spawn(file, args, options) {
                assert.equal(options.detached, grouped);
                assert.equal(file, executable, 'Only the synthetic host can be launched');
                assert.ok(
                  args.includes(
                    '--extensionTestsPath=' + path.resolve(__dirname, '../apps/vscode-extension/out/test/runner.js')
                  )
                );
                assert.ok(
                  args.includes('--extensionDevelopmentPath=' + path.resolve(__dirname, '../apps/vscode-extension'))
                );
                assert.equal(args.includes('--use-mock-keychain'), platform === 'darwin');
                assert.ok(process.env.VSCODE_TEST_WORKSPACE, 'The run prepares a workspace');
                assert.equal(
                  args[0],
                  process.env.VSCODE_TEST_WORKSPACE,
                  'VS Code reads the first token after a bare flag such as --use-mock-keychain as its value, so the workspace leads'
                );
                return open(pid, args, launched);
              },
              execFile(file, args, options, callback) {
                assert.ok(file === 'ps' || file === 'powershell', 'Only the synthetic inventory is available');
                inventoryReads.push([pid, file]);
                const stdout =
                  file === 'ps'
                    ? [...inventory].map(([id, command]) => `${id} ${command}`).join('\n')
                    : [...inventory.keys()].join('\n');
                callback(null, stdout, '');
              }
            };
          case 'os':
            return { platform: () => platform, tmpdir: () => '/fixture/tmp' };
          case 'fs':
            return {
              mkdirSync() {},
              writeFileSync() {},
              rmSync: dir => removed.push([pid, dir]),
              mkdtempSync: prefix => `${prefix}${pid}`
            };
          case 'path':
            return path;
          case 'node:util':
            return require(name);
          case '@vscode/test-electron':
            return {
              downloadAndUnzipVSCode: async () => executable,
              resolveCliArgsFromVSCodeExecutablePath: () => ['not-used'],
              runTests: ({ launchArgs }) =>
                new Promise(resolve => open(pid, launchArgs, launched).once('exit', resolve))
            };
          case 'esbuild':
            return { build: async () => {} };
          case './clean-vscode-test.js':
            return { cacheCleanRequested: () => false };
          case './devhub-auth.js':
            return {
              requiresScratchSetup: () => false,
              resolveDevHubConfig: () => undefined
            };
          case './run-playwright-cli-e2e.js':
            return {};
          case 'cross-spawn':
            return (file, args, options) => stubRequire('child_process').spawn(file, args, options);
          case 'proper-lockfile':
            return { lock: async () => async () => {} };
          default:
            throw new Error(`Unexpected module: ${name}`);
        }
      };
      const run = runInNewContext(
        `${source}\nrun()`,
        {
          require: stubRequire,
          module,
          process,
          __filename: filename,
          __dirname: __dirname,
          console: { log() {}, warn() {}, error() {} },
          setTimeout(callback, ms) {
            if (ms === 50) timeout = callback;
            if (ms === 300) callback();
            return callback;
          },
          clearTimeout(handle) {
            if (handle === timeout) timeout = undefined;
          }
        },
        { filename }
      );
      await Promise.race([ready, run.then(() => assert.fail('The synthetic host did not launch'))]);
      return { run, process, timeOut: () => timeout() };
    }

    const [first, second] = await Promise.all([start(700), start(701)]);
    inventory.set(700, `${executable} --user-data-dir=/fixture/reused-pid`);
    hosts.get(700).emit('exit', 0, null);
    await first.run;
    assert.deepEqual(signals, [], 'An exited launch cannot signal anyone, including a reused PID');
    assert.notEqual(profiles.get(700), profiles.get(701), 'The two launches must not share a VS Code instance');
    assert.ok(removed.some(([pid, dir]) => pid === 700 && dir === path.dirname(profiles.get(700))));
    assert.ok(!removed.some(([, dir]) => dir === path.dirname(profiles.get(701))));

    await second.timeOut();
    await second.run;
    assert.equal(second.process.exitCode, 124);
    assert.deepEqual(signals, [ownedSignal(701, 'SIGKILL')]);
    assert.deepEqual([...inventory.keys()], [600, 601, 602, 603, 604, 700]);

    const [third, fourth] = await Promise.all([start(702), start(703)]);
    third.process.emit('SIGINT');
    third.process.emit('SIGINT');
    await assert.rejects(third.run, /Interrupted/);
    assert.deepEqual(signals.slice(1), [ownedSignal(702, 'SIGINT'), ownedSignal(702, 'SIGKILL')]);
    assert.deepEqual([...inventory.keys()], [600, 601, 602, 603, 604, 700, 703]);
    inventory.delete(703);
    hosts.get(703).emit('exit', 0, null);
    await fourth.run;
    assert.equal(signals.length, 3);

    const last = await start(704);
    const shutdown = last.timeOut();
    await Promise.resolve();
    assert.equal(last.process.exitCode, undefined, 'A failed signal does not count as host exit');
    assert.ok(!removed.some(([, dir]) => dir === path.dirname(profiles.get(704))));
    hosts.get(704).emit('exit', 0, null);
    await Promise.all([shutdown, last.run]);
    assert.equal(last.process.exitCode, 124);
    assert.deepEqual(signals.slice(3), [ownedSignal(704, 'SIGKILL')]);
    assert.deepEqual(inventoryReads, [], 'Cleanup must not enumerate even without signaling');
  });
}

const cleanFilename = path.join(__dirname, 'clean-vscode-test.js');
const cleanSource = readFileSync(cleanFilename, 'utf8');
const repoRoot = path.resolve(__dirname, '..');

const fixtureTmp = '/fixture/tmp';
// Node's os.tmpdir() reads these variables on every call.
const tmpdirOf = (env, platform) =>
  (platform === 'win32' ? env.TEMP || env.TMP : env.TMPDIR || env.TMP || env.TEMP) || fixtureTmp;

function fakeChild(kind, run) {
  const child = Object.assign(new EventEmitter(), { pid: 1 });
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.finish = (code, signal = null) => {
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.kill = signal => {
    run.childSignals.push([kind, signal]);
    if (signal === 'SIGKILL' || !run.stubborn)
      setImmediate(() => (run.exitsZero ? child.finish(0) : child.finish(null, signal)));
    return true;
  };
  return child;
}

const buildOutputs = [
  path.join(repoRoot, 'apps', 'vscode-extension', 'dist', 'extension.js'),
  path.join(repoRoot, 'apps', 'vscode-extension', 'media', 'main.js')
];
const tick = () => new Promise(resolve => setImmediate(resolve));

// The checkout records a clobber whenever a run removes or rewrites a file that another run wrote.
function createCheckout({ cachedBuild = 'stable' } = {}) {
  const cachedDir = path.join(repoRoot, '.vscode-test', `vscode-linux-x64-${cachedBuild}`);
  const files = new Map();
  const owners = new Map();
  const clobbers = [];
  const locks = new Set();
  const removed = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const filesUnder = dir => [...files.keys()].filter(file => file === dir || file.startsWith(dir + path.sep));
  const put = (by, file, content) => {
    if (owners.has(file) && owners.get(file) !== by) clobbers.push({ by, file, owner: owners.get(file) });
    files.set(file, content);
    owners.set(file, by);
  };
  const drop = (by, dir) => {
    for (const file of filesUnder(dir)) {
      if (owners.has(file) && owners.get(file) !== by) clobbers.push({ by, file, owner: owners.get(file) });
      files.delete(file);
      owners.delete(file);
    }
  };
  if (cachedBuild) {
    put('cache', path.join(cachedDir, 'code'), 'cached VS Code');
    put('cache', path.join(cachedDir, 'is-complete'), '');
  }
  const installedIn = dir => {
    const ids = filesUnder(dir)
      .filter(file => path.basename(file) === 'package.json')
      .map(file => `${path.basename(path.dirname(file))}@1.0.0`);
    return ids.length ? [['stdout', ids.join('\n') + '\n']] : [];
  };

  // interrupt: { at, presses, stubborn }. SIGINT reaches only the runner, the way `kill -INT <pid>` does,
  // so the runner must stop its own child. A process with no SIGINT listener dies at once and runs no finally.
  function start(
    id,
    { argv, env = {}, interrupt = {}, platform = 'linux', listing, holdProfile = 0, exitsZero = false }
  ) {
    const run = {
      id,
      childSignals: [],
      foreignSignals: [],
      stubborn: !!interrupt.stubborn,
      exitsZero,
      onSigint: [],
      builds: 0,
      warnings: []
    };
    const signals = {};
    for (const name of ['packaged', 'launched', 'died']) {
      run[name] = new Promise(resolve => {
        signals[name] = resolve;
      });
    }
    const process = Object.assign(new EventEmitter(), {
      argv: ['node', filename, ...argv],
      env: { __ALV_XVFB_RAN: '1', ...env },
      execPath: 'node',
      platform,
      cwd: () => repoRoot,
      chdir() {},
      kill(target, signal) {
        run.foreignSignals.push([target, signal]);
      },
      exit(code) {
        process.exitCode = code;
      }
    });
    const pressCtrlC = () => {
      if (process.listenerCount('SIGINT') === 0) {
        signals.died({ exitCode: 130, leftover: filesUnder(fixtureTmp) });
        return;
      }
      process.emit('SIGINT');
      for (const hook of run.onSigint) hook();
    };
    const reached = step => {
      if (interrupt.at !== step) return;
      if (process.listenerCount('SIGINT') === 0) return pressCtrlC();
      let presses = interrupt.presses || 1;
      const press = () => {
        pressCtrlC();
        if (--presses > 0) setImmediate(press);
      };
      setImmediate(press);
    };
    const codeCli = args => {
      const index = args.indexOf('--install-extension');
      if (index < 0) return false;
      run.installed = files.get(args[index + 1]);
      reached('installing');
      return true;
    };
    const fs = {
      existsSync: file => files.has(file),
      mkdirSync: dir => files.set(dir, 'directory'),
      writeFileSync: (file, content) => files.set(file, content),
      mkdtempSync: prefix => {
        files.set(`${prefix}${id}`, 'directory');
        return `${prefix}${id}`;
      },
      rmSync: (target, options = {}) => {
        run.extractLate?.();
        // A process that holds a profile file makes removal fail until it lets go. Node's rmSync retries
        // maxRetries times.
        if (path.basename(target).startsWith('alv-vscode-'))
          for (let attempt = 0; attempt < holdProfile; attempt += 1)
            if (attempt >= (options.maxRetries ?? 0))
              throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY' });
        removed.push(target);
        for (const file of filesUnder(target)) files.delete(file);
      }
    };
    const spawn = (file, args, options = {}) => {
      if (file === 'node') {
        const child = fakeChild('packaging', run);
        const out = args[args.indexOf('--out') + 1];
        run.vsixOut = out;
        files.set(out, `VSIX built by ${id}`);
        // vsce copies the build while it packages, so the VSIX is whole only if no build output changed meanwhile.
        const staged = buildOutputs.map(output => files.get(output));
        // run-vsce.js stages the extension under its os.tmpdir() and removes the stage unless SIGKILL stops it.
        const stage = path.join(tmpdirOf(options.env || process.env, platform), `alv-vsce-stage-${id}`);
        files.set(stage, 'directory');
        const finish = child.finish;
        child.finish = (code, signal = null) => {
          if (signal !== 'SIGKILL') for (const file of filesUnder(stage)) files.delete(file);
          if (staged.some((content, index) => content === undefined || content !== files.get(buildOutputs[index])))
            files.set(out, `partial VSIX from ${id}`);
          finish(code, signal);
        };
        run.finishPackaging = () => child.finish(0);
        signals.packaged();
        reached('packaging');
        if (interrupt.at && interrupt.at !== 'packaging') setImmediate(run.finishPackaging);
        return child;
      }
      if (file === 'pnpm') {
        const child = fakeChild('pnpm', run);
        // `pnpm run build` runs `pnpm run clean` first, then writes the outputs one by one.
        setImmediate(async () => {
          if (args[1] === 'build') {
            for (const output of buildOutputs) files.delete(output);
            for (const output of buildOutputs) {
              await tick();
              files.set(output, `built by ${id}`);
            }
          }
          child.finish(0);
        });
        return child;
      }
      if (file === 'code-cli') {
        const child = fakeChild('code-cli', run);
        const extensionsDir = args[args.indexOf('--extensions-dir') + 1];
        const listed = args.includes('--list-extensions') ? (listing ?? installedIn(extensionsDir)) : [];
        const index = args.indexOf('--install-extension');
        const fromMarketplace = index >= 0 && !files.has(args[index + 1]);
        if (!codeCli(args) || interrupt.at !== 'installing')
          setImmediate(async () => {
            for (const [stream, chunk] of listed) child[stream].emit('data', chunk);
            // A forced install removes the extension, then writes it again.
            if (fromMarketplace) {
              const dir = path.join(extensionsDir, args[index + 1]);
              drop(id, dir);
              await checkout.installGate;
              for (const part of ['extension.js', 'package.json']) {
                await tick();
                put(id, path.join(dir, part), `installed by ${id}`);
              }
            }
            child.finish(0);
          });
        return child;
      }
      assert.equal(file, run.executable, 'Only the build this run downloaded can launch');
      run.hostTemp = tmpdirOf(options.env || process.env, platform);
      run.hostExtensionsDir = args[args.indexOf('--extensions-dir') + 1];
      run.host = fakeChild('host', run);
      signals.launched();
      return run.host;
    };
    const stubRequire = name => {
      switch (name) {
        case 'child_process':
          return {
            spawn,
            execFile(file, args, options, callback) {
              assert.equal(file, 'pnpm', 'Only the synthetic build can run');
              callback(null, '', '');
            }
          };
        case 'proper-lockfile':
          return {
            async lock(file, { lockfilePath = `${file}.lock` } = {}) {
              if (locks.has(lockfilePath))
                throw Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' });
              locks.add(lockfilePath);
              return async () => {
                locks.delete(lockfilePath);
              };
            }
          };
        case 'cross-spawn':
          return Object.assign(spawn, {
            sync(file, args) {
              codeCli(args);
              return { status: 0, stdout: '', stderr: '' };
            }
          });
        case 'os':
          return { platform: () => platform, tmpdir: () => tmpdirOf(process.env, platform) };
        case 'fs':
          return fs;
        case 'path':
          return path;
        case 'node:util':
          return require(name);
        case '@vscode/test-electron':
          return {
            downloadAndUnzipVSCode: async ({ version, cachePath }) => {
              const build = path.join(cachePath, `vscode-linux-x64-${/insider/.test(version) ? 'insiders' : 'stable'}`);
              const executable = path.join(build, 'code');
              if (interrupt.at !== 'downloading') {
                // @vscode/test-electron 3.1.0 reuses a complete build, except an Insiders build with a newer one out.
                // Otherwise it removes the directory and downloads into it.
                run.executable = executable;
                const complete = files.has(path.join(build, 'is-complete'));
                run.downloaded = !complete || (build.endsWith('insiders') && checkout.newerInsiders);
                if (!run.downloaded) return executable;
                drop(id, build);
                for (const part of ['resources', 'code', 'is-complete']) {
                  await tick();
                  put(id, path.join(build, part), `VS Code downloaded by ${id}`);
                }
                return executable;
              }
              const downloaded = () => {
                run.executable = executable;
                run.downloaded = !files.has(executable);
                files.set(executable, 'downloaded VS Code');
                return executable;
              };
              files.set(path.join(cachePath, 'partial.zip'), 'partial download');
              // On macOS, @vscode/test-electron saves the archive under os.tmpdir() and deletes it after unzip exits.
              const archive = path.join(tmpdirOf(process.env, platform), `vscode-test-${id}.zip`);
              if (platform === 'darwin') files.set(archive, 'downloaded archive');
              reached('downloading');
              // One press lets the download finish. A second press abandons it, and its extraction keeps
              // writing while the run cleans up, until the process exits.
              return new Promise(resolve => {
                let presses = 0;
                run.onSigint.push(() => {
                  presses += 1;
                  if (presses === 1 && interrupt.presses === 1)
                    setImmediate(() => {
                      files.delete(archive);
                      resolve(downloaded());
                    });
                  if (presses === 2)
                    run.extractLate = () => files.set(path.join(cachePath, 'late-extract'), 'extracted');
                });
              });
            },
            resolveCliArgsFromVSCodeExecutablePath: () => ['code-cli']
          };
        case 'esbuild':
          return {
            build: async () => {
              run.builds += 1;
            }
          };
        case './clean-vscode-test.js': {
          const cleanModule = { exports: {} };
          runInNewContext(
            cleanSource,
            { require: stubRequire, module: cleanModule, process, console: quiet },
            { filename: cleanFilename }
          );
          return cleanModule.exports;
        }
        case './devhub-auth.js':
          return { requiresScratchSetup: () => false, resolveDevHubConfig: () => undefined };
        case './run-playwright-cli-e2e.js':
          return {};
        default:
          throw new Error(`Unexpected module: ${name}`);
      }
    };
    run.run = runInNewContext(
      `${source}\nrun()`,
      {
        require: stubRequire,
        module: {},
        process,
        __filename: filename,
        __dirname,
        console: { ...quiet, warn: (...args) => run.warnings.push(args.join(' ')) },
        // Unref'd, so a run a failed test leaves waiting cannot keep the test process alive.
        setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
        clearTimeout
      },
      { filename }
    );
    run.ended = Promise.race([
      run.died,
      run.run
        .then(
          () => 0,
          () => 1
        )
        .then(code => ({ exitCode: process.exitCode ?? code, leftover: filesUnder(fixtureTmp) }))
    ]);
    for (const name of ['packaged', 'launched']) {
      run[name] = Promise.race([run[name], run.run.then(() => assert.fail(`Run ${id} ended before it ${name}`))]);
      run[name].catch(() => {});
    }
    run.pressCtrlC = pressCtrlC;
    run.finish = () => {
      run.host.finish(0);
      return run.run;
    };
    return run;
  }

  const removedUnder = file => removed.filter(target => file === target || file.startsWith(target + path.sep));
  const checkout = { files, clobbers, start, removedUnder, newerInsiders: false };
  return checkout;
}

test('a run that asks for a clean cache leaves the VS Code build another run uses', async () => {
  const checkout = createCheckout();
  const first = checkout.start('first', { argv: ['--scope=unit'] });
  await first.launched;
  const second = checkout.start('second', { argv: ['--scope=unit'], env: { CLEAN_VSCODE_TEST_CACHE: '1' } });
  await second.launched;

  assert.equal(first.downloaded, false, 'The first run reuses the cached build');
  assert.equal(second.downloaded, true, 'A clean-cache run downloads a fresh build');
  assert.equal(second.hostTemp, fixtureTmp, 'VS Code keeps the system temp dir');
  await second.finish();
  assert.deepEqual(checkout.removedUnder(first.executable), [], 'The running build was never removed');
  assert.ok(checkout.files.has(first.executable));
  await first.finish();
});

const smoke = ['--scope=unit', '--smoke-vsix'];
const dependency = { VSCODE_TEST_EXTENSIONS: 'fixture.dependency' };

test("two runs on a cold cache download VS Code once and leave each other's files alone", async () => {
  const checkout = createCheckout({ cachedBuild: null });
  const first = checkout.start('first', { argv: ['--scope=unit'] });
  const second = checkout.start('second', { argv: ['--scope=unit'] });
  await Promise.all([first.launched, second.launched]);

  assert.deepEqual(checkout.clobbers, []);
  assert.equal([first, second].filter(run => run.downloaded).length, 1, 'The second run reuses the first download');
  await Promise.all([first.finish(), second.finish()]);
});

test('an Insiders run leaves the Insiders build another run uses when a newer one is out', async () => {
  const checkout = createCheckout({ cachedBuild: 'insiders' });
  const first = checkout.start('first', { argv: ['--scope=unit', '--vscode=insiders'] });
  await first.launched;
  checkout.newerInsiders = true;
  const second = checkout.start('second', { argv: ['--scope=unit', '--vscode=insiders'] });
  await second.launched;

  assert.deepEqual(checkout.clobbers, []);
  assert.ok(checkout.files.has(first.executable), 'The running build is still there');
  await Promise.all([first.finish(), second.finish()]);
});

test("two runs that install the same missing extension leave each other's files alone", async () => {
  const checkout = createCheckout();
  let openGate;
  // Installs wait here, so the second run reaches its install while the first is still writing.
  checkout.installGate = new Promise(resolve => {
    openGate = resolve;
  });
  const argv = ['--scope=unit', '--install-deps'];
  const first = checkout.start('first', { argv, env: dependency });
  const second = checkout.start('second', { argv, env: dependency });
  await new Promise(resolve => setTimeout(resolve, 1500));
  openGate();
  await Promise.all([first.launched, second.launched]);

  assert.deepEqual(checkout.clobbers, []);
  await Promise.all([first.finish(), second.finish()]);
  assert.equal((await first.ended).exitCode, 0);
  assert.equal((await second.ended).exitCode, 0);
});

test('a forced install leaves the extensions another run uses', async () => {
  const checkout = createCheckout();
  const first = checkout.start('first', { argv: ['--scope=unit', '--install-deps'], env: dependency });
  await first.launched;
  const second = checkout.start('second', {
    argv: ['--scope=unit', '--install-deps', '--force-install-deps'],
    env: dependency
  });
  await second.launched;

  assert.deepEqual(checkout.clobbers, []);
  assert.ok(checkout.files.has(path.join(first.hostExtensionsDir, 'fixture.dependency', 'package.json')));
  assert.ok(checkout.files.has(path.join(second.hostExtensionsDir, 'fixture.dependency', 'package.json')));
  await Promise.all([first.finish(), second.finish()]);
});

test('a smoke run that starts while another packages its VSIX leaves that build alone', async () => {
  const checkout = createCheckout();
  const first = checkout.start('first', { argv: smoke });
  await first.packaged;
  const second = checkout.start('second', { argv: smoke });
  await new Promise(resolve => setTimeout(resolve, 200));
  first.finishPackaging();
  await second.packaged;
  second.finishPackaging();
  await Promise.all([first.launched, second.launched]);

  assert.equal(first.installed, 'VSIX built by first');
  assert.equal(second.installed, 'VSIX built by second');
  assert.notEqual(first.vsixOut, second.vsixOut);
  await Promise.all([first.finish(), second.finish()]);
  assert.deepEqual(
    [...checkout.files.keys()].filter(file => file.endsWith('.vsix')),
    [],
    'Each run removes its VSIX with its profile'
  );
});

test('Ctrl+C while a run waits for another to finish its build stops only the waiting run', async () => {
  const checkout = createCheckout();
  const first = checkout.start('first', { argv: smoke });
  await first.packaged;
  const second = checkout.start('second', { argv: smoke });
  await new Promise(resolve => setTimeout(resolve, 200));
  second.pressCtrlC();
  const { exitCode, leftover } = await second.ended;

  assert.equal(exitCode, 1);
  assert.deepEqual(
    leftover.filter(file => file.includes('second')),
    []
  );
  assert.deepEqual(second.childSignals, [], 'The waiting run had no child to stop');
  first.finishPackaging();
  await first.launched;
  assert.equal(first.installed, 'VSIX built by first');
  await first.finish();
});

// The real lock, in real processes: each holder writes when it enters and leaves. The second holder is killed
// with SIGKILL inside the lock, so it never removes the lock directory.
test('the checkout lock admits one process at a time, survives a removed .vscode-test and outlives a holder killed with SIGKILL', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'alv-lock-'));
  const journal = path.join(root, 'journal');
  const until = async predicate => {
    for (const deadline = Date.now() + 30_000; !predicate(); await new Promise(resolve => setTimeout(resolve, 50)))
      assert.ok(Date.now() < deadline, `Timed out waiting for ${predicate}`);
  };
  const holder = (name, inside, onOutput = () => {}) =>
    new Promise((resolve, reject) => {
      const script = `const fs = require('fs');
require(${JSON.stringify(filename)}).withCheckoutLock(${JSON.stringify(root)}, { check() {} }, async () => {
  fs.appendFileSync(${JSON.stringify(journal)}, 'enter ${name}\\n');
  ${inside}
  fs.appendFileSync(${JSON.stringify(journal)}, 'leave ${name}\\n');
});`;
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', chunk => {
        stdout += chunk;
        onOutput(String(chunk));
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal, stdout }));
    });
  try {
    const release = path.join(root, 'release');
    const untilReleased = `while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 50));`;
    const first = holder('a', untilReleased);
    await until(() => readFileSync(journal, { encoding: 'utf8', flag: 'a+' }).includes('enter a'));
    let secondOutput = '';
    const second = holder('b', '', chunk => (secondOutput += chunk));
    await until(() => secondOutput.includes('Waiting for another test run'));
    writeFileSync(release, '');
    assert.deepEqual([(await first).code, (await second).code], [0, 0]);
    assert.deepEqual(readFileSync(journal, 'utf8').trim().split('\n'), ['enter a', 'leave a', 'enter b', 'leave b']);

    rmSync(journal);
    rmSync(release);
    const holderOfRemoved = holder('e', untilReleased);
    await until(() => readFileSync(journal, { encoding: 'utf8', flag: 'a+' }).includes('enter e'));
    let waiterOutput = '';
    const waiter = holder('f', '', chunk => (waiterOutput += chunk));
    await until(() => waiterOutput.includes('Waiting for another test run'));
    rmSync(path.join(root, '.vscode-test'), { recursive: true, force: true });
    writeFileSync(release, '');
    assert.equal((await waiter).code, 0, 'A run waiting while .vscode-test is removed still gets the lock');
    await holderOfRemoved;

    rmSync(journal);
    const killed = await holder('c', "process.kill(process.pid, 'SIGKILL');");
    assert.ok(killed.signal === 'SIGKILL' || killed.code !== 0);
    const started = Date.now();
    const next = await holder('d', '');
    assert.equal(next.code, 0);
    assert.ok(Date.now() - started < 30_000);
    assert.deepEqual(readFileSync(journal, 'utf8').trim().split('\n'), ['enter c', 'enter d', 'leave d']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run removes a profile that another process holds for a moment', async () => {
  const checkout = createCheckout();
  const run = checkout.start('first', { argv: ['--scope=unit'], holdProfile: 3 });
  await run.launched;
  const { exitCode } = await run.finish().then(() => run.ended);

  assert.equal(exitCode, 0);
  assert.equal(checkout.files.has(path.join(fixtureTmp, 'alv-vscode-first')), false, 'The profile is removed');
  assert.deepEqual(run.warnings, []);
});

test('a run that cannot remove its profile names the profile to remove', async () => {
  const checkout = createCheckout();
  const run = checkout.start('first', { argv: ['--scope=unit'], holdProfile: Infinity });
  await run.launched;
  const { exitCode } = await run.finish().then(() => run.ended);
  const profile = path.join(fixtureTmp, 'alv-vscode-first');

  assert.equal(exitCode, 0);
  assert.ok(checkout.files.has(profile), 'The held profile stays');
  assert.ok(run.warnings.length > 0);
  for (const warning of run.warnings) assert.ok(warning.includes(profile), warning);
});

// Resolves when the holder prints its first output; rejects at once if it fails to spawn or exits before that.
function holderOpened(holder, stderr) {
  const ac = new AbortController();
  const opened = once(holder.stdout, 'data', { signal: ac.signal });
  const failed = Promise.race([
    once(holder, 'error', { signal: ac.signal }).then(([error]) => {
      throw new Error(`The holder process failed to start: ${error.message}`);
    }),
    once(holder, 'exit', { signal: ac.signal }).then(([code, signal]) => {
      throw new Error(
        `The holder process exited (code ${code}, signal ${signal}) before it opened the file: ${stderr()}`
      );
    })
  ]);
  return Promise.race([opened, failed]).finally(() => ac.abort());
}

test(
  'removeTestProfile removes a profile whose file another process holds for a moment',
  { skip: process.platform !== 'win32' && 'Only Windows refuses to remove a file that a process holds open' },
  async () => {
    const profile = mkdtempSync(path.join(tmpdir(), 'alv-vscode-'));
    const held = path.join(profile, 'held');
    writeFileSync(held, '');
    // Opened with FileShare.None, as a Windows process can, so nothing can delete the file until it is closed.
    const holder = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$f = [IO.File]::Open('${held.replace(/'/g, "''")}', 'Open', 'Read', 'None'); Write-Output open; Start-Sleep -Milliseconds 1000; $f.Close()`
    ]);
    let holderStderr = '';
    holder.stderr.on('data', chunk => (holderStderr += chunk));
    try {
      await holderOpened(holder, () => holderStderr);
      assert.throws(() => rmSync(profile, { recursive: true, force: true }), /EBUSY|EPERM/);
      require('./run-tests.js').removeTestProfile(profile);
      assert.equal(existsSync(profile), false);
    } finally {
      holder.kill();
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
);

test('a diagnostic on stderr does not hide an extension ID listed on stdout', async () => {
  const checkout = createCheckout();
  const run = checkout.start('first', {
    argv: ['--scope=unit', '--install-deps'],
    env: { VSCODE_TEST_EXTENSIONS: 'fixture.dependency' },
    listing: [
      ['stderr', 'fixture diagnostic: '],
      ['stdout', 'fixture.dependency@1.0.0\n']
    ]
  });
  await run.launched;
  assert.equal(run.builds, 1);
  run.finish();
  assert.equal((await run.ended).exitCode, 0);
});

test('Ctrl+C reports an interrupted run even when the child exits with 0', async () => {
  // `pnpm run` waits for a script that handles SIGINT and then exits 0.
  const checkout = createCheckout();
  const run = checkout.start('first', { argv: smoke, exitsZero: true, interrupt: { at: 'packaging' } });
  await assert.rejects(run.run, error => {
    assert.match(error.message, /Interrupted/);
    assert.doesNotMatch(error.message, /exited with/);
    return true;
  });
});

test('An interrupted run exits 130 and any other failure exits 1', () => {
  const lines = [];
  const log = { error: line => lines.push(line) };
  assert.equal(
    reportRunFailure(Object.assign(new Error('[test-runner] Interrupted.'), { interrupted: true }), log),
    130
  );
  assert.equal(reportRunFailure(new Error('pnpm exited with 1'), log), 1);
  assert.deepEqual(lines, ['[test-runner] Interrupted.', '[test-runner] Failed: pnpm exited with 1']);
});

const cleanCache = { CLEAN_VSCODE_TEST_CACHE: '1' };
for (const { step, argv, env, platform, presses = 1, stubborn = false, childSignals } of [
  { step: 'packaging', argv: smoke, childSignals: [['packaging', 'SIGINT']] },
  ...['linux', 'win32'].map(platform => ({
    step: 'packaging',
    argv: smoke,
    platform,
    presses: 2,
    stubborn: true,
    childSignals: [
      ['packaging', 'SIGINT'],
      ['packaging', 'SIGKILL']
    ]
  })),
  { step: 'installing', argv: smoke, childSignals: [['code-cli', 'SIGINT']] },
  {
    step: 'installing',
    argv: ['--scope=unit', '--install-deps'],
    env: { VSCODE_TEST_EXTENSIONS: 'fixture.dependency' },
    childSignals: [['code-cli', 'SIGINT']]
  },
  ...['linux', 'darwin'].flatMap(platform =>
    [undefined, cleanCache].flatMap(env =>
      [1, 2].map(presses => ({ step: 'downloading', argv: ['--scope=unit'], env, platform, presses, childSignals: [] }))
    )
  )
]) {
  const shown = [...argv.slice(1), ...Object.keys(env || {}), ...(platform && platform !== 'linux' ? [platform] : [])];
  const label = `${step} (${shown.join(' ') || 'shared cache'}, pressed ${presses}x)`;
  test(`Ctrl+C while ${label} leaves no file of the run behind`, async () => {
    const checkout = createCheckout();
    const run = checkout.start('first', { argv, env, platform, interrupt: { at: step, presses, stubborn } });
    const { exitCode, leftover } = await run.ended;

    assert.deepEqual(leftover, [], 'The run removes its workspace and profile, with the VSIX, vsce stage and archive');
    assert.equal(exitCode, 1);
    assert.deepEqual(run.childSignals, childSignals, 'Only the child the run started receives SIGINT, then SIGKILL');
    assert.deepEqual(run.foreignSignals, []);
    assert.equal(run.host, undefined, 'An interrupted run never launches VS Code');
    assert.equal(run.builds, 0, 'An interrupted run starts no build');
  });
}
