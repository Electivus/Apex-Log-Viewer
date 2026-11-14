const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

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

test('extension type-check scripts bootstrap generated shared package declarations', () => {
  const scripts = JSON.parse(readFile('package.json')).scripts || {};

  assert.match(String(scripts['check-types'] || ''), /^pnpm run build:shared && /);
  assert.match(String(scripts.compile || ''), /^pnpm run build:shared && /);
});

test('standalone webview tests bootstrap generated protocol artifacts', () => {
  const scripts = JSON.parse(readFile('package.json')).scripts || {};

  assert.match(String(scripts['test:webview'] || ''), /^pnpm run build:protocol && /);
});

for (const workflowPath of ['.github/workflows/release.yml', '.github/workflows/prerelease.yml']) {
  test(`${workflowPath} builds the direct-core extension and target-specific ripgrep runtime packages`, () => {
    const workflow = readFile(workflowPath);

    assert.match(
      workflow,
      /pnpm run clean[\s\S]*?pnpm run build:shared[\s\S]*?pnpm run build:ripgrep-runtime/,
      'expected workflow packaging jobs to rebuild the shared packages before extension assets'
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

test('prerelease workflow sets the pre-release manifest version before installing package dependencies', () => {
  const packageJob = readWorkflowJob('.github/workflows/prerelease.yml', 'package_vsix');

  assert.match(
    packageJob,
    /- name:\s+Set pre-release version in apps\/vscode-extension\/package\.json[\s\S]*?- name:\s+Install dependencies[\s\S]*?- name:\s+Build extension packaging assets/,
    'expected pnpm to install against the rewritten pre-release manifest before verifyDepsBeforeRun checks it'
  );
});

test('prerelease workflow runs only on manual dispatch', () => {
  const workflow = yaml.parse(readFile('.github/workflows/prerelease.yml'));

  assert.deepEqual(
    Object.keys(workflow.on),
    ['workflow_dispatch'],
    'expected no schedule trigger; scheduled runs wait on the marketplace approval and cancel each other'
  );
});

test('prerelease workflow refuses to attach a build to a release tag that points at another commit', () => {
  const assembleJob = readWorkflowJob('.github/workflows/prerelease.yml', 'assemble_release');

  assert.match(
    assembleJob,
    /git ls-remote --tags origin "refs\/tags\/\$\{TAG\}"[\s\S]*?"\$TAG_SHA" != "\$GITHUB_SHA"[\s\S]*?exit 1[\s\S]*?gh release view "\$TAG"/,
    'expected an existing tag on another commit to fail the job before the release is updated'
  );
  assert.match(
    assembleJob,
    /gh release create "\$TAG" --target "\$GITHUB_SHA"/,
    'expected a new release to tag the built commit instead of the default branch head'
  );
});

const BUILD_SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const fail = message => {
  process.stderr.write(message + '\\n');
  process.exit(1);
};
const releasePath = 'repos/' + state.repo + '/releases/tags/' + state.tag;
const tagCommitPath = 'repos/' + state.repo + '/commits/refs/tags/' + state.tag;
if (args[0] === 'api' && args[1] === releasePath) {
  if (state.lookupError) fail('gh: ' + state.lookupError);
  if (!state.release) fail('gh: Not Found (HTTP 404)');
  if (!args.includes('--silent')) process.stdout.write(JSON.stringify({ tag_name: state.tag }) + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === tagCommitPath) {
  if (!state.tagSha) fail('gh: No commit found for SHA: ' + state.tag + ' (HTTP 422)');
  process.stdout.write(state.tagSha + '\\n');
  process.exit(0);
}
if (args[0] === 'release') {
  if (process.env.GH_REPO !== state.repo) {
    fail('failed to run git: fatal: not a git repository (or any of the parent directories): .git');
  }
  if (args[1] === 'view' && args[2] === state.tag) {
    if (state.lookupError) fail(state.lookupError);
    if (!state.release) fail('release not found');
    process.exit(0);
  }
  if (args[1] === 'delete' && args[2] === state.tag && args.includes('--yes')) {
    if (!state.release) fail('release not found');
    state.release = false;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (args.includes('--cleanup-tag')) {
      if (state.tagDeleteRefused) fail('failed to delete tag tags/' + state.tag + ': Repository rule violations found (HTTP 422)');
      state.tagSha = null;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    process.exit(0);
  }
}
process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(99);
`;

function runRollbackStep(initialState) {
  const job = yaml.parse(readFile('.github/workflows/prerelease.yml')).jobs.rollback_prerelease;
  const step = job.steps.find(candidate => candidate.name === 'Delete GitHub pre-release and tag');
  assert.ok(step, 'expected the rollback job to keep its delete step');
  assert.equal(step.shell, 'bash');

  const repo = 'Electivus/Apex-Log-Viewer';
  const tag = 'v0.57.3';
  const expressions = {
    '${{ needs.prepare.outputs.tag }}': tag,
    '${{ github.token }}': 'test-token',
    '${{ github.repository }}': repo
  };
  const jobEnv = Object.fromEntries(
    Object.entries(job.env || {}).map(([key, value]) => {
      assert.ok(value in expressions, `test cannot resolve ${key}: ${value}`);
      return [key, expressions[value]];
    })
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-rollback-'));
  try {
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 });
    const statePath = path.join(workDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ repo, tag, ...initialState }));

    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      cwd: workDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: repo,
        GITHUB_SHA: BUILD_SHA,
        FAKE_GH_STATE: statePath,
        ...jobEnv
      },
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.ifError(result.error);
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
      releaseLeft: finalState.release,
      tagLeft: Boolean(finalState.tagSha)
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const bashOnly = { skip: process.platform === 'win32' && 'runs the Ubuntu rollback step in bash' };

test('prerelease rollback deletes the pre-release and tag of the failed build', bashOnly, () => {
  const run = runRollbackStep({ release: true, tagSha: BUILD_SHA });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.releaseLeft, false, run.output);
  assert.equal(run.tagLeft, false, run.output);
});

test('prerelease rollback treats a missing release as nothing to delete', bashOnly, () => {
  const run = runRollbackStep({ release: false, tagSha: null });

  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /does not exist; nothing to delete/);
});

test('prerelease rollback fails when the release lookup fails for another reason', bashOnly, () => {
  const run = runRollbackStep({ release: true, tagSha: BUILD_SHA, lookupError: 'Bad credentials (HTTP 401)' });

  assert.notEqual(run.status, 0, run.output);
  assert.equal(run.releaseLeft, true, run.output);
  assert.equal(run.tagLeft, true, run.output);
});

test('prerelease rollback leaves a release whose tag points at another commit in place', bashOnly, () => {
  const run = runRollbackStep({ release: true, tagSha: OTHER_SHA });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.releaseLeft, true, run.output);
  assert.equal(run.tagLeft, true, run.output);
});

test('prerelease rollback fails when the tag ruleset refuses the tag delete', bashOnly, () => {
  const run = runRollbackStep({ release: true, tagSha: BUILD_SHA, tagDeleteRefused: true });

  assert.notEqual(run.status, 0, run.output);
  assert.equal(run.tagLeft, true, run.output);
});

test('tag release workflow keeps the checked-in manifest unchanged after installing dependencies', () => {
  const packageJob = readWorkflowJob('.github/workflows/release.yml', 'package');

  assert.match(
    packageJob,
    /- name:\s+Install dependencies[\s\S]*?- name:\s+Verify tag matches extension package version[\s\S]*?- name:\s+Build extension packaging assets/,
    'expected tag releases to verify, but not rewrite, the manifest installed by pnpm'
  );
  assert.doesNotMatch(
    packageJob,
    /writeFileSync\(/,
    'expected tag releases not to invalidate pnpm dependency verification by rewriting the manifest'
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
    /ref:\s+\$\{\{\s*github\.sha\s*\}\}/,
    'expected validation to checkout only the immutable triggering commit'
  );
  assert.match(
    validateJob,
    /COMMIT_SHA=\$\(git rev-parse HEAD\)[\s\S]*?echo "commit_sha=\$\{COMMIT_SHA\}"/,
    'expected the workflow to persist the validated commit SHA'
  );
  assert.match(
    packageJob,
    /ref:\s+\$\{\{\s*github\.sha\s*\}\}/,
    'expected package jobs to use the same immutable triggering commit'
  );
  assert.match(validateJob, /EVENT_REF:\s+\$\{\{ github\.ref \}\}/);
  assert.match(validateJob, /if \[\[ "\$\{EVENT_REF\}" != "refs\/tags\/\$\{REQUESTED_TAG\}" \]\]/);
  assert.match(packageJob, /\bpnpm run test:sf-plugin:package\b/);
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
      /OUTPUT=\$\(pnpm exec vsce publish --azure-credential --packagePath "\$\{FILE\}"(?: --pre-release)? 2>&1\)/,
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
