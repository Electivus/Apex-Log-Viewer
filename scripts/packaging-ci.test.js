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

for (const workflowPath of ['.github/workflows/prerelease.yml', '.github/workflows/release.yml']) {
  test(`${workflowPath} provisions the linux-arm64 cross-linker before packaging`, () => {
    const workflowSource = readFile(workflowPath);

    assert.match(
      workflowSource,
      /Install Linux ARM64 cross-linker[\s\S]*apt-get install -y gcc-aarch64-linux-gnu/,
      'expected workflow to install the aarch64 Linux GNU toolchain via apt-get'
    );
    assert.match(
      workflowSource,
      /CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER:\s*aarch64-linux-gnu-gcc/,
      'expected workflow to export the linux-arm64 cargo linker'
    );
  });
}

test('prerelease rollback deletes a stranded remote tag even if release lookup fails', () => {
  const workflowSource = readFile('.github/workflows/prerelease.yml');

  assert.match(
    workflowSource,
    /rollback_prerelease[\s\S]*gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$TAG"/,
    'expected prerelease rollback to check for a stranded remote tag'
  );
  assert.match(
    workflowSource,
    /rollback_prerelease[\s\S]*gh api -X DELETE "repos\/\$GITHUB_REPOSITORY\/git\/refs\/tags\/\$TAG"/,
    'expected prerelease rollback to delete the remote tag when publish cleanup runs'
  );
});
