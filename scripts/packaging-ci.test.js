const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function readFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
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

  assert.match(packageScript, /\bbuild:shared\b/);
  assert.doesNotMatch(packageScript, /\bbuild:(?:sf-plugin|embedded-sf-plugin)\b/);
  assert.match(packageScript, /\bbuild:ripgrep-runtime\b/);
  assert.match(packageScript, /\bbuild:package-metadata\b/);
  assert.doesNotMatch(packageScript, /\bpackage:runtime\b/);
});

test('root scripts no longer expose native runtime packaging lanes', () => {
  const scripts = JSON.parse(readFile('package.json')).scripts || {};

  for (const removed of ['build:runtime', 'package:runtime', 'package:runtime:local', 'test:rust']) {
    assert.equal(scripts[removed], undefined, `${removed} should not be present`);
  }
});

for (const workflowPath of ['.github/workflows/release.yml', '.github/workflows/prerelease.yml']) {
  test(`${workflowPath} builds the direct-core extension and target-specific ripgrep runtime packages`, () => {
    const workflow = readFile(workflowPath);

    assert.match(
      workflow,
      /pnpm run clean[\s\S]*?pnpm run build:ripgrep-runtime/,
      'expected workflow packaging jobs to build extension assets without an embedded plugin'
    );
    assert.match(
      workflow,
      /MATRIX_TARGET:\s*\$\{\{\s*matrix\.target\s*\}\}[\s\S]*?pnpm run build:ripgrep-runtime "\$\{MATRIX_TARGET\}"/,
      'expected workflow packaging jobs to copy the ripgrep package for the VSIX target'
    );
    assert.doesNotMatch(workflow, /build:(?:sf-plugin|embedded-sf-plugin)/);
    assert.doesNotMatch(workflow, /fetch-runtime-release\.mjs|verify-runtime-compatibility\.mjs/);
  });

  test(`${workflowPath} installs workspace dependencies before building extension release artifacts`, () => {
    const workflow = readFile(workflowPath);

    assert.doesNotMatch(
      workflow,
      /pnpm install --frozen-lockfile --filter/,
      'expected extension release workflows to install package workspace dependencies for the sf plugin build'
    );
    assert.match(workflow, /\brun:\s+pnpm install --frozen-lockfile\b/);
  });
}

