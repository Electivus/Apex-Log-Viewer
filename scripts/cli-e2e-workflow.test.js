const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');

const SHARED_SCRATCH_ENV_KEYS = [
  'PLAYWRIGHT_WORKERS',
  'SF_SCRATCH_STRATEGY',
  'SF_SCRATCH_POOL_NAME',
  'SF_SCRATCH_POOL_OWNER',
  'SF_SCRATCH_POOL_LEASE_TTL_SECONDS',
  'SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS',
  'SF_SCRATCH_POOL_HEARTBEAT_SECONDS',
  'SF_SCRATCH_POOL_MIN_REMAINING_MINUTES',
  'SF_SCRATCH_POOL_SEED_VERSION',
  'SF_SCRATCH_POOL_SNAPSHOT_NAME',
  'SF_DEVHUB_AUTH_URL',
  'SF_DEVHUB_ALIAS',
  'SF_SCRATCH_DURATION',
  'SF_TEST_KEEP_ORG'
];

function read(relativePath) {
  return fs.readFileSync(relativePath, 'utf8');
}

function readWorkflow() {
  return YAML.parse(read('.github/workflows/e2e-playwright.yml'));
}

function getWorkflowJob(workflow, jobName) {
  const job = workflow?.jobs?.[jobName];
  assert.ok(job, `expected workflow to define jobs.${jobName}`);
  return job;
}

function getWorkflowStep(workflow, stepName, jobName = 'playwright_e2e') {
  const steps = getWorkflowJob(workflow, jobName)?.steps;
  assert.ok(Array.isArray(steps), `expected workflow to define jobs.${jobName}.steps`);

  const step = steps.find(candidate => candidate?.name === stepName);
  assert.ok(step, `expected workflow step '${stepName}' to exist in job '${jobName}'`);

  return {
    step,
    index: steps.indexOf(step)
  };
}

function getDirectWorkflowStep(workflow, stepName) {
  return getWorkflowStep(workflow, stepName, 'playwright_e2e_os_matrix');
}

test('package.json test:scripts includes the CLI real-org workflow guard', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/cli-e2e-workflow\.test\.js\b/,
    'expected the CLI real-org workflow guard to run in the default script suite'
  );
});

test('real-org Playwright workflow runs the CLI suite before the extension suite and uploads separate CLI artifacts', () => {
  const workflow = readWorkflow();
  const cliStep = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const extensionStep = getWorkflowStep(workflow, 'Run Playwright E2E');
  const uploadArtifactsStep = getWorkflowStep(workflow, 'Upload CLI E2E artifacts');

  assert.match(
    String(cliStep.step.run || ''),
    /\bnpm run test:e2e:proxy-lab -- npm run test:e2e:cli\b/,
    'expected the workflow to run CLI real-org E2E through the MITM proxy lab'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cliStep.step.env || {}, 'ALV_E2E_PROXY_LAB_SKIP_NPM_CI'),
    'expected CLI real-org E2E to populate the proxy-lab dependency volume'
  );
  assert.equal(
    uploadArtifactsStep.step?.with?.path,
    'output/playwright-cli/',
    'expected the workflow to upload output/playwright-cli/ as dedicated CLI artifacts'
  );

  assert.ok(
    cliStep.index < extensionStep.index,
    'expected the CLI real-org step to run before the extension Playwright step'
  );
});

test('real-org Playwright workflow keeps the CLI scratch-env contract aligned with the extension step', () => {
  const workflow = readWorkflow();
  const { step: cliStep } = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const { step: extensionStep } = getWorkflowStep(workflow, 'Run Playwright E2E');

  for (const key of SHARED_SCRATCH_ENV_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(cliStep.env || {}, key),
      `expected CLI real-org step env to include '${key}'`
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(extensionStep.env || {}, key),
      `expected extension Playwright step env to include '${key}'`
    );
    assert.equal(
      cliStep.env[key],
      extensionStep.env[key],
      `expected CLI real-org step env '${key}' to stay aligned with the extension Playwright step`
    );
  }
});

test('real-org Playwright workflow runs the extension suite through the MITM proxy lab', () => {
  const workflow = readWorkflow();
  const { step: extensionStep } = getWorkflowStep(workflow, 'Run Playwright E2E');
  const runBlock = String(extensionStep.run || '');

  assert.match(
    runBlock,
    /^\s*npm run test:e2e:telemetry\s*$/m,
    'expected telemetry validation to remain a host-side workflow command'
  );
  assert.doesNotMatch(
    runBlock,
    /\btest:e2e:proxy-lab -- npm run test:e2e:telemetry\b/,
    'expected telemetry wrapper not to be launched directly through the MITM proxy lab'
  );
  assert.match(
    runBlock,
    /^\s*npm run test:e2e:proxy-lab -- npm run test:e2e\s*$/m,
    'expected the non-telemetry extension suite to run through the MITM proxy lab'
  );
  assert.equal(
    extensionStep.env?.ALV_E2E_TELEMETRY_PROXY_LAB,
    '1',
    'expected telemetry wrapper to launch its Playwright child through the MITM proxy lab'
  );
  assert.equal(
    extensionStep.env?.ALV_E2E_PROXY_LAB_SKIP_NPM_CI,
    '1',
    'expected extension E2E to reuse the dependency volume populated by the CLI proxy-lab step'
  );
});

