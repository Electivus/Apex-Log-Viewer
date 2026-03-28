const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modulePath = path.join(__dirname, '..', 'apps', 'vscode-extension', 'scripts', 'copy-runtime-binary.mjs');

test('resolveSourceCandidates prefers target-specific cargo output before host fallback', async () => {
  const mod = await import(modulePath);

  assert.deepEqual(
    mod.resolveSourceCandidates('/repo', 'linux-arm64', 'release'),
    [
      '/repo/target/aarch64-unknown-linux-gnu/release/apex-log-viewer',
      '/repo/target/release/apex-log-viewer'
    ]
  );
});

test('copyRuntimeBinary falls back to the host cargo output when a target-specific artifact is absent', async () => {
  const mod = await import(modulePath);
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
