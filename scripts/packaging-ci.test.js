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

const BUILD_SHA = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const REPO = 'Electivus/Apex-Log-Viewer';
const TAG = 'v0.57.3';
const VSIX = 'apex-log-viewer-0.57.3-pre-20261114-1111111-linux-x64.vsix';
const FAKE_GITHUB = path.join(__dirname, 'prerelease-fake-github.js');

const bashOnly = { skip: process.platform === 'win32' && 'runs Ubuntu workflow steps in bash' };

function runPrereleaseSteps(jobName, stepNames, github, { checkout = false } = {}) {
  const job = yaml.parse(readFile('.github/workflows/prerelease.yml')).jobs[jobName];
  const expressions = {
    '${{ needs.prepare.outputs.tag }}': TAG,
    '${{ needs.prepare.outputs.version }}': '0.57.3',
    '${{ needs.prepare.outputs.label }}': '20261114',
    '${{ needs.prepare.outputs.shortsha }}': '1111111',
    '${{ github.token }}': 'test-token',
    '${{ github.repository }}': REPO
  };
  const jobEnv = Object.fromEntries(
    Object.entries(job.env || {}).map(([key, value]) => {
      assert.ok(value in expressions, `test cannot resolve ${key}: ${value}`);
      return [key, expressions[value]];
    })
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-prerelease-'));
  try {
    const binDir = path.join(workDir, 'bin');
    fs.mkdirSync(binDir);
    for (const tool of ['gh', 'git']) {
      fs.writeFileSync(
        path.join(binDir, tool),
        `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GITHUB}" ${tool} "$@"\n`,
        { mode: 0o755 }
      );
    }
    fs.writeFileSync(path.join(workDir, VSIX), 'vsix');
    const statePath = path.join(workDir, 'github.json');
    fs.writeFileSync(statePath, JSON.stringify({ repo: REPO, tag: TAG, tagSha: null, releases: [], ...github }));

    let status = 0;
    let output = '';
    for (const stepName of stepNames) {
      const step = job.steps.find(candidate => candidate.name === stepName);
      assert.ok(step, `expected ${jobName} to have the step "${stepName}"`);
      assert.equal(step.shell, 'bash');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
        cwd: workDir,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          GITHUB_REPOSITORY: REPO,
          GITHUB_SHA: BUILD_SHA,
          GITHUB_RUN_NUMBER: '7',
          FAKE_GITHUB_STATE: statePath,
          ...(checkout ? { FAKE_CHECKOUT_REPO: REPO } : {}),
          ...jobEnv
        },
        encoding: 'utf8',
        timeout: 10_000
      });
      assert.ifError(result.error);
      output += `${result.stdout}\n${result.stderr}\n`;
      status = result.status;
      if (status !== 0) break;
    }
    return { status, output, github: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const CREATE_STEP = 'Create or update GitHub pre-release';
const UPLOAD_STEP = 'Upload VSIX to GitHub release';
const PUBLISH_STEP = 'Publish GitHub pre-release';

function runAssembly(github, stepNames = [CREATE_STEP, UPLOAD_STEP, PUBLISH_STEP]) {
  return runPrereleaseSteps('assemble_release', stepNames, github, { checkout: true });
}

function runRollback(github) {
  return runPrereleaseSteps('rollback_prerelease', ['Delete GitHub pre-release and tag'], github);
}

test('prerelease assembly keeps the pre-release a draft without a tag until its last step', bashOnly, () => {
  const steps = yaml.parse(readFile('.github/workflows/prerelease.yml')).jobs.assemble_release.steps;
  assert.equal(steps.at(-1).name, PUBLISH_STEP, 'expected publishing to be the last step of the assembly');

  const beforePublish = runAssembly({}, [CREATE_STEP, UPLOAD_STEP]);
  assert.equal(beforePublish.status, 0, beforePublish.output);
  assert.deepEqual(
    beforePublish.github.releases.map(release => [release.draft, release.target, release.assets]),
    [[true, BUILD_SHA, [VSIX]]],
    beforePublish.output
  );
  assert.equal(beforePublish.github.tagSha, null, beforePublish.output);

  const published = runAssembly(beforePublish.github, [PUBLISH_STEP]);
  assert.equal(published.status, 0, published.output);
  assert.equal(published.github.releases[0].draft, false, published.output);
  assert.equal(published.github.tagSha, BUILD_SHA, published.output);
});

test('prerelease assembly adopts a draft left by an earlier attempt and tags this build', bashOnly, () => {
  const run = runAssembly({ releases: [{ id: 5, draft: true, target: OTHER_SHA, assets: [VSIX] }] });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(
    run.github.releases.map(release => [release.id, release.draft, release.assets]),
    [[5, false, [VSIX]]],
    run.output
  );
  assert.equal(run.github.tagSha, BUILD_SHA, run.output);
});

test('prerelease assembly updates a pre-release that is already published for this build', bashOnly, () => {
  const run = runAssembly({ tagSha: BUILD_SHA, releases: [{ id: 5, draft: false, target: BUILD_SHA, assets: [] }] });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(
    run.github.releases.map(release => [release.id, release.draft, release.assets]),
    [[5, false, [VSIX]]],
    run.output
  );
  assert.equal(run.github.tagSha, BUILD_SHA, run.output);
});

test('prerelease assembly fails instead of creating a second draft when the release lookup fails', bashOnly, () => {
  const releases = [{ id: 5, draft: true, target: BUILD_SHA, assets: [] }];
  const run = runAssembly({ listError: 'Server Error (HTTP 502)', releases });

  assert.notEqual(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, releases, run.output);
});

test('prerelease assembly refuses a release tag that points at another commit', bashOnly, () => {
  const run = runAssembly({ tagSha: OTHER_SHA });

  assert.notEqual(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, [], run.output);
  assert.equal(run.github.tagSha, OTHER_SHA, run.output);
});

test('prerelease rollback deletes the draft of an assembly that failed before publishing', bashOnly, () => {
  const run = runRollback({ releases: [{ id: 1, draft: true, target: BUILD_SHA, assets: [VSIX] }] });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, [], run.output);
  assert.equal(run.github.tagSha, null, run.output);
});

