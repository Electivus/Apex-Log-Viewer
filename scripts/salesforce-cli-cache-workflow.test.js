const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');

const E2E_WORKFLOW_PATH = '.github/workflows/e2e-playwright.yml';
const WARM_WORKFLOW_PATH = '.github/workflows/salesforce-cli-cache.yml';
const CACHE_DIR_OUTPUT = '${{ steps.sf-cli-cache.outputs.cache-dir }}';
const RESOLVER_RUN = 'node scripts/setup-salesforce-cli.mjs --print-cache-key';
const SETUP_RUN = 'node scripts/setup-salesforce-cli.mjs';

function read(relativePath) {
  return fs.readFileSync(relativePath, 'utf8');
}

function readWorkflow(relativePath) {
  return YAML.parse(read(relativePath));
}

function getJob(workflow, jobName) {
  const job = workflow?.jobs?.[jobName];
  assert.ok(job, `expected workflow to define jobs.${jobName}`);
  assert.ok(Array.isArray(job.steps), `expected jobs.${jobName} to define steps`);
  return job;
}

function directLaneJob() {
  return getJob(readWorkflow(E2E_WORKFLOW_PATH), 'playwright_e2e_os_matrix');
}

function salesforceCliCacheSteps(job) {
  return (job.steps || []).filter(step => step.with?.path === CACHE_DIR_OUTPUT);
}

function warmJob() {
  const workflow = readWorkflow(WARM_WORKFLOW_PATH);
  const jobs = Object.values(workflow.jobs || {});
  assert.equal(jobs.length, 1, 'expected a single cache-warming job');
  return getJob(workflow, Object.keys(workflow.jobs)[0]);
}

function matrixRunners(job) {
  const entries = job.strategy?.matrix?.os;
  assert.ok(Array.isArray(entries), 'expected the job to define a matrix.os runner list');
  return entries.map(entry => entry.runner).sort();
}

function findStepIndex(job, predicate, description) {
  const index = job.steps.findIndex(predicate);
  assert.notEqual(index, -1, `expected a ${description} step`);
  return index;
}

function pinnedSha(uses) {
  return /@([0-9a-f]{40})$/.exec(String(uses || ''))?.[1];
}

// Everything that feeds the Salesforce CLI cache key or its installed content: the
// pinned package, the Node runtime selected before the resolver runs (the key embeds
// its version), the resolver's inputs and the installer's inputs.
function salesforceCliCacheContract(job) {
  const resolverIndex = findStepIndex(job, step => step.run === RESOLVER_RUN, 'cache-key resolver');
  const resolver = job.steps[resolverIndex];
  const setup = job.steps[findStepIndex(job, step => step.run === SETUP_RUN, 'Salesforce CLI setup')];
  const nodeRuntime = job.steps
    .slice(0, resolverIndex)
    .filter(step => /^actions\/setup-node@/.test(String(step.uses || '')))
    .map(step => {
      // Package-manager caching does not change the selected Node runtime.
      const { cache, 'cache-dependency-path': cacheDependencyPath, ...runtime } = step.with || {};
      return { if: step.if, uses: step.uses, with: runtime };
    });

  return {
    packageName: job.env?.SALESFORCE_CLI_PACKAGE,
    nodeRuntime,
    resolver: { id: resolver.id, shell: resolver.shell, env: resolver.env },
    setup: { shell: setup.shell, env: setup.env }
  };
}

test('direct Real Org E2E Lanes restore the Salesforce CLI cache without saving it from a pull request', () => {
  const workflow = readWorkflow(E2E_WORKFLOW_PATH);

  assert.equal(salesforceCliCacheSteps(directLaneJob()).length, 1, 'expected the direct lanes to restore the cache');
  for (const job of Object.values(workflow.jobs)) {
    for (const step of salesforceCliCacheSteps(job)) {
      assert.match(step.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/, 'expected PR runs never to save this cache');
    }
  }
});