test('real-org Playwright workflow disables Playwright retries for the expensive CI run', () => {
  const workflow = readWorkflow();

  assert.equal(
    workflow?.jobs?.playwright_e2e?.env?.PLAYWRIGHT_RETRIES,
    '0',
    'expected the real-org Playwright workflow to disable retries via PLAYWRIGHT_RETRIES=0'
  );
});

test('real-org Playwright workflow serializes CI runs by scratch-org pool', () => {
  const workflow = readWorkflow();
  const concurrency = workflow?.concurrency || {};

  assert.equal(
    concurrency.group,
    "${{ vars.SF_SCRATCH_POOL_NAME != '' && format('e2e-playwright-pool-{0}', vars.SF_SCRATCH_POOL_NAME) || 'sf-e2e-scratch-global' }}",
    'expected E2E workflow concurrency to be keyed by shared scratch-org pool name'
  );
  assert.equal(
    concurrency['cancel-in-progress'],
    false,
    'expected an active E2E run to finish instead of being canceled by another shared-pool run'
  );
  assert.equal(
    Object.hasOwn(concurrency, 'queue'),
    false,
    'expected workflow concurrency to avoid the unsupported queue key'
  );
  assert.doesNotMatch(
    String(concurrency.group || ''),
    /github\.ref/,
    'expected dependency PR bursts to share the same pool concurrency group instead of one group per ref'
  );
});

test('direct real-org Playwright OS matrix runs Windows and macOS without the proxy lab', () => {
  const workflow = readWorkflow();
  const matrix = getWorkflowJob(workflow, 'playwright_e2e_os_matrix')?.strategy?.matrix?.include;
  const cliStep = getDirectWorkflowStep(workflow, 'Run CLI real-org E2E');
  const extensionStep = getDirectWorkflowStep(workflow, 'Run Playwright E2E');

  assert.deepEqual(
    matrix?.map(entry => ({
      artifact_suffix: entry.artifact_suffix,
      os: entry.os,
      vscode_platform: entry.vscode_platform
    })),
    [
      {
        os: 'windows-latest',
        vscode_platform: 'win32-x64-archive',
        artifact_suffix: 'windows'
      },
      {
        os: 'macos-latest',
        vscode_platform: 'darwin-arm64',
        artifact_suffix: 'macos'
      }
    ]
  );

  assert.match(String(cliStep.step.run || ''), /^\s*npm run test:e2e:cli\s*$/m);
  assert.doesNotMatch(String(cliStep.step.run || ''), /proxy-lab/);
  assert.match(String(extensionStep.step.run || ''), /^\s*npm run test:e2e\s*$/m);
  assert.doesNotMatch(String(extensionStep.step.run || ''), /proxy-lab/);
  assert.ok(cliStep.index < extensionStep.index, 'expected direct CLI E2E to run before direct extension E2E');
});

test('direct real-org Playwright workflow keeps the CLI scratch-env contract aligned with the extension step', () => {
  const workflow = readWorkflow();
  const { step: cliStep } = getDirectWorkflowStep(workflow, 'Run CLI real-org E2E');
  const { step: extensionStep } = getDirectWorkflowStep(workflow, 'Run Playwright E2E');

  for (const key of SHARED_SCRATCH_ENV_KEYS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(cliStep.env || {}, key),
      `expected direct CLI real-org step env to include '${key}'`
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(extensionStep.env || {}, key),
      `expected direct extension Playwright step env to include '${key}'`
    );
    assert.equal(
      cliStep.env[key],
      extensionStep.env[key],
      `expected direct CLI real-org step env '${key}' to stay aligned with the direct extension step`
    );
  }

  assert.equal(
    cliStep.env.SF_SCRATCH_POOL_OWNER,
    'github:${{ github.run_id }}/${{ github.run_attempt }}/${{ matrix.artifact_suffix }}',
    'expected direct E2E pool owners to include the OS artifact suffix'
  );
});

test('direct real-org Playwright workflow uploads OS-specific artifacts and disables retries', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_os_matrix');
  const uploadCliStep = getDirectWorkflowStep(workflow, 'Upload CLI E2E artifacts');
  const uploadExtensionStep = getDirectWorkflowStep(workflow, 'Upload Playwright artifacts');

  assert.equal(job.env?.PLAYWRIGHT_RETRIES, '0');
  assert.equal(uploadCliStep.step.with?.name, 'playwright-cli-e2e-${{ matrix.artifact_suffix }}');
  assert.equal(uploadCliStep.step.with?.path, 'output/playwright-cli/');
  assert.equal(uploadExtensionStep.step.with?.name, 'playwright-e2e-${{ matrix.artifact_suffix }}');
  assert.equal(uploadExtensionStep.step.with?.path, 'output/playwright/');
});

