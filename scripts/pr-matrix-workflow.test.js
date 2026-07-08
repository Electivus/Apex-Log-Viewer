const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');

function read(relativePath) {
  return fs.readFileSync(relativePath, 'utf8');
}

function readWorkflow(relativePath) {
  return YAML.parse(read(relativePath));
}

function getJob(workflow, jobName) {
  const job = workflow?.jobs?.[jobName];
  assert.ok(job, `expected workflow to define jobs.${jobName}`);
  return job;
}

function getStep(job, stepName) {
  const steps = job?.steps;
  assert.ok(Array.isArray(steps), 'expected job to define steps');
  const step = steps.find(candidate => candidate?.name === stepName);
  assert.ok(step, `expected job step '${stepName}' to exist`);
  return {
    step,
    index: steps.indexOf(step)
  };
}

function matrixByOs(job) {
  const matrix = job?.strategy?.matrix;
  const entries = Array.isArray(matrix?.include) ? matrix.include : matrix?.os;
  assert.ok(Array.isArray(entries), 'expected job matrix to define OS entries');
  return new Map(entries.map(entry => [entry.os || entry.runner, entry]));
}

const EXPECTED_SHARD_MATRIX = [
  { playwright_shard: '1/4', artifact_suffix: 'shard-1' },
  { playwright_shard: '2/4', artifact_suffix: 'shard-2' },
  { playwright_shard: '3/4', artifact_suffix: 'shard-3' },
  { playwright_shard: '4/4', artifact_suffix: 'shard-4' }
];

test('package.json test:scripts includes the PR matrix workflow guard', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/pr-matrix-workflow\.test\.js\b/,
    'expected the PR matrix workflow guard to run in the default script suite'
  );
});

test('CI build_and_test covers Ubuntu, Windows, and macOS with matching VS Code cache platforms', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');
  const buildJob = getJob(workflow, 'build_and_test');
  const matrix = matrixByOs(buildJob);

  assert.equal(buildJob['timeout-minutes'], 45);
  assert.equal(buildJob.strategy?.['fail-fast'], false);
  assert.deepEqual(Array.from(matrix.keys()).sort(), ['macos-latest', 'ubuntu-latest', 'windows-latest']);
  assert.equal(matrix.get('ubuntu-latest')?.vscode_platform, 'linux-x64');
  assert.equal(matrix.get('windows-latest')?.vscode_platform, 'win32-x64-archive');
  assert.equal(matrix.get('macos-latest')?.vscode_platform, 'darwin-arm64');
});

test('CI disables Windows autocrlf before checkout', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');
  const buildJob = getJob(workflow, 'build_and_test');
  const autocrlfStep = getStep(buildJob, 'Disable Windows autocrlf');
  const checkoutStep = getStep(buildJob, 'Checkout');

  assert.equal(autocrlfStep.step.if, "runner.os == 'Windows'");
  assert.equal(autocrlfStep.step.run, 'git config --global core.autocrlf false');
  assert.ok(autocrlfStep.index < checkoutStep.index, 'expected Windows autocrlf to be disabled before checkout');
});

test('CI resolves VS Code metadata per matrix platform and runs scope dispatch under bash', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');
  const buildJob = getJob(workflow, 'build_and_test');
  const vscodeCacheStep = getStep(buildJob, 'Resolve VS Code cache metadata').step;
  const runTestsStep = getStep(buildJob, 'Run tests').step;

  assert.equal(vscodeCacheStep.env?.VSCODE_TARGET, 'stable');
  assert.equal(vscodeCacheStep.env?.VSCODE_PLATFORM, '${{ matrix.vscode_platform }}');
  assert.equal(runTestsStep.shell, 'bash');
  assert.match(String(runTestsStep.run || ''), /case "\$\{\{ github\.event\.inputs\.scope \|\| 'unit' \}\}" in/);
});

