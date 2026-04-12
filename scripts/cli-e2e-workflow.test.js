const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function read(relativePath) {
  return fs.readFileSync(relativePath, 'utf8');
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
  const workflow = read('.github/workflows/e2e-playwright.yml');

  const cliStepMatch = workflow.match(
    /- name:\s+Run CLI real-org E2E[\s\S]*?run:\s*\|[\s\S]*?\bnpm run test:e2e:cli\b/
  );
  const extensionStepMatch = workflow.match(/- name:\s+Run Playwright E2E\b/);
  const uploadCliArtifactsMatch = workflow.match(
    /- name:\s+Upload CLI E2E artifacts[\s\S]*?path:\s+output\/playwright-cli\//
  );

  assert.ok(cliStepMatch, 'expected the workflow to run npm run test:e2e:cli in a dedicated CLI real-org step');
  assert.ok(extensionStepMatch, 'expected the workflow to keep the extension Playwright step');
  assert.ok(
    uploadCliArtifactsMatch,
    'expected the workflow to upload output/playwright-cli/ as dedicated CLI artifacts'
  );

  assert.ok(
    cliStepMatch.index < extensionStepMatch.index,
    'expected the CLI real-org step to run before the extension Playwright step'
  );
});