test('test:scripts covers the prerelease version computation regression suite', () => {
  const rootPackageJson = JSON.parse(readFile('package.json'));

  assert.match(
    String(rootPackageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/compute-prerelease-version\.test\.js\b/,
    'expected the prerelease version regression test to run in the default script test suite'
  );
});

test('prerelease workflow computes the next publish version via the dedicated helper script', () => {
  const workflowSource = readFile('.github/workflows/prerelease.yml');

  assert.match(
    workflowSource,
    /NEW_VERSION=\$\(node scripts\/compute-prerelease-version\.mjs --manifest apps\/vscode-extension\/package\.json\)/,
    'expected the prerelease workflow to delegate Marketplace version selection to the dedicated helper'
  );
  assert.doesNotMatch(
    workflowSource,
    /spawnSync\('\.\/node_modules\/\.bin\/vsce'/,
    'expected the prerelease workflow to stop embedding the vsce Marketplace query inline in YAML'
  );
});

test('sf plugin release workflow publishes matching sf-plugin-v tags through npm', () => {
  const workflowSource = readFile('.github/workflows/sf-plugin-release.yml');
  const validateJob = readWorkflowJob('.github/workflows/sf-plugin-release.yml', 'validate_tag');
  const packageJob = readWorkflowJob('.github/workflows/sf-plugin-release.yml', 'package_plugin');
  const publishJob = readWorkflowJob('.github/workflows/sf-plugin-release.yml', 'publish_npm');

  assert.match(workflowSource, /tags:\s*\n\s+- 'sf-plugin-v\*'/);
  assert.match(
    validateJob,
    /TAG_VERSION="\$\{TAG_NAME#sf-plugin-v\}"[\s\S]*?packages\/sf-plugin\/package\.json version \$\{PKG_VERSION\}/,
    'expected the workflow to reject tags that do not match the sf plugin package version'
  );
  assert.match(
    validateJob,
    /ref:\s+\$\{\{\s*inputs\.tag_name && format\('refs\/tags\/\{0\}', inputs\.tag_name\) \|\| github\.ref\s*\}\}/,
    'expected manual dispatch to checkout the fully qualified tag ref before validation'
  );
  assert.match(
    validateJob,
    /COMMIT_SHA=\$\(git rev-parse HEAD\)[\s\S]*?echo "commit_sha=\$\{COMMIT_SHA\}"/,
    'expected the workflow to persist the validated commit SHA'
  );
  assert.match(
    packageJob,
    /ref:\s+\$\{\{\s*needs\.validate_tag\.outputs\.commit_sha\s*\}\}/,
    'expected package jobs to use the validated commit SHA instead of an unqualified tag name'
  );
  assert.match(packageJob, /\bpnpm run test:sf-plugin\b/);
  assert.match(packageJob, /\bpnpm run build:sf-plugin\b/);
  assert.match(packageJob, /\bpnpm run stage:sf-plugin-npm\b/);
  assert.match(
    publishJob,
    /id-token:\s+write[\s\S]*?node scripts\/publish-npm-package-if-needed\.mjs \.\/dist\/sf-plugin-npm --tag "\$\{NPM_DIST_TAG\}" --access public/,
    'expected npm publish to use the skip-if-present script from the staged plugin package'
  );
});

test('prerelease Open VSX publish skips already published target artifacts', () => {
  const publishJob = readWorkflowJob('.github/workflows/prerelease.yml', 'publish_open_vsx');

  assert.match(
    publishJob,
    /OUTPUT=\$\(pnpm dlx ovsx publish --pat "\$\{OVSX_PAT\}" --packagePath "\$\{FILE\}" --pre-release 2>&1\)/,
    'expected Open VSX publish output to be captured for duplicate-version handling'
  );
  assert.match(
    publishJob,
    /grep -F "is already published\."[\s\S]*?Skipping \$\{FILE\}; Open VSX already has this version and target\./,
    'expected duplicate Open VSX target publishes to be skipped instead of failing the workflow'
  );
});

for (const [workflowPath, jobName] of [
  ['.github/workflows/prerelease.yml', 'publish_marketplace'],
  ['.github/workflows/release.yml', 'publish_marketplace']
]) {
  test(`${workflowPath} Marketplace publish skips already published target artifacts`, () => {
    const publishJob = readWorkflowJob(workflowPath, jobName);

    assert.match(
      publishJob,
      /OUTPUT=\$\(pnpm exec vsce publish --packagePath "\$\{FILE\}"(?: --pre-release)? 2>&1\)/,
      'expected Marketplace publish output to be captured for duplicate-version handling'
    );
    assert.match(
      publishJob,
      /grep -F "already exists\."[\s\S]*?Skipping \$\{FILE\}; VS Code Marketplace already has this version and target\./,
      'expected duplicate Marketplace target publishes to be skipped instead of failing the workflow'
    );
  });
}

for (const [workflowPath, jobName, description] of [
  ['.github/workflows/release.yml', 'publish_marketplace', 'Marketplace publish'],
  ['.github/workflows/release.yml', 'publish_open_vsx', 'Open VSX publish'],
  ['.github/workflows/prerelease.yml', 'publish_marketplace', 'pre-release Marketplace publish'],
  ['.github/workflows/prerelease.yml', 'publish_open_vsx', 'pre-release Open VSX publish']
]) {
  test(`${description} job checks out the repo before setup-node reads .nvmrc`, () => {
    const publishJob = readWorkflowJob(workflowPath, jobName);

    assert.match(
      publishJob,
      /- name:\s+Checkout[\s\S]*?uses:\s+actions\/checkout@[0-9a-f]{40}[\s\S]*?- name:\s+Setup Node\.js from \.nvmrc/,
      `expected ${workflowPath} ${jobName} to check out the repo before setup-node reads .nvmrc`
    );
  });
}
