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
    mod.resolveSourceCandidates('/repo', 'linux-arm64', 'release'),
    [
      path.join('/repo', 'target', 'aarch64-unknown-linux-gnu', 'release', 'apex-log-viewer'),
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
    mod.resolveCargoBuildArgs('linux-arm64', 'release'),
    [
      'build',
      '-p',
      'apex-log-viewer-cli',
      '--bin',
      'apex-log-viewer',
      '--release',
      '--target',
      'aarch64-unknown-linux-gnu'
    ]
  );
});

test('buildRuntimeTarget runs cargo for the requested target before copying the runtime', async () => {
  const mod = await import(pathToFileURL(buildModulePath).href);
  const spawnCalls = [];

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
    }
  });

  assert.deepEqual(spawnCalls, [
    {
      command: 'cargo',
      args: [
        'build',
        '-p',
        'apex-log-viewer-cli',
        '--bin',
        'apex-log-viewer',
        '--release',
        '--target',
        'aarch64-pc-windows-msvc'
      ],
      options: { cwd: '/repo', stdio: 'inherit' }
    }
  ]);
  assert.deepEqual(result, {
    copied: true,
    profile: 'release',
    repoRoot: '/repo',
    target: 'win32-arm64'
  });
});
