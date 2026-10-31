const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('release docs describe the independent core and plugin packaging model', () => {
  const ci = fs.readFileSync('docs/CI.md', 'utf8');
  const publishing = fs.readFileSync('docs/PUBLISHING.md', 'utf8');
  const architecture = fs.readFileSync('docs/ARCHITECTURE.md', 'utf8');
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');

  assert.match(ci, /pnpm run build/);
  assert.match(ci, /test:sf-plugin/);
  assert.doesNotMatch(ci, /build:embedded-sf-plugin/);
  assert.doesNotMatch(ci, /NPM_TOKEN/);
  assert.match(publishing, /plugin npm release/i);
  assert.match(publishing, /sf-plugin-vX\.Y\.Z/);
  assert.match(publishing, /sf-plugin-release\.yml/);
  assert.match(publishing, /Trusted Publishing\/OIDC/);
  assert.doesNotMatch(publishing, /rust-release\.yml/);
  assert.match(architecture, /@alv\/core/);
  assert.match(architecture, /in-process/i);
  assert.doesNotMatch(architecture, /electivus-runner\.cjs/);
  assert.match(changelog, /shared TypeScript core/i);
});

test('README screenshot assets point at the published extension media paths', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const assetPaths = [
    'apps/vscode-extension/media/banner.png',
    'apps/vscode-extension/media/docs/hero.png',
    'apps/vscode-extension/media/docs/log-viewer.png',
    'apps/vscode-extension/media/docs/debug-flags.png',
    'apps/vscode-extension/media/docs/tail.png',
    'apps/vscode-extension/media/docs/custom-logs.png'
  ];

  for (const assetPath of assetPaths) {
    assert.equal(fs.existsSync(assetPath), true, `expected ${assetPath} to exist`);
    assert.match(readme, new RegExp(escapeRegExp(assetPath)));
  }

  assert.doesNotMatch(readme, /raw\.githubusercontent\.com\/Electivus\/Apex-Log-Viewer\/main\/media\//);
  assert.doesNotMatch(readme, /!\[[^\]]*\]\(media\//);
});

const CONTRACTS_PATH = 'packages/core/src/customLogs/contracts.ts';

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The string literals of the union that starts at `declaration` and ends at the next semicolon. */
function unionMembers(source, declaration) {
  const start = source.search(declaration);
  assert.notEqual(start, -1, `expected ${CONTRACTS_PATH} to match ${declaration}`);
  const end = source.indexOf(';', start);
  const members = [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.notEqual(members.length, 0, `expected ${declaration} to list string literals`);
  assert.equal(new Set(members).size, members.length, `expected ${declaration} to list each member once`);
  return members;
}

test('docs/CUSTOM_LOGS.md names every source shape, unavailable reason, gap reason, capture outcome, issue code, and error code', () => {
  const contracts = withoutComments(fs.readFileSync(CONTRACTS_PATH, 'utf8'));
  const docs = fs.readFileSync('docs/CUSTOM_LOGS.md', 'utf8');
  const lists = {
    'source shape': unionMembers(contracts, /export type CustomLogSourceShape =/),
    'unavailable reason': unionMembers(contracts, /export type CustomLogUnavailableReason =/),
    'configuration issue code': unionMembers(contracts, /export type CustomLogConfigIssueCode =/),
    'gap reason': unionMembers(contracts, /export type CustomLogStoreGap = \{[\s\S]*?\breason:/),
    'capture outcome': unionMembers(contracts, /export type CustomLogCaptureOutcome =/),
    'error code': unionMembers(contracts, /export type CustomLogErrorCode =/)
  };

  const missing = Object.entries(lists).flatMap(([kind, members]) =>
    members.filter(member => !docs.includes(`\`${member}\``)).map(member => `${kind} ${member}`)
  );

  assert.deepEqual(missing, [], 'expected docs/CUSTOM_LOGS.md to name each of these in code font');
});

test('docs/TELEMETRY.md names the Custom Logs capture events and request method that telemetry.json declares', () => {
  const telemetry = JSON.parse(fs.readFileSync('telemetry.json', 'utf8'));
  const docs = fs.readFileSync('docs/TELEMETRY.md', 'utf8');
  const events = Object.keys(telemetry.events).filter(name => name.startsWith('customLogs.capture.'));
  const methods = telemetry.events['core.request'].properties.method.values.filter(name =>
    name.startsWith('custom_log_capture')
  );

  assert.notEqual(events.length, 0, 'expected telemetry.json to declare the customLogs.capture events');
  assert.notEqual(methods.length, 0, 'expected telemetry.json to declare a custom_log_capture core.request method');
  const missing = [...events, ...methods].filter(name => !docs.includes(`\`${name}\``));
  assert.deepEqual(missing, [], 'expected docs/TELEMETRY.md to name each of these in code font');
});

test('test:scripts includes the release docs smoke test', () => {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.match(
    String(packageJson.scripts?.['test:scripts'] || ''),
    /\bscripts\/docs-release\.test\.js\b/,
    'expected the release docs smoke test to run in the default script suite'
  );
});
