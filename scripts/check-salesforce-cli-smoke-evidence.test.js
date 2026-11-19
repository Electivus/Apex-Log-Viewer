const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const {
  changesCliPin,
  findRunIds,
  runProblem,
  decideEvidence,
  REQUEST_STEP,
  WORKFLOW_NAME
} = require('./check-salesforce-cli-smoke-evidence');

const HEAD = '6d9c949932c4b4c2a4739674b86ab5b8f9f2c45a';
const REPO = 'Electivus/Apex-Log-Viewer';

function run(overrides = {}) {
  return {
    databaseId: 7,
    workflowName: WORKFLOW_NAME,
    event: 'workflow_dispatch',
    headSha: HEAD,
    conclusion: 'success',
    status: 'completed',
    jobs: [{ steps: [{ name: REQUEST_STEP, conclusion: 'success' }] }],
    ...overrides
  };
}

test('changesCliPin sees an added or removed pin and ignores a mention', () => {
  assert.equal(
    changesCliPin('-  SALESFORCE_CLI_PACKAGE: "@salesforce/cli@2.159.7"\n+  X: "@salesforce/cli@2.160.0"'),
    true
  );
  assert.equal(
    changesCliPin(' unchanged @salesforce/cli@2.159.7\n+docs mention @salesforce/cli without a version'),
    false
  );
});

test('findRunIds keeps run links of this repository once each', () => {
  const body = `smoke https://github.com/${REPO}/actions/runs/11 and again https://github.com/${REPO}/actions/runs/11\nother https://github.com/Other/Repo/actions/runs/22`;
  assert.deepEqual(findRunIds(body, REPO), ['11']);
  assert.deepEqual(findRunIds(null, REPO), []);
});

test('runProblem accepts only a successful smoke dispatch of the real-org workflow on the head', () => {
  assert.equal(runProblem(run(), HEAD), null);
  assert.match(runProblem(run({ workflowName: 'CI' }), HEAD), /not E2E/);
  assert.match(runProblem(run({ event: 'pull_request' }), HEAD), /not a manual dispatch/);
  assert.match(runProblem(run({ headSha: '1'.repeat(40) }), HEAD), /not the head/);
  assert.match(runProblem(run({ conclusion: 'failure' }), HEAD), /ended failure/);
  assert.match(
    runProblem(run({ jobs: [{ steps: [{ name: REQUEST_STEP, conclusion: 'skipped' }] }] }), HEAD),
    /without jwt_smoke_devhub_org_id/
  );
});

test('decideEvidence passes without a pin change, and with one only given a passing linked run', () => {
  assert.equal(decideEvidence({ pinChanged: false, runIds: [], runs: [], headSha: HEAD }).ok, true);
  const missing = decideEvidence({ pinChanged: true, runIds: [], runs: [], headSha: HEAD });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /Link a JWT smoke run/);
  const bad = run({ databaseId: 8, conclusion: 'failure' });
  const failed = decideEvidence({ pinChanged: true, runIds: ['8'], runs: [bad], headSha: HEAD });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Run 8 ended failure/);
  assert.equal(decideEvidence({ pinChanged: true, runIds: ['8', '7'], runs: [bad, run()], headSha: HEAD }).ok, true);
});

test('the real-org workflow records the smoke request and gates pull requests on the evidence', () => {
  const workflow = YAML.parse(fs.readFileSync('.github/workflows/e2e-playwright.yml', 'utf8'));
  const marker = workflow.jobs.classify_e2e.steps.find(step => step.name === REQUEST_STEP);
  assert.equal(marker.if, "${{ inputs.jwt_smoke_devhub_org_id != '' }}");

  const job = workflow.jobs.salesforce_cli_smoke_evidence;
  assert.equal(job.if, "${{ github.event_name == 'pull_request' }}");
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read', actions: 'read' });
  assert.ok(workflow.jobs.playwright_e2e_required.needs.includes('salesforce_cli_smoke_evidence'));
  const step = job.steps.find(candidate => candidate.run === 'node scripts/check-salesforce-cli-smoke-evidence.js');
  assert.ok(step, 'expected the gate script step');
  assert.doesNotMatch(JSON.stringify(job), /github\.event\.pull_request\.body/);
  assert.equal(step.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
});