test('prerelease rollback deletes every release that carries the tag', bashOnly, () => {
  const run = runRollback({
    releases: [
      { id: 1, draft: true, target: BUILD_SHA, assets: [] },
      { id: 2, draft: true, target: BUILD_SHA, assets: [] }
    ]
  });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, [], run.output);
});

test('prerelease rollback deletes a published pre-release and its tag', bashOnly, () => {
  const run = runRollback({ tagSha: BUILD_SHA, releases: [{ id: 1, draft: false, target: BUILD_SHA, assets: [] }] });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, [], run.output);
  assert.equal(run.github.tagSha, null, run.output);
});

test('prerelease rollback fails and names the manual step when the ruleset refuses the tag delete', bashOnly, () => {
  const run = runRollback({
    tagSha: BUILD_SHA,
    tagDeleteRefused: true,
    releases: [{ id: 1, draft: false, target: BUILD_SHA, assets: [] }]
  });

  assert.notEqual(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, [], run.output);
  assert.equal(run.github.tagSha, BUILD_SHA, run.output);
  assert.match(run.output, /::error::.*Release tags - Protect updates and deletes/);
  assert.match(run.output, /git push origin :refs\/tags\/v0\.57\.3/);
});

test('prerelease rollback reruns keep failing on a refused tag until an admin deletes it', bashOnly, () => {
  const first = runRollback({
    tagSha: BUILD_SHA,
    tagDeleteRefused: true,
    releases: [{ id: 1, draft: false, target: BUILD_SHA, assets: [] }]
  });
  assert.notEqual(first.status, 0, first.output);

  const rerun = runRollback(first.github);
  assert.notEqual(rerun.status, 0, rerun.output);
  assert.doesNotMatch(rerun.output, /nothing to delete/);
  assert.match(rerun.output, /git push origin :refs\/tags\/v0\.57\.3/);

  const afterAdmin = runRollback({ ...rerun.github, tagSha: null });
  assert.equal(afterAdmin.status, 0, afterAdmin.output);
  assert.match(afterAdmin.output, /nothing to delete/);
});

test('prerelease rollback rerun deletes a tag that an earlier run left behind', bashOnly, () => {
  const run = runRollback({ tagSha: BUILD_SHA, releases: [] });

  assert.equal(run.status, 0, run.output);
  assert.equal(run.github.tagSha, null, run.output);
});

test('prerelease rollback treats a missing release and tag as nothing to delete', bashOnly, () => {
  const run = runRollback({});

  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /does not exist; nothing to delete/);
});

test('prerelease rollback leaves a pre-release whose tag points at another commit in place', bashOnly, () => {
  const releases = [{ id: 1, draft: false, target: OTHER_SHA, assets: [] }];
  const run = runRollback({ tagSha: OTHER_SHA, releases });

  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, releases, run.output);
  assert.equal(run.github.tagSha, OTHER_SHA, run.output);
});

test('prerelease rollback fails when a GitHub API lookup fails', bashOnly, () => {
  const releases = [{ id: 1, draft: true, target: BUILD_SHA, assets: [] }];
  const run = runRollback({ apiError: 'Bad credentials (HTTP 401)', releases });

  assert.notEqual(run.status, 0, run.output);
  assert.deepEqual(run.github.releases, releases, run.output);
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
