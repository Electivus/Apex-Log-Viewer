# Remove Claude Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove both Claude Code GitHub Actions workflows from the repository.

**Architecture:** This is a CI configuration cleanup. The implementation deletes the two Claude workflow YAML files and removes only the repository-security tests that asserted those deleted files existed. Generic workflow security tests remain intact for all remaining workflows.

**Tech Stack:** GitHub Actions YAML, Node.js test runner, shell, `rg`, `git`.

---

## File Structure

- Delete: `.github/workflows/claude-code-review.yml`
  - Responsibility today: automatic Claude Code Review on pull request events.
- Delete: `.github/workflows/claude.yml`
  - Responsibility today: mention-triggered Claude Code runs from `@claude` comments or reviews.
- Modify: `scripts/repo-security.test.js`
  - Remove the two tests that parse and assert the deleted Claude workflow files.
  - Remove the now-unused Claude model helper if it has no remaining callers.
  - Keep generic workflow security tests and helper functions used by remaining tests.
- No product source files, package manifests, runtime files, or CI workflows other than the two Claude workflows should change.

### Task 1: Remove Claude-Specific Security Tests

**Files:**
- Modify: `scripts/repo-security.test.js`

- [ ] **Step 1: Confirm the Claude-specific tests exist before removal**

Run:

```bash
rg -n "Claude workflow only responds|Claude review workflow skips" scripts/repo-security.test.js
```

Expected output includes:

```text
scripts/repo-security.test.js:928:test('Claude workflow only responds to trusted collaborators and has write permissions for repo actions', () => {
scripts/repo-security.test.js:955:test('Claude review workflow skips the action when the OAuth token is unavailable', () => {
```

- [ ] **Step 2: Remove the two Claude-specific tests**

Edit `scripts/repo-security.test.js` and delete the now-unused `assertUsesDefaultClaudeModel` helper:

```javascript
function assertUsesDefaultClaudeModel(step, description) {
  const claudeArgs = step.with?.claude_args;
  if (claudeArgs === undefined) {
    return;
  }

  assert.equal(
    typeof claudeArgs,
    'string',
    `${description} claude_args should be a string when present`
  );
  assert.doesNotMatch(
    claudeArgs,
    /(^|\s)--model(?:=|\s)/,
    `${description} should not override the default Claude model`
  );
}
```

Then delete both complete test blocks:

```javascript
test('Claude workflow only responds to trusted collaborators and has write permissions for repo actions', () => {
  const workflow = yaml.parse(read('.github/workflows/claude.yml'));
  const job = workflow.jobs.claude;
  const actionStep = findRequiredStep(
    job.steps,
    'Claude workflow Run Claude Code',
    step => step.id === 'claude'
  );

  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'issue_comment',
    'pull_request_review',
    'pull_request_review_comment'
  ]);
  assert.equal(job.permissions.contents, 'write');
  assert.equal(job.permissions['pull-requests'], 'write');
  assert.equal(job.permissions.issues, 'write');
  assert.equal(job.permissions.actions, 'read');
  assert.match(job.if, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(job.if, /github\.event\.comment\.author_association == 'MEMBER'/);
  assert.match(job.if, /github\.event\.comment\.author_association == 'COLLABORATOR'/);
  assert.match(job.if, /github\.event\.review\.author_association == 'OWNER'/);
  assert.match(job.if, /github\.event\.review\.author_association == 'MEMBER'/);
  assert.match(job.if, /github\.event\.review\.author_association == 'COLLABORATOR'/);
  assertUsesDefaultClaudeModel(actionStep, 'Claude workflow Run Claude Code');
});
```

Delete this block as well:

```javascript
test('Claude review workflow skips the action when the OAuth token is unavailable', () => {
  const workflow = yaml.parse(read('.github/workflows/claude-code-review.yml'));
  const job = workflow.jobs['claude-review'];
  const bunSetupStep = findRequiredStep(
    job.steps,
    'Claude review Install Bun for Claude review wrapper',
    step => step.name === 'Install Bun for Claude review wrapper'
  );
  const bunWrapperStep = findRequiredStep(
    job.steps,
    'Claude review Prepare Claude review Bun wrapper',
    step => step.name === 'Prepare Claude review Bun wrapper'
  );
  const actionStep = findRequiredStep(
    job.steps,
    'Claude review Run Claude Code Review',
    step => step.id === 'claude-review'
  );
  const limitStep = findRequiredStep(
    job.steps,
    'Claude review Allow Claude usage-limit exhaustion',
    step => step.name === 'Allow Claude usage-limit exhaustion'
  );
  const skipStep = findRequiredStep(
    job.steps,
    'Claude review Skip Claude Code Review when OAuth token is unavailable',
    step => step.name === 'Skip Claude Code Review when OAuth token is unavailable'
  );

  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions['pull-requests'], 'write');
  assert.equal(job.permissions.actions, 'read');
  assert.equal(job.permissions.checks, undefined);
  assert.equal(job.permissions.issues, undefined);
  assert.equal(job.env.CLAUDE_CODE_OAUTH_TOKEN, '${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}');
  assert.equal(bunSetupStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' }}");
  assert.equal(bunWrapperStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' }}");
  assert.match(bunWrapperStep.run, /REAL_BUN_PATH=/);
  assert.match(bunWrapperStep.run, /CLAUDE_REVIEW_BUN_PATH=/);
  assert.match(bunWrapperStep.run, /CLAUDE_BUN_LOG_PATH=/);
  assert.match(bunWrapperStep.run, /tee -a "\$\{CLAUDE_BUN_LOG_PATH:\?\}"/);
  assert.equal(actionStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' }}");
  assert.equal(actionStep.env.REAL_BUN_PATH, '${{ env.REAL_BUN_PATH }}');
  assert.equal(actionStep.env.CLAUDE_BUN_LOG_PATH, '${{ env.CLAUDE_BUN_LOG_PATH }}');
  assert.equal(actionStep.with.claude_code_oauth_token, '${{ env.CLAUDE_CODE_OAUTH_TOKEN }}');
  assert.equal(actionStep.with.github_token, '${{ github.token }}');
  assert.equal(actionStep.with.path_to_bun_executable, '${{ env.CLAUDE_REVIEW_BUN_PATH }}');
  assert.equal(actionStep['continue-on-error'], true);
  assertUsesDefaultClaudeModel(actionStep, 'Claude review Run Claude Code Review');
  assert.equal(limitStep.if, "${{ steps.claude-review.outcome == 'failure' }}");
  assert.equal(limitStep.env.CLAUDE_BUN_LOG_PATH, '${{ env.CLAUDE_BUN_LOG_PATH }}');
  assert.match(limitStep.run, /claude-execution-output\.json/);
  assert.match(limitStep.run, /claude-review-bun\.log/);
  assert.match(limitStep.run, /CLAUDE_BUN_LOG_PATH/);
  assert.match(limitStep.run, /Action failed with error:/);
  assert.match(limitStep.run, /You've hit your limit/);
  assert.match(limitStep.run, /subtype !== 'success'/);
  assert.equal(skipStep.if, "${{ env.CLAUDE_CODE_OAUTH_TOKEN == '' }}");
  assert.match(skipStep.run, /Skipping Claude Code Review because CLAUDE_CODE_OAUTH_TOKEN is unavailable/);
});
```

