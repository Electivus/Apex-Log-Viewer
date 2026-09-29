const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const { spawnSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { resolveDevHubConfig, salesforceChildEnv, validateDevHubJwt } = require('./devhub-auth');

const E2E_WORKFLOW_PATH = '.github/workflows/e2e-playwright.yml';
const SLOT_RECOVERY_WORKFLOW_PATH = '.github/workflows/slot-recovery.yml';
const E2E_LANE_JOBS = ['playwright_e2e', 'playwright_e2e_os_matrix'];
const GATE_RUN = 'node scripts/check-real-org-config.js';
const JWT_SECRET_NAMES = ['SF_DEVHUB_CLIENT_ID', 'SF_DEVHUB_USERNAME', 'SF_DEVHUB_LOGIN_URL', 'SF_DEVHUB_PRIVATE_KEY'];
const GATE_INPUTS = ['SF_SCRATCH_POOL_NAME', ...JWT_SECRET_NAMES];
// Values for the repository secrets and variables the workflows bind, by expression source.
const repositoryValues = {
  'vars.SF_SCRATCH_POOL_NAME': 'test-pool',
  'secrets.SF_DEVHUB_CLIENT_ID': 'workflow-test-client',
  'secrets.SF_DEVHUB_USERNAME': 'workflow-test@example.com',
  'secrets.SF_DEVHUB_LOGIN_URL': 'https://login.salesforce.com',
  'secrets.SF_DEVHUB_PRIVATE_KEY': generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem'
  }),
  'secrets.SF_DEVHUB_AUTH_URL': 'force://legacy:secret:token@example.com'
};

function read(relativePath) {
  return fs.readFileSync(relativePath, 'utf8');
}

function readWorkflow(relativePath) {
  return YAML.parse(read(relativePath));
}

// The repository secret or variable a step's env entry comes from, following job-level env indirection.
function bindingSource(job, step, name) {
  const value = String(step.env?.[name] ?? job.env?.[name] ?? '');
  const jobEnv = /^\$\{\{ env\.(\w+) \}\}$/.exec(value);
  if (jobEnv) {
    return bindingSource(job, {}, jobEnv[1]);
  }
  return /^\$\{\{ ((?:secrets|vars)\.\w+) \}\}$/.exec(value)?.[1];
}

function gateStepIndex(job) {
  const index = job.steps.findIndex(step => step.run === GATE_RUN);
  assert.notEqual(index, -1, 'expected the real-org configuration gate');
  return index;
}

function gateBindings(job) {
  const gate = job.steps[gateStepIndex(job)];
  return Object.fromEntries(GATE_INPUTS.map(name => [name, bindingSource(job, gate, name)]));
}

// Resolves the step's credential env as Actions would, without evaluating shell or other expressions.
function resolvedStepEnv(job, step, values = repositoryValues) {
  const env = { ...salesforceChildEnv(), CI: 'true', SF_DEVHUB_ALIAS: 'cached-devhub' };
  for (const name of [...GATE_INPUTS, 'SF_DEVHUB_AUTH_URL']) {
    env[name] = values[bindingSource(job, step, name)] ?? '';
  }
  return env;
}

// Pool maintenance commands a run invokes, through the admin script or its package scripts.
function poolCommands(run) {
  return [...String(run || '').matchAll(/scratch-pool(?:-admin\.js\s+|:)([a-z][a-z-]*)/g)].map(match => match[1]);
}

function prewarmStepIndex(job) {
  const index = job.steps.findIndex(step => poolCommands(step.run).includes('prewarm'));
  assert.notEqual(index, -1, 'expected a prewarm step');
  return index;
}

function slotRecoveryJob() {
  const jobs = Object.values(readWorkflow(SLOT_RECOVERY_WORKFLOW_PATH).jobs || {});
  assert.equal(jobs.length, 1, 'expected a single Slot Recovery job');
  assert.ok(Array.isArray(jobs[0].steps), 'expected the Slot Recovery job to define steps');
  return jobs[0];
}

test('Slot Recovery runs after every Real Org E2E workflow run, hourly and on demand', () => {
  const workflow = readWorkflow(SLOT_RECOVERY_WORKFLOW_PATH);
  const triggers = workflow.on;

  assert.deepEqual(Object.keys(triggers).sort(), ['schedule', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(triggers.workflow_run, {
    workflows: [readWorkflow(E2E_WORKFLOW_PATH).name],
    types: ['completed']
  });
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.if, undefined, `expected jobs.${jobName} to run whatever the E2E conclusion`);
  }

  assert.equal(triggers.schedule?.length, 1);
  const [minute, ...hourlyFields] = triggers.schedule[0].cron.split(/\s+/);
  assert.match(minute, /^\d+$/);
  assert.deepEqual(hourlyFields, ['*', '*', '*', '*'], 'expected an hourly backstop');
});

test('overlapping Slot Recovery triggers coalesce into one run at a time', () => {
  const workflow = readWorkflow(SLOT_RECOVERY_WORKFLOW_PATH);
  const { group, 'cancel-in-progress': cancelInProgress } = workflow.concurrency || {};

  assert.equal(typeof group, 'string', 'expected a workflow-level concurrency group');
  // A dispatch from another branch, a schedule and a workflow_run must share one group.
  assert.doesNotMatch(group, /\$\{\{/, 'expected the group to stay the same for every trigger and ref');
  assert.notEqual(cancelInProgress, true, 'expected a running recovery to finish instead of being cancelled');
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.concurrency, undefined, `expected jobs.${jobName} not to split the workflow group`);
  }
});

