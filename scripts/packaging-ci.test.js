const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('package script rebuilds the extension packaging assets that vsce includes', () => {
  const rootPackageJson = JSON.parse(readFile('package.json'));
  const packageScript = String(rootPackageJson.scripts?.package || '');

  assert.match(packageScript, /\bpackage:runtime\b/);
  assert.match(packageScript, /\bbuild:tree-sitter-runtime\b/);
  assert.match(packageScript, /\bbuild:package-metadata\b/);
});

test('package:runtime fetches the pinned CLI release asset and package:runtime:local keeps the local cargo fallback', () => {
  const rootPackageJson = JSON.parse(readFile('package.json'));

  assert.equal(rootPackageJson.scripts?.['package:runtime'], 'node scripts/fetch-runtime-release.mjs');
  assert.match(
    String(rootPackageJson.scripts?.['package:runtime:local'] || ''),
    /cargo build -p alv-cli --bin apex-log-viewer --release && node apps\/vscode-extension\/scripts\/copy-runtime-binary\.mjs release/
  );
});

for (const workflowPath of ['.github/workflows/prerelease.yml', '.github/workflows/release.yml']) {
  test(`${workflowPath} fetches pinned CLI release assets instead of building Rust targets during packaging`, () => {
    const workflowSource = readFile(workflowPath);

    assert.match(
      workflowSource,
      /node scripts\/fetch-runtime-release\.mjs "\$\{MATRIX_TARGET\}"/,
      'expected workflow to fetch the pinned CLI runtime release asset for the target'
    );
    assert.doesNotMatch(
      workflowSource,
      /node scripts\/build-runtime-target\.mjs "\$\{MATRIX_TARGET\}" release/,
      'expected workflow to stop building the Rust workspace head during extension packaging'
    );
    assert.doesNotMatch(
      workflowSource,
      /rustup target add|gcc-aarch64-linux-gnu|CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER/,
      'expected workflow packaging jobs to stop installing Rust target build prerequisites'
    );
  });
}