test('CI keeps the VSIX smoke job Ubuntu-only after the cross-OS build matrix succeeds', () => {
  const workflow = readWorkflow('.github/workflows/ci.yml');
  const smokeJob = getJob(workflow, 'smoke_vsix');
  const vscodeCacheStep = getStep(smokeJob, 'Resolve VS Code cache metadata').step;

  assert.equal(smokeJob.needs, 'build_and_test');
  assert.equal(smokeJob['runs-on'], 'ubuntu-latest');
  assert.equal(smokeJob.if, "needs.build_and_test.result == 'success'");
  assert.equal(vscodeCacheStep.env?.VSCODE_PLATFORM, 'linux-x64');
});

test('real-org E2E keeps Ubuntu on the proxy lab and adds direct Windows/macOS lanes', () => {
  const workflow = readWorkflow('.github/workflows/e2e-playwright.yml');
  const proxyJob = getJob(workflow, 'playwright_e2e');
  const directJob = getJob(workflow, 'playwright_e2e_os_matrix');
  const matrix = matrixByOs(directJob);
  const proxyCliStep = getStep(proxyJob, 'Run CLI real-org E2E').step;
  const proxyExtensionStep = getStep(proxyJob, 'Run Playwright E2E').step;

  assert.equal(proxyJob['runs-on'], 'ubuntu-latest');
  assert.deepEqual(proxyJob.strategy?.matrix?.shard, EXPECTED_SHARD_MATRIX);
  assert.match(String(proxyCliStep.run || ''), /\bnpm run test:e2e:proxy-lab -- npm run test:e2e:cli\b/);
  assert.match(String(proxyExtensionStep.run || ''), /\bnpm run test:e2e:proxy-lab -- npm run test:e2e\b/);

  assert.equal(directJob.strategy?.['fail-fast'], false);
  assert.deepEqual(directJob.strategy?.matrix?.shard, EXPECTED_SHARD_MATRIX);
  assert.deepEqual(Array.from(matrix.keys()).sort(), ['macos-latest', 'windows-latest']);
  assert.equal(matrix.get('windows-latest')?.vscode_platform, 'win32-x64-archive');
  assert.equal(matrix.get('windows-latest')?.artifact_suffix, 'windows');
  assert.equal(matrix.get('macos-latest')?.vscode_platform, 'darwin-arm64');
  assert.equal(matrix.get('macos-latest')?.artifact_suffix, 'macos');
});

test('direct E2E lanes run without proxy-lab and publish OS-specific artifacts', () => {
  const workflow = readWorkflow('.github/workflows/e2e-playwright.yml');
  const directJob = getJob(workflow, 'playwright_e2e_os_matrix');
  const cliStep = getStep(directJob, 'Run CLI real-org E2E').step;
  const extensionStep = getStep(directJob, 'Run Playwright E2E').step;
  const uploadCliStep = getStep(directJob, 'Upload CLI E2E artifacts').step;
  const uploadExtensionStep = getStep(directJob, 'Upload Playwright artifacts').step;

  assert.match(String(cliStep.run || ''), /^\s*npm run test:e2e:cli\s*$/m);
  assert.doesNotMatch(String(cliStep.run || ''), /proxy-lab/);
  assert.match(String(extensionStep.run || ''), /^\s*npm run test:e2e\s*$/m);
  assert.doesNotMatch(String(extensionStep.run || ''), /proxy-lab/);
  assert.equal(uploadCliStep.with?.name, 'playwright-cli-e2e-${{ matrix.os.artifact_suffix }}-${{ matrix.shard.artifact_suffix }}');
  assert.equal(uploadCliStep.with?.path, 'output/playwright-cli/');
  assert.equal(uploadExtensionStep.with?.name, 'playwright-e2e-${{ matrix.os.artifact_suffix }}-${{ matrix.shard.artifact_suffix }}');
  assert.equal(uploadExtensionStep.with?.path, 'output/playwright/');
});
