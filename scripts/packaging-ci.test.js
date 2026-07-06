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

  assert.match(packageScript, /\bbuild:sf-plugin\b/);
  assert.match(packageScript, /\bbuild:embedded-sf-plugin\b/);
  assert.match(packageScript, /\bbuild:tree-sitter-runtime\b/);
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
  test(`${workflowPath} builds the embedded sf plugin and target-specific ripgrep runtime packages`, () => {
    const workflow = readFile(workflowPath);

    assert.match(
      workflow,
      /npm run build:sf-plugin[\s\S]*?npm run build:embedded-sf-plugin[\s\S]*?npm run build:tree-sitter-runtime/,
      'expected workflow packaging jobs to build the plugin runner before VSIX packaging'
    );
    assert.match(
      workflow,
      /MATRIX_TARGET:\s*\$\{\{\s*matrix\.target\s*\}\}[\s\S]*?npm run build:ripgrep-runtime -- "\$\{MATRIX_TARGET\}"/,
      'expected workflow packaging jobs to copy the ripgrep package for the VSIX target'
    );
    assert.doesNotMatch(workflow, /fetch-runtime-release\.mjs|verify-runtime-compatibility\.mjs/);
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

test('prerelease Open VSX publish skips already published target artifacts', () => {
  const publishJob = readWorkflowJob('.github/workflows/prerelease.yml', 'publish_open_vsx');

  assert.match(
    publishJob,
    /OUTPUT=\$\(npx --yes ovsx publish --pat "\$\{OVSX_PAT\}" --packagePath "\$\{FILE\}" --pre-release 2>&1\)/,
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
      /OUTPUT=\$\(npx --yes @vscode\/vsce publish --packagePath "\$\{FILE\}"(?: --pre-release)? 2>&1\)/,
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
