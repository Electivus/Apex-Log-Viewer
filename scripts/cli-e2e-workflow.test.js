const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const { spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { salesforceChildEnv, resolveDevHubConfig, validateDevHubJwt } = require('./devhub-auth');

test('real-org configuration gate rejects missing JWT even with a legacy URL and cached alias', () => {
  const result = spawnSync(process.execPath, ['scripts/check-real-org-config.js'], {
    env: {
      ...salesforceChildEnv(),
      CI: 'true',
      SF_SCRATCH_POOL_NAME: 'test-pool',
      SF_DEVHUB_AUTH_URL: 'force://legacy:secret:token@example.com',
      SF_DEVHUB_ALIAS: 'cached-devhub'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CI requires complete Dev Hub JWT configuration/);
  assert.doesNotMatch(result.stdout + result.stderr, /force:\/\/|legacy:secret:token/);
});

const JWT_SECRET_NAMES = ['SF_DEVHUB_CLIENT_ID', 'SF_DEVHUB_USERNAME', 'SF_DEVHUB_LOGIN_URL', 'SF_DEVHUB_PRIVATE_KEY'];
const jwtSecrets = {
  SF_DEVHUB_CLIENT_ID: 'workflow-test-client',
  SF_DEVHUB_USERNAME: 'workflow-test@example.com',
  SF_DEVHUB_LOGIN_URL: 'https://login.salesforce.com',
  SF_DEVHUB_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem'
  })
};

function workflowCredentialEnv(job, step, secrets) {
  const configured = { ...job.env, ...step.env };
  const env = { ...salesforceChildEnv(), CI: 'true', SF_DEVHUB_ALIAS: 'cached-devhub' };
  // Resolve the workflow's credential bindings without evaluating shell or GitHub expressions.
  for (const name of [...JWT_SECRET_NAMES, 'SF_DEVHUB_AUTH_URL', 'SF_SCRATCH_POOL_NAME']) {
    const value = configured[name];
    const secret = /^\$\{\{ secrets\.(\w+) \}\}$/.exec(value || '');
    env[name] = secret ? secrets[secret[1]] || '' : value === '${{ env.SCRATCH_POOL_NAME }}' ? 'test-pool' : '';
  }
  return env;
}

test('each real-org workflow gate validates complete JWT and rejects partial or placeholder secrets', () => {
  const workflow = readWorkflow();
  for (const jobName of ['playwright_e2e', 'intellij_native_real_org_linux', 'playwright_e2e_os_matrix']) {
    const job = getWorkflowJob(workflow, jobName);
    const gate = getWorkflowStep(workflow, 'Require scratch-org pool configuration', jobName).step;
    const [command, ...args] = String(gate.run).trim().split(/\s+/);
    assert.equal(command, 'node', 'the credential gate must run natively on every supported OS');
    for (const [label, changes] of [
      ['complete', {}],
      ...JWT_SECRET_NAMES.map(name => [`missing ${name}`, { [name]: '' }]),
      ...JWT_SECRET_NAMES.map(name => [`redacted ${name}`, { [name]: '[REDACTED]' }])
    ]) {
      const secrets = { ...jwtSecrets, SF_DEVHUB_AUTH_URL: 'force://legacy:secret:token@example.com', ...changes };
      const result = spawnSync(process.execPath, args, {
        env: workflowCredentialEnv(job, gate, secrets),
        encoding: 'utf8'
      });
      assert.equal(result.status, label === 'complete' ? 0 : 1, `${jobName}: ${label}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY|force:\/\/legacy|workflow-test-client/);
    }
    const missingPool = workflowCredentialEnv(job, gate, jwtSecrets);
    delete missingPool.SF_SCRATCH_POOL_NAME;
    const result = spawnSync(process.execPath, args, { env: missingPool, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SF_SCRATCH_POOL_NAME/);

    const consumers = job.steps.filter(step =>
      /Run (CLI real-org E2E|Playwright E2E|native Kotlin real-org validation)$/.test(step.name)
    );
    assert.ok(consumers.length);
    for (const step of consumers) {
      const env = workflowCredentialEnv(job, step, jwtSecrets);
      validateDevHubJwt(resolveDevHubConfig(env));
      for (const name of JWT_SECRET_NAMES) {
        assert.throws(() => validateDevHubJwt(resolveDevHubConfig({ ...env, [name]: '' })), /Incomplete/);
      }
      assert.equal(step.env.SF_DEVHUB_AUTH_URL, undefined);
      assert.equal(step.env.SF_DEVHUB_ALIAS, undefined);
    }
  }
});

const SHARED_SCRATCH_ENV_KEYS = [
  'SF_SCRATCH_STRATEGY',
  'SF_SCRATCH_POOL_NAME',
  'SF_SCRATCH_POOL_OWNER',
  'SF_SCRATCH_POOL_LEASE_TTL_SECONDS',
  'SF_SCRATCH_POOL_WAIT_TIMEOUT_SECONDS',
  'SF_SCRATCH_POOL_HEARTBEAT_SECONDS',
  'SF_SCRATCH_POOL_MIN_REMAINING_MINUTES',
  'SF_SCRATCH_POOL_SEED_VERSION',
  'SF_SCRATCH_POOL_SNAPSHOT_NAME',
  ...JWT_SECRET_NAMES,
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

function getTelemetryWorkflowStep(workflow, stepName) {
  return getWorkflowStep(workflow, stepName, 'playwright_e2e_telemetry');
}

function getRequiredWorkflowStep(workflow, stepName) {
  return getWorkflowStep(workflow, stepName, 'playwright_e2e_required');
}

test('direct CI selects the generic keychain only for macOS and propagates it to Salesforce children', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_os_matrix');
  const selection = job.env.SF_USE_GENERIC_UNIX_KEYCHAIN;
  assert.equal(selection, "${{ runner.os == 'macOS' && 'true' || '' }}");
  for (const os of ['macOS', 'Windows']) {
    const env = { SF_USE_GENERIC_UNIX_KEYCHAIN: os === 'macOS' ? 'true' : '' };
    assert.equal(salesforceChildEnv(env).SF_USE_GENERIC_UNIX_KEYCHAIN, env.SF_USE_GENERIC_UNIX_KEYCHAIN);
  }
  for (const name of ['playwright_e2e', 'intellij_native_real_org_linux', 'playwright_e2e_telemetry']) {
    assert.equal(getWorkflowJob(workflow, name).env.SF_USE_GENERIC_UNIX_KEYCHAIN, undefined);
  }
});

test('package.json test:scripts includes the CLI real-org workflow guard', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/cli-e2e-workflow\.test\.js\b/,
    'expected the CLI real-org workflow guard to run in the default script suite'
  );
});

test('manual JWT lifecycle proof requires an explicit expected Dev Hub and keeps normal PR runs unchanged', () => {
  const workflow = readWorkflow();
  const input = workflow.on.workflow_dispatch.inputs.jwt_smoke_devhub_org_id;
  assert.equal(input?.type, 'string');
  assert.equal(input.required, false);
  assert.equal(input.default, undefined);
  for (const jobName of ['playwright_e2e', 'playwright_e2e_os_matrix']) {
    const step = getWorkflowStep(workflow, 'Run CLI real-org E2E', jobName).step;
    assert.equal(step.env.ALV_JWT_SMOKE_DEVHUB_ORG_ID, '${{ inputs.jwt_smoke_devhub_org_id }}');
    assert.equal(step.env.ALV_DEVHUB_JWT_SMOKE, "${{ inputs.jwt_smoke_devhub_org_id != '' && '1' || '' }}");
  }
  const proxyStep = getWorkflowStep(workflow, 'Run CLI real-org E2E').step;
  assert.equal(proxyStep.env.ALV_POOL_JWT_SMOKE, "${{ inputs.jwt_smoke_devhub_org_id != '' && '1' || '' }}");
  const compose = YAML.parse(read('docker-compose.e2e-proxy.yml'));
  assert.equal(compose.services.runner.environment.ALV_POOL_JWT_SMOKE, '${ALV_POOL_JWT_SMOKE:-}');
});

test('real-org Playwright workflow exposes a stable required PR gate', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_required');
  const { step } = getRequiredWorkflowStep(workflow, 'Require successful Real Org E2E lanes');

  assert.equal(job.name, 'Real Org E2E required');
  assert.deepEqual(job.needs, [
    'classify_e2e',
    'playwright_e2e',
    'intellij_native_real_org_linux',
    'playwright_e2e_os_matrix',
    'playwright_e2e_telemetry'
  ]);
  assert.equal(job.if, '${{ always() }}');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(step.env?.CLASSIFIER_RESULT, '${{ needs.classify_e2e.result }}');
  assert.equal(step.env?.RUN_E2E, '${{ needs.classify_e2e.outputs.run_e2e }}');
  assert.equal(step.env?.UBUNTU_RESULT, '${{ needs.playwright_e2e.result }}');
  assert.equal(step.env?.INTELLIJ_LINUX_RESULT, '${{ needs.intellij_native_real_org_linux.result }}');
  assert.equal(step.env?.DIRECT_RESULT, '${{ needs.playwright_e2e_os_matrix.result }}');
  assert.equal(step.env?.TELEMETRY_RESULT, '${{ needs.playwright_e2e_telemetry.result }}');
  assert.match(String(step.run || ''), /UBUNTU_RESULT.*success/s);
  assert.match(String(step.run || ''), /INTELLIJ_LINUX_RESULT.*success/s);
  assert.match(String(step.run || ''), /DIRECT_RESULT.*success/s);
  assert.match(String(step.run || ''), /TELEMETRY_RESULT.*(?:success|skipped)/s);
  assert.match(String(step.run || ''), /No product\/runtime\/E2E changes detected/);
  assert.match(String(step.run || ''), /CLASSIFIER_RESULT.*success/s);
  assert.match(String(step.run || ''), /invalid result/);
});

test('real-org workflow classifies risky changes and preserves a successful safe-skip gate', () => {
  const workflow = readWorkflow();
  const classifier = getWorkflowJob(workflow, 'classify_e2e');
  const classificationStep = classifier.steps.find(step => step.name === 'Classify product and test changes');

  assert.equal(classifier.outputs.run_e2e, '${{ steps.changes.outputs.run_e2e }}');
  assert.match(String(classificationStep?.run || ''), /workflow_dispatch/);
  assert.match(String(classificationStep?.run || ''), /scripts\/classify-real-org-e2e\.js/);
  for (const jobName of ['playwright_e2e', 'intellij_native_real_org_linux', 'playwright_e2e_os_matrix']) {
    const job = getWorkflowJob(workflow, jobName);
    assert.equal(job.needs, 'classify_e2e');
    assert.equal(job.if, "${{ needs.classify_e2e.outputs.run_e2e == 'true' }}");
  }
});

test('real-org Playwright workflow runs the CLI suite before the extension suite and uploads separate CLI artifacts', () => {
  const workflow = readWorkflow();
  const cliStep = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const extensionStep = getWorkflowStep(workflow, 'Run Playwright E2E');
  const uploadArtifactsStep = getWorkflowStep(workflow, 'Upload CLI E2E artifacts');

  assert.match(
    String(cliStep.step.run || ''),
    /^\s*node scripts\/run-e2e-proxy-lab\.js pnpm run test:e2e:cli\s*$/m,
    'expected the workflow to run CLI real-org E2E directly through the MITM proxy-lab orchestrator'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(cliStep.step.env || {}, 'ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL'),
    'expected CLI real-org E2E to populate the proxy-lab dependency volume'
  );
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      workflow?.jobs?.playwright_e2e?.env || {},
      'ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL'
    ),
    'expected proxy-lab dependency reuse to stay scoped to the later extension step'
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
  const { step: cliStep } = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const { step: extensionStep } = getWorkflowStep(workflow, 'Run Playwright E2E');
  const runBlock = String(extensionStep.run || '');

  assert.doesNotMatch(
    runBlock,
    /\btest:e2e:telemetry\b/,
    'expected Ubuntu extension E2E to leave telemetry validation to the final telemetry job'
  );
  assert.match(
    runBlock,
    /^\s*node scripts\/run-e2e-proxy-lab\.js pnpm run test:e2e\s*$/m,
    'expected the extension suite to run directly through the MITM proxy-lab orchestrator'
  );
  assert.doesNotMatch(
    `${cliStep.run || ''}\n${runBlock}`,
    /pnpm run test:e2e:proxy-lab/,
    'expected the dependency-free host orchestrator to run before the proxy-lab container installs dependencies'
  );
  assert.equal(
    cliStep.env?.PLAYWRIGHT_WORKERS,
    '${{ env.PLAYWRIGHT_WORKERS }}',
    'expected Ubuntu CLI E2E to use the general Playwright worker setting'
  );
  assert.equal(
    extensionStep.env?.PLAYWRIGHT_WORKERS,
    '${{ env.PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS }}',
    'expected Ubuntu extension proxy-lab E2E to use its dedicated worker setting'
  );
  assert.equal(cliStep.env?.ALV_E2E_PROXY_LAB_DEVHUB_ALIAS, undefined);
  assert.equal(
    extensionStep.env?.ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL,
    "${{ vars.ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL || '1' }}",
    'expected extension E2E to use the configured proxy-lab dependency reuse setting'
  );
  assert.equal(extensionStep.env?.ALV_E2E_PROXY_LAB_DEVHUB_ALIAS, undefined);
});

test('real-org Playwright workflow keeps E2E tunables configurable with safe defaults', () => {
  const workflow = readWorkflow();
  const job = workflow?.jobs?.playwright_e2e;
  const inputs = workflow?.on?.workflow_dispatch?.inputs || {};

  assert.ok(!Object.prototype.hasOwnProperty.call(inputs.scratch_duration_days || {}, 'default'));
  assert.ok(!Object.prototype.hasOwnProperty.call(inputs.playwright_workers || {}, 'default'));
  assert.ok(!Object.prototype.hasOwnProperty.call(inputs.playwright_extension_proxy_lab_workers || {}, 'default'));

  assert.equal(
    job?.env?.VSCODE_TEST_VERSION,
    "${{ vars.VSCODE_TEST_VERSION || github.event.inputs.vscode_version || 'stable' }}"
  );
  assert.equal(job?.env?.SALESFORCE_CLI_PACKAGE, '@salesforce/cli@2.150.6');
  assert.equal(
    job?.env?.PLAYWRIGHT_WORKERS,
    "${{ github.event.inputs.playwright_workers || vars.PLAYWRIGHT_WORKERS || '1' }}"
  );
  assert.equal(
    job?.env?.PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS,
    "${{ github.event.inputs.playwright_extension_proxy_lab_workers || vars.PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS || '1' }}"
  );
  assert.equal(job?.env?.PLAYWRIGHT_RETRIES, "${{ vars.PLAYWRIGHT_RETRIES || '0' }}");
  assert.ok(!Object.prototype.hasOwnProperty.call(job?.env || {}, 'PLAYWRIGHT_SHARD'));
  assert.equal(job?.env?.PLAYWRIGHT_TIMEOUT_MS, "${{ vars.PLAYWRIGHT_TIMEOUT_MS || '360000' }}");
  assert.equal(job?.env?.PLAYWRIGHT_EXPECT_TIMEOUT_MS, "${{ vars.PLAYWRIGHT_EXPECT_TIMEOUT_MS || '60000' }}");
  assert.equal(job?.env?.SF_DEVHUB_ALIAS, undefined);
  assert.equal(
    job?.env?.SF_SCRATCH_DURATION,
    "${{ github.event.inputs.scratch_duration_days || vars.SF_SCRATCH_DURATION || '1' }}"
  );
  assert.equal(job?.env?.SF_TEST_KEEP_ORG, "${{ vars.SF_TEST_KEEP_ORG || '1' }}");
  assert.equal(job?.env?.INSTALL_LINUX_DEPS, "${{ vars.INSTALL_LINUX_DEPS || 'true' }}");
  assert.equal(job?.env?.AZURE_CLIENT_ID, '${{ secrets.AZURE_CLIENT_ID }}');
  assert.equal(job?.env?.AZURE_TENANT_ID, '${{ secrets.AZURE_TENANT_ID }}');
  assert.equal(job?.env?.AZURE_SUBSCRIPTION_ID, '${{ secrets.AZURE_SUBSCRIPTION_ID }}');
  assert.equal(
    job?.env?.HAS_AZURE_E2E_TELEMETRY_CONFIG,
    "${{ vars.ALV_E2E_TELEMETRY_RESOURCE_GROUP != '' && vars.ALV_E2E_TELEMETRY_APP != '' && vars.ALV_E2E_TELEMETRY_BASE_APP != '' && '1' || '' }}"
  );
  assert.equal(job?.env?.ALV_E2E_TELEMETRY_RUN_ID_SEED, 'github:${{ github.run_id }}/ubuntu');
  assert.ok(!Object.prototype.hasOwnProperty.call(job?.env || {}, 'ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL'));
});

test('real-org Playwright workflow runs once on Ubuntu without shard configuration', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e');
  const { step: cliStep } = getWorkflowStep(workflow, 'Run CLI real-org E2E');
  const { step: extensionStep } = getWorkflowStep(workflow, 'Run Playwright E2E');

  assert.ok(!Object.prototype.hasOwnProperty.call(job, 'strategy'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'PLAYWRIGHT_SHARD'));
  assert.ok(!Object.prototype.hasOwnProperty.call(cliStep.env || {}, 'PLAYWRIGHT_SHARD'));
  assert.ok(!Object.prototype.hasOwnProperty.call(extensionStep.env || {}, 'PLAYWRIGHT_SHARD'));
  assert.doesNotMatch(read('.github/workflows/e2e-playwright.yml'), /PLAYWRIGHT_SHARD|playwright_shard|matrix\.shard/);
  assert.equal(cliStep.env?.PLAYWRIGHT_WORKERS, '${{ env.PLAYWRIGHT_WORKERS }}');
  assert.equal(extensionStep.env?.PLAYWRIGHT_WORKERS, '${{ env.PLAYWRIGHT_EXTENSION_PROXY_LAB_WORKERS }}');
});

test('real-org Playwright workflow enables test telemetry on the Ubuntu run', () => {
  const workflow = readWorkflow();
  const azureLoginStep = getWorkflowStep(workflow, 'Azure login for App Insights telemetry');
  const prepareTelemetryStep = getWorkflowStep(workflow, 'Prepare App Insights telemetry');
  const uploadCliStep = getWorkflowStep(workflow, 'Upload CLI E2E artifacts');
  const extensionStep = getWorkflowStep(workflow, 'Run Playwright E2E');

  assert.ok(uploadCliStep.index < azureLoginStep.index, 'expected telemetry login after CLI artifacts');
  assert.ok(azureLoginStep.index < prepareTelemetryStep.index, 'expected Azure login before exporting telemetry env');
  assert.ok(prepareTelemetryStep.index < extensionStep.index, 'expected test telemetry env before extension E2E');
  assert.equal(
    azureLoginStep.step.if,
    "${{ env.AZURE_CLIENT_ID != '' && env.AZURE_TENANT_ID != '' && env.AZURE_SUBSCRIPTION_ID != '' && env.HAS_AZURE_E2E_TELEMETRY_CONFIG == '1' }}"
  );
  assert.equal(
    prepareTelemetryStep.step.if,
    "${{ env.AZURE_CLIENT_ID != '' && env.AZURE_TENANT_ID != '' && env.AZURE_SUBSCRIPTION_ID != '' && env.HAS_AZURE_E2E_TELEMETRY_CONFIG == '1' }}"
  );
  assert.equal(prepareTelemetryStep.step.run, 'node scripts/run-playwright-e2e-telemetry.js --export-env');
});

test('Ubuntu proxy-lab E2E jobs avoid redundant host dependency setup', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e');
  const stepNames = job.steps.map(step => step.name);
  const setupNodeStep = getWorkflowStep(workflow, 'Setup Node.js from .nvmrc').step;

  assert.ok(!stepNames.includes('Resolve VS Code cache metadata'));
  assert.ok(!stepNames.includes('Restore VS Code test cache'));
  assert.ok(!stepNames.includes('Install Salesforce CLI'));
  assert.ok(!stepNames.includes('Install extension dependencies'));
  assert.ok(!stepNames.includes('Install Linux deps for Electron (best-effort)'));
  assert.ok(!Object.prototype.hasOwnProperty.call(setupNodeStep.with || {}, 'cache'));
  assert.ok(
    Object.prototype.hasOwnProperty.call(job.env || {}, 'SALESFORCE_CLI_PACKAGE'),
    'expected the proxy-lab Docker build to keep receiving the configured Salesforce CLI package'
  );
});

test('real-org Playwright workflow lets scratch-org leases bound concurrent CI runs', () => {
  const workflow = readWorkflow();
  assert.equal(
    workflow?.concurrency,
    undefined,
    'expected the atomic scratch-org lease service to enforce pool capacity without serializing whole workflow runs'
  );
});

test('direct real-org Playwright OS matrix runs Windows and macOS without the proxy lab', () => {
  const workflow = readWorkflow();
  const matrix = getWorkflowJob(workflow, 'playwright_e2e_os_matrix')?.strategy?.matrix;
  const cliStep = getDirectWorkflowStep(workflow, 'Run CLI real-org E2E');
  const extensionStep = getDirectWorkflowStep(workflow, 'Run Playwright E2E');

  assert.deepEqual(
    matrix?.os?.map(entry => ({
      artifact_suffix: entry.artifact_suffix,
      runner: entry.runner,
      vscode_platform: entry.vscode_platform
    })),
    [
      {
        runner: 'windows-latest',
        vscode_platform: 'win32-x64-archive',
        artifact_suffix: 'windows'
      },
      {
        runner: 'macos-latest',
        vscode_platform: 'darwin-arm64',
        artifact_suffix: 'macos'
      }
    ]
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(matrix || {}, 'shard'));

  assert.match(String(cliStep.step.run || ''), /^\s*node scripts\/run-playwright-cli-e2e\.js\s*$/m);
  assert.doesNotMatch(String(cliStep.step.run || ''), /proxy-lab/);
  assert.match(String(extensionStep.step.run || ''), /^\s*node scripts\/run-playwright-e2e\.js\s*$/m);
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

  assert.equal(cliStep.env.PLAYWRIGHT_WORKERS, '${{ env.PLAYWRIGHT_WORKERS }}');
  assert.equal(extensionStep.env.PLAYWRIGHT_WORKERS, '${{ env.PLAYWRIGHT_WORKERS }}');
  assert.equal(
    cliStep.env.SF_SCRATCH_POOL_OWNER,
    'github:${{ github.run_id }}/${{ github.run_attempt }}/${{ matrix.os.artifact_suffix }}',
    'expected direct E2E pool owners to include the OS artifact suffix'
  );
});

test('direct real-org Playwright workflow uploads OS-specific artifacts and keeps tunables configurable', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_os_matrix');
  const uploadCliStep = getDirectWorkflowStep(workflow, 'Upload CLI E2E artifacts');
  const uploadExtensionStep = getDirectWorkflowStep(workflow, 'Upload Playwright artifacts');

  assert.equal(job.needs, 'classify_e2e');
  assert.equal(job.if, "${{ needs.classify_e2e.outputs.run_e2e == 'true' }}");
  assert.equal(
    job.env?.VSCODE_TEST_VERSION,
    "${{ vars.VSCODE_TEST_VERSION || github.event.inputs.vscode_version || 'stable' }}"
  );
  assert.equal(job.env?.SALESFORCE_CLI_PACKAGE, '@salesforce/cli@2.150.6');
  assert.equal(job.env?.SALESFORCE_CLI_NODE_VERSION, undefined);
  assert.equal(
    job.env?.PLAYWRIGHT_WORKERS,
    "${{ github.event.inputs.playwright_workers || vars.PLAYWRIGHT_WORKERS || '1' }}"
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'PLAYWRIGHT_SHARD'));
  assert.equal(job.env?.PLAYWRIGHT_RETRIES, "${{ vars.PLAYWRIGHT_RETRIES || '0' }}");
  assert.equal(job.env?.PLAYWRIGHT_TIMEOUT_MS, "${{ vars.PLAYWRIGHT_TIMEOUT_MS || '360000' }}");
  assert.equal(job.env?.PLAYWRIGHT_EXPECT_TIMEOUT_MS, "${{ vars.PLAYWRIGHT_EXPECT_TIMEOUT_MS || '60000' }}");
  assert.equal(job.env?.SF_DEVHUB_ALIAS, undefined);
  assert.equal(
    job.env?.SF_SCRATCH_DURATION,
    "${{ github.event.inputs.scratch_duration_days || vars.SF_SCRATCH_DURATION || '1' }}"
  );
  assert.equal(job.env?.SF_TEST_KEEP_ORG, "${{ vars.SF_TEST_KEEP_ORG || '1' }}");
  const cliStep = getDirectWorkflowStep(workflow, 'Run CLI real-org E2E').step;
  assert.match(String(cliStep.env?.ALV_INTELLIJ_REAL_ORG_E2E), /runner\.os == 'Windows'/);
  assert.match(String(cliStep.env?.ALV_INTELLIJ_REAL_ORG_E2E), /workflow_dispatch/);
  assert.equal(uploadCliStep.step.with?.name, 'playwright-cli-e2e-${{ matrix.os.artifact_suffix }}');
  assert.equal(uploadCliStep.step.with?.path, 'output/playwright-cli/');
  assert.equal(uploadExtensionStep.step.with?.name, 'playwright-e2e-${{ matrix.os.artifact_suffix }}');
  assert.equal(uploadExtensionStep.step.with?.path, 'output/playwright/');
});

test('direct E2E jobs install with the frozen pnpm lock and build in the same job', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_os_matrix');
  const installDepsStep = getDirectWorkflowStep(workflow, 'Install extension dependencies');
  const buildStep = getDirectWorkflowStep(workflow, 'Build direct E2E artifacts');
  const requireConfigStep = getDirectWorkflowStep(workflow, 'Require scratch-org pool configuration');

  assert.ok(
    installDepsStep.index < buildStep.index && buildStep.index < requireConfigStep.index,
    'expected dependency fallback and build to run before the E2E commands'
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(workflow.jobs, 'playwright_e2e_os_prepare'));
  assert.equal(installDepsStep.step.run, 'pnpm install --frozen-lockfile');
  assert.equal(buildStep.step.run, 'pnpm run build');
  assert.ok(!job.steps.some(step => step.name === 'Download direct E2E build artifacts'));
  assert.ok(!job.steps.some(step => step.name === 'Restore direct E2E runtime executable bits'));
});

test('direct macOS Playwright workflow runs Salesforce CLI through the cached setup helper with an LTS Node runtime', () => {
  const workflow = readWorkflow();
  const setupSfNodeStep = getDirectWorkflowStep(workflow, 'Setup Salesforce CLI Node.js');
  const resolveCacheStep = getDirectWorkflowStep(workflow, 'Resolve Salesforce CLI cache metadata');
  const restoreCacheStep = getDirectWorkflowStep(workflow, 'Restore Salesforce CLI cache');
  const setupSfStep = getDirectWorkflowStep(workflow, 'Setup Salesforce CLI');
  const restoreProjectNodeStep = getDirectWorkflowStep(workflow, 'Restore Node.js from .nvmrc');
  const installDepsStep = getDirectWorkflowStep(workflow, 'Install extension dependencies');

  assert.ok(
    setupSfNodeStep.index < resolveCacheStep.index && resolveCacheStep.index < restoreCacheStep.index,
    'expected macOS to select the Salesforce CLI Node runtime before resolving the CLI cache'
  );
  assert.equal(setupSfNodeStep.step.if, "runner.os == 'macOS'");
  assert.equal(setupSfNodeStep.step.uses, 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e');
  assert.equal(setupSfNodeStep.step.with?.['node-version-file'], '.nvmrc');
  assert.equal(resolveCacheStep.step.run, 'node scripts/setup-salesforce-cli.mjs --print-cache-key');
  assert.equal(restoreCacheStep.step.with?.path, '${{ steps.sf-cli-cache.outputs.cache-dir }}');
  assert.equal(restoreCacheStep.step.with?.key, '${{ steps.sf-cli-cache.outputs.cache-key }}');
  assert.equal(setupSfStep.step.run, 'node scripts/setup-salesforce-cli.mjs');
  assert.equal(setupSfStep.step.env?.SALESFORCE_CLI_CACHE_ROOT, '${{ runner.tool_cache }}');
  assert.equal(setupSfStep.step.env?.SALESFORCE_CLI_WRAP_NODE, "${{ runner.os == 'macOS' && '1' || '' }}");
  assert.ok(
    setupSfStep.index < restoreProjectNodeStep.index,
    'expected the project Node runtime to be restored after capturing the Salesforce CLI runtime'
  );
  assert.equal(restoreProjectNodeStep.step.if, "runner.os == 'macOS'");
  assert.equal(restoreProjectNodeStep.step.uses, 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e');
  assert.equal(restoreProjectNodeStep.step.with?.['node-version-file'], '.nvmrc');
  assert.ok(
    restoreProjectNodeStep.index < installDepsStep.index,
    'expected pnpm install to run under the project Node version'
  );
});

test('real-org Playwright workflow runs telemetry validation after the E2E jobs', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_telemetry');
  const telemetryStep = getTelemetryWorkflowStep(workflow, 'Run Playwright E2E telemetry validation');
  const runBlock = String(telemetryStep.step.run || '');

  assert.deepEqual(
    job.needs,
    ['classify_e2e', 'playwright_e2e', 'playwright_e2e_os_matrix'],
    'expected telemetry validation to wait for both E2E jobs'
  );
  assert.equal(
    job.if,
    "${{ needs.classify_e2e.outputs.run_e2e == 'true' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork == false) }}",
    'expected telemetry validation not to expose Azure secrets to fork pull requests'
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(job, 'strategy'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'PLAYWRIGHT_SHARD'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'PLAYWRIGHT_WORKERS'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'SCRATCH_POOL_NAME'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'SALESFORCE_CLI_PACKAGE'));
  assert.ok(!Object.prototype.hasOwnProperty.call(job.env || {}, 'ALV_E2E_PROXY_LAB_SKIP_PNPM_INSTALL'));
  assert.equal(
    job.env?.HAS_AZURE_E2E_TELEMETRY_CONFIG,
    "${{ vars.ALV_E2E_TELEMETRY_RESOURCE_GROUP != '' && vars.ALV_E2E_TELEMETRY_APP != '' && vars.ALV_E2E_TELEMETRY_BASE_APP != '' && '1' || '' }}"
  );
  assert.equal(job.env?.ALV_E2E_TELEMETRY_RUN_ID_SEED, 'github:${{ github.run_id }}/ubuntu');
  assert.match(
    runBlock,
    /skipping dedicated telemetry validation after the E2E jobs/,
    'expected the final telemetry job to pass cleanly when telemetry config is incomplete'
  );
  assert.match(
    runBlock,
    /^\s*node scripts\/run-playwright-e2e-telemetry\.js --validate-only\s*$/m,
    'expected the final telemetry job to query telemetry without running Playwright'
  );
  assert.doesNotMatch(runBlock, /\btest:e2e\b/, 'expected final telemetry validation not to run E2E tests');
  assert.doesNotMatch(runBlock, /PLAYWRIGHT_SHARD/, 'expected final telemetry validation not to configure a shard');
  assert.equal(
    job.steps.some(step => step?.name === 'Upload Playwright telemetry artifacts'),
    false,
    'expected final telemetry validation not to upload Playwright artifacts'
  );
});

test('real-org Playwright workflow logs into Azure immediately before final telemetry validation', () => {
  const workflow = readWorkflow();
  const job = getWorkflowJob(workflow, 'playwright_e2e_telemetry');
  const azureLoginStep = getTelemetryWorkflowStep(workflow, 'Azure login for dedicated App Insights validation');
  const setupNodeStep = getTelemetryWorkflowStep(workflow, 'Setup Node.js from .nvmrc');
  const telemetryStep = getTelemetryWorkflowStep(workflow, 'Run Playwright E2E telemetry validation');
  const stepNames = job.steps.map(step => step.name);

  assert.equal(
    azureLoginStep.step.uses,
    'azure/login@93381592711f247e165c389ebb30b596c84cdc48',
    'expected azure/login to stay pinned to the SHA currently allowed by the Electivus org action policy'
  );
  assert.ok(!stepNames.includes('Resolve VS Code cache metadata'));
  assert.ok(!stepNames.includes('Restore VS Code test cache'));
  assert.ok(!stepNames.includes('Install Salesforce CLI'));
  assert.ok(!stepNames.includes('Install extension dependencies'));
  assert.ok(!stepNames.includes('Install Linux deps for Electron (best-effort)'));
  assert.ok(
    setupNodeStep.index < azureLoginStep.index,
    'expected Azure login to run after checkout/setup so the OIDC assertion is fresher for telemetry validation'
  );
  assert.ok(azureLoginStep.index < telemetryStep.index, 'expected Azure login to run before telemetry validation');
  assert.equal(
    azureLoginStep.index + 1,
    telemetryStep.index,
    'expected Azure login to run immediately before final telemetry validation'
  );
});
