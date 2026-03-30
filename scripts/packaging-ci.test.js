const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readCargoVersion(relativePath) {
  const cargoToml = readFile(relativePath);
  const match = cargoToml.match(/^version = "([^"]+)"$/m);

  assert.ok(match, `expected ${relativePath} to declare a package version`);
  return match[1];
}

function assertVersionedPathDependency(relativePath, dependencyName, version, dependencyPath) {
  const cargoToml = readFile(relativePath);
  const inlineTable = cargoToml.match(
    new RegExp(`${dependencyName}\\s*=\\s*\\{([^}]*)\\}`, 'm')
  );

  assert.ok(inlineTable, `expected ${relativePath} to declare ${dependencyName} as an inline table dependency`);
  assert.match(
    inlineTable[1],
    new RegExp(`\\bversion\\s*=\\s*"${version}"`),
    `expected ${relativePath} to keep ${dependencyName} pinned to version ${version}`
  );
  assert.match(
    inlineTable[1],
    new RegExp(`\\bpath\\s*=\\s*"${dependencyPath.replaceAll('/', '\\/')}"`),
    `expected ${relativePath} to keep ${dependencyName} pinned to path ${dependencyPath}`
  );
}

function readWorkflowJob(relativePath, jobName) {
  const workflowSource = readFile(relativePath);
  const match = workflowSource.match(
    new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-z0-9_]+:\\n|(?![\\s\\S]))`, 'mi')
  );

  assert.ok(match, `expected ${relativePath} to declare the ${jobName} job`);
  return match[1];
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
    /cargo build -p apex-log-viewer-cli --bin apex-log-viewer --release && node apps\/vscode-extension\/scripts\/copy-runtime-binary\.mjs release/
  );
});

test('test:scripts covers the runtime release fetch regression suite', () => {
  const rootPackageJson = JSON.parse(readFile('package.json'));

  assert.match(
    String(rootPackageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/fetch-runtime-release\.test\.js\b/,
    'expected the pinned runtime fetch regression test to run in the default script test suite'
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

test('rust-release workflow bootstrap skips crates.io publishing', () => {
  const workflowSource = readFile('.github/workflows/rust-release.yml');

  assert.doesNotMatch(
    workflowSource,
    /publish_crate:/,
    'expected the initial CLI release workflow to avoid crates.io publishing during npm-first bootstrap'
  );
  assert.doesNotMatch(
    workflowSource,
    /cargo publish --manifest-path crates\/alv-cli\/Cargo\.toml/,
    'expected the initial CLI release workflow to skip cargo publish during npm-first bootstrap'
  );
});

test('published Rust manifests keep versioned local dependencies so cargo publish is valid', () => {
  const appServerVersion = readCargoVersion('crates/alv-app-server/Cargo.toml');
  const coreVersion = readCargoVersion('crates/alv-core/Cargo.toml');
  const mcpVersion = readCargoVersion('crates/alv-mcp/Cargo.toml');
  const protocolVersion = readCargoVersion('crates/alv-protocol/Cargo.toml');
  const cliVersion = readCargoVersion('crates/alv-cli/Cargo.toml');

  assertVersionedPathDependency('crates/alv-app-server/Cargo.toml', 'alv-core', coreVersion, '../alv-core');
  assertVersionedPathDependency(
    'crates/alv-app-server/Cargo.toml',
    'alv-protocol',
    protocolVersion,
    '../alv-protocol'
  );
  assertVersionedPathDependency(
    'crates/alv-cli/Cargo.toml',
    'alv-app-server',
    appServerVersion,
    '../alv-app-server'
  );
  assert.equal(
    appServerVersion,
    cliVersion,
    'expected the app-server crate version to stay aligned with the distributed CLI crate version'
  );
  assert.equal(coreVersion, cliVersion, 'expected alv-core to stay aligned with the CLI crate version');
  assert.equal(
    protocolVersion,
    cliVersion,
    'expected alv-protocol to stay aligned with the CLI crate version'
  );
  assert.equal(mcpVersion, cliVersion, 'expected alv-mcp to stay aligned with the CLI crate version');
  assert.ok(cliVersion.length > 0, 'expected the CLI crate version to remain readable');
});

test('runtime bundle stays pinned to the first successful npm-backed CLI release', () => {
  const runtimeBundle = JSON.parse(readFile('config/runtime-bundle.json'));

  assert.deepEqual(runtimeBundle, {
    cliVersion: '0.1.1',
    tag: 'rust-v0.1.1',
    channel: 'stable',
    protocolVersion: '1'
  });
});

test('rust-release workflow preserves per-artifact directories when downloading runtime binaries', () => {
  const workflowSource = readFile('.github/workflows/rust-release.yml');

  assert.match(
    workflowSource,
    /merge-multiple:\s+false/,
    'expected release packaging to keep each downloaded runtime artifact in its own directory'
  );
  assert.match(
    workflowSource,
    /source_candidate_artifact="rust-binary-\$\{target\}\/\$\{binary\}"/,
    'expected the release packaging job to normalize binaries from per-target artifact directories'
  );
});

test('rust-release workflow configures the npm registry before publishing packages', () => {
  const nativePublishJob = readWorkflowJob('.github/workflows/rust-release.yml', 'publish_npm_native');
  const metaPublishJob = readWorkflowJob('.github/workflows/rust-release.yml', 'publish_npm_meta');

  assert.match(
    nativePublishJob,
    /uses:\s+actions\/setup-node@v6[\s\S]*?registry-url:\s+'https:\/\/registry\.npmjs\.org'/,
    'expected native npm publish job to configure the npm registry before publishing'
  );
  assert.match(
    metaPublishJob,
    /uses:\s+actions\/setup-node@v6[\s\S]*?registry-url:\s+'https:\/\/registry\.npmjs\.org'/,
    'expected meta npm publish job to configure the npm registry before publishing'
  );
});

test('rust-release workflow uses an idempotent npm publish helper for reruns of the same tag', () => {
  const nativePublishJob = readWorkflowJob('.github/workflows/rust-release.yml', 'publish_npm_native');
  const metaPublishJob = readWorkflowJob('.github/workflows/rust-release.yml', 'publish_npm_meta');

  assert.match(
    nativePublishJob,
    /node scripts\/publish-npm-package-if-needed\.mjs "\$\{dir\}" --tag "\$\{NPM_DIST_TAG\}" --access public/,
    'expected native npm publish job to skip versions that were already published during an earlier partial run'
  );
  assert.match(
    metaPublishJob,
    /node scripts\/publish-npm-package-if-needed\.mjs dist\/npm\/meta --tag "\$\{NPM_DIST_TAG\}" --access public/,
    'expected meta npm publish job to skip versions that were already published during an earlier partial run'
  );
});

test('rust-release publish jobs check out the repo before reading .nvmrc', () => {
  const nativePublishJob = readWorkflowJob('.github/workflows/rust-release.yml', 'publish_npm_native');
  const metaPublishJob = readWorkflowJob('.github/workflows/rust-release.yml', 'publish_npm_meta');

  assert.match(
    nativePublishJob,
    /- name:\s+Checkout[\s\S]*?uses:\s+actions\/checkout@v6[\s\S]*?- name:\s+Setup Node\.js from \.nvmrc/,
    'expected native npm publish job to check out the repo before setup-node reads .nvmrc'
  );
  assert.match(
    metaPublishJob,
    /- name:\s+Checkout[\s\S]*?uses:\s+actions\/checkout@v6[\s\S]*?- name:\s+Setup Node\.js from \.nvmrc/,
    'expected meta npm publish job to check out the repo before setup-node reads .nvmrc'
  );
});

test('rust-release release job checks out the repo before running gh release commands', () => {
  const releaseJob = readWorkflowJob('.github/workflows/rust-release.yml', 'release');

  assert.match(
    releaseJob,
    /- name:\s+Checkout[\s\S]*?uses:\s+actions\/checkout@v6[\s\S]*?- name:\s+Create or update GitHub release/,
    'expected release job to check out the repo before running gh release commands'
  );
});
