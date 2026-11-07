const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const YAML = require('yaml');
const { STATUS_CONTEXT, parseCodexReview, decideGate } = require('./codex-review-gate');

const WORKFLOW_PATH = '.github/workflows/codex-review-gate.yml';
const HEAD = '6d9c949932c4b4c2a4739674b86ab5b8f9f2c45a';
const OLD_HEAD = '1111111111111111111111111111111111111111';

function marker(codeReview) {
  const state = { code_review: codeReview, security_review: { commit_sha: null, status: null } };
  return `<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`;
}

function comment({ login = 'chatgpt-codex-connector[bot]', type = 'Bot', body, url = 'https://example.test/c/1' }) {
  return { user: { login, type }, body, html_url: url };
}

const clean = { commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' };

test('parseCodexReview reads the state from the Codex summary comment', () => {
  const review = parseCodexReview([
    comment({ login: 'someone', type: 'User', body: 'LGTM' }),
    comment({ body: `### Codex Review\n\nDidn't find any major issues.\n\n${marker(clean)}` })
  ]);
  assert.deepEqual(review, {
    commitSha: HEAD,
    status: 'completed',
    hasUnresolvedFindings: false,
    url: 'https://example.test/c/1'
  });
});

test('parseCodexReview ignores a marker pasted by anyone but the Codex bot', () => {
  assert.equal(parseCodexReview([comment({ login: 'mallory', type: 'User', body: marker(clean) })]), null);
  assert.equal(
    parseCodexReview([comment({ login: 'chatgpt-codex-connector[bot]', type: 'User', body: marker(clean) })]),
    null
  );
  assert.equal(
    parseCodexReview([comment({ login: 'chatgpt-codex-connector', type: 'Bot', body: marker(clean) })]),
    null
  );
});

test('parseCodexReview fails closed on a malformed marker', () => {
  assert.equal(parseCodexReview([comment({ body: '<!-- codex-review-state:v1 {"code_review": nope} -->' })]), null);
  assert.equal(parseCodexReview([comment({ body: '<!-- codex-review-state:v1 {"security_review":{}} -->' })]), null);
});

test('parseCodexReview ignores a Codex comment without the marker', () => {
  assert.equal(parseCodexReview([comment({ body: "Codex Review: Didn't find any major issues" })]), null);
  assert.equal(parseCodexReview([]), null);
});

test('parseCodexReview uses the newest marked Codex comment', () => {
  const review = parseCodexReview([
    comment({ body: marker({ ...clean, commit_sha: OLD_HEAD }), url: 'https://example.test/c/old' }),
    comment({ body: marker(clean), url: 'https://example.test/c/new' })
  ]);
  assert.equal(review.commitSha, HEAD);
  assert.equal(review.url, 'https://example.test/c/new');
});

const reviewOf = overrides => ({
  commitSha: HEAD,
  status: 'completed',
  hasUnresolvedFindings: false,
  url: 'https://example.test/c/1',
  ...overrides
});

const GATE_ROWS = [
  {
    name: 'Dependabot is exempt even without a review',
    input: { author: 'dependabot[bot]', headSha: HEAD, review: null },
    expected: { state: 'success', description: 'Codex does not review Dependabot pull requests' }
  },
  {
    name: 'no review yet waits and says how to start it',
    input: { author: 'alice', headSha: HEAD, review: null },
    expected: { state: 'pending', description: 'Waiting for Codex. Comment @codex review if it does not start' }
  },
  {
    name: 'a stale sha stays pending even when completed and clean',
    input: { author: 'alice', headSha: HEAD, review: reviewOf({ commitSha: OLD_HEAD }) },
    expected: { state: 'pending', description: 'Codex has not reviewed 6d9c949 yet' }
  },
  {
    name: 'a review without a sha stays pending',
    input: { author: 'alice', headSha: HEAD, review: reviewOf({ commitSha: null, status: null }) },
    expected: { state: 'pending', description: 'Codex has not reviewed 6d9c949 yet' }
  },
  {
    name: 'running stays pending',
    input: { author: 'alice', headSha: HEAD, review: reviewOf({ status: 'running' }) },
    expected: { state: 'pending', description: 'Codex review is running' }
  },
  {
    name: 'unresolved findings fail',
    input: { author: 'alice', headSha: HEAD, review: reviewOf({ hasUnresolvedFindings: true }) },
    expected: { state: 'failure', description: 'Codex reported findings on 6d9c949' }
  },
  {
    name: 'unknown findings fail closed',
    input: { author: 'alice', headSha: HEAD, review: reviewOf({ hasUnresolvedFindings: null }) },
    expected: { state: 'failure', description: 'Codex reported findings on 6d9c949' }
  },
  {
    name: 'resolved earlier findings on a clean head pass',
    input: {
      author: 'alice',
      headSha: HEAD,
      review: parseCodexReview([comment({ body: marker({ ...clean, has_any_findings: true }) })])
    },
    expected: { state: 'success', description: 'Codex found nothing on 6d9c949' }
  },
  {
    name: 'a completed clean review of the head passes',
    input: { author: 'alice', headSha: HEAD, review: reviewOf({}) },
    expected: { state: 'success', description: 'Codex found nothing on 6d9c949' }
  }
];

for (const { name, input, expected } of GATE_ROWS) {
  test(`decideGate: ${name}`, () => {
    const verdict = decideGate(input);
    assert.deepEqual(verdict, expected);
    assert.ok(verdict.description.length < 140, 'commit status descriptions are limited to 140 characters');
  });
}

test('Codex review gate workflow runs from the default branch with minimal permissions', () => {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const workflow = YAML.parse(text);
  const job = workflow.jobs.gate;

  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(job.permissions, {
    contents: 'read',
    issues: 'read',
    'pull-requests': 'read',
    statuses: 'write'
  });
  assert.doesNotMatch(text, /head\.sha|head\.ref|github\.event\.pull_request\.head/);

  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(checkout.with['persist-credentials'], false);
  for (const step of job.steps) {
    assert.doesNotMatch(step.run ?? '', /\$\{\{/, 'event data must reach the script through env, not run');
    if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/);
  }
});

test('Codex review gate workflow serializes per pull request at job level', () => {
  const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  assert.equal(workflow.concurrency, undefined);
  assert.equal(workflow.jobs.gate.concurrency['cancel-in-progress'], false);
  assert.match(workflow.jobs.gate.concurrency.group, /github\.event\.pull_request\.number/);
  assert.match(workflow.jobs.gate.concurrency.group, /github\.event\.issue\.number/);
});

test('Codex review gate workflow reacts to pushes, Codex comments and manual runs', () => {
  const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  assert.deepEqual(workflow.on.pull_request_target.types, ['opened', 'reopened', 'synchronize', 'ready_for_review']);
  assert.deepEqual(workflow.on.issue_comment.types, ['created', 'edited']);
  assert.equal(workflow.on.workflow_dispatch.inputs.pull_request.required, true);

  const condition = workflow.jobs.gate.if;
  assert.match(condition, /github\.event_name != 'issue_comment'/);
  assert.match(condition, /github\.event\.issue\.pull_request/);
  assert.match(condition, /github\.event\.comment\.user\.login == 'chatgpt-codex-connector\[bot\]'/);
  assert.match(condition, /codex-review-state:v1/);
});

test('the status context differs from the job name so the job is not mistaken for the gate', () => {
  const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
  assert.equal(STATUS_CONTEXT, 'Codex review');
  assert.notEqual(workflow.jobs.gate.name, STATUS_CONTEXT);
});