test('Slot Recovery runs the default branch version on Ubuntu with a read-only token', () => {
  const text = read(SLOT_RECOVERY_WORKFLOW_PATH);
  const workflow = YAML.parse(text);
  const job = slotRecoveryJob();
  const checkout = job.steps.find(step => /^actions\/checkout@/.test(String(step.uses || '')));

  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.permissions, undefined, 'expected the job not to widen the read-only token');
  assert.ok(checkout, 'expected the job to check out the repository');
  // workflow_run checks out the default branch unless a ref selects the triggering PR's code.
  assert.equal(checkout.with?.ref, undefined, 'expected recovery logic never to come from a pull request');
  assert.equal(checkout.with?.['persist-credentials'], false);
  assert.doesNotMatch(text, /github\.event\.workflow_run/, 'expected no input from the triggering run');
});

test('Slot Recovery passes the real-org configuration gate with the E2E Dev Hub JWT secrets and pool variable', () => {
  const e2e = readWorkflow(E2E_WORKFLOW_PATH);
  const job = slotRecoveryJob();
  const gate = job.steps[gateStepIndex(job)];
  const bindings = gateBindings(job);

  assert.deepEqual(bindings, {
    SF_SCRATCH_POOL_NAME: 'vars.SF_SCRATCH_POOL_NAME',
    ...Object.fromEntries(JWT_SECRET_NAMES.map(name => [name, `secrets.${name}`]))
  });
  for (const laneName of E2E_LANE_JOBS) {
    assert.deepEqual(bindings, gateBindings(e2e.jobs[laneName]), `expected the ${laneName} gate inputs`);
  }
  assert.doesNotMatch(JSON.stringify(job.env || {}), /secrets\./, 'expected no job-wide Dev Hub credentials');

  const [, ...args] = GATE_RUN.split(' ');
  const runGate = values =>
    spawnSync(process.execPath, args, { env: resolvedStepEnv(job, gate, values), encoding: 'utf8' });
  for (const [label, changes] of [
    ['complete', {}],
    ...GATE_INPUTS.map(name => [`missing ${name}`, { [bindings[name]]: '' }]),
    ...JWT_SECRET_NAMES.map(name => [`redacted ${name}`, { [bindings[name]]: '[REDACTED]' }])
  ]) {
    const result = runGate({ ...repositoryValues, ...changes });
    assert.equal(result.status, label === 'complete' ? 0 : 1, `${label}: ${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY|force:\/\/legacy|workflow-test-client/);
  }
});

test('Slot Recovery replaces retired environments with prewarm for the configured pool and never reconcile', () => {
  const job = slotRecoveryJob();
  const prewarmIndex = prewarmStepIndex(job);
  const prewarm = job.steps[prewarmIndex];

  assert.deepEqual(
    job.steps.flatMap(step => poolCommands(step.run)),
    ['prewarm'],
    'expected prewarm, which skips leased slots, to be the only pool maintenance command'
  );
  for (const step of job.steps) {
    assert.doesNotMatch(String(step.run || ''), /\breconcile\b/, 'expected no step to reconcile the pool');
  }

  const poolKeyVariable = /--pool-key[= ]"?\$\{?(\w+)\}?"?/.exec(prewarm.run)?.[1];
  assert.ok(poolKeyVariable, 'expected prewarm to select its pool explicitly from the environment');
  assert.equal(bindingSource(job, prewarm, poolKeyVariable), 'vars.SF_SCRATCH_POOL_NAME');

  assert.ok(gateStepIndex(job) < prewarmIndex, 'expected the configuration gate to run before prewarm');
  for (const name of JWT_SECRET_NAMES) {
    assert.equal(bindingSource(job, prewarm, name), `secrets.${name}`);
  }
  assert.equal(bindingSource(job, prewarm, 'SF_DEVHUB_AUTH_URL'), undefined);
  assert.equal(bindingSource(job, prewarm, 'SF_DEVHUB_ALIAS'), undefined);
  validateDevHubJwt(resolveDevHubConfig(resolvedStepEnv(job, prewarm)));
});

test('Slot Recovery installs the repository dependencies and the Real Org E2E Salesforce CLI pin before prewarm', () => {
  const e2e = readWorkflow(E2E_WORKFLOW_PATH);
  const job = slotRecoveryJob();
  const prewarmIndex = prewarmStepIndex(job);
  const stepIndex = run => job.steps.findIndex(step => step.run === run);

  for (const laneName of E2E_LANE_JOBS) {
    assert.equal(job.env?.SALESFORCE_CLI_PACKAGE, e2e.jobs[laneName].env.SALESFORCE_CLI_PACKAGE);
  }
  for (const run of ['pnpm install --frozen-lockfile', 'node scripts/setup-salesforce-cli.mjs']) {
    const index = stepIndex(run);
    assert.ok(index !== -1 && index < prewarmIndex, `expected '${run}' before prewarm`);
  }
});

test('Slot Recovery fails visibly when prewarm cannot replace an environment', () => {
  const job = slotRecoveryJob();
  const prewarm = job.steps[prewarmStepIndex(job)];

  // A failed scratch creation (for example the daily signup limit) exits prewarm non-zero.
  assert.equal(job['continue-on-error'], undefined, 'expected a failed recovery to fail the run');
  assert.equal(prewarm['continue-on-error'], undefined, 'expected a failed prewarm to fail the job');
  assert.equal(prewarm.if, undefined, 'expected prewarm to run only after every earlier step succeeded');
  assert.doesNotMatch(prewarm.run, /\|\||set \+e|exit 0/, 'expected the prewarm exit status to reach the runner');
});

test('package.json test:scripts includes the Slot Recovery workflow guard', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/slot-recovery-workflow\.test\.js\b/,
    'expected the Slot Recovery workflow guard to run in the default script suite'
  );
});
