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
const source = readFileSync(filename, 'utf8');

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`VS Code cleanup owns only its launch (${platform})`, async () => {
    const executable = '/fixture/.vscode-test/Code';
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
          signals.push([pid, 'global PID', target, signal]);
          if (!inventory.has(target)) throw new Error('Synthetic PID does not exist');
          inventory.delete(target);
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
              spawn(file, args) {
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
    assert.deepEqual(signals, [[701, 'launch handle', 701, 'SIGKILL']]);
    assert.deepEqual([...inventory.keys()], [600, 601, 602, 603, 604, 700]);

    const [third, fourth] = await Promise.all([start(702), start(703)]);
    third.process.emit('SIGINT');
    third.process.emit('SIGINT');
    await assert.rejects(third.run, /VS Code test host exited with SIGKILL/);
    assert.deepEqual(signals.slice(1), [
      [702, 'launch handle', 702, 'SIGINT'],
      [702, 'launch handle', 702, 'SIGKILL']
    ]);
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
    assert.deepEqual(signals.slice(3), [[704, 'launch handle', 704, 'SIGKILL']]);
    assert.deepEqual(inventoryReads, [], 'Cleanup must not enumerate even without signaling');
  });
}

const cleanFilename = path.join(__dirname, 'clean-vscode-test.js');
const cleanSource = readFileSync(cleanFilename, 'utf8');
const repoRoot = path.resolve(__dirname, '..');
const sharedExecutable = path.join(repoRoot, '.vscode-test', 'vscode-linux-x64-stable', 'code');

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
    if (signal === 'SIGKILL' || !run.stubborn) setImmediate(() => child.finish(null, signal));
    return true;
  };
  return child;
}

function createCheckout() {
  const files = new Map([[sharedExecutable, 'cached VS Code']]);
  const removed = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const filesUnder = dir => [...files.keys()].filter(file => file === dir || file.startsWith(dir + path.sep));

  // interrupt: { at, presses, stubborn }. SIGINT reaches only the runner, the way `kill -INT <pid>` does,
  // so the runner must stop its own child. A process with no SIGINT listener dies at once and runs no finally.
  function start(id, { argv, env = {}, interrupt = {}, platform = 'linux', listing = [], holdProfile = 0 }) {
    const run = {
      id,
      childSignals: [],
      foreignSignals: [],
      stubborn: !!interrupt.stubborn,
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
        files.set(args[args.indexOf('--out') + 1], `VSIX built by ${id}`);
        // run-vsce.js stages the extension under its os.tmpdir() and removes the stage unless SIGKILL stops it.
        const stage = path.join(tmpdirOf(options.env || process.env, platform), `alv-vsce-stage-${id}`);
        files.set(stage, 'directory');
        const finish = child.finish;
        child.finish = (code, signal = null) => {
          if (signal !== 'SIGKILL') for (const file of filesUnder(stage)) files.delete(file);
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
        setImmediate(() => child.finish(0));
        return child;
      }
      if (file === 'code-cli') {
        const child = fakeChild('code-cli', run);
        const listed = args.includes('--list-extensions') ? listing : [];
        if (!codeCli(args) || interrupt.at !== 'installing')
          setImmediate(() => {
            for (const [stream, chunk] of listed) child[stream].emit('data', chunk);
            child.finish(0);
          });
        return child;
      }
      assert.equal(file, run.executable, 'Only the build this run downloaded can launch');
      run.hostTemp = tmpdirOf(options.env || process.env, platform);
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
            downloadAndUnzipVSCode: async ({ cachePath }) => {
              const executable = path.join(cachePath, 'vscode-linux-x64-stable', 'code');
              const downloaded = () => {
                run.executable = executable;
                run.downloaded = !files.has(executable);
                files.set(executable, 'downloaded VS Code');
                return executable;
              };
              if (interrupt.at !== 'downloading') return downloaded();
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
        setTimeout: callback => callback,
        clearTimeout() {}
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
    run.finish = () => {
      run.host.finish(0);
      return run.run;
    };
    return run;
  }

  const removedUnder = file => removed.filter(target => file === target || file.startsWith(target + path.sep));
  return { files, start, removedUnder };
}

test('two overlapping VSIX smoke runs each install the VSIX they built', async () => {
  const checkout = createCheckout();
  const first = checkout.start('first', { argv: ['--scope=unit', '--smoke-vsix'] });
  const second = checkout.start('second', { argv: ['--scope=unit', '--smoke-vsix'] });
  await Promise.all([first.packaged, second.packaged]);
  first.finishPackaging();
  second.finishPackaging();
  await Promise.all([first.launched, second.launched]);

  assert.equal(first.installed, 'VSIX built by first');
  assert.equal(second.installed, 'VSIX built by second');
  await Promise.all([first.finish(), second.finish()]);
});

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

test('a run removes a profile that another process holds for a moment', async () => {
  const run = createCheckout().start('first', { argv: ['--scope=unit'], holdProfile: 3 });
  await run.launched;
  const { exitCode, leftover } = await run.finish().then(() => run.ended);

  assert.equal(exitCode, 0);
  assert.deepEqual(leftover, []);
  assert.deepEqual(run.warnings, []);
});

test('a run that cannot remove its profile names the profile to remove', async () => {
  const run = createCheckout().start('first', { argv: ['--scope=unit'], holdProfile: Infinity });
  await run.launched;
  const { exitCode, leftover } = await run.finish().then(() => run.ended);

  assert.equal(exitCode, 0);
  assert.ok(leftover.includes(path.join(fixtureTmp, 'alv-vscode-first')));
  assert.ok(run.warnings.length > 0);
  for (const warning of run.warnings) assert.ok(warning.includes(path.join(fixtureTmp, 'alv-vscode-first')), warning);
});

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
    try {
      await once(holder.stdout, 'data');
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

const smoke = ['--scope=unit', '--smoke-vsix'];
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