test('direct macOS Playwright workflow runs Salesforce CLI with an LTS Node runtime', () => {
  const workflow = readWorkflow();
  const installSfStep = getDirectWorkflowStep(workflow, 'Install Salesforce CLI');
  const setupSfNodeStep = getDirectWorkflowStep(workflow, 'Setup Salesforce CLI Node.js');
  const exportSfNodeStep = getDirectWorkflowStep(workflow, 'Export Salesforce CLI Node.js runtime');
  const restoreProjectNodeStep = getDirectWorkflowStep(workflow, 'Restore Node.js from .nvmrc');
  const installDepsStep = getDirectWorkflowStep(workflow, 'Install extension dependencies');

  assert.ok(
    setupSfNodeStep.index < installSfStep.index,
    'expected macOS to select the Salesforce CLI Node runtime before installing the CLI'
  );
  assert.equal(setupSfNodeStep.step.if, "runner.os == 'macOS'");
  assert.equal(setupSfNodeStep.step.uses, 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e');
  assert.equal(setupSfNodeStep.step.with?.['node-version'], '20');

  assert.ok(
    installSfStep.index < exportSfNodeStep.index,
    'expected LTS Node Salesforce CLI to install before exporting its runtime and binary path'
  );
  assert.match(
    String(installSfStep.step.run || ''),
    /npm install -g @salesforce\/cli@2\.136\.8 --no-audit --no-fund/,
    'expected the workflow to keep installing the pinned Salesforce CLI'
  );
  assert.equal(exportSfNodeStep.step.if, "runner.os == 'macOS'");
  assert.match(
    String(exportSfNodeStep.step.run || ''),
    /node_path="\$\(command -v node\)"/,
    'expected the macOS direct E2E job to export the Salesforce CLI Node runtime for the VS Code wrapper'
  );
  assert.match(
    String(exportSfNodeStep.step.run || ''),
    /wrapper_dir="\$\{RUNNER_TEMP\}\/alv-sf-node20"/,
    'expected the macOS direct E2E job to create a sanitized Salesforce CLI wrapper'
  );
  assert.match(
    String(exportSfNodeStep.step.run || ''),
    /SF_CLI_BIN_PATH=\$\{wrapper_path\}.*>> "\$GITHUB_ENV"/,
    'expected the macOS direct E2E job to export the sanitized Salesforce CLI wrapper for runtime calls'
  );
  assert.match(
    String(exportSfNodeStep.step.run || ''),
    /ALV_SF_BIN_PATH=\$\{wrapper_path\}.*>> "\$GITHUB_ENV"/,
    'expected the macOS direct E2E job to export the sanitized Salesforce CLI wrapper for Rust runtime calls'
  );

  assert.ok(
    exportSfNodeStep.index < restoreProjectNodeStep.index,
    'expected the project Node runtime to be restored after capturing the Salesforce CLI runtime'
  );
  assert.equal(restoreProjectNodeStep.step.if, "runner.os == 'macOS'");
  assert.equal(restoreProjectNodeStep.step.uses, 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e');
  assert.equal(restoreProjectNodeStep.step.with?.['node-version-file'], '.nvmrc');
  assert.ok(
    restoreProjectNodeStep.index < installDepsStep.index,
    'expected npm ci to run under the project Node version'
  );
});

test('real-org Playwright workflow logs into Azure immediately before telemetry-capable extension E2E', () => {
  const workflow = readWorkflow();
  const azureLoginStep = getWorkflowStep(workflow, 'Azure login for dedicated App Insights validation');
  const cliStep = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const uploadArtifactsStep = getWorkflowStep(workflow, 'Upload CLI E2E artifacts');
  const extensionStep = getWorkflowStep(workflow, 'Run Playwright E2E');

  assert.equal(
    azureLoginStep.step.uses,
    'azure/login@93381592711f247e165c389ebb30b596c84cdc48',
    'expected azure/login to stay pinned to the SHA currently allowed by the Electivus org action policy'
  );
  assert.ok(
    cliStep.index < azureLoginStep.index,
    'expected Azure login to run after the CLI real-org step so the OIDC assertion is fresher for telemetry validation'
  );
  assert.ok(
    uploadArtifactsStep.index < azureLoginStep.index,
    'expected Azure login to run after CLI artifact upload and immediately before the extension Playwright step'
  );
  assert.ok(
    azureLoginStep.index < extensionStep.index,
    'expected Azure login to run before the telemetry-capable extension Playwright step'
  );
  assert.equal(
    azureLoginStep.index + 1,
    extensionStep.index,
    'expected Azure login to run immediately before the telemetry-capable extension Playwright step'
  );
});