- [ ] **Step 3: Confirm no Claude-specific security tests remain**

Run:

```bash
rg -n "assertUsesDefaultClaudeModel|Claude workflow only responds|Claude review workflow skips" scripts/repo-security.test.js
```

Expected: command exits with status `1` because the helper and those test names are gone.

### Task 2: Remove Claude Workflow Files

**Files:**
- Delete: `.github/workflows/claude-code-review.yml`
- Delete: `.github/workflows/claude.yml`

- [ ] **Step 1: Confirm both workflow files exist before removal**

Run:

```bash
test -f .github/workflows/claude-code-review.yml
test -f .github/workflows/claude.yml
```

Expected: both commands exit with status `0` and produce no output.

- [ ] **Step 2: Delete the workflow files**

Run:

```bash
git rm .github/workflows/claude-code-review.yml .github/workflows/claude.yml
```

Expected output includes:

```text
rm '.github/workflows/claude-code-review.yml'
rm '.github/workflows/claude.yml'
```

- [ ] **Step 3: Confirm Git sees the intended files changed**

Run:

```bash
git status --short
```

Expected output includes:

```text
D  .github/workflows/claude-code-review.yml
D  .github/workflows/claude.yml
 M docs/superpowers/specs/2026-05-18-remove-claude-workflows-design.md
 M scripts/repo-security.test.js
```

Expected: the new plan file also appears as untracked until it is added for commit. No unrelated source, package, runtime, or test files are modified.

### Task 3: Verify Claude Workflow Removal

**Files:**
- Inspect: `.github/workflows/`
- Inspect: `scripts/repo-security.test.js`
- Inspect: repository references returned by `rg`

- [ ] **Step 1: List remaining workflow files**

Run:

```bash
rg --files .github/workflows
```

Expected: output does not include either of these paths:

```text
.github/workflows/claude-code-review.yml
.github/workflows/claude.yml
```

- [ ] **Step 2: Check for remaining Claude references in workflow files**

Run:

```bash
rg -n "claude|Claude|anthropic" .github/workflows
```

Expected: command exits with status `1` because there are no matches in `.github/workflows`.

- [ ] **Step 3: Check broader repository references**

Run:

```bash
rg -n "claude|Claude|anthropic" .github docs package.json README.md scripts
```

Expected: matches may remain in the approved spec/plan documents and in generic helper names only if they are not operational workflow definitions. There should be no remaining Claude GitHub Actions workflow definition and no Claude-specific repository-security test that reads deleted workflow files.

- [ ] **Step 4: Run the repository script/security suite with the repo Node version**

Run:

```bash
zsh -lc 'source ~/.nvm/nvm.sh && nvm use 24.15.0 >/dev/null && npm run test:scripts'
```

Expected: command exits with status `0`.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff -- .github/workflows/claude-code-review.yml .github/workflows/claude.yml scripts/repo-security.test.js docs/superpowers/specs/2026-05-18-remove-claude-workflows-design.md docs/superpowers/plans/2026-05-18-remove-claude-workflows.md
```

Expected: diff shows both workflow files deleted, the two Claude-specific tests removed, and the spec/plan updated for that scope.

- [ ] **Step 6: Commit the workflow removal**

Run:

```bash
git add .github/workflows/claude-code-review.yml .github/workflows/claude.yml scripts/repo-security.test.js docs/superpowers/specs/2026-05-18-remove-claude-workflows-design.md docs/superpowers/plans/2026-05-18-remove-claude-workflows.md
git commit -m "ci: remove claude workflows"
```

Expected: commit succeeds and includes the deleted workflow files, the aligned test cleanup, and the updated Superpowers documents.
