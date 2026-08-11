const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldRunRealOrgE2E } = require('./classify-real-org-e2e');

test('real-org E2E classifier skips only explicit documentation changes', () => {
  assert.equal(shouldRunRealOrgE2E(['docs/CI.md', 'CHANGELOG.md']), false);
  assert.equal(shouldRunRealOrgE2E(['.github/ISSUE_TEMPLATE/bug.yml']), false);
});

test('real-org E2E classifier fails closed for empty or behavior-bearing changes', () => {
  for (const changedPath of [
    'test/conformance/v1/scenarios/list-logs-through-boundaries.json',
    'playwright.config.ts',
    'playwright.cli.config.ts',
    'docker-compose.e2e-proxy.yml',
    'apps/intellij-plugin/build.gradle.kts',
    'packages/core/src/runtime.ts',
    'scripts/run-playwright-cli-e2e.js'
  ]) {
    assert.equal(shouldRunRealOrgE2E([changedPath]), true, changedPath);
  }
  assert.equal(shouldRunRealOrgE2E([]), true);
  assert.equal(shouldRunRealOrgE2E(['docs/CI.md', 'apps/intellij-plugin/build.gradle.kts']), true);
});