test('Salesforce CLI cache warms on main when its key inputs change, inside the eviction window, and on demand', () => {
  const triggers = readWorkflow(WARM_WORKFLOW_PATH).on;

  assert.deepEqual(triggers.push?.branches, ['main']);
  assert.deepEqual(
    [...(triggers.push?.paths || [])].sort(),
    ['.github/workflows/salesforce-cli-cache.yml', '.nvmrc', 'scripts/setup-salesforce-cli.mjs'],
    'expected pushes that change the Node runtime pin, the CLI setup script or this workflow to re-warm'
  );
  assert.ok(Object.hasOwn(triggers, 'workflow_dispatch'), 'expected maintainers to be able to warm on demand');
  assert.equal(triggers.pull_request, undefined, 'expected a PR never to warm the default-branch cache');

  assert.equal(triggers.schedule?.length, 1);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = triggers.schedule[0].cron.split(/\s+/);
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  assert.equal(month, '*');
  assert.equal(dayOfWeek, '*');
  // `*/N` fires on days 1, 1+N, ...; month ends only shorten a gap, so N bounds every gap.
  const interval = Number(/^\*\/(\d+)$/.exec(dayOfMonth)?.[1]);
  assert.ok(
    interval >= 1 && interval < 7,
    `expected a schedule inside GitHub's 7-day eviction window, got ${dayOfMonth}`
  );
});

test('Salesforce CLI cache warming runs read-only on the direct lane runners without Dev Hub credentials', () => {
  const text = read(WARM_WORKFLOW_PATH);
  const workflow = YAML.parse(text);
  const job = warmJob();

  assert.deepEqual(matrixRunners(job), matrixRunners(directLaneJob()));
  assert.equal(job.strategy['fail-fast'], false, 'expected one OS to warm even when the other fails');
  assert.equal(job['runs-on'], '${{ matrix.os.runner }}');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(job.permissions, undefined, 'expected the job not to widen the read-only token');
  assert.doesNotMatch(text, /\bsecrets\./, 'expected cache warming to need no repository secrets');
  assert.doesNotMatch(text, /\bSF_DEVHUB_/, 'expected cache warming never to see Dev Hub inputs');
});

test('Salesforce CLI cache warming resolves its key and installs exactly like the direct lanes', () => {
  const warm = salesforceCliCacheContract(warmJob());
  const lanes = salesforceCliCacheContract(directLaneJob());

  assert.deepEqual(warm, lanes);
  assert.match(warm.packageName, /^@salesforce\/cli@\d+\.\d+\.\d+$/, 'expected an exact Salesforce CLI pin');
  assert.ok(
    warm.nodeRuntime.some(step => step.if === "runner.os == 'macOS'"),
    'expected the macOS Salesforce CLI Node runtime step to be mirrored'
  );
  assert.equal(warm.setup.env?.SALESFORCE_CLI_WRAP_NODE, "${{ runner.os == 'macOS' && '1' || '' }}");
});

test('Salesforce CLI cache warming saves under the key the direct lanes restore, only when it is missing', () => {
  const job = warmJob();
  const [laneRestore] = salesforceCliCacheSteps(directLaneJob());
  const lookupIndex = findStepIndex(job, step => /^actions\/cache\/restore@/.test(String(step.uses || '')), 'lookup');
  const setupIndex = findStepIndex(job, step => step.run === SETUP_RUN, 'Salesforce CLI setup');
  const saveIndex = findStepIndex(
    job,
    step => /^actions\/cache\/save@[0-9a-f]{40}$/.test(String(step.uses || '')),
    'save'
  );
  const lookup = job.steps[lookupIndex];
  const save = job.steps[saveIndex];
  const onMiss = `steps.${lookup.id}.outputs.cache-hit != 'true'`;

  assert.deepEqual({ path: save.with?.path, key: save.with?.key }, laneRestore.with);
  assert.deepEqual(lookup.with, { ...laneRestore.with, 'lookup-only': true }, 'expected lookup without a download');
  assert.equal(pinnedSha(save.uses), pinnedSha(laneRestore.uses), 'expected one pinned actions/cache commit');
  assert.equal(pinnedSha(lookup.uses), pinnedSha(laneRestore.uses), 'expected one pinned actions/cache commit');
  assert.ok(lookupIndex < setupIndex && setupIndex < saveIndex, 'expected lookup, then install, then save');
  assert.equal(job.steps[setupIndex].if, onMiss, 'expected an existing cache entry to skip the install');
  assert.equal(save.if, onMiss, 'expected an existing cache entry to skip the save');
});

test('package.json test:scripts includes the Salesforce CLI cache workflow guard', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/salesforce-cli-cache-workflow\.test\.js\b/,
    'expected the Salesforce CLI cache workflow guard to run in the default script suite'
  );
});
