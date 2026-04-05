const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function workflowFiles() {
  return fs
    .readdirSync(path.join(repoRoot, '.github', 'workflows'))
    .filter(name => name.endsWith('.yml'))
    .map(name => path.posix.join('.github/workflows', name));
}

function usesRefs(relativePath) {
  return Array.from(read(relativePath).matchAll(/^\s+uses:\s+([^\s#]+)\s*$/gm), match => match[1]);
}

test('all workflow uses refs are pinned to full commit SHAs', () => {
  for (const workflowPath of workflowFiles()) {
    for (const ref of usesRefs(workflowPath)) {
      if (ref.startsWith('./')) {
        continue;
      }
      assert.match(
        ref,
        /@[0-9a-f]{40}$/,
        `${workflowPath} should pin ${ref} to a full commit SHA`
      );
    }
  }
});

test('dependency review workflow exists and is wired to pull_request', () => {
  const workflow = read('.github/workflows/dependency-review.yml');
  assert.match(workflow, /^name:\s+Dependency Review$/m);
  assert.match(workflow, /^on:\s*[\r\n]+  pull_request:/m);
  assert.match(workflow, /uses:\s+actions\/dependency-review-action@[0-9a-f]{40}/);
  assert.match(workflow, /config-file:\s+\.\/\.github\/dependency-review-config\.yml/);
});

test('CI workflow enforces dependency provenance and npm signature verification', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /\bnpm run security:dependency-sources\b/);
  assert.match(workflow, /\bnpm run security:npm-signatures\b/);
});

test('CODEOWNERS covers workflows, manifests, lockfiles, and release metadata', () => {
  const owners = read('.github/CODEOWNERS');
  for (const expected of [
    '/.github/workflows/ @Electivus/maintainers',
    '/.github/dependency-review-config.yml @Electivus/maintainers',
    '/package.json @Electivus/maintainers',
    '/package-lock.json @Electivus/maintainers',
    '/Cargo.toml @Electivus/maintainers',
    '/Cargo.lock @Electivus/maintainers',
    '/deny.toml @Electivus/maintainers',
    '/config/runtime-bundle.json @Electivus/maintainers',
    '/apps/vscode-extension/scripts/copy-tree-sitter-runtime.mjs @Electivus/maintainers',
    '/scripts/fetch-runtime-release.mjs @Electivus/maintainers'
  ]) {
    assert.match(owners, new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('package.json runs repo-security and dependency-source checks in the default script lane', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg.scripts?.['test:scripts'] || ''), /\bscripts\/repo-security\.test\.js\b/);
  assert.match(String(pkg.scripts?.['test:scripts'] || ''), /\bnode scripts\/check-dependency-sources\.mjs\b/);
  assert.equal(pkg.scripts?.['security:dependency-sources'], 'node scripts/check-dependency-sources.mjs');
});

test('Rust workspace keeps a checked-in Cargo.lock and cargo-deny config', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'Cargo.lock')), true, 'Cargo.lock should be checked in');
  const denyToml = read('deny.toml');
  assert.match(denyToml, /^\[sources\]$/m);
  assert.match(denyToml, /^unknown-registry = "deny"$/m);
  assert.match(denyToml, /^unknown-git = "deny"$/m);
});

test('Rust supply-chain workflow runs cargo-deny on PRs and main pushes', () => {
  const workflow = read('.github/workflows/rust-supply-chain.yml');
  assert.match(workflow, /^name:\s+Rust Supply Chain$/m);
  assert.match(workflow, /^on:\s*[\r\n]+  pull_request:\s*[\r\n]+  push:\s*[\r\n]+    branches:\s*[\r\n]+      - main/m);
  assert.match(workflow, /\bcargo deny check advisories bans licenses sources\b/);
});
