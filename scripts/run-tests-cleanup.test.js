const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
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
            return { cleanVsCodeTest() {} };
          case './devhub-auth.js':
            return {
              requiresScratchSetup: () => false,
              resolveDevHubConfig: () => undefined
            };
          case './run-playwright-cli-e2e.js':
            return {};
          case 'cross-spawn':
            return {};
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

function createCheckout() {
  const files = new Map([[sharedExecutable, 'cached VS Code']]);
  const removed = [];
  const quiet = { log() {}, warn() {}, error() {} };

  function start(id, { argv, env = {} }) {
    const run = { id };
    const signals = {};
    for (const name of ['packaged', 'launched']) {
      run[name] = new Promise(resolve => {
        signals[name] = resolve;
      });
    }
    const process = Object.assign(new EventEmitter(), {
      argv: ['node', filename, ...argv],
      env: { __ALV_XVFB_RAN: '1', ...env },
      execPath: 'node',
      platform: 'linux',
      cwd: () => repoRoot,
      chdir() {},
      exit(code) {
        process.exitCode = code;
      }
    });
    const fs = {
      existsSync: file => files.has(file),
      mkdirSync: dir => files.set(dir, 'directory'),
      writeFileSync: (file, content) => files.set(file, content),
      mkdtempSync: prefix => {
        files.set(`${prefix}${id}`, 'directory');
        return `${prefix}${id}`;
      },
      rmSync: target => {
        removed.push(target);
        for (const file of [...files.keys()]) {
          if (file === target || file.startsWith(target + path.sep)) files.delete(file);
        }
      }
    };
    const stubRequire = name => {
      switch (name) {
        case 'child_process':
          return {
            spawn(file, args) {
              const child = Object.assign(new EventEmitter(), { pid: 1, kill: () => true });
              if (file === 'node') {
                files.set(args[args.indexOf('--out') + 1], `VSIX built by ${id}`);
                run.finishPackaging = () => child.emit('exit', 0);
                signals.packaged();
              } else {
                assert.equal(file, run.executable, 'Only the run’s own VS Code build can launch');
                run.host = child;
                signals.launched();
              }
              return child;
            },
            execFile(file, args, options, callback) {
              assert.equal(file, 'pnpm', 'Only the synthetic build can run');
              callback(null, '', '');
            }
          };
        case 'cross-spawn':
          return Object.assign(() => assert.fail('No Windows shim is expected'), {
            sync(file, args) {
              const index = args.indexOf('--install-extension');
              if (index >= 0) run.installed = files.get(args[index + 1]);
              return { status: 0, stdout: '', stderr: '' };
            }
          });
        case 'os':
          return { platform: () => 'linux', tmpdir: () => '/fixture/tmp' };
        case 'fs':
          return fs;
        case 'path':
          return path;
        case 'node:util':
          return require(name);
        case '@vscode/test-electron':
          return {
            downloadAndUnzipVSCode: async ({ cachePath }) => {
              run.executable = path.join(cachePath, 'vscode-linux-x64-stable', 'code');
              run.downloaded = !files.has(run.executable);
              files.set(run.executable, 'downloaded VS Code');
              return run.executable;
            },
            resolveCliArgsFromVSCodeExecutablePath: () => ['code-cli']
          };
        case 'esbuild':
          return { build: async () => {} };
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
        console: quiet,
        setTimeout: callback => callback,
        clearTimeout() {}
      },
      { filename }
    );
    for (const name of ['packaged', 'launched']) {
      run[name] = Promise.race([run[name], run.run.then(() => assert.fail(`Run ${id} ended before it ${name}`))]);
      run[name].catch(() => {});
    }
    run.finish = () => {
      run.host.emit('exit', 0, null);
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
  await second.finish();
  assert.deepEqual(checkout.removedUnder(first.executable), [], 'The running build was never removed');
  assert.ok(checkout.files.has(first.executable));
  await first.finish();
});
