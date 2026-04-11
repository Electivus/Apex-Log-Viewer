const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'apps', 'vscode-extension', 'scripts', 'copy-runtime-binary.mjs');
const buildModulePath = path.join(__dirname, 'build-runtime-target.mjs');

test('resolveSourceCandidates prefers target-specific cargo output before host fallback', async () => {
  const mod = await import(pathToFileURL(modulePath).href);

  assert.deepEqual(
    mod.resolveSourceCandidates('/repo', 'linux-x64', 'release'),
    [
      path.join('/repo', 'target', 'x86_64-unknown-linux-musl', 'release', 'apex-log-viewer'),
      path.join('/repo', 'target', 'release', 'apex-log-viewer')
    ]
  );
});

test('copyRuntimeBinary falls back to the host cargo output when a target-specific artifact is absent', async () => {
  const mod = await import(pathToFileURL(modulePath).href);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-copy-runtime-'));
  const source = path.join(repoRoot, 'target', 'release', 'apex-log-viewer');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'binary');

  const result = mod.copyRuntimeBinary({
    repoRoot,
    target: 'linux-arm64',
    profile: 'release'
  });

  assert.equal(result.source, source);
  assert.equal(
    result.destination,
    path.join(repoRoot, 'apps', 'vscode-extension', 'bin', 'linux-arm64', 'apex-log-viewer')
  );
  assert.equal(fs.existsSync(result.destination), true);

  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('resolveCargoBuildArgs includes the packaged runtime target triple', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);

  assert.deepEqual(
    mod.resolveCargoBuildArgs('linux-x64', 'release'),
    [
      'build',
      '-p',
      'apex-log-viewer-cli',
      '--bin',
      'apex-log-viewer',
      '--release',
      '--target',
      'x86_64-unknown-linux-musl'
    ]
  );
});

test('ensureBootstrapCargoTargetInstalled adds the linux-x64 musl target when it is missing', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);
  const spawnCalls = [];

  mod.ensureBootstrapCargoTargetInstalled({
    repoRoot: '/repo',
    target: 'linux-x64',
    spawnSyncImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      if (args[1] === 'list') {
        return { status: 0, stdout: 'x86_64-unknown-linux-gnu\n' };
      }
      return { status: 0 };
    }
  });

  assert.deepEqual(spawnCalls, [
    {
      command: 'rustup',
      args: ['target', 'list', '--installed'],
      options: { cwd: '/repo', encoding: 'utf8' }
    },
    {
      command: 'rustup',
      args: ['target', 'add', 'x86_64-unknown-linux-musl'],
      options: { cwd: '/repo', stdio: 'inherit' }
    }
  ]);
});

test('ensureBootstrapCargoTargetInstalled skips work when linux-x64 musl is already installed or the target is unrelated', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);
  const spawnCalls = [];

  mod.ensureBootstrapCargoTargetInstalled({
    repoRoot: '/repo',
    target: 'linux-x64',
    spawnSyncImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { status: 0, stdout: 'x86_64-unknown-linux-musl\n' };
    }
  });
  mod.ensureBootstrapCargoTargetInstalled({
    repoRoot: '/repo',
    target: 'win32-x64',
    spawnSyncImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    }
  });

  assert.deepEqual(spawnCalls, [
    {
      command: 'rustup',
      args: ['target', 'list', '--installed'],
      options: { cwd: '/repo', encoding: 'utf8' }
    }
  ]);
});

test('ensureBootstrapCargoTargetInstalled tolerates missing rustup so distro-managed toolchains can still rely on cargo directly', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);

  assert.doesNotThrow(() =>
    mod.ensureBootstrapCargoTargetInstalled({
      repoRoot: '/repo',
      target: 'linux-x64',
      spawnSyncImpl() {
        return {
          error: Object.assign(new Error('spawn rustup ENOENT'), { code: 'ENOENT' })
        };
      }
    })
  );
});

test('buildRuntimeTarget runs cargo for the requested target before copying the runtime', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);
  const spawnCalls = [];
  const bootstrapCalls = [];

  const result = mod.buildRuntimeTarget({
    repoRoot: '/repo',
    target: 'win32-arm64',
    profile: 'release',
    spawnSyncImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { status: 0 };
    },
    copyRuntimeBinaryImpl(args) {
      return { copied: true, ...args };
    },
    ensureBootstrapCargoTargetInstalledImpl(args) {
      bootstrapCalls.push(args);
    }
  });

  assert.deepEqual(bootstrapCalls, [
    {
      repoRoot: '/repo',
      spawnSyncImpl: bootstrapCalls[0].spawnSyncImpl,
      target: 'win32-arm64'
    }
  ]);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [
    'build',
    '-p',
    'apex-log-viewer-cli',
    '--bin',
    'apex-log-viewer',
    '--release',
    '--target',
    'aarch64-pc-windows-msvc'
  ]);
  assert.equal(spawnCalls[0].command, 'cargo');
  assert.equal(spawnCalls[0].options.cwd, '/repo');
  assert.equal(spawnCalls[0].options.stdio, 'inherit');
  assert.deepEqual(result, {
    copied: true,
    profile: 'release',
    repoRoot: '/repo',
    target: 'win32-arm64'
  });
});

test('resolveCargoBuildEnv pins the musl linker for linux-x64 while leaving other targets untouched', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);

  assert.equal(
    mod.resolveCargoBuildEnv('linux-x64', {}).CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER,
    'musl-gcc'
  );
  assert.equal(
    mod.resolveCargoBuildEnv('win32-x64', {
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: '/inherited/musl-gcc'
    }).CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER,
    '/inherited/musl-gcc'
  );
  assert.equal(
    mod.resolveCargoBuildEnv('linux-x64', {
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: '/custom/musl-gcc'
    }).CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER,
    '/custom/musl-gcc'
  );
});

test('resolveBuildArguments defaults to the current target and treats a lone profile argument as release mode selection', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);

  assert.deepEqual(mod.resolveBuildArguments([], 'linux-x64'), {
    target: 'linux-x64',
    profile: 'release'
  });
  assert.deepEqual(mod.resolveBuildArguments(['release'], 'linux-x64'), {
    target: 'linux-x64',
    profile: 'release'
  });
  assert.deepEqual(mod.resolveBuildArguments(['linux-arm64'], 'linux-x64'), {
    target: 'linux-arm64',
    profile: 'release'
  });
  assert.deepEqual(mod.resolveBuildArguments(['linux-arm64', 'debug'], 'linux-x64'), {
    target: 'linux-arm64',
    profile: 'debug'
  });
});
